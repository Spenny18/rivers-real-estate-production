// The deal inbox: forms emailed from CREA WEBForms land on the deal.
//
// WEBForms has no API, but it can email a PDF of any form to any address.
// Every deal has an address of the form
//
//     spencer+deal-3f9a1c2b7d@riversrealestate.ca
//
// Gmail ignores everything after the "+", so the mail lands in Spencer's
// ordinary inbox, and this poller (using the Google connection already made
// for Calendar, with the gmail.readonly scope added) reads it back every few
// minutes, finds the deal by the token, and imports each PDF attachment as a
// draft document. The token can also be put in the subject line
// ("[deal-3f9a1c2b7d]") for a client that cannot address to a +tag.
//
// Read-only: the app never labels, moves or deletes mail. What has already
// been looked at is recorded in deal_inbound_messages so nothing is imported
// twice and the deal page can show what arrived. The message processing is
// pure over Gmail's message JSON so it can be tested without Gmail.

import { eq, desc } from "drizzle-orm";
import { db, storage } from "./storage";
import { dealInboundMessages, type DealInboundMessage } from "@shared/schema";
import { getValidAccessToken, googleConfigured } from "./google-calendar";
import { extractInboxToken, getDealByInboxToken, importPdfDocument, inboxMailbox, nowIso } from "./deal-store";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const POLL_MS = 5 * 60 * 1000;
const SEARCH_QUERY = "has:attachment filename:pdf newer_than:30d";

// ---- Gmail message shape (the parts we read) --------------------------------------

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

function header(msg: GmailMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function walkParts(part: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!part) return out;
  out.push(part);
  for (const p of part.parts ?? []) walkParts(p, out);
  return out;
}

function isPdfPart(p: GmailPart): boolean {
  const name = (p.filename ?? "").toLowerCase();
  const mime = (p.mimeType ?? "").toLowerCase();
  return mime === "application/pdf" || (name.endsWith(".pdf") && (mime === "application/octet-stream" || mime === ""));
}

function fromBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function senderAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** Optional allowlist of senders (addresses or @domains), comma separated. */
function senderAllowed(from: string): boolean {
  const raw = (process.env.DEAL_INBOX_ALLOWED_SENDERS ?? "").trim();
  if (!raw) return true;
  const addr = senderAddress(from);
  return raw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => (rule.startsWith("@") ? addr.endsWith(rule) : addr === rule));
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "Document";
}

export interface ProcessResult {
  status: "imported" | "unmatched" | "no_pdf" | "rejected" | "error" | "duplicate";
  dealId?: number;
  documentIds: number[];
  detail?: string;
}

/**
 * Look at one Gmail message: find the deal it is addressed to, import its
 * PDFs. `fetchAttachment` fetches a part's bytes by attachment id (Gmail
 * keeps anything over a few KB out of the message body).
 */
