// Marketing assets built from one of Spencer's Pillar 9 listings (my-listings.ts).
//
//   graphics   branded social images — square post, story, link/landscape —
//              for an occasion (Just Listed, New Price, Open House…), drawn as
//              SVG around a listing photo and rasterised by resvg with the
//              brand fonts the market report already bundles.
//   feature    a one-page feature sheet PDF (US Letter).
//   copy       captions, emails, scripts and remarks, written by Claude from
//              the listing's facts, saved so earlier versions stay at hand.
//
// RECA's advertising rules want the brokerage named on every ad, so it is on
// every graphic, the feature sheet, and in the copy prompt.

import Anthropic from "@anthropic-ai/sdk";
import { Resvg } from "@resvg/resvg-js";
import { sqlite, storage } from "./storage";
import { AGENT } from "./brand";
import { fontFiles, pngsToPdf } from "./report-pages";
import { fetchListingPhoto } from "./rets-photos";
import { tidyAddress } from "./listing-card";
import { publicOrigin } from "./origin";
import type { MyListing } from "./my-listings";

const INK = "#0A0A0A";
const MUTED = "#666666";
const RULE = "#E5E5E5";
const GOLD = "#D4AF37";
const PAPER = "#FFFFFF";
const FONT_SANS = "Manrope";
const FONT_SERIF = "Playfair Display";
const FONT_DISPLAY = "Cinzel";

export const OCCASIONS = {
  "just-listed": "Just Listed",
  "coming-soon": "Coming Soon",
  "open-house": "Open House",
  "new-price": "New Price",
  "under-contract": "Under Contract",
  "just-sold": "Just Sold",
} as const;
export type Occasion = keyof typeof OCCASIONS;

export const FORMATS = {
  square: { w: 1080, h: 1080, label: "Square post · 1080×1080" },
  story: { w: 1080, h: 1920, label: "Story / Reel cover · 1080×1920" },
  landscape: { w: 1200, h: 628, label: "Facebook / LinkedIn · 1200×628" },
} as const;
export type GraphicFormat = keyof typeof FORMATS;

/** The occasion a listing's status suggests. */
export function defaultOccasion(l: Pick<MyListing, "status" | "listPrice" | "originalListPrice">): Occasion {
  if (l.status === "Sold") return "just-sold";
  if (l.status === "Pending") return "under-contract";
  if (l.status === "Coming Soon") return "coming-soon";
  if (l.originalListPrice && l.listPrice && l.listPrice < l.originalListPrice) return "new-price";
  return "just-listed";
}

// ---- Facts --------------------------------------------------------------------------

export function money(n: number | null | undefined): string {
  return n == null ? "" : `$${n.toLocaleString("en-CA")}`;
}

export function streetLine(l: Pick<MyListing, "address">): string {
  return tidyAddress(l.address.split(",")[0].trim());
}

export function placeLine(l: Pick<MyListing, "community" | "city">): string {
  const city = l.city ? tidyAddress(l.city.toLowerCase()) : null;
  const community = l.community ? tidyAddress(l.community.toLowerCase()) : null;
  return [community, city].filter((v, i, a) => v && a.indexOf(v) === i).join(", ");
}

export function statsParts(l: Pick<MyListing, "beds" | "baths" | "sqft">): string[] {
  const out: string[] = [];
  if (l.beds) out.push(`${l.beds} Bed`);
  if (l.baths) out.push(`${l.baths} Bath`);
  if (l.sqft) out.push(`${l.sqft.toLocaleString("en-CA")} Sq Ft`);
  return out;
}

/** The public page for a listing that is on the site's MLS search, if it is. */
export function publicListingUrl(id: string): string | null {
  const row: any = storage.getMlsListingById(id);
  if (!row || row.removedAt) return null;
  try {
    return `${publicOrigin()}/mls/${storage.getMlsSeoSlug(row)}`;
  } catch {
    return null;
  }
}

// ---- SVG helpers --------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Greedy wrap by an average glyph width (no text metrics in SVG). */
export function wrap(text: string, size: number, width: number, maxLines: number, glyph = 0.54): string[] {
  const perLine = Math.max(8, Math.floor(width / (size * glyph)));
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= perLine) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const used = lines.join(" ").length;
  if (used < text.replace(/\s+/g, " ").trim().length && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[\s,.;:]*\S{0,12}$/, "") + "…";
  }
  return lines;
}

