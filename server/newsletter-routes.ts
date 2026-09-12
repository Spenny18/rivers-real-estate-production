// Newsletter routes.
//
// Public: the unsubscribe page every issue links to, a subscribe endpoint for
// the site's forms, and the Resend webhook that reports bounces and spam
// complaints. Admin (behind requireAuth): the list, the issues, previews,
// test sends and the send button.

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { AGENT } from "./brand";
import { publicOrigin } from "./origin";
import { isValidPeriod } from "./market-report";
import { defaultReportPeriod } from "./market-report-render";
import {
  applyResendEvent,
  buildRenderContext,
  ensureDraft,
  getSendProgress,
  newsletterConfigured,
  previewIssue,
  rowsFromCsv,
  sendIssue,
  sendTest,
  toIssueView,
  unsubscribeByToken,
  verifyResendSignature,
} from "./newsletter";
import { parseIssueContent } from "./newsletter-template";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;
type RateLimit = (opts: { windowMs: number; max: number; key: string }) => Middleware;

const STATUSES = ["subscribed", "unsubscribed", "bounced", "complained"] as const;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A small standalone page, styled like the newsletter, for the unsubscribe flow. */
function page(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)} · ${esc(AGENT.business)}</title>` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Montserrat:wght@400;700&display=swap">` +
    `<style>body{margin:0;background:#F4F4F4;font-family:Montserrat,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#666;}` +
    `.card{max-width:520px;margin:48px auto;background:#fff;border:1px solid #E4E4E4;padding:40px 36px;text-align:center;}` +
    `h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:28px;letter-spacing:.08em;text-transform:uppercase;color:#000;margin:0 0 16px;}` +
    `p{font-size:14px;line-height:1.7;margin:0 0 16px;}` +
    `button,a.btn{display:inline-block;background:#000;color:#fff;border:0;padding:14px 28px;font:700 11px Montserrat,Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;text-decoration:none;}` +
    `small{display:block;margin-top:24px;font-size:11px;color:#999;line-height:1.6;}</style></head>` +
    `<body><div class="card"><div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:#999;margin-bottom:18px;">${esc(AGENT.business)}</div>${body}` +
    `<small>${esc(AGENT.name)} · ${esc(AGENT.brokerage)}<br>${esc(AGENT.address)}</small></div></body></html>`
  );
}

