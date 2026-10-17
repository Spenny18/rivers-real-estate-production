// "Show original" for an email in the Inbox: the formatted (HTML) version,
// fetched from Gmail when asked for rather than stored. The sync keeps only
// plain text (server/gmail-inbox.ts), where Gmail renders every picture as
// "[Image]" and every link as "text<http://…>".
//
// Safe to display because of three independent layers:
//   1. sanitize-html keeps an allowlist of email markup — no scripts, event
//      handlers, forms, frames, embeds or javascript: URLs survive;
//   2. the client shows it in an <iframe sandbox> without allow-scripts;
//   3. a Content-Security-Policy in the document itself blocks every outside
//      request — remote images included, until Spencer asks for them
//      ("Load images"), since senders use them as open-tracking pixels.
// Inline images (cid: references to parts of the message) are embedded as
// data: URIs so they show without any outside request.

import sanitizeHtml from "sanitize-html";
import { agentUserId, decode, gmailGet, walk, type GmailPart } from "./gmail-inbox";
import { getValidAccessToken } from "./google-calendar";

const MAX_INLINE_BYTES = 6 * 1024 * 1024;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function partHeader(p: GmailPart, name: string): string {
  return p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** base64url (Gmail) -> standard base64 (data: URIs). */
function std64(data: string): string {
  return data.replace(/-/g, "+").replace(/_/g, "/");
}

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "abbr", "address", "b", "big", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del",
    "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p",
    "pre", "q", "s", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
    "u", "ul", "wbr", "style",
  ],
  allowedAttributes: {
    "*": ["style", "class", "align", "valign", "width", "height", "bgcolor", "color", "dir", "lang", "title", "border"],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height", "style"],
    font: ["face", "size", "color"],
    table: ["cellpadding", "cellspacing", "border", "width", "bgcolor", "align", "role"],
    td: ["colspan", "rowspan", "nowrap"],
    th: ["colspan", "rowspan", "nowrap"],
    col: ["span"],
  },
  // <style> blocks are common in email; CSS can't run script, and the
  // document's CSP stops it fetching anything.
  allowVulnerableTags: true,
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
  allowProtocolRelative: false,
  transformTags: {
    // Links open in a new tab, outside the sandboxed frame.
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
  },
};

export interface OriginalEmail {
  /** A complete HTML document for the iframe's srcdoc. */
  html: string;
  /** Pictures hosted elsewhere (blocked unless images were allowed). */
  remoteImages: number;
  /** Pictures inside the email itself, shown either way. */
  inlineImages: number;
  /** True when the email had no formatted version (plain text shown). */
  plainOnly: boolean;
}

// Emails don't change once sent, and the Inbox now shows each one inline as
// it scrolls into view — so keep recent results rather than asking Gmail again
// every time a thread is opened.
const CACHE_MAX = 300;
const CACHE_MS = 60 * 60_000;
const cache = new Map<string, { at: number; value: OriginalEmail }>();

export async function originalEmail(gmailId: string, opts: { images: boolean; hideQuoted?: boolean }): Promise<OriginalEmail> {
  const key = `${gmailId}|${opts.images ? 1 : 0}|${opts.hideQuoted ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fetchOriginal(gmailId, opts);
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return value;
}

async function fetchOriginal(gmailId: string, opts: { images: boolean; hideQuoted?: boolean }): Promise<OriginalEmail> {
  const userId = agentUserId();
  const token = userId ? await getValidAccessToken(userId) : null;
  if (!token) throw new Error("The Google connection has expired. Reconnect it on the Scheduling page.");
  const msg = await gmailGet(token, `/messages/${encodeURIComponent(gmailId)}?format=full`);
  const parts = walk(msg.payload);

  const htmlPart = parts.find((p) => p.mimeType === "text/html" && p.body?.data && !p.filename);
  const textPart = parts.find((p) => p.mimeType === "text/plain" && p.body?.data && !p.filename);

  // Inline images, keyed by Content-ID, as data: URIs.
  const inline = new Map<string, string>();
  let budget = MAX_INLINE_BYTES;
  for (const p of parts) {
    const cid = partHeader(p, "Content-ID").replace(/^<|>$/g, "").trim();
    if (!cid || !p.mimeType?.startsWith("image/")) continue;
    let data = p.body?.data ?? null;
    if (!data && p.body?.attachmentId && (p.body.size ?? 0) <= budget) {
      try {
        data = (await gmailGet(token, `/messages/${encodeURIComponent(gmailId)}/attachments/${encodeURIComponent(p.body.attachmentId)}`))?.data ?? null;
      } catch {
        data = null;
      }
    }
    if (!data) continue;
    budget -= data.length * 0.75;
    if (budget < 0) break;
    inline.set(cid.toLowerCase(), `data:${p.mimeType};base64,${std64(data)}`);
  }

  let body: string;
  let plainOnly = false;
  if (htmlPart?.body?.data) {
    body = decode(htmlPart.body.data);
  } else {
    plainOnly = true;
    body = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(textPart?.body?.data ? decode(textPart.body.data) : msg.snippet ?? "")}</pre>`;
  }

  const { html, remoteImages } = renderEmailDocument(body, inline, opts.images, { hideQuoted: opts.hideQuoted && !plainOnly });
  return { html, remoteImages, inlineImages: inline.size, plainOnly };
}

/**
 * Sanitised, self-contained HTML document for the sandboxed frame. Exported
 * for tests. `inline` maps lower-cased Content-IDs to data: URIs.
 */
/**
 * Earlier messages quoted under a reply, by mail client: Gmail's gmail_quote,
 * Apple Mail's <blockquote type="cite">, Outlook's divRplyFwdMsg header (and
 * everything after it), Yahoo's yahoo_quoted, Thunderbird's moz-cite-prefix.
 * Ids and the blockquote's type are stripped by the sanitiser, so they're
 * turned into a class first.
 */
const QUOTE_CSS =
  `.gmail_quote,.gmail_quote_container,.yahoo_quoted,.moz-cite-prefix,blockquote.lhc-quote,` +
  `.lhc-quote-start,.lhc-quote-start~*{display:none!important}`;

function markQuotes(html: string): string {
  return html
    .replace(/<blockquote\b([^>]*)\btype\s*=\s*["']?cite["']?/gi, '<blockquote class="lhc-quote"$1')
    .replace(/<(div|hr)\b([^>]*)\bid\s*=\s*["']?(divRplyFwdMsg|stopSpelling)["']?/gi, '<$1 class="lhc-quote-start"$2');
}

export function renderEmailDocument(
  body: string,
  inline: Map<string, string>,
  images: boolean,
  opts: { hideQuoted?: boolean } = {},
): { html: string; remoteImages: number } {
  // cid: references -> the embedded image (unknown cids are dropped).
  const withInline = (opts.hideQuoted ? markQuotes(body) : body).replace(/(["'(])cid:([^"')\s]+)/gi, (_m, q, id) => {
    const uri = inline.get(String(id).toLowerCase());
    return uri ? `${q}${uri}` : `${q}data:,`;
  });

  const clean = sanitizeHtml(withInline, SANITIZE);
  const remoteImages =
    (clean.match(/<img\b[^>]*\bsrc\s*=\s*["']?https?:/gi)?.length ?? 0) + (clean.match(/url\(\s*["']?https?:/gi)?.length ?? 0);

  const imgSrc = images ? "data: https: http:" : "data:";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:${images ? " https:" : ""}`;
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank">` +
    `<style>html,body{margin:0;padding:12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}${opts.hideQuoted ? QUOTE_CSS : ""}</style>` +
    `</head><body>${clean}</body></html>`;
  return { html, remoteImages };
}