function t(x: number, y: number, s: string, o: { size: number; font?: string; weight?: number; fill?: string; anchor?: string; spacing?: number }) {
  return (
    `<text x="${x}" y="${y}" font-family="${o.font ?? FONT_SANS}" font-size="${o.size}" font-weight="${o.weight ?? 400}" ` +
    `fill="${o.fill ?? INK}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(s)}</text>`
  );
}

function photoOrPlaceholder(photo: string | null, x: number, y: number, w: number, h: number): string {
  if (!photo) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#1c1c1c"/>` +
      t(x + w / 2, y + h / 2, "RIVERS REAL ESTATE", { size: Math.round(w / 22), font: FONT_DISPLAY, fill: "#3a3a3a", anchor: "middle", spacing: 6 });
  }
  return `<image href="${photo}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`;
}

export interface GraphicOptions {
  occasion: Occasion;
  /** Open house date and time, or any line under the headline. */
  detail?: string;
  /** Show the sale price on a Just Sold graphic. Off by default. */
  showSoldPrice?: boolean;
}

function priceLine(l: MyListing, o: GraphicOptions): { price: string; was: string | null } {
  if (o.occasion === "just-sold") {
    return { price: o.showSoldPrice && l.closePrice ? `Sold for ${money(l.closePrice)}` : "", was: null };
  }
  const was = o.occasion === "new-price" && l.originalListPrice && l.listPrice && l.originalListPrice > l.listPrice ? money(l.originalListPrice) : null;
  return { price: money(l.listPrice), was };
}

