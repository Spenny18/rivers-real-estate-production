// Property cards in emails. A listing link on a line of its own — which is how
// the Inbox's "Insert listing" writes one — goes out as a card: photo, price,
// address, beds and baths, and a "View listing" button. The plain-text part
// of the email keeps the line and the link as typed.
//
// Built from tables and inline styles, the only layout Gmail, Outlook and
// Apple Mail all render the same. The link is tracked like any other
// (server/tracking.ts), so a click shows on the contact's activity.

import { storage } from "./storage";
import { resolveShowingListing, type ShowingListing } from "./showings";
import { publicOrigin } from "./origin";
import { createTrackedEmail, EMAIL_FONT, plainTextToTrackedHtml, type LinkBlock } from "./tracking";

const OWN_HOSTS = new Set(["riversrealestate.ca", "www.riversrealestate.ca"]);

/** The MLS listing a link to one of the site's listing pages points at. */
export function listingFromUrl(url: string): ShowingListing | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let ownHost = OWN_HOSTS.has(u.hostname);
  try {
    ownHost ||= u.hostname === new URL(publicOrigin()).hostname;
  } catch {
    /* no configured origin */
  }
  const m = u.pathname.match(/^\/mls\/([^/?#]+)\/?$/);
  if (!ownHost || !m) return null;
  const slug = decodeURIComponent(m[1]);
  const row: any = storage.getMlsListingBySeoSlug(slug) ?? storage.getMlsListingById(slug);
  if (!row) return null;
  const l = resolveShowingListing(row.id);
  return l.source === "mls" ? l : null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "407 kanell Drive NE" → "407 Kanell Drive NE": the feed sometimes leaves a street name lower-case. */
export function tidyAddress(a: string): string {
  return a.replace(/\b([a-z])([a-z]+)\b/g, (_m, f: string, rest: string) => f.toUpperCase() + rest);
}

/** The card for one listing; `href` is already attribute-encoded. */
export function listingCardHtml(l: ShowingListing, href: string): string {
  l = { ...l, address: tidyAddress(l.address) };
  // "$1.85M · 4 bd · 3.5 ba" → price on its own line, rooms under the address.
  const parts = (l.summary ?? "").split(" · ").filter(Boolean);
  const price = parts[0]?.startsWith("$") ? parts.shift()! : null;
  const rooms = parts.join(" · ");
  const font = `font-family:${EMAIL_FONT};`;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="max-width:480px;border:1px solid #e3e3e3;border-radius:6px;border-collapse:separate;margin:10px 0;">` +
    (l.photoUrl
      ? `<tr><td style="padding:0;"><a href="${href}" style="text-decoration:none;">` +
        `<img src="${esc(l.photoUrl)}" width="480" alt="${esc(l.address)}" ` +
        `style="display:block;width:100%;max-width:480px;height:auto;border:0;border-radius:6px 6px 0 0;"></a></td></tr>`
      : "") +
    `<tr><td style="padding:14px 16px 16px;${font}">` +
    (price ? `<div style="font-size:18px;font-weight:bold;color:#111;">${esc(price)}</div>` : "") +
    `<div style="font-size:14px;color:#222;margin-top:3px;">${esc(l.address)}</div>` +
    (rooms ? `<div style="font-size:13px;color:#666;margin-top:3px;">${esc(rooms)}</div>` : "") +
    `<a href="${href}" style="display:inline-block;margin-top:12px;background:#111;color:#ffffff;text-decoration:none;` +
    `font-size:13px;${font}padding:9px 16px;border-radius:4px;">View listing</a>` +
    `</td></tr></table>`
  );
}

/** Cards for the site's listing links; the address line above one is dropped (the card has it). */
export function listingBlock(url: string): LinkBlock | null {
  const l = listingFromUrl(url);
  if (!l) return null;
  const street = l.address.split(",")[0].trim().toLowerCase();
  return {
    html: (href) => listingCardHtml(l, href),
    caption: (line) => !!street && line.trim().toLowerCase().startsWith(street),
  };
}

/** The HTML part of an email to a contact: tracked links, listing links as cards. */
export function emailHtml(text: string, trackingId: string): string {
  return plainTextToTrackedHtml(text, trackingId, { block: listingBlock });
}

/** Set up tracking for one email and build its HTML part; null if tracking can't be set up. */
export function trackedEmailHtml(
  text: string,
  to: string,
  subject: string,
  opts: { kind: string; contactFubId?: string | null },
): string | undefined {
  try {
    return emailHtml(text, createTrackedEmail(to, subject, { kind: opts.kind, channel: "gmail", contactFubId: opts.contactFubId ?? null }));
  } catch (e: any) {
    console.error("[email] tracking setup failed:", e?.message ?? e);
    return undefined;
  }
}
