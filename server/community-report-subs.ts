// Monthly community reports for specific contacts.
//
// Spencer signs a contact up for a community (one of the neighbourhood pages)
// and a property class; every month, once last month's report exists, the
// contact is emailed it — the same email and PDF a visitor gets from the
// neighbourhood page's "email me the full report" form, with an unsubscribe
// link.
//
// Keyed by email rather than by a lead or CRM contact id, so the same
// subscription shows up whether Spencer opens the person from the CRM or
// from website leads; both ids are kept when known.
//
// Timing: the month's report only exists from the 2nd (market-report-store),
// and rendering one is heavy, so a missing report is only rendered inside the
// overnight fill window (neighbourhood-reports.inFillWindow). Emails go out
// during the day (SEND_WINDOW_HOURS, Mountain time). Each subscription
// records the period it last received, so a contact gets each month once,
// however many hourly ticks see it as due.

import crypto from "node:crypto";
import { sqlite, storage } from "./storage";
import { publicOrigin } from "./origin";
import { sendEmail, buildCommunityReportEmailHtml } from "./email";
import { defaultReportPeriod } from "./market-report-render";
import {
  classOptions,
  dominantClass,
  existingReportForClass,
  inFillWindow,
  isClassFilter,
  reportForClass,
  reportScopeForNeighbourhood,
} from "./neighbourhood-reports";
import { CLASS_LABEL, type ClassFilter } from "./market-stats";
import { periodLong } from "./report-pages";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS community_report_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,              -- lower-cased
    name TEXT NOT NULL,
    crm_contact_id TEXT,              -- crm_contacts.fub_id, when added from the CRM
    lead_id INTEGER,                  -- leads.id, when added from website leads
    neighbourhood_slug TEXT NOT NULL,
    cls TEXT NOT NULL,                -- a ClassFilter
    active INTEGER NOT NULL DEFAULT 1,
    token TEXT NOT NULL UNIQUE,       -- for the unsubscribe link
    last_sent_period TEXT,            -- YYYY-MM of the last report emailed
    last_sent_at TEXT,
    last_error TEXT,
    unsubscribed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (email, neighbourhood_slug, cls)
  );
  CREATE INDEX IF NOT EXISTS idx_community_report_subs_email ON community_report_subs(email);
`);

export interface CommunityReportSub {
  id: number;
  email: string;
  name: string;
  crmContactId: string | null;
  leadId: number | null;
  neighbourhoodSlug: string;
  neighbourhoodName: string | null;
  cls: ClassFilter;
  clsLabel: string;
  active: boolean;
  lastSentPeriod: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
}

const SELECT = `SELECT id, email, name, crm_contact_id AS crmContactId, lead_id AS leadId,
  neighbourhood_slug AS neighbourhoodSlug, cls, active, token, last_sent_period AS lastSentPeriod,
  last_sent_at AS lastSentAt, last_error AS lastError, unsubscribed_at AS unsubscribedAt,
  created_at AS createdAt FROM community_report_subs`;

type Row = Omit<CommunityReportSub, "active" | "neighbourhoodName" | "clsLabel"> & { active: number; token: string };

function toSub(r: Row): CommunityReportSub {
  const { token: _token, ...rest } = r;
  return {
    ...rest,
    active: !!r.active,
    neighbourhoodName: storage.getNeighbourhoodBySlug(r.neighbourhoodSlug)?.name ?? null,
    clsLabel: CLASS_LABEL[r.cls] ?? r.cls,
  };
}

function getRow(id: number): Row | undefined {
  return sqlite.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined;
}

export function getSub(id: number): CommunityReportSub | null {
  const r = getRow(id);
  return r ? toSub(r) : null;
}

export function listSubsForEmail(email: string): CommunityReportSub[] {
  return (sqlite.prepare(`${SELECT} WHERE email = ? ORDER BY created_at DESC`).all(email.trim().toLowerCase()) as Row[]).map(toSub);
}

function listActiveRows(): Row[] {
  return sqlite.prepare(`${SELECT} WHERE active = 1 ORDER BY id`).all() as Row[];
}

/** The property classes Spencer can pick for a community, busiest first. */
export function optionsForNeighbourhood(slug: string):
  | { ok: true; name: string; classOptions: Array<{ value: ClassFilter; label: string }>; defaultCls: ClassFilter }
  | { ok: false; error: string } {
  const n = storage.getNeighbourhoodBySlug(slug);
  if (!n) return { ok: false, error: "Neighbourhood not found" };
  const scope = reportScopeForNeighbourhood(n);
  if (!scope) return { ok: false, error: `${n.name} has no sold history to report on yet.` };
  return { ok: true, name: n.name, classOptions: classOptions(scope), defaultCls: dominantClass(scope) };
}

export function createSub(input: {
  email: string;
  name: string;
  neighbourhoodSlug: string;
  cls: unknown;
  crmContactId?: string | null;
  leadId?: number | null;
}): { ok: true; sub: CommunityReportSub } | { ok: false; error: string } {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "This contact has no valid email address." };
  const opts = optionsForNeighbourhood(String(input.neighbourhoodSlug ?? ""));
  if (!opts.ok) return opts;
  const cls = input.cls ?? opts.defaultCls;
  if (!isClassFilter(cls) || !opts.classOptions.some((o) => o.value === cls)) {
    return { ok: false, error: "Choose a property type that sells in this community." };
  }
  const name = String(input.name ?? "").trim().slice(0, 120) || email;
  const existing = sqlite
    .prepare(`SELECT id FROM community_report_subs WHERE email = ? AND neighbourhood_slug = ? AND cls = ?`)
    .get(email, input.neighbourhoodSlug, cls) as { id: number } | undefined;
  if (existing) {
    // Re-adding one they unsubscribed from turns it back on: Spencer is
    // doing this on the contact's say-so.
    sqlite
      .prepare(`UPDATE community_report_subs SET active = 1, unsubscribed_at = NULL, name = ?,
        crm_contact_id = COALESCE(?, crm_contact_id), lead_id = COALESCE(?, lead_id) WHERE id = ?`)
      .run(name, input.crmContactId ?? null, input.leadId ?? null, existing.id);
    return { ok: true, sub: getSub(existing.id)! };
  }
  const info = sqlite
    .prepare(`INSERT INTO community_report_subs
      (email, name, crm_contact_id, lead_id, neighbourhood_slug, cls, active, token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(
      email,
      name,
      input.crmContactId ?? null,
      input.leadId ?? null,
      input.neighbourhoodSlug,
      cls,
      crypto.randomBytes(24).toString("base64url"),
      new Date().toISOString(),
    );
  return { ok: true, sub: getSub(Number(info.lastInsertRowid))! };
}