/** One social graphic as SVG; `photo` is a data: URI or null. */
export function graphicSvg(l: MyListing, format: GraphicFormat, o: GraphicOptions, photo: string | null): string {
  const { w, h } = FORMATS[format];
  const headline = OCCASIONS[o.occasion].toUpperCase();
  const { price, was } = priceLine(l, o);
  const stats = statsParts(l).join("   ·   ");
  const street = streetLine(l);
  const place = placeLine(l);
  const brand = `${AGENT.name.toUpperCase()}  ·  ${AGENT.business.toUpperCase()}  ·  ${AGENT.brokerage.toUpperCase()}`;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${INK}" stop-opacity="0"/><stop offset="0.55" stop-color="${INK}" stop-opacity="0.72"/>` +
      `<stop offset="1" stop-color="${INK}" stop-opacity="0.96"/></linearGradient></defs>`,
  ];

  if (format === "landscape") {
    const pw = Math.round(w * 0.58);
    const px = pw + 48;
    const tw = w - px - 44;
    parts.push(photoOrPlaceholder(photo, 0, 0, pw, h));
    parts.push(`<rect x="${pw}" y="0" width="${w - pw}" height="${h}" fill="${INK}"/>`);
    parts.push(`<rect x="${px}" y="70" width="56" height="3" fill="${GOLD}"/>`);
    parts.push(t(px, 124, headline, { size: 34, font: FONT_DISPLAY, weight: 600, fill: GOLD, spacing: 4 }));
    let y = 176;
    if (o.detail) {
      for (const line of wrap(o.detail, 22, tw, 2)) {
        parts.push(t(px, y, line, { size: 22, weight: 600, fill: PAPER }));
        y += 30;
      }
      y += 10;
    }
    if (price) {
      parts.push(t(px, y + 40, price, { size: price.length > 14 ? 34 : 46, font: FONT_SERIF, weight: 600, fill: PAPER }));
      y += 56;
      if (was) {
        parts.push(t(px, y + 22, `Was ${was}`, { size: 20, fill: "#9a9a9a" }));
        y += 30;
      }
    }
    y += 30;
    for (const line of wrap(street, 26, tw, 2)) {
      parts.push(t(px, y, line, { size: 26, weight: 600, fill: PAPER }));
      y += 34;
    }
    if (place) parts.push(t(px, y, place, { size: 20, fill: "#bdbdbd" }));
    if (stats) parts.push(t(px, h - 112, stats, { size: 19, weight: 500, fill: PAPER }));
    parts.push(`<rect x="${px}" y="${h - 84}" width="${tw}" height="1" fill="#333"/>`);
    parts.push(t(px, h - 52, AGENT.name.toUpperCase(), { size: 16, font: FONT_DISPLAY, weight: 600, fill: PAPER, spacing: 3 }));
    parts.push(t(px, h - 28, `${AGENT.business} · ${AGENT.brokerage}`, { size: 14, fill: "#9a9a9a" }));
    parts.push("</svg>");
    return parts.join("\n");
  }

  // Square and story: the photo full-bleed, the copy over a fade at the foot.
  const story = format === "story";
  const m = 72;
  const tw = w - m * 2;
  parts.push(photoOrPlaceholder(photo, 0, 0, w, h));
  parts.push(`<rect x="0" y="${Math.round(h * (story ? 0.42 : 0.3))}" width="${w}" height="${Math.round(h * (story ? 0.58 : 0.7))}" fill="url(#fade)"/>`);
  // Occasion tag, top left.
  const tagSize = story ? 34 : 30;
  const tagW = Math.round(headline.length * tagSize * 0.86 + 56);
  parts.push(`<rect x="${m}" y="${story ? 140 : m}" width="${tagW}" height="${tagSize + 34}" fill="${INK}" fill-opacity="0.82" stroke="${GOLD}" stroke-width="2"/>`);
  parts.push(t(m + tagW / 2, (story ? 140 : m) + tagSize + 8, headline, { size: tagSize, font: FONT_DISPLAY, weight: 600, fill: GOLD, anchor: "middle", spacing: 5 }));

  // Bottom block, built upward from the brand line.
  let y = h - (story ? 150 : 64);
  parts.push(t(m, y, brand, { size: story ? 20 : 17, weight: 600, fill: "#cfcfcf", spacing: 2 }));
  y -= story ? 40 : 34;
  parts.push(`<rect x="${m}" y="${y}" width="${tw}" height="1" fill="#ffffff" fill-opacity="0.35"/>`);
  y -= story ? 44 : 36;
  if (stats) {
    parts.push(t(m, y, stats, { size: story ? 32 : 28, weight: 500, fill: PAPER }));
    y -= story ? 64 : 54;
  }
  if (place) {
    parts.push(t(m, y, place, { size: story ? 30 : 26, fill: "#d6d6d6" }));
    y -= story ? 50 : 42;
  }
  const streetSize = story ? 50 : 44;
  const streetLines = wrap(street, streetSize, tw, 2);
  for (const line of [...streetLines].reverse()) {
    parts.push(t(m, y, line, { size: streetSize, weight: 700, fill: PAPER }));
    y -= Math.round(streetSize * 1.2);
  }
  y -= 14;
  if (price) {
    const priceSize = price.length > 14 ? (story ? 64 : 56) : story ? 92 : 80;
    if (was) {
      parts.push(t(m, y, `Was ${was}`, { size: story ? 30 : 26, fill: "#a8a8a8" }));
      y -= story ? 48 : 42;
    }
    parts.push(t(m, y, price, { size: priceSize, font: FONT_SERIF, weight: 600, fill: PAPER }));
    y -= Math.round(priceSize * 1.05);
  }
  if (o.detail) {
    const lines = wrap(o.detail, story ? 34 : 30, tw, 2);
    for (const line of [...lines].reverse()) {
      parts.push(t(m, y, line, { size: story ? 34 : 30, weight: 700, fill: GOLD, spacing: 1 }));
      y -= story ? 46 : 40;
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/** The feature sheet: one US Letter page at 96 dpi; `photos` are data: URIs. */
export function featureSheetSvg(l: MyListing, photos: string[], o: { occasion?: Occasion; showSoldPrice?: boolean } = {}): string {
  const W = 816;
  const H = 1056;
  const M = 48;
  const CW = W - M * 2;
  const occasion = o.occasion ?? defaultOccasion(l);
  const { price, was } = priceLine(l, { occasion, showSoldPrice: o.showSoldPrice });
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  parts.push(`<rect width="${W}" height="${H}" fill="${PAPER}"/>`);
  parts.push(t(M, 58, AGENT.business.toUpperCase(), { size: 18, font: FONT_DISPLAY, weight: 600, spacing: 5 }));
  parts.push(t(W - M, 58, OCCASIONS[occasion].toUpperCase(), { size: 14, font: FONT_DISPLAY, weight: 600, fill: GOLD, anchor: "end", spacing: 4 }));
  parts.push(`<rect x="${M}" y="74" width="${CW}" height="1" fill="${RULE}"/>`);

  const heroH = photos.length > 1 ? 360 : 440;
  parts.push(photoOrPlaceholder(photos[0] ?? null, M, 92, CW, heroH));
  let y = 92 + heroH;
  if (photos.length > 1) {
    const gap = 12;
    const thumbs = photos.slice(1, 4);
    const tw = (CW - gap * (thumbs.length - 1)) / thumbs.length;
    thumbs.forEach((p, i) => parts.push(photoOrPlaceholder(p, M + i * (tw + gap), y + gap, tw, 120)));
    y += gap + 120;
  }

  y += 52;
  if (price) parts.push(t(M, y, price, { size: 36, font: FONT_SERIF, weight: 600 }));
  if (was) parts.push(t(W - M, y, `Was ${was}`, { size: 15, fill: MUTED, anchor: "end" }));
  y += price ? 34 : 0;
  parts.push(t(M, y, streetLine(l), { size: 20, weight: 700 }));
  y += 24;
  const place = [placeLine(l), l.postalCode].filter(Boolean).join(" · ");
  if (place) parts.push(t(M, y, place, { size: 14, fill: MUTED }));
  y += 26;

  // Fact strip.
  const facts: Array<[string, string]> = [];
  if (l.beds != null) facts.push(["Bedrooms", String(l.beds)]);
  if (l.baths != null) facts.push(["Bathrooms", String(l.baths)]);
  if (l.sqft) facts.push(["Living area", `${l.sqft.toLocaleString("en-CA")} sq ft`]);
  if (l.yearBuilt) facts.push(["Built", String(l.yearBuilt)]);
  if (l.lotSqft) facts.push(["Lot", `${l.lotSqft.toLocaleString("en-CA")} sq ft`]);
  else if (l.condoFee) facts.push(["Condo fee", `${money(l.condoFee)}/mo`]);
  parts.push(`<rect x="${M}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);
  if (facts.length) {
    const fw = CW / facts.length;
    facts.forEach(([k, v], i) => {
      parts.push(t(M + i * fw, y + 26, k.toUpperCase(), { size: 10, weight: 600, fill: MUTED, spacing: 1.5 }));
      parts.push(t(M + i * fw, y + 50, v, { size: 17, weight: 600 }));
    });
  }
  y += 68;
  parts.push(`<rect x="${M}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);
  y += 30;

  const footerTop = H - 110;
  if (l.remarks) {
    const lineH = 19;
    const maxLines = Math.max(0, Math.floor((footerTop - 24 - y) / lineH));
    for (const line of wrap(l.remarks, 13, CW, maxLines, 0.5)) {
      parts.push(t(M, y, line, { size: 13, fill: "#333333" }));
      y += lineH;
    }
  }

  parts.push(`<rect x="0" y="${footerTop}" width="${W}" height="${H - footerTop}" fill="${INK}"/>`);
  parts.push(t(M, footerTop + 40, AGENT.name.toUpperCase(), { size: 18, font: FONT_DISPLAY, weight: 600, fill: PAPER, spacing: 3 }));
  parts.push(t(M, footerTop + 64, AGENT.title, { size: 11, fill: "#bdbdbd" }));
  parts.push(t(M, footerTop + 86, `${AGENT.business} · ${AGENT.brokerage}`, { size: 12, fill: GOLD }));
  parts.push(t(W - M, footerTop + 40, AGENT.phone, { size: 15, weight: 600, fill: PAPER, anchor: "end" }));
  parts.push(t(W - M, footerTop + 62, AGENT.email, { size: 12, fill: "#bdbdbd", anchor: "end" }));
  parts.push(t(W - M, footerTop + 84, AGENT.site, { size: 12, fill: "#bdbdbd", anchor: "end" }));
  parts.push("</svg>");
  return parts.join("\n");
}

// ---- Rendering ----------------------------------------------------------------------

export function rasterise(svg: string, width: number, background = INK): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: FONT_SANS },
    background,
  });
  return Buffer.from(r.render().asPng());
}

