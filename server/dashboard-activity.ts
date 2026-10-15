// "Recent activity" on the dashboard: what contacts have just done, newest
// first, one row per person — like Follow Up Boss's dashboard feed.
//
// Gathered from what the app already records:
//   web_events      site visits, listing views, sign-ups (the site pixel) and
//                   email opens/clicks (tracked emails) — server/tracking.ts
//   leads           enquiries from any form or lead email
//   account_favorites  listings saved in the client portal
//   sms_messages / inbox_emails  texts and emails they sent Spencer
//
// Spencer's own addresses are left out, so his own browsing and his Sent-folder
// opens don't top the list. Opens that look automated (Apple Mail privacy
// preloading and the like) are left out too.
//
//   GET /api/admin/dashboard/activity?days=30&kind=all|visit|open|click|inquiry|saved|reply

import type { Express, Request, Response, NextFunction } from "express";
import { sqlite, storage } from "./storage";
import { AGENT } from "./brand";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

export type ActivityKind = "visit" | "listing" | "open" | "click" | "signup" | "inquiry" | "saved" | "reply";

export interface ActivityRow {
  key: string;
  contactFubId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  kind: ActivityKind;
  label: string;
  /** Where the activity points, if anywhere: a page path or listing. */
  path: string | null;
  at: string;
  /** How many things they did in the window, of the kinds being shown. */
  count: number;
}

const FILTERS: Record<string, ActivityKind[]> = {
  all: ["visit", "listing", "open", "click", "signup", "inquiry", "saved", "reply"],
  visit: ["visit", "listing", "signup"],
  open: ["open"],
  click: ["click"],
  inquiry: ["inquiry"],
  saved: ["saved"],
  reply: ["reply"],
};