export function registerNewsletterRoutes(app: Express, deps: { requireAuth: Middleware; rateLimit: RateLimit }) {
  const { requireAuth, rateLimit } = deps;

  // ---- Public ------------------------------------------------------------------

  app.get("/newsletter/unsubscribe", (req, res) => {
    const token = String(req.query.t ?? "");
    const s = storage.getNewsletterSubscriberByToken(token);
    res.type("html");
    if (!s) {
      return res.status(404).send(
        page(
          "Link not recognised",
          `<h1>Link not recognised</h1><p>This unsubscribe link isn't one I sent, or it has already been used. If you'd like to stop receiving the market update, email <a href="mailto:${esc(AGENT.email)}">${esc(AGENT.email)}</a> and I'll take you off the list myself.</p>`,
        ),
      );
    }
    if (s.status !== "subscribed") {
      return res.send(page("Already unsubscribed", `<h1>You're off the list</h1><p>${esc(s.email)} no longer receives the Calgary market update.</p>`));
    }
    res.send(
      page(
        "Unsubscribe",
        `<h1>Unsubscribe</h1><p>Stop sending the monthly Calgary market update to <strong>${esc(s.email)}</strong>?</p>` +
          `<form method="post" action="/newsletter/unsubscribe?t=${encodeURIComponent(token)}"><button type="submit">Yes, unsubscribe me</button></form>` +
          `<p style="margin-top:20px;font-size:12px;">Changed your mind? Just close this page.</p>`,
      ),
    );
  });

  // The confirm button and RFC 8058 one-click both land here.
  app.post("/newsletter/unsubscribe", (req, res) => {
    const token = String(req.query.t ?? "");
    const s = unsubscribeByToken(token, "Unsubscribe link");
    res.type("html");
    if (!s) return res.status(404).send(page("Link not recognised", `<h1>Link not recognised</h1><p>This unsubscribe link isn't one I sent.</p>`));
    res.send(
      page(
        "Unsubscribed",
        `<h1>Done</h1><p>${esc(s.email)} won't receive the Calgary market update again. Sorry to see you go — if it was the volume, I only ever send one a month.</p>` +
          `<a class="btn" href="${esc(publicOrigin())}">Back to the site</a>`,
      ),
    );
  });

  app.post(
    "/api/newsletter/subscribe",
    rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: "newsletter-subscribe" }),
    (req, res) => {
      const b = req.body ?? {};
      if (typeof b.website === "string" && b.website.trim()) return res.json({ ok: true }); // honeypot
      const email = String(b.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ message: "Please enter a valid email address." });
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
      const existing = storage.getNewsletterSubscriberByEmail(email);
      if (existing && existing.status !== "subscribed") {
        // Someone who left and signs up again has given fresh consent.
        storage.setNewsletterSubscriberStatus(existing.id, "subscribed", `Re-subscribed via website form (${ip})`);
      }
      storage.upsertNewsletterSubscribers([
        {
          email,
          firstName: String(b.firstName ?? "").slice(0, 80),
          lastName: String(b.lastName ?? "").slice(0, 80),
          source: "website",
          consentSource: `Website form${ip ? ` from ${ip}` : ""}`,
          consentAt: new Date().toISOString(),
        },
      ]);
      res.json({ ok: true });
    },
  );

  app.post("/api/newsletter/webhooks/resend", (req, res) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ message: "RESEND_WEBHOOK_SECRET not set" });
    const raw = (req as any).rawBody as Buffer | undefined;
    const ok =
      !!raw &&
      verifyResendSignature(raw, {
        id: req.header("svix-id") ?? undefined,
        timestamp: req.header("svix-timestamp") ?? undefined,
        signature: req.header("svix-signature") ?? undefined,
      }, secret);
    if (!ok) return res.status(401).json({ message: "Bad signature" });
    const r = applyResendEvent(req.body);
    if (r.handled) console.log(`[newsletter] webhook ${req.body?.type}: ${r.note}`);
    res.json({ ok: true, ...r });
  });

  // ---- Admin: overview ---------------------------------------------------------

  app.get("/api/admin/newsletter", requireAuth, (_req, res) => {
    res.json({
      counts: storage.countNewsletterSubscribers(),
      issues: storage.listNewsletterIssues().map(toIssueView),
      progress: getSendProgress(),
      configured: newsletterConfigured(),
      origin: publicOrigin(),
      defaultPeriod: defaultReportPeriod(),
    });
  });

  // ---- Admin: subscribers ------------------------------------------------------

  app.get("/api/admin/newsletter/subscribers", requireAuth, (req, res) => {
    const q = req.query.q ? String(req.query.q).trim() : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    if (status && !(STATUSES as readonly string[]).includes(status)) return res.status(400).json({ message: "unknown status" });
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    res.json({
      rows: storage.listNewsletterSubscribers({ q, status, limit: 100, offset }),
      counts: storage.countNewsletterSubscribers(),
    });
  });

  app.get("/api/admin/newsletter/subscribers.csv", requireAuth, (_req, res) => {
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["email,first_name,last_name,status,source,consent_source,consent_at,status_reason,status_changed_at,created_at"];
    for (const s of storage.allNewsletterSubscribers()) {
      lines.push([s.email, s.firstName, s.lastName, s.status, s.source, s.consentSource, s.consentAt, s.statusReason, s.statusChangedAt, s.createdAt].map(cell).join(","));
    }
    res.setHeader("Content-Disposition", `attachment; filename="newsletter-subscribers.csv"`);
    res.type("text/csv").send(lines.join("\n"));
  });

  /** Paste or upload a CSV export. Every row is recorded with where consent came from. */
  app.post("/api/admin/newsletter/subscribers/import", requireAuth, (req, res) => {
    const csv = String(req.body?.csv ?? "");
    if (!csv.trim()) return res.status(400).json({ message: "Nothing to import." });
    const source = String(req.body?.source ?? "import").slice(0, 40);
    const consentSource = String(req.body?.consentSource ?? "").trim().slice(0, 300) || `Imported from ${source}`;
    const consentAt = req.body?.consentAt ? String(req.body.consentAt) : null;
    const rows = rowsFromCsv(csv);
    if (!rows.length) return res.status(400).json({ message: "No email addresses found. Is there an email column?" });
    const r = storage.upsertNewsletterSubscribers(rows.map((x) => ({ ...x, source, consentSource, consentAt })));
    res.json({ ok: true, parsed: rows.length, ...r, counts: storage.countNewsletterSubscribers() });
  });

  /** Everyone in the CRM mirror with an email address. */
  app.post("/api/admin/newsletter/subscribers/import-crm", requireAuth, (_req, res) => {
    const contacts = storage.listCrmContacts({ limit: 100_000 }).filter((c) => c.email);
    const r = storage.upsertNewsletterSubscribers(
      contacts.map((c) => ({
        email: c.email!,
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
        source: "crm",
        consentSource: "Existing client or lead in the CRM (Follow Up Boss)",
        consentAt: c.fubCreatedAt ?? null,
      })),
    );
    res.json({ ok: true, parsed: contacts.length, ...r, counts: storage.countNewsletterSubscribers() });
  });

  app.post("/api/admin/newsletter/subscribers", requireAuth, (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ message: "Enter a valid email address." });
    const r = storage.upsertNewsletterSubscribers([
      {
        email,
        firstName: String(req.body?.firstName ?? ""),
        lastName: String(req.body?.lastName ?? ""),
        source: "manual",
        consentSource: String(req.body?.consentSource ?? "").trim().slice(0, 300) || "Added by Spencer in the admin",
        consentAt: new Date().toISOString(),
      },
    ]);
    res.json({ ok: true, ...r, subscriber: storage.getNewsletterSubscriberByEmail(email) });
  });

  app.patch("/api/admin/newsletter/subscribers/:id", requireAuth, (req, res) => {
    const id = Number((req.params as any).id);
    const s = storage.getNewsletterSubscriber(id);
    if (!s) return res.status(404).json({ message: "Not found" });
    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!(STATUSES as readonly string[]).includes(status)) return res.status(400).json({ message: "unknown status" });
      storage.setNewsletterSubscriberStatus(id, status as any, status === "subscribed" ? "Re-subscribed by Spencer in the admin" : "Changed by Spencer in the admin");
    }
    if (req.body?.firstName !== undefined || req.body?.lastName !== undefined) {
      storage.updateNewsletterSubscriber(id, {
        firstName: req.body?.firstName !== undefined ? String(req.body.firstName).trim() : undefined,
        lastName: req.body?.lastName !== undefined ? String(req.body.lastName).trim() : undefined,
      });
    }
    res.json({ ok: true, subscriber: storage.getNewsletterSubscriber(id) });
  });

  app.delete("/api/admin/newsletter/subscribers/:id", requireAuth, (req, res) => {
    storage.deleteNewsletterSubscriber(Number((req.params as any).id));
    res.json({ ok: true, counts: storage.countNewsletterSubscribers() });
  });

  // ---- Admin: issues -----------------------------------------------------------

  app.post("/api/admin/newsletter/issues", requireAuth, (req, res) => {
    const period = req.body?.period ? String(req.body.period) : defaultReportPeriod();
    if (!isValidPeriod(period)) return res.status(400).json({ message: "period must be YYYY-MM" });
    res.json({ ok: true, issue: toIssueView(ensureDraft(period)) });
  });

  app.get("/api/admin/newsletter/issues/:id", requireAuth, (req, res) => {
    const row = storage.getNewsletterIssue(Number((req.params as any).id));
    if (!row) return res.status(404).json({ message: "Not found" });
    const ctx = buildRenderContext(row.period);
    res.json({
      issue: toIssueView(row),
      stats: storage.newsletterSendStats(row.id),
      available: { report: !!ctx.report, commentary: !!(ctx.commentary?.headline || ctx.commentary?.body), reports: ctx.reports.length },
      progress: getSendProgress(),
    });
  });

  app.put("/api/admin/newsletter/issues/:id", requireAuth, (req, res) => {
    const row = storage.getNewsletterIssue(Number((req.params as any).id));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.status === "sending") return res.status(409).json({ message: "This issue is being sent right now." });
    const subject = req.body?.subject !== undefined ? String(req.body.subject).trim().slice(0, 200) : undefined;
    if (subject !== undefined && !subject) return res.status(400).json({ message: "Subject is required." });
    const content = req.body?.content !== undefined ? parseIssueContent(JSON.stringify(req.body.content)) : undefined;
    storage.updateNewsletterIssue(row.id, {
      subject,
      preheader: req.body?.preheader !== undefined ? String(req.body.preheader).trim().slice(0, 300) || null : undefined,
      contentJson: content ? JSON.stringify(content) : undefined,
    });
    res.json({ ok: true, issue: toIssueView(storage.getNewsletterIssue(row.id)!) });
  });

  app.delete("/api/admin/newsletter/issues/:id", requireAuth, (req, res) => {
    const row = storage.getNewsletterIssue(Number((req.params as any).id));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.status === "sending") return res.status(409).json({ message: "This issue is being sent right now." });
    storage.deleteNewsletterIssue(row.id);
    res.json({ ok: true });
  });

  app.get("/api/admin/newsletter/issues/:id/preview", requireAuth, (req, res) => {
    const row = storage.getNewsletterIssue(Number((req.params as any).id));
    if (!row) return res.status(404).json({ message: "Not found" });
    try {
      const p = previewIssue(row);
      if (req.query.format === "html") return res.type("html").send(p.html);
      res.json(p);
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Render failed" });
    }
  });

  app.post("/api/admin/newsletter/issues/:id/test", requireAuth, async (req, res) => {
    const to = String(req.body?.to ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ message: "Enter the address to send the test to." });
    const r = await sendTest(Number((req.params as any).id), to);
    if (!r.ok) return res.status(502).json({ message: r.error ?? "Send failed" });
    res.json({ ok: true });
  });

  app.post("/api/admin/newsletter/issues/:id/schedule", requireAuth, (req, res) => {
    const row = storage.getNewsletterIssue(Number((req.params as any).id));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.status === "sending" || row.status === "sent") return res.status(409).json({ message: `This issue is already ${row.status}.` });
    const at = new Date(String(req.body?.at ?? ""));
    if (Number.isNaN(at.getTime())) return res.status(400).json({ message: "Pick a date and time." });
    if (at.getTime() < Date.now() - 60_000) return res.status(400).json({ message: "That time has already passed." });
    const c = newsletterConfigured();
    if (!c.ok) return res.status(400).json({ message: c.reason });
    if (storage.countNewsletterSubscribers().subscribed === 0) return res.status(400).json({ message: "Nobody is subscribed yet." });
    storage.updateNewsletterIssue(row.id, { status: "scheduled", scheduledFor: at.toISOString() });
    res.json({ ok: true, issue: toIssueView(storage.getNewsletterIssue(row.id)!) });
  });

  app.post("/api/admin/newsletter/issues/:id/unschedule", requireAuth, (req, res) => {
    const row = storage.getNewsletterIssue(Number((req.params as any).id));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.status !== "scheduled") return res.status(409).json({ message: "This issue is not scheduled." });
    storage.updateNewsletterIssue(row.id, { status: "draft", scheduledFor: null });
    res.json({ ok: true, issue: toIssueView(storage.getNewsletterIssue(row.id)!) });
  });

  /** Send now, in the background; poll GET /api/admin/newsletter/progress. */
  app.post("/api/admin/newsletter/issues/:id/send", requireAuth, (req, res) => {
    const row = storage.getNewsletterIssue(Number((req.params as any).id));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.status === "sent" && !req.body?.resend) return res.status(409).json({ message: "This issue has already been sent." });
    if (getSendProgress().running) return res.status(409).json({ message: "A send is already running." });
    const c = newsletterConfigured();
    if (!c.ok) return res.status(400).json({ message: c.reason });
    const already = storage.newsletterSentSubscriberIds(row.id).size;
    const pending = storage.listNewsletterRecipients().length;
    if (pending === 0 && already === 0) return res.status(400).json({ message: "Nobody is subscribed yet." });
    storage.updateNewsletterIssue(row.id, { scheduledFor: null });
    sendIssue(row.id).catch((e) => console.error("[newsletter] send failed:", e));
    res.json({ ok: true, message: "Sending" });
  });

  app.get("/api/admin/newsletter/progress", requireAuth, (_req, res) => {
    const p = getSendProgress();
    res.json({ progress: p, issue: p.issueId ? toIssueView(storage.getNewsletterIssue(p.issueId)!) : null });
  });
}
