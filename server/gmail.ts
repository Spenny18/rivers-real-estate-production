// Sending email as Spencer, through his own Google Workspace mailbox.
//
// This deliberately does NOT introduce a new sending service. The app already
// has Resend wired up for lead alerts, and it would have been the quicker
// route — but mail sent through Resend never touches the mailbox it claims to
// come from. It would not appear in Sent, a reply would start a fresh thread
// rather than continuing the conversation, and Follow Up Boss (which syncs the
// mailbox, not the domain) would never see it. The client's history would end
// up split across two places again, which is the failure this whole CRM was
// built to avoid.
//
// Sending through Gmail instead means the message is a real message from a
// real mailbox: it lands in Sent, replies thread against it, and Follow Up
// Boss picks it up on its own mailbox sync and mirrors it straight back into
// the CRM. Nothing has to be told about anything.
//
// It reuses the OAuth already in place for Calendar — same client, same token
// store, same refresh — so this is one added scope rather than a second
// integration. That scope is the catch: `gmail.send` is one of Google's
// restricted scopes, which normally means a verification review. On a Google
// Workspace domain the OAuth consent screen can instead be set to "Internal",
// which exempts it entirely and also stops refresh tokens expiring every seven
// days the way they do in Testing mode. riversrealestate.ca is Workspace, so
// that is the setup: consent screen -> Internal.

import { randomBytes } from "node:crypto";
import { getValidAccessToken } from "./google-calendar";
import { storage } from "./storage";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The scope this module needs, on top of the calendar ones. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/**
 * Whether the stored Google connection can actually send.
 *
 * A connection made before this feature existed carries only the calendar
 * scopes, and Google will reject a send against it. Checking the granted scope
 * up front turns that into "reconnect Google to enable email" in the admin,
 * rather than a 403 at the moment someone presses Send on a message they have
 * just written.
 */
export function canSendEmail(userId: number): { ok: boolean; reason?: string } {
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) {
    return { ok: false, reason: "Google isn't connected. Connect it on the Scheduling page." };
  }
  if (!(integ.scope ?? "").includes(GMAIL_SEND_SCOPE)) {
    return {
      ok: false,
      reason:
        "Your Google connection predates email sending. Reconnect Google on the Scheduling " +
        "page to grant permission to send.",
    };
  }
  return { ok: true };
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  /** Plain text body, as typed. */
  text: string;
  /**
   * Optional HTML alternative. When present the message goes out as
   * multipart/alternative; the CRM uses it to carry an open pixel and tracked
   * links (see server/tracking.ts) while the text part stays exactly as typed.
   */
  html?: string;
  /** Set to continue an existing conversation rather than start a new one. */
  threadId?: string;
  /** The Message-ID being replied to, so mail clients thread it correctly. */
  inReplyTo?: string;
  /** Add Spencer's Gmail signature to both parts, as Gmail would (server/gmail-signature.ts). */
  signature?: boolean;
  /** Files sent with it (server/email-attachments.ts). The message becomes multipart/mixed. */
  attachments?: Array<{ filename: string; contentType: string; data: Buffer }>;
}

