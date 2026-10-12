// Calls on the business line: the log, the contact they belong to, and
// outbound calling.
//
// Every call — in or out — gets a call_log row (keyed by Twilio's CallSid of
// the leg the client is on) and a "call" activity on the contact's CRM record,
// so it shows in their Inbox thread beside texts and emails. Recordings stay
// on Twilio; the admin streams them through an authenticated endpoint.
//
// Outbound calls are bridged, so the client always sees the business line:
//   - from the admin ("Call" in the Inbox): Twilio rings Spencer's cell; he
//     presses 1 (so his own voicemail can't pick up and get connected); then
//     it dials the client with the business line as caller ID.
//   - from his cell: he calls the business line, is asked for a number (or *
//     for whoever last called or texted), and is connected the same way.
// Calls are recorded; the other party hears a short notice first.

import { sqlite, storage } from "./storage";
import { publicOrigin } from "./origin";
import { ensureContactForPhone, smsConfig, smsConfigured, toE164 } from "./sms";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT UNIQUE,            -- Twilio CallSid of the leg the client is on (null until known)
    direction TEXT NOT NULL,         -- inbound | outbound
    client_number TEXT NOT NULL,     -- E.164 of the client side
    contact_fub_id TEXT,
    status TEXT NOT NULL,            -- ringing | answered | missed | voicemail | no-answer | failed | busy | canceled
    duration_seconds INTEGER,
    recording_sid TEXT,
    recording_seconds INTEGER,
    voicemail INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_call_log_time ON call_log(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_call_log_contact ON call_log(contact_fub_id);
`);

export interface CallRow {
  id: number;
  callSid: string | null;
  direction: "inbound" | "outbound";
  clientNumber: string;
  contactFubId: string | null;
  status: string;
  durationSeconds: number | null;
  recordingSid: string | null;
  recordingSeconds: number | null;
  voicemail: boolean;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

const SELECT = `SELECT id, call_sid AS callSid, direction, client_number AS clientNumber, contact_fub_id AS contactFubId, status,
  duration_seconds AS durationSeconds, recording_sid AS recordingSid, recording_seconds AS recordingSeconds, voicemail, error,
  started_at AS startedAt, ended_at AS endedAt FROM call_log`;

function row(r: any): CallRow | null {
  return r ? { ...r, voicemail: !!r.voicemail } : null;
}

export function getCall(id: number): CallRow | null {
  return row(sqlite.prepare(`${SELECT} WHERE id = ?`).get(id));
}

export function getCallBySid(sid: string): CallRow | null {
  return row(sqlite.prepare(`${SELECT} WHERE call_sid = ?`).get(sid));
}

// ---- The log -----------------------------------------------------------------------------

export function startCall(input: { callSid?: string | null; direction: "inbound" | "outbound"; clientNumber: string; contactFubId: string | null; status?: string }): CallRow {
  const now = new Date().toISOString();
  const r = sqlite
    .prepare(
      `INSERT INTO call_log (call_sid, direction, client_number, contact_fub_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(call_sid) DO UPDATE SET status = call_log.status`,
    )
    .run(input.callSid ?? null, input.direction, input.clientNumber, input.contactFubId, input.status ?? "ringing", now);
  const call = input.callSid ? getCallBySid(input.callSid)! : getCall(Number(r.lastInsertRowid))!;
  logActivity(call);
  return call;
}

export function updateCall(id: number, patch: Partial<Pick<CallRow, "callSid" | "status" | "durationSeconds" | "recordingSid" | "recordingSeconds" | "voicemail" | "error" | "endedAt">>): CallRow | null {
  const cols: Record<string, unknown> = {
    call_sid: patch.callSid,
    status: patch.status,
    duration_seconds: patch.durationSeconds,
    recording_sid: patch.recordingSid,
    recording_seconds: patch.recordingSeconds,
    voicemail: patch.voicemail === undefined ? undefined : patch.voicemail ? 1 : 0,
    error: patch.error,
    ended_at: patch.endedAt,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) {
    sqlite.prepare(`UPDATE call_log SET ${set.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...set.map(([, v]) => v), id);
  }
  const call = getCall(id);
  if (call) logActivity(call);
  return call;
}