export function setSubActive(id: number, active: boolean): CommunityReportSub | null {
  sqlite
    .prepare(`UPDATE community_report_subs SET active = ?, unsubscribed_at = CASE WHEN ? = 1 THEN NULL ELSE unsubscribed_at END WHERE id = ?`)
    .run(active ? 1 : 0, active ? 1 : 0, id);
  return getSub(id);
}

export function deleteSub(id: number): boolean {
  return sqlite.prepare(`DELETE FROM community_report_subs WHERE id = ?`).run(id).changes > 0;
}

/** The subscription an unsubscribe token belongs to, without changing it. */
export function findByToken(token: string): CommunityReportSub | null {
  const row = sqlite.prepare(`${SELECT} WHERE token = ?`).get(String(token ?? "")) as Row | undefined;
  return row ? toSub(row) : null;
}

/** The unsubscribe link's target. Returns the subscription it turned off. */
export function unsubscribeByToken(token: string): CommunityReportSub | null {
  const row = sqlite.prepare(`${SELECT} WHERE token = ?`).get(String(token ?? "")) as Row | undefined;
  if (!row) return null;
  if (row.active) {
    sqlite
      .prepare(`UPDATE community_report_subs SET active = 0, unsubscribed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), row.id);
  }
  return getSub(row.id);
}

export function unsubscribeUrl(token: string): string {
  return `${publicOrigin().replace(/\/+$/, "")}/community-report/unsubscribe?t=${encodeURIComponent(token)}`;
}

// ---- Sending ----------------------------------------------------------------

/** Mountain-time hours in which the monthly emails go out: [start, end). */
export const SEND_WINDOW_HOURS = { start: 8, end: 20 };

function edmonton(now: Date): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { day: get("day"), hour: get("hour") };
}

export function inSendWindow(now = new Date()): boolean {
  const { hour } = edmonton(now);
  return hour >= SEND_WINDOW_HOURS.start && hour < SEND_WINDOW_HOURS.end;
}

/** Due when active and not yet sent this month's report, from the 2nd. */
export function isDue(sub: { active: boolean | number; lastSentPeriod: string | null }, now = new Date()): boolean {
  if (!sub.active) return false;
  if (edmonton(now).day < 2) return false;
  return sub.lastSentPeriod !== defaultReportPeriod(now);
}

export interface SendResult {
  status: "sent" | "waiting" | "error";
  error?: string;
  period?: string;
}

type Assembled =
  | { status: "ready"; period: string; email: { to: string; subject: string; html: string; contactFubId: string | null } }
  | { status: "waiting"; period: string }
  | { status: "error"; error: string };

/**
 * The email for one subscription this month. `render` allows rendering the
 * report when it doesn't exist yet (manual sends, previews, the overnight
 * window); otherwise a missing report means "waiting".
 */
async function assemble(row: Row, opts: { render: boolean; now?: Date }): Promise<Assembled> {
  const n = storage.getNeighbourhoodBySlug(row.neighbourhoodSlug);
  if (!n) return { status: "error", error: "That neighbourhood page no longer exists." };
  const scope = reportScopeForNeighbourhood(n);
  if (!scope) return { status: "error", error: `${n.name} has no sold history to report on.` };
  const period = defaultReportPeriod(opts.now);

  let report = existingReportForClass(scope, row.cls, period);
  if (!report) {
    if (!opts.render) return { status: "waiting", period };
    try {
      report = await reportForClass(scope, row.cls);
    } catch (e: any) {
      return { status: "error", error: `Couldn't prepare the report: ${String(e?.message ?? e).slice(0, 200)}` };
    }
  }

  const origin = publicOrigin().replace(/\/+$/, "");
  const periodLabel = periodLong(report.period);
  return {
    status: "ready",
    period: report.period,
    email: {
      to: row.email,
      subject: `${n.name} ${report.subtitle} market report — ${periodLabel}`,
      html: buildCommunityReportEmailHtml({
        recipientName: row.name,
        communityName: n.name,
        subtitle: report.subtitle,
        periodLabel,
        pdfUrl: `${origin}${report.pdfUrl}`,
        previewUrl: `${origin}${report.png1Url}`,
        pageUrl: `${origin}/neighbourhoods/${n.slug}`,
        origin,
        monthly: { unsubscribeUrl: unsubscribeUrl(row.token) },
      }),
      contactFubId: row.crmContactId,
    },
  };
}

