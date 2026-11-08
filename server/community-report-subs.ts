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
import { getSmartList, listMembers } from "./smart-lists";

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

  -- A smart list signed up for a community's report: everyone in the list
  -- with an email gets it, worked out again before every send.
  CREATE TABLE IF NOT EXISTS community_report_list_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    smart_list_id INTEGER NOT NULL,
    neighbourhood_slug TEXT NOT NULL,
    cls TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (smart_list_id, neighbourhood_slug, cls)
  );
`);
// Which list subscription a contact's row came from (null: added by hand).
if (!(sqlite.prepare(`PRAGMA table_info(community_report_subs)`).all() as Array<{ name: string }>).some((c) => c.name === "source_list_sub_id")) {
  sqlite.exec(`ALTER TABLE community_report_subs ADD COLUMN source_list_sub_id INTEGER`);
}

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
  /** Set when the row came from a smart list's subscription. */
  sourceListSubId: number | null;
  sourceListName: string | null;
  createdAt: string;
}

const SELECT = `SELECT id, email, name, crm_contact_id AS crmContactId, lead_id AS leadId,
  neighbourhood_slug AS neighbourhoodSlug, cls, active, token, last_sent_period AS lastSentPeriod,
  last_sent_at AS lastSentAt, last_error AS lastError, unsubscribed_at AS unsubscribedAt,
  source_list_sub_id AS sourceListSubId, created_at AS createdAt FROM community_report_subs`;

type Row = Omit<CommunityReportSub, "active" | "neighbourhoodName" | "clsLabel" | "sourceListName"> & { active: number; token: string };

function sourceListName(listSubId: number | null): string | null {
  if (listSubId == null) return null;
  const l = sqlite.prepare(`SELECT smart_list_id AS id FROM community_report_list_subs WHERE id = ?`).get(listSubId) as { id: number } | undefined;
  return l ? (getSmartList(l.id)?.name ?? null) : null;
}

function toSub(r: Row): CommunityReportSub {
  const { token: _token, ...rest } = r;
  return {
    ...rest,
    sourceListName: sourceListName(r.sourceListSubId),
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
  const row = getRow(id);
  if (!row) return false;
  // A row a smart list gave would only come back at the list's next sync, so
  // removing it keeps it, turned off: that's what stops the list re-adding it.
  if (row.sourceListSubId != null) {
    return sqlite.prepare(`UPDATE community_report_subs SET active = 0 WHERE id = ?`).run(id).changes > 0;
  }
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
  // Smart lists change; bring their subscribers up to date first.
  syncAllListSubs();
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
        if (res.status === "sent") {
          out.sent++;
          await pause(SEND_GAP_MS);
        }
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

// ---- Smart lists ------------------------------------------------------------------
//
// A list subscription doesn't send anything itself. Before each send it is
// expanded into ordinary per-contact rows (source_list_sub_id set), so a list
// member gets exactly what a hand-added contact gets: one email a month, an
// unsubscribe link, and a row Spencer can see on their record.
//   - Someone who joins the list gets a row; someone who already has one for
//     that community and class (by hand, or from another list) keeps theirs.
//   - Someone who leaves the list loses the row the list gave them, unless
//     they had unsubscribed: that row stays, so rejoining the list doesn't
//     sign them back up.
//   - Pausing or removing the list subscription does the same for everyone
//     it added.

/** Space between scheduled emails: well inside Resend's per-second limit. */
export const SEND_GAP_MS = 600;
const pause = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export interface ListSub {
  id: number;
  smartListId: number;
  smartListName: string | null;
  neighbourhoodSlug: string;
  neighbourhoodName: string | null;
  cls: ClassFilter;
  clsLabel: string;
  active: boolean;
  createdAt: string;
  /** Rows it currently gives contacts, and how they stand this month. */
  subscribers: number;
  sentThisMonth: number;
  unsubscribed: number;
}

type ListRow = { id: number; smartListId: number; neighbourhoodSlug: string; cls: ClassFilter; active: number; createdAt: string };

const LIST_SELECT = `SELECT id, smart_list_id AS smartListId, neighbourhood_slug AS neighbourhoodSlug, cls, active, created_at AS createdAt
  FROM community_report_list_subs`;

function toListSub(r: ListRow, now = new Date()): ListSub {
  const counts = sqlite
    .prepare(
      `SELECT SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS subscribers,
              SUM(CASE WHEN active = 1 AND last_sent_period = ? THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN active = 0 AND unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsub
         FROM community_report_subs WHERE source_list_sub_id = ?`,
    )
    .get(defaultReportPeriod(now), r.id) as { subscribers: number | null; sent: number | null; unsub: number | null };
  return {
    id: r.id,
    smartListId: r.smartListId,
    smartListName: getSmartList(r.smartListId)?.name ?? null,
    neighbourhoodSlug: r.neighbourhoodSlug,
    neighbourhoodName: storage.getNeighbourhoodBySlug(r.neighbourhoodSlug)?.name ?? null,
    cls: r.cls,
    clsLabel: CLASS_LABEL[r.cls] ?? r.cls,
    active: !!r.active,
    createdAt: r.createdAt,
    subscribers: counts.subscribers ?? 0,
    sentThisMonth: counts.sent ?? 0,
    unsubscribed: counts.unsub ?? 0,
  };
}

export function listListSubs(smartListId?: number): ListSub[] {
  const rows = (smartListId != null
    ? sqlite.prepare(`${LIST_SELECT} WHERE smart_list_id = ? ORDER BY id`).all(smartListId)
    : sqlite.prepare(`${LIST_SELECT} ORDER BY id`).all()) as ListRow[];
  return rows.map((r) => toListSub(r));
}

function getListRow(id: number): ListRow | undefined {
  return sqlite.prepare(`${LIST_SELECT} WHERE id = ?`).get(id) as ListRow | undefined;
}

export function getListSub(id: number): ListSub | null {
  const r = getListRow(id);
  return r ? toListSub(r) : null;
}

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Bring one list subscription's rows in line with who's in the list now. */
export function syncListSub(id: number): { added: number; removed: number } {
  const r = getListRow(id);
  const list = r ? getSmartList(r.smartListId) : null;
  const del = sqlite.prepare(
    `DELETE FROM community_report_subs WHERE source_list_sub_id = ? AND unsubscribed_at IS NULL AND email = ?`,
  );
  if (!r || !r.active || !list) {
    const removed = sqlite
      .prepare(`DELETE FROM community_report_subs WHERE source_list_sub_id = ? AND unsubscribed_at IS NULL`)
      .run(id).changes;
    return { added: 0, removed };
  }
  const members = new Map<string, { fubId: string; name: string | null }>();
  for (const m of listMembers(list.filters)) {
    const email = (m.email ?? "").trim().toLowerCase();
    if (VALID_EMAIL.test(email) && !members.has(email)) members.set(email, m);
  }
  let added = 0;
  let removed = 0;
  const now = new Date().toISOString();
  const exists = sqlite.prepare(`SELECT 1 FROM community_report_subs WHERE email = ? AND neighbourhood_slug = ? AND cls = ?`);
  const insert = sqlite.prepare(
    `INSERT INTO community_report_subs
       (email, name, crm_contact_id, neighbourhood_slug, cls, active, token, source_list_sub_id, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  sqlite.transaction(() => {
    for (const [email, m] of Array.from(members)) {
      if (exists.get(email, r.neighbourhoodSlug, r.cls)) continue;
      insert.run(email, (m.name ?? "").trim() || email, m.fubId, r.neighbourhoodSlug, r.cls, crypto.randomBytes(24).toString("base64url"), id, now);
      added++;
    }
    const mine = sqlite
      .prepare(`SELECT email FROM community_report_subs WHERE source_list_sub_id = ? AND unsubscribed_at IS NULL`)
      .all(id) as Array<{ email: string }>;
    for (const { email } of mine) {
      if (!members.has(email)) removed += del.run(id, email).changes;
    }
  })();
  return { added, removed };
}

export function syncAllListSubs(): void {
  for (const { id } of sqlite.prepare(`SELECT id FROM community_report_list_subs ORDER BY id`).all() as Array<{ id: number }>) {
    try {
      syncListSub(id);
    } catch (e: any) {
      console.error(`[community-report-subs] list sync #${id} failed:`, e?.message ?? e);
    }
  }
}

export function createListSub(input: { smartListId: number; neighbourhoodSlug: string; cls: unknown }):
  | { ok: true; listSub: ListSub; added: number }
  | { ok: false; error: string } {
  if (!getSmartList(input.smartListId)) return { ok: false, error: "List not found" };
  const opts = optionsForNeighbourhood(String(input.neighbourhoodSlug ?? ""));
  if (!opts.ok) return opts;
  const cls = input.cls ?? opts.defaultCls;
  if (!isClassFilter(cls) || !opts.classOptions.some((o) => o.value === cls)) {
    return { ok: false, error: "Choose a property type that sells in this community." };
  }
  sqlite
    .prepare(
      `INSERT INTO community_report_list_subs (smart_list_id, neighbourhood_slug, cls, active, created_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(smart_list_id, neighbourhood_slug, cls) DO UPDATE SET active = 1`,
    )
    .run(input.smartListId, input.neighbourhoodSlug, cls, new Date().toISOString());
  const row = sqlite
    .prepare(`SELECT id FROM community_report_list_subs WHERE smart_list_id = ? AND neighbourhood_slug = ? AND cls = ?`)
    .get(input.smartListId, input.neighbourhoodSlug, cls) as { id: number };
  const { added } = syncListSub(row.id);
  return { ok: true, listSub: getListSub(row.id)!, added };
}

export function setListSubActive(id: number, active: boolean): ListSub | null {
  if (!getListRow(id)) return null;
  sqlite.prepare(`UPDATE community_report_list_subs SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  syncListSub(id);
  return getListSub(id);
}

export function deleteListSub(id: number): boolean {
  if (!getListRow(id)) return false;
  sqlite.prepare(`DELETE FROM community_report_list_subs WHERE id = ?`).run(id);
  syncListSub(id); // the row's gone, so this clears what it added
  // A contact another list also covers gets a row from that list again.
  syncAllListSubs();
  return true;
}

const listSending = new Set<number>();

export function isListSending(id: number): boolean {
  return listSending.has(id);
}

/**
 * Email this month's report now to every subscriber of a list subscription
 * who hasn't had it. Runs in the background; renders the report first if
 * needed. Returns how many it will try.
 */
export function sendListSubNow(id: number, opts: { send?: typeof sendEmail; gapMs?: number } = {}):
  | { ok: true; queued: number; done: Promise<{ sent: number; errors: number }> }
  | { ok: false; error: string } {
  const r = getListRow(id);
  if (!r) return { ok: false, error: "Not found" };
  if (!r.active) return { ok: false, error: "This list's report is paused." };
  if (listSending.has(id)) return { ok: false, error: "Already sending." };
  syncListSub(id);
  const period = defaultReportPeriod();
  // Everyone in the list now, whether their row came from this list, another
  // one, or was added by hand.
  const list = getSmartList(r.smartListId);
  const emails = new Set(
    (list ? listMembers(list.filters) : []).map((m) => (m.email ?? "").trim().toLowerCase()).filter((e) => VALID_EMAIL.test(e)),
  );
  const targets = (
    sqlite
      .prepare(
        `SELECT id, email FROM community_report_subs
          WHERE neighbourhood_slug = ? AND cls = ? AND active = 1 AND coalesce(last_sent_period, '') != ? ORDER BY id`,
      )
      .all(r.neighbourhoodSlug, r.cls, period) as Array<{ id: number; email: string }>
  ).filter((t) => emails.has(t.email));
  listSending.add(id);
  const done = (async () => {
    let sent = 0;
    let errors = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        // Only the first may render; the rest find it stored.
        const res = await sendSub(t.id, { render: i === 0, send: opts.send });
        if (res.status === "sent") sent++;
        else errors++;
        await pause(opts.gapMs ?? SEND_GAP_MS);
      }
    } finally {
      listSending.delete(id);
    }
    console.log(`[community-report-subs] list #${id} send now: sent=${sent} errors=${errors}`);
    return { sent, errors };
  })();
  return { ok: true, queued: targets.length, done };
}

let timer: NodeJS.Timeout | null = null;

export function startCommunityReportSubsCron() {
  if (timer) return;
  timer = setInterval(() => {
    runCommunityReportCycle().catch((e) => console.error("[community-report-subs] uncaught:", e));
  }, 60 * 60 * 1000);
  console.log("[community-report-subs] scheduled hourly");
}
