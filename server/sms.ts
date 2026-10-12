// Text messaging through Spencer's own Twilio number — the replacement for
// texting from Follow Up Boss.
//
// The number clients know is the business line (TWILIO_FROM_NUMBER, the
// (587) 602-5820 number once it's ported out of FUB). Spencer's personal
// cell (AGENT_CELL_NUMBER) never appears to a client. Instead the app relays:
//
//   client -> business line   forwarded to Spencer's cell FROM the business
//                             line, prefixed with who it's from
//   Spencer's cell -> business line
//                             a reply: relayed to the client FROM the
//                             business line (to whoever texted last, or to an
//                             explicit "4035551234: message")
//
// so on his iPhone the business line reads as one thread he can answer, and
// clients only ever see 5820. Every message, either way, is kept in
// sms_messages and logged on the client's CRM record as a text.
//
// Env:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN  from the Twilio console
//   TWILIO_FROM_NUMBER    the business line, e.g. +15876025820
//   AGENT_CELL_NUMBER     where texts and calls are forwarded, e.g. +14039669237

import { createHmac, timingSafeEqual } from "node:crypto";
import { sqlite, storage } from "./storage";
import { publicOrigin } from "./origin";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sms_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,          -- inbound | outbound
    kind TEXT NOT NULL,               -- client | relay | forward | reminder | test
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    body TEXT NOT NULL,
    twilio_sid TEXT,
    status TEXT,
    error TEXT,
    contact_fub_id TEXT,
    tour_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sms_messages_time ON sms_messages(created_at DESC);

  -- Who Spencer is replying to when he answers a forwarded text.
  CREATE TABLE IF NOT EXISTS sms_relay_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// ---- Configuration -------------------------------------------------------------

/** E.164 for North American numbers: "(587) 602-5820" -> "+15876025820". */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "(587) 602-5820" for display. */
export function prettyPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function smsConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    from: toE164(process.env.TWILIO_FROM_NUMBER),
    agentCell: toE164(process.env.AGENT_CELL_NUMBER),
  };
}

export function smsConfigured(): { ok: boolean; missing: string[] } {
  const c = smsConfig();
  const missing = [
    !c.accountSid && "TWILIO_ACCOUNT_SID",
    !c.authToken && "TWILIO_AUTH_TOKEN",
    !c.from && "TWILIO_FROM_NUMBER",
  ].filter(Boolean) as string[];
  return { ok: missing.length === 0, missing };
}

// ---- Sending ----------------------------------------------------------------------

export interface SmsLogFields {
  kind: "client" | "relay" | "forward" | "reminder" | "test";
  contactFubId?: string | null;
  tourId?: number | null;
}

function logMessage(row: {
  direction: "inbound" | "outbound";
  kind: string;
  from: string;
  to: string;
  body: string;
  sid?: string | null;
  status?: string | null;
  error?: string | null;
  contactFubId?: string | null;
  tourId?: number | null;
}): number {
  const r = sqlite
    .prepare(
      `INSERT INTO sms_messages (direction, kind, from_number, to_number, body, twilio_sid, status, error, contact_fub_id, tour_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.direction,
      row.kind,
      row.from,
      row.to,
      row.body.slice(0, 2000),
      row.sid ?? null,
      row.status ?? null,
      row.error ?? null,
      row.contactFubId ?? null,
      row.tourId ?? null,
      new Date().toISOString(),
    );
  return Number(r.lastInsertRowid);
}

/**
 * Put a client conversation on their CRM record, next to the texts mirrored
 * from Follow Up Boss, so the history reads as one thread.
 */
function logOnContact(contactFubId: string | null | undefined, direction: "inbound" | "outbound", body: string, sid: string | null) {
  if (!contactFubId) return;
  const now = new Date().toISOString();
  storage.upsertCrmActivities([
    {
      uid: `text:twilio:${sid ?? `${direction}-${now}`}`,
      kind: "text",
      fubId: null,
      contactFubId,
      title: "Text message",
      body: body.slice(0, 4000),
      direction,
      outcome: null,
      durationSeconds: null,
      occurredAt: now,
      dueAt: null,
      completed: false,
      assignedTo: null,
      raw: JSON.stringify({ via: "twilio", sid }),
      syncedAt: now,
    },
  ]);
}

/** Send one text from the business line. Never throws. */
export async function sendSms(
  to: string,
  body: string,
  log: SmsLogFields,
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const cfg = smsConfig();
  const dest = toE164(to);
  const conf = smsConfigured();
  if (!conf.ok) return { ok: false, error: `Texting isn't set up (missing ${conf.missing.join(", ")})` };
  if (!dest) return { ok: false, error: `"${to}" isn't a phone number that can receive texts` };

  let sid: string | undefined;
  let error: string | undefined;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: dest,
        From: cfg.from!,
        Body: body,
        StatusCallback: `${publicOrigin()}/api/twilio/sms-status`,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.sid) sid = data.sid;
    else error = `Twilio ${res.status}: ${data?.message ?? "send failed"}`.slice(0, 300);
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
  }

  logMessage({
    direction: "outbound",
    kind: log.kind,
    from: cfg.from!,
    to: dest,
    body,
    sid,
    status: sid ? "queued" : "failed",
    error,
    contactFubId: log.contactFubId,
    tourId: log.tourId,
  });
  if (sid && (log.kind === "client" || log.kind === "relay" || log.kind === "reminder")) {
    logOnContact(log.contactFubId, "outbound", body, sid);
  }
  return sid ? { ok: true, sid } : { ok: false, error };
}

