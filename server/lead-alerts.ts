// New-lead alerts: a text to Spencer's cell the moment a lead comes in, the
// way Follow Up Boss's app buzzes his phone.
//
// Sent from the business line to AGENT_CELL_NUMBER (sms.ts), so they arrive in
// the same thread as forwarded client texts. An alert never changes who his
// replies go to (the relay's reply target): replying to the thread after an
// alert must not text the new lead by surprise mid-conversation with someone
// else. The alert shows the lead's number to tap, and "number: message"
// texts them through the business line as always.
//
// What alerts:
//   - every enquiry the app takes (website forms, bookings, portal sign-ups,
//     lead-source emails): one alert per enquiry, so a past contact enquiring
//     again is flagged too. Hooked in at storage.onLeadCreated (contacts.ts).
//   - people Follow Up Boss brings in that never touched the app (its own
//     lead sources), once each, when the sync first sees them, if they were
//     created after alerts were switched on and within the last day.
//
// Quiet hours (optional, 10 pm to 7 am Calgary): alerts wait and go out at
// 7 am. Bursts (more than 6 in an hour, e.g. a backlog of lead emails) are
// rolled into a single "N more new leads" text instead of a run of them.
//
// Every alert is kept in new_lead_texts. Its contact column moves with the
// contact when the app's copy of a lead is folded into FUB's (contacts.ts),
// so the FUB copy arriving later doesn't alert a second time.

