/**
 * Consumer portal (/account/*) — auth, storage helpers, and Express route
 * registration. Mounted from server/routes.ts via `registerAccountRoutes(app)`.
 *
 * Auth model:
 *   1. User enters their email at /account/login
 *   2. POST /api/account/auth/magic-link → server emails them a one-time URL
 *      containing a random token (account_magic_tokens row).
 *   3. They click the link → GET /api/account/auth/magic-callback?token=X
 *      verifies the token, creates an account_users row (and a mirrored lead)
 *      if it's their first sign-in, issues a session cookie, redirects to
 *      /account/dashboard.
 *   4. All subsequent /api/account/* endpoints check the cookie and resolve
 *      it to an account_user via account_sessions.
 *
 * Google OAuth lands in Phase 1.5 — wired alongside magic link, same session
 * model. The /api/account/auth/google endpoints are already stubbed below.
 */
import type { Express, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { db } from "./storage";
import {
  accountUsers,
  accountSessions,
  accountMagicTokens,
  accountFavorites,
  accountPropertyNotes,
  accountMarketReportSubs,
  savedSearches,
  tours,
  leads,
  users,
  type AccountUser,
} from "@shared/schema";
import { sendEmail } from "./email";
import { storage } from "./storage";

import { publicOrigin, publicOriginConfigured } from "./origin";
// ---- Config ---------------------------------------------------------------

const COOKIE_NAME = "rrec_account";
const SESSION_DAYS = 60;
const MAGIC_TOKEN_TTL_MIN = 15;

function nowIso(): string {
  return new Date().toISOString();
}
function plusDaysIso(days: number): string {
  return new Date(Date.now() + days * 86400 * 1000).toISOString();
}
function plusMinutesIso(min: number): string {
  return new Date(Date.now() + min * 60 * 1000).toISOString();
}
function randHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function originFromReq(req: Request): string {
  // An explicit PUBLIC_ORIGIN wins; otherwise prefer the host actually being
  // served (magic links have to come back to where the user already is)
  // before falling back to the shared default.
  if (publicOriginConfigured()) return publicOrigin();
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : publicOrigin();
}

// ---- Storage helpers ------------------------------------------------------

export function getAccountUserById(id: number): AccountUser | undefined {
  return db.select().from(accountUsers).where(eq(accountUsers.id, id)).get();
}

export function getAccountUserByEmail(email: string): AccountUser | undefined {
  return db
    .select()
    .from(accountUsers)
    .where(eq(accountUsers.email, email.toLowerCase()))
    .get();
}

function ensureLeadForEmail(email: string): number {
  // Reuse an existing lead with this email if present; otherwise create one.
  const existing = db.select().from(leads).where(eq(leads.email, email)).get();
  if (existing) return existing.id;
  const row = db
    .insert(leads)
    .values({
      name: email.split("@")[0],
      email,
      source: "portal",
      status: "new",
      message: "Signed up for the Rivers Real Estate portal.",
    } as any)
    .returning()
    .get();
  return row.id;
}

function findOrCreateAccountUser(email: string): AccountUser {
  const lower = email.toLowerCase();
  const existing = getAccountUserByEmail(lower);
  if (existing) return existing;
  const leadId = ensureLeadForEmail(lower);
  return db
    .insert(accountUsers)
    .values({
      leadId,
      email: lower,
      emailVerified: true,
      lastLoginAt: nowIso(),
    } as any)
    .returning()
    .get();
}

function issueSession(userId: number): string {
  const id = randHex(32);
  db.insert(accountSessions)
    .values({
      id,
      accountUserId: userId,
      expiresAt: plusDaysIso(SESSION_DAYS),
    } as any)
    .run();
  return id;
}

function resolveSession(sid: string | undefined): AccountUser | null {
  if (!sid) return null;
  const sess = db
    .select()
    .from(accountSessions)
    .where(eq(accountSessions.id, sid))
    .get();
  if (!sess) return null;
  if (new Date(sess.expiresAt).getTime() < Date.now()) {
    db.delete(accountSessions).where(eq(accountSessions.id, sid)).run();
    return null;
  }
  return getAccountUserById(sess.accountUserId) ?? null;
}

function parseCookie(req: Request): string | undefined {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

function setSessionCookie(res: Response, sessionId: string) {
  const isProd = process.env.NODE_ENV === "production";
  const attrs = [
    `${COOKIE_NAME}=${sessionId}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (isProd) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res: Response) {
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
}

// ---- Auth middleware ------------------------------------------------------

export interface AccountReq extends Request {
  accountUser?: AccountUser;
}

function requireAccount(req: AccountReq, res: Response, next: NextFunction) {
  const user = resolveSession(parseCookie(req));
  if (!user) return res.status(401).json({ error: "not_signed_in" });
  req.accountUser = user;
  next();
}

// ---- Magic link email -----------------------------------------------------

async function emailMagicLink(email: string, link: string) {
  const subject = "Your Rivers Real Estate sign-in link";
  const escaped = link.replace(/&/g, "&amp;");
  const html =
    `<div style="font-family:'Manrope',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0a0a0a;line-height:1.55;">` +
    `<p style="font-family:'Playfair Display',Georgia,serif;font-size:22px;margin:0 0 12px;">Sign in to your portal</p>` +
    `<p style="margin:0 0 18px;">Click the button below to sign in to your Rivers Real Estate account. The link expires in ${MAGIC_TOKEN_TTL_MIN} minutes.</p>` +
    `<p style="margin:24px 0;"><a href="${escaped}" style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#fff;text-decoration:none;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;">SIGN IN</a></p>` +
    `<p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Or copy this link into your browser:</p>` +
    `<p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${escaped}" style="color:#0a0a0a;">${escaped}</a></p>` +
    `<p style="margin:0 0 18px;font-size:13px;color:#6b7280;">If you didn't request this, you can safely ignore the email.</p>` +
    `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0;" />` +
    `<p style="margin:0;font-size:12px;color:#6b7280;">Spencer Rivers · Rivers Real Estate · (403) 966-9237</p>` +
    `</div>`;
  const text = [
    `Sign in to your Rivers Real Estate portal:`,
    ``,
    link,
    ``,
    `This link expires in ${MAGIC_TOKEN_TTL_MIN} minutes.`,
    ``,
    `If you didn't request this, ignore this email.`,
    ``,
    `— Spencer Rivers · Rivers Real Estate · (403) 966-9237`,
  ].join("\n");
  try {
    const result = await sendEmail({ to: email, subject, html, text });
    if (!result.ok) {
      console.error("[account] magic link email failed:", result.error);
    }
  } catch (e) {
    console.error("[account] magic link email error:", e);
  }
}

// ---- Route registration ---------------------------------------------------

export function registerAccountRoutes(app: Express) {
  // -- Auth: send magic link
  app.post("/api/account/auth/magic-link", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "invalid_email" });
    }
    const token = randHex(24);
    db.insert(accountMagicTokens)
      .values({
        id: token,
        email,
        expiresAt: plusMinutesIso(MAGIC_TOKEN_TTL_MIN),
      } as any)
      .run();
    const origin = originFromReq(req);
    const link = `${origin}/api/account/auth/magic-callback?token=${token}`;
    await emailMagicLink(email, link);
    res.json({ ok: true });
  });

  // -- Auth: consume magic link
  app.get("/api/account/auth/magic-callback", (req, res) => {
    const token = String(req.query.token || "");
    if (!token) return res.redirect("/account/login?error=missing_token");
    const row = db
      .select()
      .from(accountMagicTokens)
      .where(eq(accountMagicTokens.id, token))
      .get();
    if (!row) return res.redirect("/account/login?error=invalid_token");
    if (row.consumedAt) return res.redirect("/account/login?error=token_used");
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      return res.redirect("/account/login?error=token_expired");
    }
    db.update(accountMagicTokens)
      .set({ consumedAt: nowIso() })
      .where(eq(accountMagicTokens.id, token))
      .run();
    const user = findOrCreateAccountUser(row.email);
    db.update(accountUsers)
      .set({ lastLoginAt: nowIso(), emailVerified: true })
      .where(eq(accountUsers.id, user.id))
      .run();
    const sid = issueSession(user.id);
    setSessionCookie(res, sid);
    res.redirect("/account/dashboard");
  });

  // -- Auth: current user
  app.get("/api/account/me", (req, res) => {
    const user = resolveSession(parseCookie(req));
    if (!user) return res.status(401).json({ user: null });
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
      },
    });
  });

  // -- Auth: logout
  app.post("/api/account/logout", (req, res) => {
    const sid = parseCookie(req);
    if (sid) db.delete(accountSessions).where(eq(accountSessions.id, sid)).run();
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // -- Google OAuth stubs (Phase 1.5 will wire to the existing Google
  //    integration. For now they redirect back to login with a notice.)
  app.get("/api/account/auth/google", (_req, res) => {
    res.redirect("/account/login?error=google_oauth_not_configured");
  });
  app.get("/api/account/auth/google/callback", (_req, res) => {
    res.redirect("/account/login?error=google_oauth_not_configured");
  });

  // -- Favorites
  app.get("/api/account/favorites", requireAccount, (req: AccountReq, res) => {
    const rows = db
      .select()
      .from(accountFavorites)
      .where(eq(accountFavorites.accountUserId, req.accountUser!.id))
      .orderBy(desc(accountFavorites.createdAt))
      .all();
    res.json({ favorites: rows });
  });

  app.post("/api/account/favorites", requireAccount, (req: AccountReq, res) => {
    const mlsId = String(req.body?.mlsId || "").trim();
    if (!mlsId) return res.status(400).json({ error: "missing_mlsId" });
    const existing = db
      .select()
      .from(accountFavorites)
      .where(
        and(
          eq(accountFavorites.accountUserId, req.accountUser!.id),
          eq(accountFavorites.mlsId, mlsId),
        ),
      )
      .get();
    if (existing) return res.json({ ok: true, favorite: existing });
    const row = db
      .insert(accountFavorites)
      .values({
        accountUserId: req.accountUser!.id,
        mlsId,
      } as any)
      .returning()
      .get();
    res.json({ ok: true, favorite: row });
  });

  app.delete(
    "/api/account/favorites/:mlsId",
    requireAccount,
    (req: AccountReq, res) => {
      const mlsId = String(req.params.mlsId);
      db.delete(accountFavorites)
        .where(
          and(
            eq(accountFavorites.accountUserId, req.accountUser!.id),
            eq(accountFavorites.mlsId, mlsId),
          ),
        )
        .run();
      res.json({ ok: true });
    },
  );

  // -- Saved searches -------------------------------------------------------
  // Reuses the existing savedSearches table (already wired into the lead
  // alert cron). Portal-owned rows are scoped by accountUserId; alerts are
  // emailed to emailRecipient (= the user's email) on the configured cadence.
  const FALLBACK_AGENT_USER_ID = 1; // Spencer is the seeded admin user.

  app.get("/api/account/searches", requireAccount, (req: AccountReq, res) => {
    const rows = db
      .select()
      .from(savedSearches)
      .where(eq(savedSearches.accountUserId, req.accountUser!.id))
      .orderBy(desc(savedSearches.createdAt))
      .all();
    res.json({ searches: rows });
  });

  app.post("/api/account/searches", requireAccount, (req: AccountReq, res) => {
    const name = String(req.body?.name || "").trim();
    const filters = req.body?.filters ?? {};
    const frequency = String(req.body?.frequency || "daily");
    const emailAlerts = req.body?.emailAlerts !== false; // default true
    if (!name) return res.status(400).json({ error: "missing_name" });
    if (!["instant", "daily", "weekly", "monthly"].includes(frequency)) {
      return res.status(400).json({ error: "invalid_frequency" });
    }
    // Resolve a default agent userId. Required by the schema, not used
    // visibly anywhere on the portal side.
    let agentUserId = FALLBACK_AGENT_USER_ID;
    try {
      const firstAdmin = db.select().from(users).limit(1).get();
      if (firstAdmin) agentUserId = firstAdmin.id;
    } catch {}
    const row = db
      .insert(savedSearches)
      .values({
        userId: agentUserId,
        accountUserId: req.accountUser!.id,
        leadId: req.accountUser!.leadId,
        emailRecipient: req.accountUser!.email,
        name,
        filters: JSON.stringify(filters),
        emailAlerts,
        alertType: "listings",
        frequency,
        instant: frequency === "instant",
        active: true,
      } as any)
      .returning()
      .get();
    res.json({ ok: true, search: row });
  });

  app.patch(
    "/api/account/searches/:id",
    requireAccount,
    (req: AccountReq, res) => {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid_id" });
      const existing = db
        .select()
        .from(savedSearches)
        .where(
          and(
            eq(savedSearches.id, id),
            eq(savedSearches.accountUserId, req.accountUser!.id),
          ),
        )
        .get();
      if (!existing) return res.status(404).json({ error: "not_found" });
      const patch: any = {};
      if (typeof req.body?.name === "string") patch.name = req.body.name.trim();
      if (req.body?.filters !== undefined)
        patch.filters = JSON.stringify(req.body.filters);
      if (typeof req.body?.frequency === "string" &&
          ["instant", "daily", "weekly", "monthly"].includes(req.body.frequency)) {
        patch.frequency = req.body.frequency;
        patch.instant = req.body.frequency === "instant";
      }
      if (typeof req.body?.emailAlerts === "boolean")
        patch.emailAlerts = req.body.emailAlerts;
      if (typeof req.body?.active === "boolean") patch.active = req.body.active;
      if (Object.keys(patch).length === 0) {
        return res.json({ ok: true, search: existing });
      }
      const updated = db
        .update(savedSearches)
        .set(patch)
        .where(eq(savedSearches.id, id))
        .returning()
        .get();
      res.json({ ok: true, search: updated });
    },
  );

  app.delete(
    "/api/account/searches/:id",
    requireAccount,
    (req: AccountReq, res) => {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid_id" });
      db.delete(savedSearches)
        .where(
          and(
            eq(savedSearches.id, id),
            eq(savedSearches.accountUserId, req.accountUser!.id),
          ),
        )
        .run();
      res.json({ ok: true });
    },
  );

  // -- Property notes -------------------------------------------------------
  // One note per (account_user, mls_id). Upsert behavior on PUT.

  app.get("/api/account/notes", requireAccount, (req: AccountReq, res) => {
    const rows = db
      .select()
      .from(accountPropertyNotes)
      .where(eq(accountPropertyNotes.accountUserId, req.accountUser!.id))
      .orderBy(desc(accountPropertyNotes.updatedAt))
      .all();
    res.json({ notes: rows });
  });

  app.get(
    "/api/account/notes/:mlsId",
    requireAccount,
    (req: AccountReq, res) => {
      const mlsId = String(req.params.mlsId);
      const row = db
        .select()
        .from(accountPropertyNotes)
        .where(
          and(
            eq(accountPropertyNotes.accountUserId, req.accountUser!.id),
            eq(accountPropertyNotes.mlsId, mlsId),
          ),
        )
        .get();
      res.json({ note: row ?? null });
    },
  );

  app.put(
    "/api/account/notes/:mlsId",
    requireAccount,
    (req: AccountReq, res) => {
      const mlsId = String(req.params.mlsId);
      const note = String(req.body?.note || "").trim();
      if (!note) {
        // Empty body = delete (allows clearing the note via the UI).
        db.delete(accountPropertyNotes)
          .where(
            and(
              eq(accountPropertyNotes.accountUserId, req.accountUser!.id),
              eq(accountPropertyNotes.mlsId, mlsId),
            ),
          )
          .run();
        return res.json({ ok: true, note: null });
      }
      const existing = db
        .select()
        .from(accountPropertyNotes)
        .where(
          and(
            eq(accountPropertyNotes.accountUserId, req.accountUser!.id),
            eq(accountPropertyNotes.mlsId, mlsId),
          ),
        )
        .get();
      if (existing) {
        const updated = db
          .update(accountPropertyNotes)
          .set({ note, updatedAt: nowIso() })
          .where(eq(accountPropertyNotes.id, existing.id))
          .returning()
          .get();
        return res.json({ ok: true, note: updated });
      }
      const inserted = db
        .insert(accountPropertyNotes)
        .values({
          accountUserId: req.accountUser!.id,
          mlsId,
          note,
        } as any)
        .returning()
        .get();
      res.json({ ok: true, note: inserted });
    },
  );

  app.delete(
    "/api/account/notes/:mlsId",
    requireAccount,
    (req: AccountReq, res) => {
      const mlsId = String(req.params.mlsId);
      db.delete(accountPropertyNotes)
        .where(
          and(
            eq(accountPropertyNotes.accountUserId, req.accountUser!.id),
            eq(accountPropertyNotes.mlsId, mlsId),
          ),
        )
        .run();
      res.json({ ok: true });
    },
  );

  // -- Tour requests --------------------------------------------------------
  // Portal users create rows in the existing `tours` table. Spencer manages
  // them through the admin /admin/calendar view; status flows
  // requested → confirmed (or cancelled) → completed.

  app.get("/api/account/tours", requireAccount, (req: AccountReq, res) => {
    const userLeadId = req.accountUser!.leadId;
    const rows = db
      .select()
      .from(tours)
      .where(eq(tours.leadId, userLeadId))
      .orderBy(desc(tours.createdAt))
      .all();
    res.json({ tours: rows });
  });

  app.post("/api/account/tours", requireAccount, async (req: AccountReq, res) => {
    const mlsId = String(req.body?.mlsId || "").trim();
    const preferredAt = String(req.body?.preferredAt || "").trim();
    const notes = String(req.body?.notes || "").trim();
    if (!mlsId) return res.status(400).json({ error: "missing_mlsId" });
    if (!preferredAt) return res.status(400).json({ error: "missing_preferredAt" });

    const row = db
      .insert(tours)
      .values({
        listingId: mlsId,
        leadId: req.accountUser!.leadId,
        scheduledFor: preferredAt,
        status: "requested",
        notes: notes || null,
      } as any)
      .returning()
      .get();

    // Notify Spencer. Best-effort — don't fail the request if mail fails.
    try {
      const notifyTo = process.env.SPENCER_NOTIFY_EMAIL || "spencer@riversrealestate.ca";
      let address = mlsId;
      try {
        const listing = storage.getMlsListingById(mlsId);
        if (listing?.fullAddress) address = listing.fullAddress;
      } catch {}
      const when = new Date(preferredAt).toLocaleString("en-CA", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const userEmail = req.accountUser!.email;
      const userName = req.accountUser!.name || userEmail;
      const subject = `Tour request: ${address}`;
      const html =
        `<div style="font-family:'Manrope',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0a0a0a;line-height:1.55;">` +
        `<p style="font-family:'Playfair Display',Georgia,serif;font-size:22px;margin:0 0 12px;">New tour request</p>` +
        `<p style="margin:0 0 8px;"><strong>Property:</strong> ${address}</p>` +
        `<p style="margin:0 0 8px;"><strong>Preferred:</strong> ${when}</p>` +
        `<p style="margin:0 0 8px;"><strong>From:</strong> ${userName} &lt;${userEmail}&gt;</p>` +
        (notes ? `<p style="margin:12px 0;padding:12px;background:#fafafa;border-left:3px solid #D4AF37;"><em>${notes.replace(/</g,"&lt;")}</em></p>` : "") +
        `<p style="margin:18px 0;"><a href="https://riversrealestate.ca/admin/calendar" style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#fff;text-decoration:none;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;">REVIEW IN ADMIN</a></p>` +
        `</div>`;
      const text = `New tour request\n\nProperty: ${address}\nPreferred: ${when}\nFrom: ${userName} <${userEmail}>${notes ? `\n\nNotes: ${notes}` : ""}\n\nReview: https://riversrealestate.ca/admin/calendar`;
      await sendEmail({ to: notifyTo, subject, html, text, replyTo: userEmail });
    } catch (e) {
      console.error("[account] tour-request notify failed:", e);
    }

    res.json({ ok: true, tour: row });
  });

  app.delete(
    "/api/account/tours/:id",
    requireAccount,
    (req: AccountReq, res) => {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid_id" });
      // Only allow cancelling — preserves audit trail.
      const existing = db
        .select()
        .from(tours)
        .where(
          and(
            eq(tours.id, id),
            eq(tours.leadId, req.accountUser!.leadId),
          ),
        )
        .get();
      if (!existing) return res.status(404).json({ error: "not_found" });
      db.update(tours)
        .set({ status: "cancelled" })
        .where(eq(tours.id, id))
        .run();
      res.json({ ok: true });
    },
  );

  // -- Market report subscriptions ------------------------------------------
  // Users subscribe to receive periodic neighbourhood digests (new listings,
  // price reductions, sold comparables) on a chosen cadence. The actual
  // sending lives in server/market-report-cron.ts (existing lead-alert
  // infrastructure reuses sendEmail). These endpoints just manage the subs.

  app.get(
    "/api/account/market-reports",
    requireAccount,
    (req: AccountReq, res) => {
      const rows = db
        .select()
        .from(accountMarketReportSubs)
        .where(eq(accountMarketReportSubs.accountUserId, req.accountUser!.id))
        .orderBy(desc(accountMarketReportSubs.createdAt))
        .all();
      res.json({ subs: rows });
    },
  );

  app.post(
    "/api/account/market-reports",
    requireAccount,
    (req: AccountReq, res) => {
      const neighbourhoodSlug = (req.body?.neighbourhoodSlug ?? "")
        .toString()
        .trim() || null;
      const frequency = String(req.body?.frequency || "weekly");
      if (!["daily", "weekly", "monthly"].includes(frequency)) {
        return res.status(400).json({ error: "invalid_frequency" });
      }
      // Prevent duplicate (user, neighbourhood) pairs.
      const existing = db
        .select()
        .from(accountMarketReportSubs)
        .where(
          and(
            eq(accountMarketReportSubs.accountUserId, req.accountUser!.id),
            neighbourhoodSlug
              ? eq(accountMarketReportSubs.neighbourhoodSlug, neighbourhoodSlug)
              : eq(accountMarketReportSubs.neighbourhoodSlug, ""),
          ),
        )
        .get();
      if (existing) {
        const updated = db
          .update(accountMarketReportSubs)
          .set({ frequency, active: true })
          .where(eq(accountMarketReportSubs.id, existing.id))
          .returning()
          .get();
        return res.json({ ok: true, sub: updated });
      }
      const row = db
        .insert(accountMarketReportSubs)
        .values({
          accountUserId: req.accountUser!.id,
          neighbourhoodSlug,
          frequency,
          active: true,
        } as any)
        .returning()
        .get();
      res.json({ ok: true, sub: row });
    },
  );

  app.patch(
    "/api/account/market-reports/:id",
    requireAccount,
    (req: AccountReq, res) => {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid_id" });
      const existing = db
        .select()
        .from(accountMarketReportSubs)
        .where(
          and(
            eq(accountMarketReportSubs.id, id),
            eq(accountMarketReportSubs.accountUserId, req.accountUser!.id),
          ),
        )
        .get();
      if (!existing) return res.status(404).json({ error: "not_found" });
      const patch: any = {};
      if (typeof req.body?.frequency === "string" &&
          ["daily", "weekly", "monthly"].includes(req.body.frequency)) {
        patch.frequency = req.body.frequency;
      }
      if (typeof req.body?.active === "boolean") patch.active = req.body.active;
      if (Object.keys(patch).length === 0) return res.json({ ok: true, sub: existing });
      const updated = db
        .update(accountMarketReportSubs)
        .set(patch)
        .where(eq(accountMarketReportSubs.id, id))
        .returning()
        .get();
      res.json({ ok: true, sub: updated });
    },
  );

  app.delete(
    "/api/account/market-reports/:id",
    requireAccount,
    (req: AccountReq, res) => {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid_id" });
      db.delete(accountMarketReportSubs)
        .where(
          and(
            eq(accountMarketReportSubs.id, id),
            eq(accountMarketReportSubs.accountUserId, req.accountUser!.id),
          ),
        )
        .run();
      res.json({ ok: true });
    },
  );
}