/** A listing photo as a data: URI, or null when the feed has none for it. */
export async function photoDataUri(l: MyListing, index: number): Promise<string | null> {
  if (index < 0 || index >= l.photoCount) return null;
  try {
    const p = await fetchListingPhoto(l.id, index, l.listingKey);
    return p ? `data:${p.contentType};base64,${p.body.toString("base64")}` : null;
  } catch (e: any) {
    console.warn(`[listing-assets] photo ${l.id}/${index}:`, e?.message ?? e);
    return null;
  }
}

export async function renderGraphic(l: MyListing, format: GraphicFormat, o: GraphicOptions & { photo?: number }): Promise<Buffer> {
  const photo = await photoDataUri(l, o.photo ?? 0);
  return rasterise(graphicSvg(l, format, o, photo), FORMATS[format].w);
}

export async function renderFeatureSheet(l: MyListing, o: { occasion?: Occasion; showSoldPrice?: boolean; photos?: number[] } = {}): Promise<Buffer> {
  const wanted = (o.photos?.length ? o.photos : [0, 1, 2, 3]).slice(0, 4);
  const photos = (await Promise.all(wanted.map((i) => photoDataUri(l, i)))).filter((p): p is string => !!p);
  const png = rasterise(featureSheetSvg(l, photos, o), 816 * 2, PAPER);
  return pngsToPdf([png], { title: `${streetLine(l)} · Feature sheet`, subject: `MLS® ${l.id}` });
}