function tableExists(name: string): boolean {
  return !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function ownEmails(): Set<string> {
  const own = new Set<string>([AGENT.email.toLowerCase()]);
  for (const v of [process.env.SPENCER_NOTIFY_EMAIL, process.env.RESEND_FROM_EMAIL]) {
    for (const m of Array.from((v ?? "").matchAll(/[^\s<>,"]+@[^\s<>,"]+/g))) own.add(m[0].toLowerCase());
  }
  const agent = storage.getUserByEmail(AGENT.email);
  const g = agent ? storage.getUserIntegration(agent.id, "google")?.accountEmail : null;
  if (g) own.add(g.toLowerCase());
  return own;
}

function money(n: number | null | undefined): string {
  if (!n) return "";
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 ? 2 : 0).replace(/\.?0+$/, "")}M` : `$${Math.round(n / 1000)}K`;
}

function clip(s: string | null | undefined, n = 90): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

interface Raw {
  email: string | null;
  contactFubId: string | null;
  kind: ActivityKind;
  label: string;
  path: string | null;
  at: string;
}

/** Everything that happened in the window, newest first, before grouping by person. */
function gather(since: string, kinds: Set<ActivityKind>): Raw[] {
  const out: Raw[] = [];
  const want = (k: ActivityKind) => kinds.has(k);

  if (tableExists("web_events") && (want("visit") || want("listing") || want("open") || want("click") || want("signup"))) {
    const rows = sqlite
      .prepare(
        `SELECT e.email, e.kind, e.path, e.title, e.mls_number AS mls, e.props, e.occurred_at AS at,
                m.full_address AS address, m.list_price AS price
         FROM web_events e LEFT JOIN mls_listings m ON m.mls_number = e.mls_number
         WHERE e.email IS NOT NULL AND e.occurred_at >= ?
         ORDER BY e.occurred_at DESC LIMIT 5000`,
      )
      .all(since) as Array<{ email: string; kind: string; path: string | null; title: string | null; mls: string | null; props: string; at: string; address: string | null; price: number | null }>;
    for (const r of rows) {
      const base = { email: r.email.toLowerCase(), contactFubId: null, at: r.at };
      if (r.kind === "pageview" && want("visit")) {
        out.push({ ...base, kind: "visit", label: `Viewed ${clip(r.title || r.path || "the site", 70)}`, path: r.path });
      } else if (r.kind === "listing_view" && want("listing")) {
        const what = r.address ? `${money(r.price)} ${money(r.price) ? "- " : ""}${r.address}` : clip(r.title || r.path || "a listing", 70);
        out.push({ ...base, kind: "listing", label: `Viewed ${what}`, path: r.path });
      } else if (r.kind === "email_open" && want("open")) {
        let automated = false;
        try {
          automated = !!JSON.parse(r.props || "{}").likelyAutomated;
        } catch {
          /* treat as a real open */
        }
        if (!automated) out.push({ ...base, kind: "open", label: `Opened email - ${clip(r.title || "(no subject)", 70)}`, path: null });
      } else if (r.kind === "email_click" && want("click")) {
        out.push({ ...base, kind: "click", label: `Clicked email - ${clip(r.title || "(no subject)", 70)}`, path: r.path });
      } else if (r.kind === "identify" && want("signup")) {
        let via = "";
        try {
          via = String(JSON.parse(r.props || "{}").via ?? "");
        } catch {
          /* no detail */
        }
        out.push({ ...base, kind: "signup", label: via ? `Registered (${clip(via.replace(/[_-]+/g, " "), 40)})` : "Registered", path: null });
      }
    }
  }

  if (want("inquiry")) {
    const rows = sqlite
      .prepare(`SELECT email, phone, source, message, created_at AS at FROM leads WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1000`)
      .all(since) as Array<{ email: string; phone: string | null; source: string; message: string; at: string }>;
    for (const r of rows) {
      const about = r.message?.match(/^About:\s*(.+)$/m)?.[1];
      const what = about ?? clip(r.message?.split("\n").find((l) => l.trim() && !/^\(/.test(l)), 60);
      const email = r.email?.trim().toLowerCase() || null;
      out.push({
        email,
        // Phone-only leads: find their contact by number below.
        contactFubId: email ? null : phoneContact(r.phone),
        kind: "inquiry",
        label: `Inquiry${what ? ` - ${what}` : ""} (${r.source})`,
        path: null,
        at: r.at,
      });
    }
  }

  if (want("saved") && tableExists("account_favorites")) {
    const rows = sqlite
      .prepare(
        `SELECT u.email, f.created_at AS at, m.full_address AS address, m.list_price AS price, f.mls_id AS mls
         FROM account_favorites f JOIN account_users u ON u.id = f.account_user_id
         LEFT JOIN mls_listings m ON m.id = f.mls_id OR m.mls_number = f.mls_id
         WHERE f.created_at >= ? ORDER BY f.created_at DESC LIMIT 1000`,
      )
      .all(since) as Array<{ email: string; at: string; address: string | null; price: number | null; mls: string }>;
    for (const r of rows) {
      const what = r.address ? `${money(r.price)} ${money(r.price) ? "- " : ""}${r.address}` : `listing ${r.mls}`;
      out.push({ email: r.email.toLowerCase(), contactFubId: null, kind: "saved", label: `Saved ${what}`, path: null, at: r.at });
    }
  }

  if (want("reply")) {
    if (tableExists("sms_messages")) {
      const rows = sqlite
        .prepare(
          `SELECT contact_fub_id AS id, body, created_at AS at FROM sms_messages
           WHERE direction = 'inbound' AND contact_fub_id IS NOT NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 1000`,
        )
        .all(since) as Array<{ id: string; body: string; at: string }>;
      for (const r of rows) out.push({ email: null, contactFubId: r.id, kind: "reply", label: `Texted: "${clip(r.body, 60)}"`, path: null, at: r.at });
    }
    if (tableExists("inbox_emails")) {
      const rows = sqlite
        .prepare(
          `SELECT contact_fub_id AS id, subject, occurred_at AS at FROM inbox_emails
           WHERE direction = 'inbound' AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1000`,
        )
        .all(since) as Array<{ id: string; subject: string; at: string }>;
      for (const r of rows) out.push({ email: null, contactFubId: r.id, kind: "reply", label: `Emailed you - ${clip(r.subject, 60)}`, path: null, at: r.at });
    }
  }

  return out.sort((a, b) => b.at.localeCompare(a.at));
}

let phoneIndex: { at: number; map: Map<string, string> } | null = null;
function phoneContact(phone: string | null): string | null {
  const d = (phone ?? "").replace(/\D/g, "").slice(-10);
  if (d.length !== 10) return null;
  if (!phoneIndex || Date.now() - phoneIndex.at > 60_000) {
    const map = new Map<string, string>();
    for (const r of sqlite.prepare(`SELECT fub_id AS id, phone FROM crm_contacts WHERE phone IS NOT NULL AND phone != ''`).all() as Array<{ id: string; phone: string }>) {
      const k = r.phone.replace(/\D/g, "").slice(-10);
      if (k.length === 10 && !map.has(k)) map.set(k, r.id);
    }
    phoneIndex = { at: Date.now(), map };
  }
  return phoneIndex.map.get(d) ?? null;
}

export function recentContactActivity(opts: { days?: number; filter?: string; limit?: number } = {}): ActivityRow[] {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const kinds = new Set(FILTERS[opts.filter ?? "all"] ?? FILTERS.all);
  const own = ownEmails();

  // Contacts by email and by id, for names, phones and stages.
  const byEmail = new Map<string, any>();
  const byId = new Map<string, any>();
  for (const c of sqlite.prepare(`SELECT fub_id, name, email, phone, stage FROM crm_contacts`).all() as any[]) {
    byId.set(c.fub_id, c);
    const e = c.email?.trim().toLowerCase();
    // Prefer FUB's copy over the app's when both exist (as contacts.ts does).
    if (e && (!byEmail.has(e) || String(byEmail.get(e).fub_id).startsWith("app-"))) byEmail.set(e, c);
  }

  const rows = new Map<string, ActivityRow>();
  for (const r of gather(since, kinds)) {
    if (r.email && own.has(r.email)) continue;
    const contact = r.contactFubId ? byId.get(r.contactFubId) : r.email ? byEmail.get(r.email) : null;
    if (contact?.email && own.has(contact.email.trim().toLowerCase())) continue;
    const key = contact ? `c:${contact.fub_id}` : r.email ? `e:${r.email}` : null;
    if (!key) continue;
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    rows.set(key, {
      key,
      contactFubId: contact?.fub_id ?? null,
      name: contact?.name ?? null,
      email: contact?.email ?? r.email,
      phone: contact?.phone ?? null,
      stage: contact?.stage ?? null,
      kind: r.kind,
      label: r.label,
      path: r.path,
      at: r.at,
      count: 1,
    });
  }
  return Array.from(rows.values()).slice(0, Math.min(Math.max(opts.limit ?? 25, 1), 200));
}

export function registerDashboardActivityRoutes(app: Express, deps: { requireAuth: Middleware }) {
  app.get("/api/admin/dashboard/activity", deps.requireAuth, (req, res) => {
    res.json(
      recentContactActivity({
        days: Number(req.query.days) || 30,
        filter: typeof req.query.kind === "string" ? req.query.kind : "all",
        limit: Number(req.query.limit) || 25,
      }),
    );
  });
}