/**
 * RFC 5322 headers must not carry raw non-ASCII, so anything outside it is
 * encoded per RFC 2047. Subjects routinely contain an em dash or an accented
 * name, and an unencoded one arrives as mojibake.
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Gmail wants the whole message base64url-encoded, not standard base64. */
function base64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** Content-Disposition for a file, with RFC 2231 encoding when the name isn't plain ASCII. */
function dispositionFor(filename: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(filename)) return `attachment; filename="${filename}"`;
  const ascii = filename.normalize("NFKD").replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function buildMime(from: string, email: OutgoingEmail): string {
  const headers = [
    `From: ${from}`,
    `To: ${email.to}`,
    `Subject: ${encodeHeader(email.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (email.inReplyTo) {
    // Both headers: In-Reply-To is what most clients thread on, References is
    // what the rest of them use.
    headers.push(`In-Reply-To: ${email.inReplyTo}`, `References: ${email.inReplyTo}`);
  }
  // A bare LF between headers and body is tolerated by Gmail but not by every
  // relay downstream; CRLF is what the spec asks for.
  const crlf = (t: string) => t.replace(/\r?\n/g, "\r\n");
  const wrap = (b: string) => b.replace(/.{76}/g, "$&\r\n");
  const b64 = (t: string) => wrap(Buffer.from(t, "utf8").toString("base64"));
  const boundary = () => `=_lhc_${randomBytes(12).toString("hex")}`;

  // The message itself: plain text, or text + HTML as alternatives.
  let bodyHeaders: string[];
  let bodyContent: string;
  if (!email.html) {
    bodyHeaders = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit"];
    bodyContent = crlf(email.text);
  } else {
    // Base64 parts: no line-length or 8-bit concerns for either body, whatever
    // was typed. Text first — the last part is the one clients prefer to show.
    const alt = boundary();
    bodyHeaders = [`Content-Type: multipart/alternative; boundary="${alt}"`];
    bodyContent = [
      `--${alt}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(crlf(email.text)),
      `--${alt}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(email.html),
      `--${alt}--`,
      "",
    ].join("\r\n");
  }

  const files = email.attachments ?? [];
  if (!files.length) return `${[...headers, ...bodyHeaders].join("\r\n")}\r\n\r\n${bodyContent}`;

  // With files: multipart/mixed, the message first and each file after it.
  const mixed = boundary();
  return [
    [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`].join("\r\n"),
    "",
    `--${mixed}`,
    ...bodyHeaders,
    "",
    bodyContent,
    ...files.flatMap((f) => [
      `--${mixed}`,
      `Content-Type: ${f.contentType}; name="${f.filename.replace(/[^\x20-\x7E]/g, "_")}"`,
      `Content-Disposition: ${dispositionFor(f.filename)}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap(f.data.toString("base64")),
    ]),
    `--${mixed}--`,
    "",
  ].join("\r\n");
}

/**
 * The send request. Small messages go as JSON; with attachments, Gmail's
 * upload endpoint, which takes the raw message (up to 35 MB) rather than a
 * base64url copy of it inside JSON.
 */
export function sendRequest(raw: string, threadId: string | undefined): { url: string; headers: Record<string, string>; body: string | Buffer } {
  if (raw.length < 4 * 1024 * 1024) {
    return {
      url: `${GMAIL_API}/messages/send`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: base64Url(raw), ...(threadId ? { threadId } : {}) }),
    };
  }
  const b = `=_lhc_up_${randomBytes(12).toString("hex")}`;
  return {
    url: `${GMAIL_API.replace("/gmail/v1/", "/upload/gmail/v1/")}/messages/send?uploadType=multipart`,
    headers: { "Content-Type": `multipart/related; boundary="${b}"` },
    body: Buffer.from(
      [
        `--${b}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(threadId ? { threadId } : {}),
        `--${b}`,
        "Content-Type: message/rfc822",
        "",
        raw,
        `--${b}--`,
        "",
      ].join("\r\n"),
      "utf8",
    ),
  };
}

/** Send one message as the connected Google account. */
export async function sendGmail(userId: number, email: OutgoingEmail): Promise<SendResult> {
  const gate = canSendEmail(userId);
  if (!gate.ok) return { ok: false, error: gate.reason };

  const token = await getValidAccessToken(userId);
  if (!token) {
    return { ok: false, error: "Google connection expired. Reconnect it on the Scheduling page." };
  }
  const integ = storage.getUserIntegration(userId, "google");
  const from = integ?.accountEmail ?? "me";
  if (email.signature) {
    const { gmailSignature, withSignature } = await import("./gmail-signature");
    email = { ...email, ...withSignature(email, await gmailSignature()) };
  }

  try {
    const req = sendRequest(buildMime(from, email), email.threadId);
    const res = await fetch(req.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...req.headers },
      body: req.body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 403 here is almost always the scope, which is worth saying plainly
      // rather than relaying Google's phrasing.
      const friendly =
        res.status === 403
          ? "Google refused the send. Reconnect Google on the Scheduling page to grant email permission."
          : `Gmail returned ${res.status}: ${text.slice(0, 200)}`;
      return { ok: false, error: friendly };
    }
    const data: any = await res.json();
    return { ok: true, messageId: data.id, threadId: data.threadId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}