export function recordDeliveryStatus(sid: string, status: string, errorCode?: string | null) {
  sqlite
    .prepare(`UPDATE sms_messages SET status = ?, error = COALESCE(?, error) WHERE twilio_sid = ?`)
    .run(status.slice(0, 30), errorCode ? `Twilio error ${errorCode}` : null, sid);
}

// ---- Webhook authenticity ------------------------------------------------------------

/**
 * Twilio signs every webhook: HMAC-SHA1, keyed with the auth token, over the
 * full URL followed by each POST parameter's name and value in name order.
 * Without this check anyone could POST to the webhook and have texts sent
 * from Spencer's number.
 */
export function validTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  const token = smsConfig().authToken;
  if (!token || !signature) return false;
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const expected = Buffer.from(createHmac("sha1", token).update(payload).digest("base64"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---- Who's texting --------------------------------------------------------------------

export interface PhoneMatch {
  contactFubId: string | null;
  name: string | null;
}

function last10(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "").slice(-10);
}

/** The CRM contact (or site lead) with this phone number, if any. */
export function whoIs(e164: string): PhoneMatch {
  const want = last10(e164);
  if (want.length < 10) return { contactFubId: null, name: null };
  const contacts = sqlite
    .prepare(`SELECT fub_id AS fubId, name, phone FROM crm_contacts WHERE phone IS NOT NULL AND phone != ''`)
    .all() as Array<{ fubId: string; name: string | null; phone: string }>;
  const c = contacts.find((x) => last10(x.phone) === want);
  if (c) return { contactFubId: c.fubId, name: c.name };
  const leads = sqlite.prepare(`SELECT name, phone FROM leads WHERE phone IS NOT NULL ORDER BY id DESC`).all() as Array<{
    name: string;
    phone: string;
  }>;
  const l = leads.find((x) => last10(x.phone) === want);
  return { contactFubId: null, name: l?.name ?? null };
}

// ---- The relay -----------------------------------------------------------------------------

/** How long a forwarded text stays the default target for Spencer's reply. */
const REPLY_WINDOW_MS = 24 * 3600_000;

function setReplyTarget(e164: string) {
  sqlite
    .prepare(
      `INSERT INTO sms_relay_state (key, value, updated_at) VALUES ('reply_to', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(e164, new Date().toISOString());
}

function replyTarget(): string | null {
  const row = sqlite.prepare(`SELECT value, updated_at AS updatedAt FROM sms_relay_state WHERE key = 'reply_to'`).get() as
    | { value: string; updatedAt: string }
    | undefined;
  if (!row || Date.now() - Date.parse(row.updatedAt) > REPLY_WINDOW_MS) return null;
  return row.value;
}

/**
 * A text arrived on the business line. Returns the TwiML reply to Twilio
 * (empty, or a short note back to Spencer when his relay couldn't be sent).
 */
export async function handleInboundSms(from: string, body: string, sid: string | null): Promise<string> {
  const cfg = smsConfig();
  const sender = toE164(from) ?? from;

  // From Spencer's own cell: a reply to relay to a client.
  if (cfg.agentCell && sender === cfg.agentCell) {
    logMessage({ direction: "inbound", kind: "relay", from: sender, to: cfg.from ?? "", body, sid });
    // "4035551234: message" picks the recipient explicitly.
    const explicit = body.match(/^\s*(\+?[\d\s().-]{10,16})\s*[:\-]\s*([\s\S]+)$/);
    const target = explicit ? toE164(explicit[1]) : replyTarget();
    const text = explicit ? explicit[2].trim() : body.trim();
    if (!target) {
      return twimlMessage(
        "Not sent: no client has texted in the last 24 hours to reply to. To start a conversation, text 4035551234: your message",
      );
    }
    const who = whoIs(target);
    const sent = await sendSms(target, text, { kind: "relay", contactFubId: who.contactFubId });
    if (!sent.ok) return twimlMessage(`Not sent to ${who.name ?? prettyPhone(target)}: ${sent.error}`);
    setReplyTarget(target);
    return twimlEmpty();
  }

  // From anyone else: a client. Log it and forward it to Spencer's cell.
  const who = whoIs(sender);
  logMessage({ direction: "inbound", kind: "client", from: sender, to: cfg.from ?? "", body, sid, contactFubId: who.contactFubId });
  logOnContact(who.contactFubId, "inbound", body, sid);
  if (cfg.agentCell) {
    setReplyTarget(sender);
    const label = who.name ? `${who.name} · ${prettyPhone(sender)}` : prettyPhone(sender);
    await sendSms(cfg.agentCell, `${label}:\n${body}`, { kind: "forward" });
  }
  return twimlEmpty();
}

// ---- TwiML ---------------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function twimlEmpty(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

function twimlMessage(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(text)}</Message></Response>`;
}

export function recentMessages(limit = 50) {
  return sqlite
    .prepare(
      `SELECT id, direction, kind, from_number AS fromNumber, to_number AS toNumber, body, status, error,
              contact_fub_id AS contactFubId, tour_id AS tourId, created_at AS createdAt
       FROM sms_messages ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}
