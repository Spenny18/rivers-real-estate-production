// Email for the Inbox (/admin/inbox): every message between Spencer's Gmail
// and a CRM contact, both directions, read straight from Gmail.
//
// Follow Up Boss's API won't list emails account-wide (see mapEmail in
// fub-sync.ts, which has nothing to feed it), so before this the app only
// knew about emails it had sent itself. This polls the mailbox with the
// read-only Google connection the deal inbox already uses.
//
// Privacy by construction: a message is fetched in full and stored only when
// its other party is a CRM contact. Everything else is recorded as "seen" by
// id alone, so it isn't fetched again — the app never keeps a copy of mail
// that has nothing to do with a client.
//
// Read-only: nothing is labelled, moved, archived or marked read in Gmail.

import { sqlite, storage } from "./storage";
import { getValidAccessToken } from "./google-calendar";
import { inboxReadiness } from "./deal-inbox";
import { AGENT } from "./brand";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS inbox_emails (
    gmail_id TEXT PRIMARY KEY,
    thread_id TEXT,
    contact_fub_id TEXT NOT NULL,
    direction TEXT NOT NULL,            -- inbound | outbound
    from_addr TEXT,
    to_addrs TEXT,
    subject TEXT,
    body_text TEXT,
    message_id_header TEXT,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    occurred_at TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_emails_contact ON inbox_emails(contact_fub_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_emails_time ON inbox_emails(occurred_at DESC);

  -- Message ids already looked at and not stored (not a contact's mail).
  CREATE TABLE IF NOT EXISTS inbox_gmail_seen (gmail_id TEXT PRIMARY KEY);

  CREATE TABLE IF NOT EXISTS inbox_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const POLL_MS = 3 * 60_000;
const FIRST_RUN_QUERY = "newer_than:60d -in:chats -in:spam -in:trash";
// Messages fetched per poll. The first run's 60 days can be several thousand;
// it carries on over the next polls (already-seen ids cost nothing to skip).
const MAX_FETCHES_PER_POLL = 1500;

export function stateGet(key: string): string | null {
  return (sqlite.prepare(`SELECT value FROM inbox_state WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
}

export function stateSet(key: string, value: string) {
  sqlite.prepare(`INSERT INTO inbox_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// ---- Parsing Gmail's message JSON -------------------------------------------------

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function walk(part: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!part) return out;
  out.push(part);
  for (const p of part.parts ?? []) walk(p, out);
  return out;
}

function decode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Every address in a header like `"Pat" <pat@x.com>, sam@y.com`. */
export function addressesIn(value: string): string[] {
  return Array.from(value.matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)).map((m) => m[0].toLowerCase());
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The new part of a reply, without the quoted history below it — the thread
 * already shows the earlier messages. Cuts at the usual markers: "On … wrote:",
 * Outlook's "From: … Sent:" block, a run of ">" lines, "-----Original Message".
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex((l, i) => {
    const t = l.trim();
    if (/^On .{4,200}wrote:\s*$/i.test(t)) return true;
    // "On Thu, Oct 9, 2026 at 2:00 PM Spencer Rivers <x@y.com>" wraps before "wrote:".
    if (/^On .{4,200}$/i.test(t) && /wrote:\s*$/i.test((lines[i + 1] ?? "").trim())) return true;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) return true;
    if (/^From:\s.+/i.test(t) && lines.slice(i + 1, i + 4).some((n) => /^(Sent|Date):\s/i.test(n.trim()))) return true;
    if (t.startsWith(">") && (lines[i + 1] ?? "").trim().startsWith(">")) return true;
    return false;
  });
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
  // Never return nothing: a message that is all quote shows as-is.
  return kept || text.trim();
}

export function messageBody(msg: GmailMessage): { text: string; hasAttachments: boolean } {
  const parts = walk(msg.payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data && !p.filename);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data && !p.filename);
  const raw = plain?.body?.data ? decode(plain.body.data) : html?.body?.data ? htmlToText(decode(html.body.data)) : msg.snippet ?? "";
  return {
    text: stripQuoted(raw).slice(0, 20_000),
    hasAttachments: parts.some((p) => !!p.filename && (p.body?.attachmentId || p.body?.size)),
  };
}

// ---- Matching mail to contacts ------------------------------------------------------

/** Spencer's own addresses: mail from these is outbound. */
function ownAddresses(userId: number): Set<string> {
  const own = new Set<string>();
  const add = (v: string | null | undefined) => v && addressesIn(v).forEach((a) => own.add(a));
  add(AGENT.email);
  add(process.env.SPENCER_NOTIFY_EMAIL);
  add(process.env.RESEND_FROM_EMAIL);
  add(storage.getUserById(userId)?.email);
  add(storage.getUserIntegration(userId, "google")?.accountEmail);
  return own;
}

function contactsByEmail(): Map<string, string> {
  const map = new Map<string, string>();
  const rows = sqlite.prepare(`SELECT fub_id AS fubId, email FROM crm_contacts WHERE email IS NOT NULL AND email != ''`).all() as Array<{
    fubId: string;
    email: string;
  }>;
  for (const r of rows) for (const a of addressesIn(r.email)) if (!map.has(a)) map.set(a, r.fubId);
  return map;
}

export interface ClassifiedEmail {
  contactFubId: string;
  direction: "inbound" | "outbound";
}

/** Which contact a message belongs to, and which way it went; null if no contact is a party to it. */
export function classify(
  meta: { from: string; to: string; cc: string },
  own: Set<string>,
  contacts: Map<string, string>,
): ClassifiedEmail | null {
  const from = addressesIn(meta.from)[0] ?? "";
  if (own.has(from)) {
    for (const a of [...addressesIn(meta.to), ...addressesIn(meta.cc)]) {
      const c = contacts.get(a);
      if (c) return { contactFubId: c, direction: "outbound" };
    }
    return null;
  }
  const c = contacts.get(from);
  return c ? { contactFubId: c, direction: "inbound" } : null;
}

// ---- Polling --------------------------------------------------------------------------

function agentUserId(): number | null {
  const u = storage.getUserByEmail(AGENT.email) ?? storage.getUserById(1);
  return u?.id ?? null;
}

async function gmailGet(token: string, path: string): Promise<any> {
  const r = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

export interface InboxSyncResult {
  ok: boolean;
  checked: number;
  stored: number;
  error?: string;
  at: string;
}

export function storeEmail(row: {
  gmailId: string;
  threadId: string | null;
  contactFubId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  subject: string;
  body: string;
  messageIdHeader: string | null;
  hasAttachments: boolean;
  occurredAt: string;
}) {
  sqlite
    .prepare(
      `INSERT INTO inbox_emails (gmail_id, thread_id, contact_fub_id, direction, from_addr, to_addrs, subject, body_text,
         message_id_header, has_attachments, occurred_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(gmail_id) DO UPDATE SET body_text = excluded.body_text, subject = excluded.subject,
         message_id_header = COALESCE(excluded.message_id_header, inbox_emails.message_id_header)`,
    )
    .run(
      row.gmailId,
      row.threadId,
      row.contactFubId,
      row.direction,
      row.from.slice(0, 300),
      row.to.slice(0, 1000),
      row.subject.slice(0, 500),
      row.body,
      row.messageIdHeader,
      row.hasAttachments ? 1 : 0,
      row.occurredAt,
      new Date().toISOString(),
    );
}

let lastResult: InboxSyncResult | null = null;
let running: Promise<InboxSyncResult> | null = null;

export function lastInboxSync(): InboxSyncResult | null {
  return lastResult;
}

/** Read new mail once. Concurrent callers share one run. */
export function syncInboxEmails(): Promise<InboxSyncResult> {
  if (running) return running;
  running = doSync().finally(() => {
    running = null;
  });
  return running;
}

async function doSync(): Promise<InboxSyncResult> {
  const at = new Date().toISOString();
  const ready = inboxReadiness();
  if (!ready.ok) return (lastResult = { ok: false, checked: 0, stored: 0, error: ready.reason, at });
  const userId = agentUserId();
  const token = userId ? await getValidAccessToken(userId) : null;
  if (!userId || !token) return (lastResult = { ok: false, checked: 0, stored: 0, error: "Google connection expired. Reconnect it on the Scheduling page.", at });

  const own = ownAddresses(userId);
  const contacts = contactsByEmail();
  const since = stateGet("gmail_synced_through");
  // Ten minutes of overlap: Gmail's `after:` is by received time, and a
  // message can be indexed a little after it arrives.
  const query = since ? `after:${Math.floor(Number(since) / 1000) - 600} -in:chats -in:spam -in:trash` : FIRST_RUN_QUERY;
  const startedMs = Date.now();

  let checked = 0;
  let stored = 0;
  try {
    const known = sqlite.prepare(`SELECT 1 FROM inbox_emails WHERE gmail_id = ? UNION ALL SELECT 1 FROM inbox_gmail_seen WHERE gmail_id = ?`);
    const markSeen = sqlite.prepare(`INSERT OR IGNORE INTO inbox_gmail_seen (gmail_id) VALUES (?)`);
    let pageToken: string | undefined;
    do {
      const list = await gmailGet(token, `/messages?q=${encodeURIComponent(query)}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`);
      const ids: string[] = (list.messages ?? []).map((m: any) => String(m.id));
      for (const id of ids) {
        if (known.get(id, id)) continue;
        if (checked >= MAX_FETCHES_PER_POLL) break;
        // Headers first: enough to know whether a contact is involved at all.
        const meta: GmailMessage = await gmailGet(
          token,
          `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
        );
        checked += 1;
        const who = classify({ from: header(meta, "From"), to: header(meta, "To"), cc: header(meta, "Cc") }, own, contacts);
        if (!who) {
          markSeen.run(id);
          continue;
        }
        const full: GmailMessage = await gmailGet(token, `/messages/${id}?format=full`);
        const body = messageBody(full);
        storeEmail({
          gmailId: id,
          threadId: full.threadId ?? null,
          contactFubId: who.contactFubId,
          direction: who.direction,
          from: header(full, "From"),
          to: [header(full, "To"), header(full, "Cc")].filter(Boolean).join(", "),
          subject: header(full, "Subject") || "(no subject)",
          body: body.text,
          messageIdHeader: header(full, "Message-ID") || header(full, "Message-Id") || null,
          hasAttachments: body.hasAttachments,
          occurredAt: new Date(Number(full.internalDate ?? Date.now())).toISOString(),
        });
        stored += 1;
      }
      pageToken = list.nextPageToken;
    } while (pageToken && checked < MAX_FETCHES_PER_POLL);
    // Only once every page has been read: otherwise the next poll would jump
    // to "after now" and the rest of the backlog would never be fetched.
    if (!pageToken && checked < MAX_FETCHES_PER_POLL) stateSet("gmail_synced_through", String(startedMs));
    if (!stateGet("inbox_launched_at")) stateSet("inbox_launched_at", at);
    lastResult = { ok: true, checked, stored, at };
    if (stored) console.log(`[inbox] ${stored} new email${stored === 1 ? "" : "s"} with contacts (${checked} checked)`);
  } catch (e: any) {
    lastResult = { ok: false, checked, stored, error: String(e?.message ?? e).slice(0, 300), at };
    console.error("[inbox] gmail sync failed:", lastResult.error);
  }
  return lastResult;
}

let timer: NodeJS.Timeout | null = null;

export function startInboxEmailCron() {
  if (timer) return;
  setTimeout(() => void syncInboxEmails(), 45_000);
  timer = setInterval(() => void syncInboxEmails(), POLL_MS);
  console.log(`[inbox] gmail sync scheduled (every ${POLL_MS / 60_000} min)`);
}