export async function processGmailMessage(
  msg: GmailMessage,
  fetchAttachment: (messageId: string, attachmentId: string) => Promise<Buffer>,
): Promise<ProcessResult> {
  const existing = db.select().from(dealInboundMessages).where(eq(dealInboundMessages.messageId, msg.id)).get();
  if (existing) return { status: "duplicate", documentIds: [] };

  const from = header(msg, "From");
  const subject = header(msg, "Subject");
  const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header(msg, "Date") || null;
  const recipients = ["To", "Cc", "Bcc", "Delivered-To", "X-Original-To", "Envelope-To", "X-Forwarded-To"]
    .map((h) => header(msg, h))
    .filter(Boolean)
    .join(" ");
  const token = extractInboxToken(recipients) ?? extractInboxToken(subject);

  const record = (r: ProcessResult) => {
    db.insert(dealInboundMessages)
      .values({
        provider: "gmail",
        messageId: msg.id,
        dealId: r.dealId ?? null,
        fromAddress: from.slice(0, 200) || null,
        subject: subject.slice(0, 300) || null,
        receivedAt,
        status: r.status,
        detail: r.detail ?? null,
        documentIds: JSON.stringify(r.documentIds),
        processedAt: nowIso(),
      })
      .run();
    return r;
  };

  if (!token) return record({ status: "unmatched", documentIds: [], detail: "no deal token in recipients or subject" });
  const deal = getDealByInboxToken(token);
  if (!deal) return record({ status: "unmatched", documentIds: [], detail: `no deal for token ${token}` });
  if (!senderAllowed(from)) return record({ status: "rejected", dealId: deal.id, documentIds: [], detail: `sender ${senderAddress(from)} not in DEAL_INBOX_ALLOWED_SENDERS` });

  const pdfParts = walkParts(msg.payload).filter(isPdfPart);
  if (!pdfParts.length) return record({ status: "no_pdf", dealId: deal.id, documentIds: [], detail: "no PDF attachment" });

  const documentIds: number[] = [];
  const problems: string[] = [];
  for (const part of pdfParts) {
    try {
      const bytes = part.body?.data
        ? fromBase64Url(part.body.data)
        : part.body?.attachmentId
          ? await fetchAttachment(msg.id, part.body.attachmentId)
          : null;
      if (!bytes) {
        problems.push(`${part.filename ?? "attachment"}: no content`);
        continue;
      }
      const doc = await importPdfDocument({
        dealId: deal.id,
        title: titleFromFilename(part.filename ?? subject ?? "Document"),
        filename: part.filename ?? null,
        bytes,
        source: "email",
        detail: `emailed by ${senderAddress(from)}${subject ? ` — "${subject.slice(0, 80)}"` : ""}`,
      });
      documentIds.push(doc.id);
    } catch (e: any) {
      problems.push(`${part.filename ?? "attachment"}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  if (!documentIds.length) return record({ status: "error", dealId: deal.id, documentIds, detail: problems.join("; ") || "import failed" });
  return record({ status: "imported", dealId: deal.id, documentIds, detail: problems.length ? problems.join("; ") : undefined });
}

// ---- Gmail access ----------------------------------------------------------------

function agentUserId(): number | null {
  const u = storage.getUserByEmail(inboxMailbox()) ?? storage.getUserByEmail("spencer@riversrealestate.ca") ?? storage.getUserById(1);
  return u?.id ?? null;
}

export function inboxReadiness(): { ok: boolean; reason?: string; accountEmail?: string | null } {
  if (!googleConfigured()) return { ok: false, reason: "Google OAuth is not configured on the server (GOOGLE_OAUTH_CLIENT_ID / _SECRET)." };
  const userId = agentUserId();
  if (!userId) return { ok: false, reason: "No agent user." };
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) return { ok: false, reason: "Google isn't connected. Connect it on the Scheduling page." };
  if (!(integ.scope ?? "").includes(GMAIL_READ_SCOPE)) {
    return {
      ok: false,
      accountEmail: integ.accountEmail,
      reason: "Your Google connection predates the deal inbox. Reconnect Google on the Scheduling page to grant read access to your mailbox.",
    };
  }
  return { ok: true, accountEmail: integ.accountEmail };
}

async function gmailGet(token: string, path: string): Promise<any> {
  const r = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Gmail ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

export interface PollResult {
  ok: boolean;
  checked: number;
  imported: number;
  documents: number;
  error?: string;
  at: string;
}

let lastPoll: PollResult | null = null;
let polling: Promise<PollResult> | null = null;

/** Read the mailbox once. Safe to call from the cron and the admin button at the same time. */
export function pollDealInbox(): Promise<PollResult> {
  if (polling) return polling;
  polling = doPoll().finally(() => {
    polling = null;
  });
  return polling;
}

async function doPoll(): Promise<PollResult> {
  const at = nowIso();
  const ready = inboxReadiness();
  if (!ready.ok) return (lastPoll = { ok: false, checked: 0, imported: 0, documents: 0, error: ready.reason, at });
  const userId = agentUserId()!;
  const token = await getValidAccessToken(userId);
  if (!token) return (lastPoll = { ok: false, checked: 0, imported: 0, documents: 0, error: "Google connection expired. Reconnect it on the Scheduling page.", at });

  let checked = 0;
  let imported = 0;
  let documents = 0;
  try {
    const seen = new Set((db.select({ id: dealInboundMessages.messageId }).from(dealInboundMessages).all() as Array<{ id: string }>).map((r) => r.id));
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const list = await gmailGet(token, `/messages?q=${encodeURIComponent(SEARCH_QUERY)}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`);
      const ids: string[] = (list.messages ?? []).map((m: any) => String(m.id)).filter((id: string) => !seen.has(id));
      for (const id of ids) {
        // Headers first: cheap, and enough to know whether this is ours.
        const meta: GmailMessage = await gmailGet(
          token,
          `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Delivered-To&metadataHeaders=X-Original-To`,
        );
        checked += 1;
        const addressed = ["To", "Cc", "Delivered-To", "X-Original-To"].map((h) => header(meta, h)).join(" ");
        const hasToken = !!(extractInboxToken(addressed) ?? extractInboxToken(header(meta, "Subject")));
        const full: GmailMessage = hasToken ? await gmailGet(token, `/messages/${id}?format=full`) : meta;
        const r = await processGmailMessage(full, async (messageId, attachmentId) => {
          const a = await gmailGet(token, `/messages/${messageId}/attachments/${attachmentId}`);
          return fromBase64Url(String(a.data ?? ""));
        });
        if (r.status === "imported") {
          imported += 1;
          documents += r.documentIds.length;
          console.log(`[deal-inbox] imported ${r.documentIds.length} PDF(s) into deal ${r.dealId} from ${header(full, "From")}`);
        }
      }
      pageToken = list.nextPageToken;
      pages += 1;
    } while (pageToken && pages < 5);
    return (lastPoll = { ok: true, checked, imported, documents, at });
  } catch (e: any) {
    const error = String(e?.message ?? e);
    console.error("[deal-inbox] poll failed:", error);
    return (lastPoll = { ok: false, checked, imported, documents, error, at });
  }
}

export function inboxStatus() {
  const ready = inboxReadiness();
  return {
    ready: ready.ok,
    reason: ready.reason ?? null,
    accountEmail: ready.accountEmail ?? null,
    mailbox: inboxMailbox(),
    lastPoll,
    polling: polling !== null,
  };
}

export function recentInboundForDeal(dealId: number, limit = 10): DealInboundMessage[] {
  return db.select().from(dealInboundMessages).where(eq(dealInboundMessages.dealId, dealId)).orderBy(desc(dealInboundMessages.id)).limit(limit).all();
}

let timer: NodeJS.Timeout | null = null;
export function startDealInboxCron(): void {
  if (timer) return;
  if (!googleConfigured()) {
    console.log("[deal-inbox] not scheduled — Google OAuth not configured");
    return;
  }
  setTimeout(() => pollDealInbox().catch((e) => console.error("[deal-inbox] uncaught:", e)), 45_000);
  timer = setInterval(() => pollDealInbox().catch((e) => console.error("[deal-inbox] uncaught:", e)), POLL_MS);
  console.log("[deal-inbox] scheduled every 5 minutes");
}