// ---- Copy ---------------------------------------------------------------------------

export const COPY_KINDS = {
  instagram: "Instagram caption",
  facebook: "Facebook post",
  linkedin: "LinkedIn post",
  email: "Email to my database",
  sms: "Text message",
  reel: "Reel / video script",
  remarks: "MLS® remarks rewrite",
} as const;
export type CopyKind = keyof typeof COPY_KINDS;

const KIND_BRIEF: Record<CopyKind, string> = {
  instagram:
    "An Instagram feed caption. A first line that stops the scroll, then 3–5 short paragraphs, a clear call to action (DM or link in bio), and 8–12 relevant hashtags on their own at the end (Calgary, the community, the property type). Under 2,000 characters. No links.",
  facebook: "A Facebook post. Warm and conversational, 80–180 words, a call to action, and the listing link on its own line if one is given.",
  linkedin: "A LinkedIn post. Professional, market-aware, 80–160 words, framed around value and the market, with the listing link if given. Two or three hashtags at most.",
  email:
    "An email to Spencer's database. First line `Subject: …`, then a blank line, then the body: a short greeting with {{first_name}}, why this home matters, the key facts as a short list, a call to action to book a showing, and the listing link if given. Under 220 words. No signature: the email client adds it.",
  sms: "A text message to past clients and buyers. Under 300 characters, personal, one call to action, the link if given. No hashtags, no emoji beyond one.",
  reel:
    "A 30–45 second talking-head Reel script for teleprompter delivery. A hook line, then short spoken lines (one sentence per line), with [B-ROLL: …] cues for the shots to film, ending in a call to action. Spoken language, not ad copy.",
  remarks:
    "Rewritten public MLS® remarks. Noun-dense and specific: the home's layout, finishes, systems, lot and location, in flowing sentences, so search engines and AI assistants can quote it. No contact details, no URLs, no agent names (MLS® rules). Under 1,000 characters.",
};

const SYSTEM = `You write listing marketing for ${AGENT.name}, ${AGENT.title}, of ${AGENT.business} (brokerage: ${AGENT.brokerage}), a luxury-focused REALTOR® in Calgary, Alberta (site: ${AGENT.site}).

Voice: refined, confident and warm; specific rather than gushing. Lead with what makes the home and its community distinctive. Canadian spelling. Avoid clichés ("nestled", "boasts", "dream home", "won't last long", "stunning" more than once).

Rules:
- Use only the facts given. Never invent features, measurements, prices, dates, or school catchments. If a fact is missing, leave it out.
- Never state a sold price unless one is given in the facts.
- Alberta (RECA) advertising: every public-facing piece other than MLS® remarks names the brokerage, ${AGENT.brokerage}.
- Fair housing: describe the property and location, never the kind of people who should live there.
- Reply with the finished text only: no preamble, no notes, no markdown headings.`;