const OUTCOME: Record<string, string> = {
  ringing: "Ringing",
  answered: "Answered",
  missed: "Missed",
  voicemail: "Voicemail",
  "no-answer": "No answer",
  busy: "Busy",
  failed: "Failed",
  canceled: "Not connected",
};

/** The call on the contact's CRM record — one activity per call, updated as it progresses. */
function logActivity(call: CallRow) {
  if (!call.contactFubId) return;
  const now = new Date().toISOString();
  storage.upsertCrmActivities([
    {
      uid: `call:twilio:${call.id}`,
      kind: "call",
      fubId: null,
      contactFubId: call.contactFubId,
      title: call.direction === "inbound" ? "Incoming call" : "Outgoing call",
      body: call.voicemail ? `Voicemail (${call.recordingSeconds ?? 0}s)` : null,
      direction: call.direction,
      outcome: OUTCOME[call.status] ?? call.status,
      durationSeconds: call.durationSeconds ?? null,
      occurredAt: call.startedAt,
      dueAt: null,
      completed: true,
      assignedTo: null,
      raw: JSON.stringify({ via: "twilio", callLogId: call.id, recording: !!call.recordingSid }),
      syncedAt: now,
    },
  ]);
  sqlite.prepare(`UPDATE crm_contacts SET last_activity_at = ? WHERE fub_id = ?`).run(now, call.contactFubId);
}

export function recentCalls(limit = 50) {
  return sqlite
    .prepare(
      `SELECT l.id, l.direction, l.client_number AS clientNumber, l.contact_fub_id AS contactFubId, c.name AS contactName,
              l.status, l.duration_seconds AS durationSeconds, l.voicemail, l.recording_sid IS NOT NULL AS hasRecording,
              l.started_at AS startedAt
       FROM call_log l LEFT JOIN crm_contacts c ON c.fub_id = l.contact_fub_id
       ORDER BY l.started_at DESC LIMIT ?`,
    )
    .all(limit)
    .map((r: any) => ({ ...r, voicemail: !!r.voicemail, hasRecording: !!r.hasRecording }));
}

// ---- Twilio REST ------------------------------------------------------------------------

function authHeader(): string {
  const cfg = smsConfig();
  return `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`;
}

/** The recording's audio, for streaming to the admin. */
export async function fetchRecording(recordingSid: string): Promise<Response> {
  const cfg = smsConfig();
  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Recordings/${encodeURIComponent(recordingSid)}.mp3`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(30_000),
  });
}

/**
 * Click-to-call: ring Spencer's cell from the business line. When he answers
 * and presses 1, /api/twilio/voice/outbound-connect dials the client.
 */
export async function callFromAdmin(target: { phone: string; contactFubId?: string | null }): Promise<{ ok: true; callId: number } | { ok: false; error: string }> {
  const conf = smsConfigured();
  if (!conf.ok) return { ok: false, error: `The business line isn't set up (missing ${conf.missing.join(", ")})` };
  const cfg = smsConfig();
  if (!cfg.agentCell) return { ok: false, error: "Set AGENT_CELL_NUMBER — that's the phone that rings first." };
  const to = toE164(target.phone);
  if (!to) return { ok: false, error: `"${target.phone}" isn't a phone number that can be called` };
  const contact = target.contactFubId ? { contactFubId: target.contactFubId } : ensureContactForPhone(to, "call");
  const call = startCall({ direction: "outbound", clientNumber: to, contactFubId: contact.contactFubId, status: "ringing" });
  const origin = publicOrigin();
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Calls.json`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        To: cfg.agentCell,
        From: cfg.from!,
        Url: `${origin}/api/twilio/voice/outbound-agent?call=${call.id}`,
        Method: "POST",
        Timeout: "25",
        StatusCallback: `${origin}/api/twilio/voice/outbound-agent-status?call=${call.id}`,
        StatusCallbackMethod: "POST",
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = `Twilio ${res.status}: ${data?.message ?? "call failed"}`.slice(0, 300);
      updateCall(call.id, { status: "failed", error, endedAt: new Date().toISOString() });
      return { ok: false, error };
    }
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 300);
    updateCall(call.id, { status: "failed", error, endedAt: new Date().toISOString() });
    return { ok: false, error };
  }
  return { ok: true, callId: call.id };
}