/** Email one subscription its community's latest report. */
export async function sendSub(
  id: number,
  opts: { render: boolean; send?: typeof sendEmail; now?: Date } = { render: true },
): Promise<SendResult> {
  const row = getRow(id);
  if (!row) return { status: "error", error: "Subscription not found" };
  const fail = (error: string): SendResult => {
    sqlite.prepare(`UPDATE community_report_subs SET last_error = ? WHERE id = ?`).run(error.slice(0, 500), id);
    return { status: "error", error };
  };
  const a = await assemble(row, opts);
  if (a.status === "error") return fail(a.error);
  if (a.status === "waiting") return { status: "waiting", period: a.period };
  const result = await (opts.send ?? sendEmail)({
    to: a.email.to,
    subject: a.email.subject,
    html: a.email.html,
    replyTo: "spencer@riversrealestate.ca",
    // One email per contact per month adds up; Spencer isn't CC'd on each.
    cc: "",
    track: { kind: "community-report-monthly", contactFubId: a.email.contactFubId },
  });
  if (!result.ok) return fail(result.error ?? "Send failed");
  sqlite
    .prepare(`UPDATE community_report_subs SET last_sent_period = ?, last_sent_at = ?, last_error = NULL WHERE id = ?`)
    .run(a.period, new Date().toISOString(), id);
  return { status: "sent", period: a.period };
}

/** The email a subscription would get this month, without sending it. */
export async function previewSub(id: number): Promise<{ subject: string; html: string } | { error: string }> {
  const row = getRow(id);
  if (!row) return { error: "Subscription not found" };
  const a = await assemble(row, { render: true });
  if (a.status === "error") return { error: a.error };
  if (a.status === "waiting") return { error: "This month's report isn't ready yet." };
  return { subject: a.email.subject, html: a.email.html };
}

let cycleRunning = false;

/**
 * One hourly tick: overnight, render any report a due subscription is
 * waiting on; during the day, send every due subscription whose report
 * exists.
 */
export async function runCommunityReportCycle(now = new Date()): Promise<{ sent: number; rendered: number; errors: number }> {
  const out = { sent: 0, rendered: 0, errors: 0 };
  if (cycleRunning) return out;
  if (storage.mlsHistorySummary().sold === 0) return out;
  const due = listActiveRows().filter((r) => isDue(r, now));
  if (due.length === 0) return out;
  cycleRunning = true;
  try {
    if (inFillWindow(now)) {
      // One render per community + class, however many contacts share it.
      const seen = new Set<string>();
      for (const r of due) {
        const key = `${r.neighbourhoodSlug}|${r.cls}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const n = storage.getNeighbourhoodBySlug(r.neighbourhoodSlug);
        const scope = n ? reportScopeForNeighbourhood(n) : null;
        if (!scope || existingReportForClass(scope, r.cls, defaultReportPeriod(now))) continue;
        try {
          await reportForClass(scope, r.cls);
          out.rendered++;
        } catch (e: any) {
          out.errors++;
          console.error(`[community-report-subs] render failed for ${r.neighbourhoodSlug} ${r.cls}:`, e?.message ?? e);
        }
      }
    } else if (inSendWindow(now)) {
      for (const r of due) {
        const res = await sendSub(r.id, { render: false, now });
        if (res.status === "sent") out.sent++;
        else if (res.status === "error") {
          out.errors++;
          console.error(`[community-report-subs] #${r.id} to ${r.email} failed: ${res.error}`);
        }
      }
    }
  } finally {
    cycleRunning = false;
  }
  if (out.sent || out.rendered || out.errors) {
    console.log(`[community-report-subs] sent=${out.sent} rendered=${out.rendered} errors=${out.errors}`);
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;

export function startCommunityReportSubsCron() {
  if (timer) return;
  timer = setInterval(() => {
    runCommunityReportCycle().catch((e) => console.error("[community-report-subs] uncaught:", e));
  }, 60 * 60 * 1000);
  console.log("[community-report-subs] scheduled hourly");
}