export function listingFacts(l: MyListing, o: { occasion: Occasion; detail?: string; showSoldPrice?: boolean; link?: string | null }): string {
  const lines = [
    `Occasion: ${OCCASIONS[o.occasion]}${o.detail ? ` — ${o.detail}` : ""}`,
    `MLS® number: ${l.id}`,
    `Status: ${l.status}`,
    `Address: ${tidyAddress(l.address)}`,
    l.community && `Community: ${l.community}`,
    l.city && `City: ${l.city}`,
    l.listPrice && o.occasion !== "just-sold" && `List price: ${money(l.listPrice)}`,
    o.occasion === "new-price" && l.originalListPrice && l.listPrice && l.originalListPrice > l.listPrice && `Previous price: ${money(l.originalListPrice)}`,
    o.occasion === "just-sold" && o.showSoldPrice && l.closePrice && `Sold price: ${money(l.closePrice)}`,
    o.occasion === "just-sold" && l.role === "buyer" && `Spencer represented the buyer.`,
    l.daysOnMarket != null && o.occasion === "just-sold" && `Days on market: ${l.daysOnMarket}`,
    (l.propertyType || l.propertySubType) && `Type: ${[l.propertySubType, l.propertyType].filter(Boolean).join(" · ")}`,
    l.beds != null && `Bedrooms: ${l.beds}`,
    l.baths != null && `Bathrooms: ${l.baths}`,
    l.sqft && `Living area: ${l.sqft.toLocaleString("en-CA")} sq ft`,
    l.lotSqft && `Lot: ${l.lotSqft.toLocaleString("en-CA")} sq ft`,
    l.yearBuilt && `Year built: ${l.yearBuilt}`,
    l.garageSpaces && `Garage spaces: ${l.garageSpaces}`,
    l.condoFee && `Condo fee: ${money(l.condoFee)}/month`,
    o.link && `Listing link: ${o.link}`,
    l.remarks && `Public remarks (the listing's own description):\n${l.remarks}`,
  ];
  return lines.filter(Boolean).join("\n");
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS listing_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    occasion TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS listing_assets_listing ON listing_assets (listing_id, id);
`);

export interface ListingAsset {
  id: number;
  listingId: string;
  kind: CopyKind;
  occasion: Occasion;
  content: string;
  model: string | null;
  createdAt: string;
}

function assetFromRow(r: any): ListingAsset {
  return { id: r.id, listingId: r.listing_id, kind: r.kind, occasion: r.occasion, content: r.content, model: r.model, createdAt: r.created_at };
}

export function listAssets(listingId: string): ListingAsset[] {
  return (sqlite.prepare("SELECT * FROM listing_assets WHERE listing_id = ? ORDER BY id DESC LIMIT 200").all(listingId) as any[]).map(assetFromRow);
}

export function saveAsset(a: Omit<ListingAsset, "id" | "createdAt">): ListingAsset {
  const createdAt = new Date().toISOString();
  const id = Number(
    sqlite
      .prepare("INSERT INTO listing_assets (listing_id, kind, occasion, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(a.listingId, a.kind, a.occasion, a.content, a.model, createdAt).lastInsertRowid,
  );
  return { ...a, id, createdAt };
}

export function updateAsset(id: number, content: string): ListingAsset | null {
  sqlite.prepare("UPDATE listing_assets SET content = ? WHERE id = ?").run(content, id);
  const r = sqlite.prepare("SELECT * FROM listing_assets WHERE id = ?").get(id);
  return r ? assetFromRow(r) : null;
}

export function deleteAsset(id: number): boolean {
  return sqlite.prepare("DELETE FROM listing_assets WHERE id = ?").run(id).changes > 0;
}

const MODEL = process.env.LISTING_ASSETS_MODEL?.trim() || "claude-sonnet-5-5";

export function copyReady(): { ok: boolean; reason?: string } {
  if (process.env.LISTING_ASSETS_FAKE === "1" || process.env.ANTHROPIC_API_KEY) return { ok: true };
  return { ok: false, reason: "ANTHROPIC_API_KEY is not set on the server, so copy can't be written yet. Graphics and feature sheets still work." };
}

export async function generateCopy(
  l: MyListing,
  kind: CopyKind,
  o: { occasion: Occasion; detail?: string; showSoldPrice?: boolean; notes?: string },
): Promise<ListingAsset> {
  const facts = listingFacts(l, { ...o, link: kind === "remarks" ? null : publicListingUrl(l.id) });
  let content: string;
  let model: string;
  if (process.env.LISTING_ASSETS_FAKE === "1") {
    content = `[${COPY_KINDS[kind]}] ${OCCASIONS[o.occasion]}: ${streetLine(l)} · ${AGENT.brokerage}`;
    model = "fake";
  } else {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Write this: ${KIND_BRIEF[kind]}\n\n<facts>\n${facts}\n</facts>` +
            (o.notes?.trim() ? `\n\nSpencer's notes for this piece (follow them):\n${o.notes.trim()}` : ""),
        },
      ],
    });
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to write this piece");
    content = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!content) throw new Error("Claude returned no text");
    model = msg.model || MODEL;
  }
  return saveAsset({ listingId: l.id, kind, occasion: o.occasion, content, model });
}