import { sqlite } from "./storage";
import { publicOrigin } from "./origin";
import { prettyPhone, sendSms, smsConfig, smsConfigured, toE164 } from "./sms";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS new_lead_text_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    quiet_hours INTEGER NOT NULL DEFAULT 0,
    enabled_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS new_lead_texts (
    key TEXT PRIMARY KEY,                -- "lead:<id>" or "contact:<fubId>"
    contact_fub_id TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL,                -- sent | held | burst | summarized | failed | off
    error TEXT,
    created_at TEXT NOT NULL,
    send_after TEXT,
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_new_lead_texts_contact ON new_lead_texts(contact_fub_id);
  CREATE INDEX IF NOT EXISTS idx_new_lead_texts_status ON new_lead_texts(status, send_after);
`);

const TZ = "America/Edmonton";
const QUIET_START = 22; // 10 pm
const QUIET_END = 7; // 7 am
const BURST_PER_HOUR = 6;

// ---- Settings -------------------------------------------------------------------------

export interface AlertSettings {
  enabled: boolean;
  quietHours: boolean;
  enabledAt: string;
}

export function alertSettings(): AlertSettings {
  let r = sqlite.prepare(`SELECT enabled, quiet_hours, enabled_at FROM new_lead_text_settings WHERE id = 1`).get() as any;
  if (!r) {
    // On by default from the moment this first runs: nothing earlier alerts.
    sqlite.prepare(`INSERT OR IGNORE INTO new_lead_text_settings (id, enabled, quiet_hours, enabled_at) VALUES (1, 1, 0, ?)`).run(new Date().toISOString());
    r = sqlite.prepare(`SELECT enabled, quiet_hours, enabled_at FROM new_lead_text_settings WHERE id = 1`).get();
  }
  return { enabled: !!r.enabled, quietHours: !!r.quiet_hours, enabledAt: r.enabled_at };
}

export function saveAlertSettings(patch: Partial<Pick<AlertSettings, "enabled" | "quietHours">>): AlertSettings {
  const cur = alertSettings();
  const enabled = patch.enabled ?? cur.enabled;
  // Switching back on starts a new window, so FUB leads from while it was off don't flood in.
  const enabledAt = enabled && !cur.enabled ? new Date().toISOString() : cur.enabledAt;
  sqlite
    .prepare(`UPDATE new_lead_text_settings SET enabled = ?, quiet_hours = ?, enabled_at = ? WHERE id = 1`)
    .run(enabled ? 1 : 0, (patch.quietHours ?? cur.quietHours) ? 1 : 0, enabledAt);
  return alertSettings();
}

// ---- Time ------------------------------------------------------------------------------

/** The hour in Calgary, 0–23. */
function calgaryHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d));
}

export function inQuietHours(d: Date): boolean {
  const h = calgaryHour(d);
  return h >= QUIET_START || h < QUIET_END;
}

/** The next 7 am Calgary time at or after `d`. */
export function nextMorning(d: Date): Date {
  // Step forward a quarter hour at a time to the first moment out of quiet hours,
  // then back to the top of that hour. Works across daylight-saving changes.
  let t = new Date(d.getTime());
  for (let i = 0; i < 4 * 24 && inQuietHours(t); i++) t = new Date(t.getTime() + 15 * 60_000);
  const mins = Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, minute: "numeric" }).format(t));
  return new Date(t.getTime() - mins * 60_000 - t.getSeconds() * 1000 - t.getMilliseconds());
}

// ---- The message ---------------------------------------------------------------------------

export interface AlertFacts {
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  message?: string | null;
  contactId?: string | null;
  again?: boolean;
}

function excerpt(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

/** The alert text. Kept short enough for one or two SMS segments where it can. */
export function alertBody(f: AlertFacts): string {
  const phone = toE164(f.phone);
  const lines = [
    `${f.again ? "Enquiry again" : "New lead"}${f.source ? ` · ${f.source}` : ""}`,
    [f.name?.trim() || "No name", phone ? prettyPhone(phone) : null, f.email?.trim() || null].filter(Boolean).join(" · "),
  ];
  if (f.message?.trim()) lines.push(`"${excerpt(f.message, 180)}"`);
  if (f.contactId) lines.push(`${publicOrigin()}/admin/crm?contact=${encodeURIComponent(f.contactId)}`);
  if (phone) lines.push(`Text them: reply "${phone.replace(/^\+1/, "")}: your message"`);
  return lines.join("\n");
}

// ---- Sending ----------------------------------------------------------------------------------

function recordAlert(key: string, contactId: string | null, body: string, status: string, extra: { error?: string | null; sendAfter?: string | null; sentAt?: string | null } = {}) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO new_lead_texts (key, contact_fub_id, body, status, error, created_at, send_after, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(key, contactId, body, status, extra.error ?? null, new Date().toISOString(), extra.sendAfter ?? null, extra.sentAt ?? null);
}

function sentInLastHour(now: Date): number {
  return (
    sqlite.prepare(`SELECT COUNT(*) AS n FROM new_lead_texts WHERE status IN ('sent', 'burst') AND created_at >= ?`).get(new Date(now.getTime() - 3600_000).toISOString()) as {
      n: number;
    }
  ).n;
}

async function deliver(key: string, body: string): Promise<boolean> {
  const cfg = smsConfig();
  const r = await sendSms(cfg.agentCell!, body, { kind: "alert" });
  sqlite
    .prepare(`UPDATE new_lead_texts SET status = ?, error = ?, sent_at = ? WHERE key = ?`)
    .run(r.ok ? "sent" : "failed", r.ok ? null : r.error ?? "send failed", r.ok ? new Date().toISOString() : null, key);
  return r.ok;
}

/**
 * Alert for one lead, now or later. Returns what happened: "sent", "held"
 * (quiet hours), "burst" (rolled into a summary), "off", "unconfigured",
 * "duplicate" or "failed".
 */
export async function queueAlert(key: string, facts: AlertFacts, now = new Date()): Promise<string> {
  if (sqlite.prepare(`SELECT 1 FROM new_lead_texts WHERE key = ?`).get(key)) return "duplicate";
  const settings = alertSettings();
  const body = alertBody(facts);
  const contactId = facts.contactId ?? null;
  if (!settings.enabled) {
    recordAlert(key, contactId, body, "off");
    return "off";
  }
  const cfg = smsConfig();
  if (!smsConfigured().ok || !cfg.agentCell) {
    recordAlert(key, contactId, body, "failed", { error: "Texting isn't set up (Twilio or AGENT_CELL_NUMBER missing)" });
    return "unconfigured";
  }
  if (settings.quietHours && inQuietHours(now)) {
    recordAlert(key, contactId, body, "held", { sendAfter: nextMorning(now).toISOString() });
    return "held";
  }
  if (sentInLastHour(now) >= BURST_PER_HOUR) {
    recordAlert(key, contactId, body, "burst");
    return "burst";
  }
  recordAlert(key, contactId, body, "sending");
  return (await deliver(key, body)) ? "sent" : "failed";
}

/** An enquiry the app just took (storage.onLeadCreated). */
export async function alertForLead(
  lead: { id: number; name: string | null; email: string | null; phone: string | null; message: string | null; source: string | null },
  contactId: string,
  wasNewContact: boolean,
): Promise<string> {
  return queueAlert(`lead:${lead.id}`, {
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
    message: lead.message,
    contactId,
    again: !wasNewContact,
  });
}

/**
 * After a Follow Up Boss people sync: new people FUB has that the app never
 * alerted about (its own lead sources). Once each; only those created after
 * alerts were switched on and within the last day, so a first sync or a long
 * outage doesn't send hundreds.
 */
export async function alertForSyncedContacts(now = new Date()): Promise<number> {
  const s = alertSettings();
  if (!s.enabled) return 0;
  const since = [s.enabledAt, new Date(now.getTime() - 86400_000).toISOString()].sort().pop()!;
  const rows = sqlite
    .prepare(
      `SELECT fub_id AS id, name, email, phone, source FROM crm_contacts
       WHERE fub_id NOT LIKE 'app-%' AND fub_created_at >= ?
         AND fub_id NOT IN (SELECT contact_fub_id FROM new_lead_texts WHERE contact_fub_id IS NOT NULL)
       ORDER BY fub_created_at LIMIT 50`,
    )
    .all(since) as Array<{ id: string; name: string | null; email: string | null; phone: string | null; source: string | null }>;
  let n = 0;
  for (const r of rows) {
    const out = await queueAlert(`contact:${r.id}`, { name: r.name, phone: r.phone, email: r.email, source: r.source ? `${r.source} (via Follow Up Boss)` : "Follow Up Boss", contactId: r.id }, now);
    if (out === "sent" || out === "held" || out === "burst") n++;
  }
  return n;
}

/**
 * Send what's waiting: alerts held for quiet hours whose time has come, and
 * one summary for any burst. Runs every few minutes (startLeadAlertCron).
 */
export async function flushAlerts(now = new Date()): Promise<{ sent: number; summarized: number }> {
  const s = alertSettings();
  let sent = 0;
  const due = sqlite
    .prepare(`SELECT key, body FROM new_lead_texts WHERE status = 'held' AND send_after <= ? ORDER BY created_at`)
    .all(now.toISOString()) as Array<{ key: string; body: string }>;
  if (due.length && (!s.quietHours || !inQuietHours(now))) {
    if (due.length > BURST_PER_HOUR) {
      // A night's worth: one text listing them.
      const names = due.map((d) => d.body.split("\n")[1]?.split(" · ")[0]).filter(Boolean);
      const body = `${due.length} new leads overnight: ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}\n${publicOrigin()}/admin/leads`;
      const r = await sendSms(smsConfig().agentCell!, body, { kind: "alert" });
      sqlite.prepare(`UPDATE new_lead_texts SET status = ?, sent_at = ? WHERE key IN (${due.map(() => "?").join(",")})`).run(r.ok ? "summarized" : "failed", r.ok ? now.toISOString() : null, ...due.map((d) => d.key));
      if (r.ok) sent++;
    } else {
      for (const d of due) if (await deliver(d.key, d.body)) sent++;
    }
  }
  let summarized = 0;
  const burst = sqlite.prepare(`SELECT key, body FROM new_lead_texts WHERE status = 'burst' ORDER BY created_at`).all() as Array<{ key: string; body: string }>;
  if (burst.length) {
    const names = burst.map((d) => d.body.split("\n")[1]?.split(" · ")[0]).filter(Boolean);
    const body = `${burst.length} more new lead${burst.length === 1 ? "" : "s"}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}\n${publicOrigin()}/admin/leads`;
    const r = await sendSms(smsConfig().agentCell!, body, { kind: "alert" });
    if (r.ok) {
      sqlite.prepare(`UPDATE new_lead_texts SET status = 'summarized', sent_at = ? WHERE key IN (${burst.map(() => "?").join(",")})`).run(now.toISOString(), ...burst.map((d) => d.key));
      summarized = burst.length;
    }
  }
  return { sent, summarized };
}

export function recentAlerts(limit = 20) {
  return sqlite
    .prepare(
      `SELECT a.key, a.contact_fub_id AS contactFubId, c.name AS contactName, a.status, a.error, a.created_at AS createdAt, a.send_after AS sendAfter, a.sent_at AS sentAt
       FROM new_lead_texts a LEFT JOIN crm_contacts c ON c.fub_id = a.contact_fub_id ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(limit);
}

/** A sample alert to the cell, to check it arrives. */
export async function sendTestAlert(): Promise<{ ok: boolean; error?: string }> {
  const cfg = smsConfig();
  if (!smsConfigured().ok || !cfg.agentCell) return { ok: false, error: "Texting isn't set up (Twilio or AGENT_CELL_NUMBER missing)" };
  return sendSms(
    cfg.agentCell,
    "Test alert. " + alertBody({ name: "Jane Example", phone: "4035550100", email: "jane@example.com", source: "Website · Contact", message: "Is the Aspen Woods home still available? Could we see it Saturday?" }),
    { kind: "alert" },
  );
}

let timer: NodeJS.Timeout | null = null;
export function startNewLeadTextCron() {
  if (timer) return;
  timer = setInterval(() => {
    flushAlerts().catch((e) => console.warn("[lead-alerts] flush failed:", e?.message ?? e));
  }, 5 * 60_000);
  timer.unref?.();
}

// For storage-level checks in tests.
export function alertRow(key: string) {
  return sqlite.prepare(`SELECT * FROM new_lead_texts WHERE key = ?`).get(key) as any;
}

