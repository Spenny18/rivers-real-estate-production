// Spencer's Gmail signature, added to the emails the app sends as him (Inbox,
// CRM and automation emails) the way Gmail adds it to mail he writes there.
//
// Read from Gmail's send-as settings with the read-only scope the Inbox already
// has. Refreshed hourly, so a change made in Gmail reaches the app within the
// hour. If it can't be read, emails go without one rather than failing.
//
// It's added after open/click tracking is applied (server/tracking.ts), so its
// links (a Blinq card, today) reach their destination unchanged and a click on
// them isn't counted as engagement with the email.

import { getValidAccessToken } from "./google-calendar";
import { agentUserId, gmailGet } from "./gmail-inbox";
import { EMAIL_BODY_STYLE } from "./tracking";

export interface Signature {
  html: string;
  /** For the plain-text part: the words, and image alt text / link targets in place of pictures. */
  text: string;
}

const TTL_MS = 60 * 60_000;
let cache: { at: number; value: Signature | null } | null = null;

export function signatureText(html: string): string {
  return html
    .replace(/<img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    // Spacer lines ("." in white, common in signature builders) carry nothing.
    .filter((l) => l && !/^[.\s·•|-]+$/.test(l))
    .join("\n");
}

/** The default send-as address's signature, or null if there isn't one or it can't be read. */
export async function gmailSignature(opts: { fresh?: boolean } = {}): Promise<Signature | null> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value: Signature | null = null;
  try {
    const userId = agentUserId();
    const token = userId ? await getValidAccessToken(userId) : null;
    if (token) {
      const r = await gmailGet(token, "/settings/sendAs");
      const list: Array<{ isDefault?: boolean; isPrimary?: boolean; signature?: string }> = r?.sendAs ?? [];
      const html = (list.find((a) => a.isDefault) ?? list.find((a) => a.isPrimary))?.signature?.trim();
      if (html) value = { html, text: signatureText(html) };
    }
  } catch (e: any) {
    console.error("[signature] couldn't read the Gmail signature:", e?.message ?? e);
    // Keep the last good one rather than dropping the signature for an hour.
    if (cache?.value) value = cache.value;
  }
  cache = { at: Date.now(), value };
  return value;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The email with the signature added to both parts. */
export function withSignature(email: { text: string; html?: string }, sig: Signature | null): { text: string; html?: string } {
  if (!sig) return email;
  const text = sig.text ? `${email.text.replace(/\s+$/, "")}\n\n${sig.text}` : email.text;
  const block = `<div style="margin-top:16px;">${sig.html}</div>`;
  const base =
    email.html ??
    `<!doctype html><html><body><div style="${EMAIL_BODY_STYLE}">${escapeHtml(email.text).replace(/\r?\n/g, "<br>\n")}</div></body></html>`;
  const html = /<\/body>/i.test(base) ? base.replace(/<\/body>/i, `${block}</body>`) : base + block;
  return { text, html };
}
