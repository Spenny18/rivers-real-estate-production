// Instagram carousels for one of Spencer's listings (my-listings.ts): a run of
// 1080×1350 portrait slides in the editorial look of the open house carousel
// designed in Cowork for 720 52 Avenue SW (Cormorant Garamond display over
// Montserrat, black and white, full-bleed photos), drawn as SVG and
// rasterised by resvg like the other social graphics (listing-assets.ts).
//
// A carousel is a spec: an ordered list of slides, each one of the layouts
// below with an eyebrow, a headline, a body line, a list of points and the
// listing photos it shows. A plain spec is built from the listing's facts;
// Claude can write a better one, looking at the photos to pick them. Spencer
// edits the words and photos slide by slide, and the spec is saved per listing.
//
// Every slide carries the brokerage in its footer (RECA advertising rules).

import zlib from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { sqlite } from "./storage";
import { AGENT } from "./brand";
import { fetchListingPhoto } from "./rets-photos";
import {
  OCCASIONS,
  listingFacts,
  money,
  photoDataUri,
  placeLine,
  publicListingUrl,
  rasterise,
  saveAsset,
  streetLine,
  type ListingAsset,
  type Occasion,
} from "./listing-assets";
import { tidyAddress } from "./listing-card";
import type { MyListing } from "./my-listings";

export const SLIDE_W = 1080;
export const SLIDE_H = 1350;
export const MAX_SLIDES = 10;

const BLACK = "#0d0d0d";
const WHITE = "#ffffff";
const STONE = "#f4f4f4";
const SERIF = "Cormorant Garamond";
const SANS = "Montserrat";

export const CAROUSEL_LAYOUTS = {
  cover: { label: "Cover", photos: 1, points: "One line under the address, e.g. the open house date and time" },
  overview: { label: "Overview + key numbers", photos: 1, points: "Key numbers, one per line as value | label" },
  "dark-list": { label: "Photo + list (dark)", photos: 1, points: "Up to four short points" },
  "dark-columns": { label: "Photo + two columns (dark)", photos: 1, points: "Two columns, one per line as heading | text" },
  "dark-tags": { label: "Photo + paragraph (dark)", photos: 1, points: "Up to three short tags" },
  pair: { label: "Two photos (light)", photos: 2, points: "Up to three short points" },
  light: { label: "Headline + photo (light)", photos: 1, points: "Up to four short tags" },
  cta: { label: "Call to action", photos: 0, points: "Up to two bold lines, e.g. dates and times" },
} as const;
export type CarouselLayout = keyof typeof CAROUSEL_LAYOUTS;
const LAYOUT_KEYS = Object.keys(CAROUSEL_LAYOUTS) as [CarouselLayout, ...CarouselLayout[]];

export const slideSchema = z.object({
  layout: z.enum(LAYOUT_KEYS),
  eyebrow: z.string().max(80).default(""),
  headline: z.string().max(140).default(""),
  body: z.string().max(400).default(""),
  points: z.array(z.string().max(200)).max(6).default([]),
  photos: z.array(z.number().int().min(0).max(199)).max(2).default([]),
});
export type CarouselSlide = z.infer<typeof slideSchema>;

export const carouselSchema = z.object({
  occasion: z.enum(Object.keys(OCCASIONS) as [Occasion, ...Occasion[]]),
  slides: z.array(slideSchema).min(1).max(MAX_SLIDES),
});
export type CarouselSpec = z.infer<typeof carouselSchema>;

// ---- Text ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface TextStyle {
  size: number;
  font?: string;
  weight?: number;
  italic?: boolean;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  spacing?: number;
  upper?: boolean;
}

/** Average advance per character, as a share of the font size. */
function glyphWidth(s: TextStyle): number {
  if (s.font === SERIF) return s.italic ? 0.36 : 0.4;
  return (s.upper ? 0.7 : 0.56) + (s.weight && s.weight >= 600 ? 0.03 : 0);
}

function textWidth(text: string, s: TextStyle): number {
  return text.length * (s.size * glyphWidth(s) + (s.spacing ?? 0));
}

function txt(x: number, y: number, text: string, s: TextStyle): string {
  const shown = s.upper ? text.toUpperCase() : text;
  return (
    `<text x="${x}" y="${y}" font-family="${s.font ?? SANS}" font-size="${s.size}" font-weight="${s.weight ?? 400}"` +
    `${s.italic ? ` font-style="italic"` : ""} fill="${s.fill ?? WHITE}"` +
    `${s.anchor && s.anchor !== "start" ? ` text-anchor="${s.anchor}"` : ""}` +
    `${s.spacing ? ` letter-spacing="${s.spacing}"` : ""}>${esc(shown)}</text>`
  );
}

/** Greedy word wrap to `width`; explicit newlines break too. `cut` is true when text was left over. */
export function wrapText(text: string, s: TextStyle, width: number, maxLines: number): { lines: string[]; cut: boolean } {
  const per = s.size * glyphWidth(s) + (s.spacing ?? 0);
  const perLine = Math.max(4, Math.floor(width / per));
  const all: string[] = [];
  for (const p of text.split(/\n+/).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    let cur = "";
    for (const w of p.split(" ")) {
      if (!cur) cur = w;
      else if ((cur + " " + w).length <= perLine) cur += " " + w;
      else {
        all.push(cur);
        cur = w;
      }
    }
    all.push(cur);
  }
  // A single word wider than the line also counts as not fitting, so fit() shrinks it.
  const cut = all.length > maxLines || all.some((l) => l.length > perLine);
  const lines = all.slice(0, maxLines);
  if (all.length > maxLines && lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/[\s,.;:—-]*$/, "") + "…";
  return { lines, cut };
}

/** The largest size from `size` down to `min` at which the text fits in `maxLines`. */
function fit(text: string, s: TextStyle, width: number, maxLines: number, min: number): { lines: string[]; size: number } {
  for (let size = s.size; size >= min; size = Math.floor(size * 0.94)) {
    const r = wrapText(text, { ...s, size }, width, maxLines);
    if (!r.cut) return { lines: r.lines, size };
  }
  return { lines: wrapText(text, { ...s, size: min }, width, maxLines).lines, size: min };
}

// ---- Pieces -------------------------------------------------------------------------

function photo(uri: string | null, x: number, y: number, w: number, h: number, dark: boolean): string {
  if (!uri) {
    return (
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${dark ? "#3a3a3a" : "#d6d6d6"}"/>` +
      txt(x + w / 2, y + h / 2, "Photo", { size: 22, fill: dark ? "#8a8a8a" : "#6b6b6b", anchor: "middle", spacing: 4, upper: true })
    );
  }
  return (
    `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image href="${uri}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/></svg>`
  );
}

function footer(left: string, n: number, total: number, dark: boolean, y = SLIDE_H - 50, x1 = 64, x2 = SLIDE_W - 64): string {
  const s: TextStyle = { size: 14, spacing: 3, upper: true, fill: dark ? "#9a9a9a" : "#6b6b6b" };
  const pad = (k: number) => String(k).padStart(2, "0");
  return txt(x1, y, left, s) + txt(x2, y, `${pad(n)} / ${pad(total)}`, { ...s, anchor: "end" });
}

const BRAND_LINE = `${AGENT.name} · ${AGENT.brokerage}`;

/** Lines of text set from `y` (the first baseline) down; returns the svg and the next free y. */
function block(lines: string[], x: number, y: number, s: TextStyle, lineH: number): { svg: string; y: number } {
  return { svg: lines.map((l, i) => txt(x, y + i * lineH, l, s)).join(""), y: y + (lines.length - 1) * lineH };
}

function splitPair(p: string): [string, string] {
  const i = p.indexOf("|");
  return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
}

// ---- Layouts ------------------------------------------------------------------------

interface Ctx {
  n: number;
  total: number;
  photos: Array<string | null>;
}

const M = 64;
const CW = SLIDE_W - M * 2;
const FOOT_TOP = SLIDE_H - 90; // content stops above this

function cover(s: CarouselSlide, c: Ctx): string {
  const out: string[] = [`<rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${BLACK}"/>`, photo(c.photos[0], 0, 0, SLIDE_W, 780, true)];
  if (s.eyebrow) {
    const st: TextStyle = { size: 16, spacing: 6, upper: true, weight: 500 };
    const w = Math.min(CW, textWidth(s.eyebrow, st) + 36);
    out.push(`<rect x="${M}" y="48" width="${w}" height="46" fill="${BLACK}"/>`, txt(M + 18, 77, s.eyebrow, st));
  }
  let y = 780 + 56;
  const h = fit(s.headline, { size: 132, font: SERIF, weight: 500 }, CW, 2, 76);
  y += Math.round(h.size * 0.78);
  const hb = block(h.lines, M, y, { size: h.size, font: SERIF, weight: 500 }, Math.round(h.size * 0.9));
  out.push(hb.svg);
  y = hb.y;
  if (s.body) {
    const b = fit(s.body, { size: 46, font: SERIF, italic: true }, CW, 1, 30);
    y += 18 + Math.round(b.size * 0.95);
    out.push(txt(M, y, b.lines[0], { size: b.size, font: SERIF, italic: true, fill: "#d9d9d9" }));
  }
  y += 34;
  out.push(`<rect x="${M}" y="${y}" width="${CW}" height="1" fill="#4d4d4d"/>`);
  y += 50;
  const swipe: TextStyle = { size: 20, spacing: 3, upper: true, fill: "#b5b5b5", anchor: "end" };
  out.push(txt(SLIDE_W - M, y, "Swipe →", swipe));
  const line = s.points[0];
  if (line) {
    const d = fit(line, { size: 24, spacing: 3, upper: true, weight: 600 }, CW - 200, 1, 15);
    out.push(txt(M, y, d.lines[0], { size: d.size, spacing: 3, upper: true, weight: 600 }));
  }
  out.push(footer(BRAND_LINE, c.n, c.total, true));
  return out.join("\n");
}

function overview(s: CarouselSlide, c: Ctx, l: MyListing): string {
  const out: string[] = [`<rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${WHITE}"/>`];
  const top: TextStyle = { size: 16, spacing: 5, upper: true, fill: "#555555" };
  out.push(txt(M, M + 14, s.eyebrow || streetLine(l), top));
  const right = l.community ? tidyAddress(l.community.toLowerCase()) : "";
  if (right) out.push(txt(SLIDE_W - M, M + 14, right, { ...top, anchor: "end" }));
  let y = M + 16 + 40;
  out.push(photo(c.photos[0], M, y, CW, 560, false));
  y += 560 + 40;
  const h = fit(s.headline, { size: 84, font: SERIF, weight: 500 }, CW, 2, 56);
  y += Math.round(h.size * 0.78);
  const hb = block(h.lines, M, y, { size: h.size, font: SERIF, weight: 500, fill: "#111111" }, Math.round(h.size * 1.0));
  out.push(hb.svg);
  y = hb.y;
  if (s.body) {
    const b = fit(s.body, { size: 34, font: SERIF, italic: true }, CW, 2, 26);
    y += 22 + b.size;
    const bb = block(b.lines, M, y, { size: b.size, font: SERIF, italic: true, fill: "#4d4d4d" }, Math.round(b.size * 1.2));
    out.push(bb.svg);
    y = bb.y;
  }
  const stats = s.points.map(splitPair).filter(([v]) => v).slice(0, 4);
  if (stats.length) {
    y += 40;
    const gh = 150;
    const gridTop = Math.min(y, FOOT_TOP - gh - 10);
    out.push(`<rect x="${M}" y="${gridTop}" width="${CW}" height="1" fill="#111111"/>`);
    out.push(`<rect x="${M}" y="${gridTop + gh}" width="${CW}" height="1" fill="#111111"/>`);
    const cw = CW / stats.length;
    stats.forEach(([value, label], i) => {
      const x = M + i * cw + (i ? 28 : 0);
      if (i) out.push(`<rect x="${M + i * cw}" y="${gridTop}" width="1" height="${gh}" fill="#cccccc"/>`);
      const v = fit(value, { size: 60, font: SERIF, weight: 500 }, cw - 36, 1, 30);
      out.push(txt(x, gridTop + 28 + Math.round(v.size * 0.8), v.lines[0], { size: v.size, font: SERIF, weight: 500, fill: "#111111" }));
      const lb = fit(label, { size: 15, spacing: 3, upper: true }, cw - 36, 1, 11);
      out.push(txt(x, gridTop + gh - 28, lb.lines[0], { size: lb.size, spacing: 3, upper: true, fill: "#555555" }));
    });
  }
  out.push(footer(BRAND_LINE, c.n, c.total, false));
  return out.join("\n");
}

/** Dark slides: a photo across the top, words on black below. */
function darkSlide(s: CarouselSlide, c: Ctx, kind: "dark-list" | "dark-columns" | "dark-tags"): string {
  const photoH = kind === "dark-list" ? 760 : 700;
  const out: string[] = [`<rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${BLACK}"/>`, photo(c.photos[0], 0, 0, SLIDE_W, photoH, true)];
  let y = photoH + 56;
  if (s.eyebrow) {
    y += 14;
    out.push(txt(M, y, s.eyebrow, { size: 16, spacing: 6, upper: true, fill: "#b5b5b5" }));
    y += 22;
  }
  const h = fit(s.headline, { size: kind === "dark-tags" ? 84 : 76, font: SERIF, weight: 500 }, CW, 2, 52);
  y += Math.round(h.size * 0.8);
  const hb = block(h.lines, M, y, { size: h.size, font: SERIF, weight: 500 }, Math.round(h.size * 1.0));
  out.push(hb.svg);
  y = hb.y;
  if (s.body) {
    const b = fit(s.body, { size: 34, font: SERIF, italic: true }, CW, 3, 26);
    y += 18 + b.size;
    const bb = block(b.lines, M, y, { size: b.size, font: SERIF, italic: true, fill: "#d9d9d9" }, Math.round(b.size * 1.25));
    out.push(bb.svg);
    y = bb.y;
  }
  const room = (need: number) => y + need <= FOOT_TOP;
  if (kind === "dark-list") {
    y += 14;
    for (const p of s.points.slice(0, 4)) {
      const st: TextStyle = { size: 22, fill: "#e0e0e0" };
      const r = wrapText(`— ${p}`, st, CW, 2);
      if (!room(r.lines.length * 31 + 12)) break;
      y += 12 + 31;
      const pb = block(r.lines, M, y, st, 31);
      out.push(pb.svg);
      y = pb.y;
    }
  } else if (kind === "dark-columns") {
    const cols = s.points.map(splitPair).slice(0, 2);
    if (cols.length) {
      y += 30;
      const gap = 40;
      const cw = (CW - gap) / 2;
      let bottom = y;
      cols.forEach(([head, body], i) => {
        const x = M + i * (cw + gap);
        out.push(`<rect x="${x}" y="${y}" width="${cw}" height="1" fill="#4d4d4d"/>`);
        out.push(txt(x, y + 20 + 14, head, { size: 15, spacing: 4, upper: true, fill: "#9a9a9a" }));
        const lines = Math.max(1, Math.floor((FOOT_TOP - (y + 70)) / 32) + 1);
        const r = wrapText(body, { size: 22 }, cw, Math.min(5, lines));
        const bb = block(r.lines, x, y + 34 + 10 + 26, { size: 22, fill: "#e0e0e0" }, 32);
        out.push(bb.svg);
        bottom = Math.max(bottom, bb.y);
      });
      y = bottom;
    }
  } else {
    const tags = s.points.slice(0, 3);
    if (tags.length && room(60)) {
      y += 30;
      out.push(`<rect x="${M}" y="${y}" width="${CW}" height="1" fill="#4d4d4d"/>`);
      tags.forEach((t, i) => {
        const cw = (CW - 48) / 3;
        const f = fit(t, { size: 15, spacing: 3, upper: true }, cw, 1, 11);
        out.push(txt(M + i * (cw + 24), y + 22 + 14, f.lines[0], { size: f.size, spacing: 3, upper: true, fill: "#cccccc" }));
      });
    }
  }
  out.push(footer(BRAND_LINE, c.n, c.total, true));
  return out.join("\n");
}

/** Two photos side by side on stone. */
function pair(s: CarouselSlide, c: Ctx): string {
  const out: string[] = [`<rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${STONE}"/>`];
  let y = M + 14;
  if (s.eyebrow) out.push(txt(M, y, s.eyebrow, { size: 16, spacing: 6, upper: true, fill: "#555555" }));
  y += 36;
  const h = fit(s.headline, { size: 84, font: SERIF, weight: 500 }, CW, 2, 52);
  y += Math.round(h.size * 0.8);
  const hb = block(h.lines, M, y, { size: h.size, font: SERIF, weight: 500, fill: "#111111" }, Math.round(h.size * 1.0));
  out.push(hb.svg);
  y = hb.y + 48;
  const pts = s.points.slice(0, 3);
  const photoH = Math.min(640, FOOT_TOP - y - (pts.length ? 130 : 20));
  const pw = (CW - 20) / 2;
  out.push(photo(c.photos[0], M, y, pw, photoH, false), photo(c.photos[1] ?? null, M + pw + 20, y, pw, photoH, false));
  y += photoH + 36;
  if (pts.length) {
    out.push(`<rect x="${M}" y="${y}" width="${CW}" height="1" fill="#111111"/>`);
    const cw = (CW - 48) / 3;
    pts.forEach((p, i) => {
      const r = wrapText(p, { size: 20 }, cw, 2);
      out.push(block(r.lines, M + i * (cw + 24), y + 24 + 20, { size: 20, fill: "#333333" }, 28).svg);
    });
  }
  out.push(footer(BRAND_LINE, c.n, c.total, false));
  return out.join("\n");
}

/** Headline over a framed photo on white. */
function light(s: CarouselSlide, c: Ctx): string {
  const out: string[] = [`<rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${WHITE}"/>`];
  let y = M + 14;
  if (s.eyebrow) {
    const e = fit(s.eyebrow, { size: 16, spacing: 6, upper: true }, CW, 1, 12);
    out.push(txt(M, y, e.lines[0], { size: e.size, spacing: 6, upper: true, fill: "#555555" }));
  }
  y += 36;
  const h = fit(s.headline, { size: 92, font: SERIF, weight: 500 }, CW, 2, 56);
  y += Math.round(h.size * 0.78);
  const hb = block(h.lines, M, y, { size: h.size, font: SERIF, weight: 500, fill: "#111111" }, Math.round(h.size * 0.95));
  out.push(hb.svg);
  y = hb.y + 40;
  const b = s.body ? fit(s.body, { size: 36, font: SERIF, italic: true }, CW, 3, 26) : null;
  const bodyH = b ? b.lines.length * Math.round(b.size * 1.3) + 36 : 0;
  const tags = s.points.slice(0, 4);
  const photoH = Math.max(320, Math.min(560, FOOT_TOP - y - bodyH - (tags.length ? 90 : 10)));
  out.push(photo(c.photos[0], M, y, CW, photoH, false));
  y += photoH;
  if (b) {
    y += 36 + b.size;
    const bb = block(b.lines, M, y, { size: b.size, font: SERIF, italic: true, fill: "#333333" }, Math.round(b.size * 1.3));
    out.push(bb.svg);
    y = bb.y;
  }
  if (tags.length && y + 70 <= FOOT_TOP + 20) {
    y += 36;
    out.push(`<rect x="${M}" y="${y}" width="${CW}" height="1" fill="#111111"/>`);
    const cw = CW / tags.length;
    tags.forEach((t, i) => {
      const f = fit(t, { size: 15, spacing: 3, upper: true }, cw - 16, 1, 11);
      out.push(txt(M + i * cw, y + 22 + 14, f.lines[0], { size: f.size, spacing: 3, upper: true, fill: "#333333" }));
    });
  }
  out.push(footer(BRAND_LINE, c.n, c.total, false));
  return out.join("\n");
}

/** The closing slide: the invitation, the address, and the contact block. */
function cta(s: CarouselSlide, c: Ctx): string {
  const cx = SLIDE_W / 2;
  const W = SLIDE_W - 144;
  const out: string[] = [`<rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${WHITE}"/>`];
  let y = 80 + 14;
  if (s.eyebrow) out.push(txt(cx, y, s.eyebrow, { size: 16, spacing: 6, upper: true, fill: "#555555", anchor: "middle" }));
  y += 30;
  const h = fit(s.headline, { size: 120, font: SERIF, weight: 500 }, W, 2, 64);
  y += Math.round(h.size * 0.8);
  const hb = block(h.lines, cx, y, { size: h.size, font: SERIF, weight: 500, fill: "#111111", anchor: "middle" }, Math.round(h.size * 0.95));
  out.push(hb.svg);
  y = hb.y + 44;
  out.push(`<rect x="${cx - 60}" y="${y}" width="120" height="1" fill="#111111"/>`);
  y += 30;
  for (const p of s.points.slice(0, 2)) {
    const f = fit(p, { size: 30, spacing: 4, upper: true, weight: 600 }, W, 1, 18);
    y += 10 + f.size;
    out.push(txt(cx, y, f.lines[0], { size: f.size, spacing: 4, upper: true, weight: 600, fill: "#111111", anchor: "middle" }));
  }
  const lines = s.body.split(/\n+/).map((t) => t.trim()).filter(Boolean);
  if (lines[0]) {
    const f = fit(lines[0], { size: 44, font: SERIF, italic: true }, W, 1, 28);
    y += 30 + f.size;
    out.push(txt(cx, y, f.lines[0], { size: f.size, font: SERIF, italic: true, fill: "#333333", anchor: "middle" }));
  }
  if (lines[1]) {
    const f = fit(lines[1], { size: 20, spacing: 2 }, W, 1, 14);
    y += 30 + f.size;
    out.push(txt(cx, y, f.lines[0], { size: f.size, spacing: 2, fill: "#555555", anchor: "middle" }));
  }
  // Contact block, pinned above the footer.
  const bTop = SLIDE_H - 64 - 34 - 236;
  out.push(`<rect x="72" y="${bTop}" width="${SLIDE_W - 144}" height="236" fill="${BLACK}"/>`);
  out.push(txt(cx, bTop + 44 + 44, AGENT.name, { size: 52, font: SERIF, weight: 500, anchor: "middle" }));
  out.push(txt(cx, bTop + 44 + 44 + 46, `${AGENT.phone} · ${AGENT.site}`, { size: 22, spacing: 3, anchor: "middle" }));
  out.push(txt(cx, bTop + 44 + 44 + 46 + 38, AGENT.brokerage, { size: 15, spacing: 4, upper: true, fill: "#b5b5b5", anchor: "middle" }));
  out.push(footer("Save & share with someone who should see it", c.n, c.total, false, SLIDE_H - 64, 72, SLIDE_W - 72));
  return out.join("\n");
}

/** One slide as SVG; `photos` are data: URIs (or null) for the slide's own photos, in order. */
export function slideSvg(l: MyListing, spec: CarouselSpec, index: number, photos: Array<string | null>): string {
  const s = spec.slides[index];
  const c: Ctx = { n: index + 1, total: spec.slides.length, photos };
  let body: string;
  switch (s.layout) {
    case "cover":
      body = cover(s, c);
      break;
    case "overview":
      body = overview(s, c, l);
      break;
    case "pair":
      body = pair(s, c);
      break;
    case "light":
      body = light(s, c);
      break;
    case "cta":
      body = cta(s, c);
      break;
    default:
      body = darkSlide(s, c, s.layout);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SLIDE_W}" height="${SLIDE_H}" viewBox="0 0 ${SLIDE_W} ${SLIDE_H}">\n${body}\n</svg>`;
}

export async function renderSlide(l: MyListing, spec: CarouselSpec, index: number, width = SLIDE_W): Promise<Buffer> {
  const s = spec.slides[index];
  const want = s.photos.slice(0, CAROUSEL_LAYOUTS[s.layout].photos);
  const photos = await Promise.all(want.map((i) => photoDataUri(l, i)));
  return rasterise(slideSvg(l, spec, index, photos), width, WHITE);
}

// ---- The plain carousel -------------------------------------------------------------

export function shortPrice(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(3).replace(/\.?0+$/, "")}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return money(n);
}

/** The numbers on the overview slide, as `value | label` lines. */
export function keyNumbers(l: MyListing, o: { occasion: Occasion; showSoldPrice?: boolean }): string[] {
  const out: string[] = [];
  if (l.beds != null) out.push(`${l.beds} | Bedrooms`);
  if (l.baths != null) out.push(`${l.baths} | Bathrooms`);
  if (l.sqft) out.push(`${l.sqft.toLocaleString("en-CA")} | Sq Ft`);
  if (o.occasion === "just-sold") {
    if (o.showSoldPrice && l.closePrice) out.push(`${shortPrice(l.closePrice)} | Sold For`);
    else if (l.yearBuilt) out.push(`${l.yearBuilt} | Built`);
  } else if (l.listPrice) out.push(`${shortPrice(l.listPrice)} | Offered At`);
  else if (l.yearBuilt) out.push(`${l.yearBuilt} | Built`);
  return out.slice(0, 4);
}

function sentences(text: string | null): string[] {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

/** The closing slide's address and price lines. */
function ctaBody(l: MyListing, o: { occasion: Occasion; showSoldPrice?: boolean }): string {
  const where = [streetLine(l), l.city ? tidyAddress(l.city.toLowerCase()) : null].filter(Boolean).join(", ");
  const price =
    o.occasion === "just-sold"
      ? o.showSoldPrice && l.closePrice
        ? `Sold for ${money(l.closePrice)}`
        : "Sold"
      : l.listPrice
        ? `Offered at ${money(l.listPrice)}`
        : "";
  return `${where}\n${[price, `MLS® ${l.id}`].filter(Boolean).join(" · ")}`;
}

const CTA_HEADLINE: Record<Occasion, string> = {
  "just-listed": "Book your\nprivate showing.",
  "coming-soon": "Be first\nthrough the door.",
  "open-house": "Join us\nthis weekend.",
  "new-price": "Book your\nprivate showing.",
  "under-contract": "Looking for\nsomething similar?",
  "just-sold": "Thinking of\nselling?",
};

/** A carousel built from the listing's facts alone, for when Claude hasn't written one. */
export function defaultCarousel(l: MyListing, o: { occasion: Occasion; detail?: string; showSoldPrice?: boolean }): CarouselSpec {
  const place = l.community ? tidyAddress(l.community.toLowerCase()) : placeLine(l);
  const fresh = l.yearBuilt && l.yearBuilt >= new Date().getFullYear() - 1;
  const kind = l.propertySubType ? tidyAddress(l.propertySubType.toLowerCase()) : null;
  const said = sentences(l.remarks);
  const n = Math.max(1, l.photoCount);
  const p = (i: number) => Math.min(i, n - 1);
  const slides: CarouselSlide[] = [
    {
      layout: "cover",
      eyebrow: [fresh ? "New Build" : kind, place].filter(Boolean).join(" · "),
      headline: OCCASIONS[o.occasion],
      body: [streetLine(l), l.city ? tidyAddress(l.city.toLowerCase()) : null].filter(Boolean).join(", "),
      points: [o.detail || [l.beds != null && `${l.beds} Bed`, l.baths != null && `${l.baths} Bath`].filter(Boolean).join(" · ")].filter(Boolean),
      photos: [0],
    },
    {
      layout: "overview",
      eyebrow: "",
      headline: kind && place ? `${kind} in ${place}.` : `${streetLine(l)}.`,
      body: said[0] ?? "",
      points: keyNumbers(l, o),
      photos: [p(1)],
    },
  ];
  if (said.length > 1) {
    slides.push({ layout: "dark-list", eyebrow: "The Highlights", headline: "A closer look.", body: "", points: said.slice(1, 4), photos: [p(2)] });
  }
  if (n > 4) {
    const facts = [
      l.yearBuilt && `Built in ${l.yearBuilt}`,
      l.garageSpaces && `${l.garageSpaces}-car garage`,
      l.lotSqft && `${l.lotSqft.toLocaleString("en-CA")} sq ft lot`,
      l.condoFee && `Condo fee ${money(l.condoFee)}/mo`,
    ].filter((v): v is string => !!v);
    slides.push({ layout: "pair", eyebrow: "Inside", headline: "Made for everyday living.", body: "", points: facts.slice(0, 3), photos: [p(3), p(4)] });
  }
  if (place) {
    slides.push({ layout: "dark-tags", eyebrow: "The Neighbourhood", headline: `${place}.`, body: placeLine(l), points: [], photos: [p(5)] });
  }
  slides.push({
    layout: "cta",
    eyebrow: o.occasion === "open-house" ? "You're Invited" : "Let's Talk",
    headline: CTA_HEADLINE[o.occasion],
    body: ctaBody(l, o),
    points: o.occasion === "open-house" && o.detail ? [o.detail] : [],
    photos: [],
  });
  return { occasion: o.occasion, slides };
}

// ---- Saved carousels ----------------------------------------------------------------

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS listing_carousels (
    listing_id TEXT PRIMARY KEY,
    spec TEXT NOT NULL,
    model TEXT,
    updated_at TEXT NOT NULL
  );
`);

export interface SavedCarousel {
  spec: CarouselSpec;
  model: string | null;
  updatedAt: string;
}

export function getCarousel(listingId: string): SavedCarousel | null {
  const r = sqlite.prepare("SELECT * FROM listing_carousels WHERE listing_id = ?").get(listingId) as any;
  if (!r) return null;
  const parsed = carouselSchema.safeParse(JSON.parse(r.spec));
  return parsed.success ? { spec: parsed.data, model: r.model, updatedAt: r.updated_at } : null;
}

export function saveCarousel(listingId: string, spec: CarouselSpec, model: string | null = null): SavedCarousel {
  const updatedAt = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO listing_carousels (listing_id, spec, model, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(listing_id) DO UPDATE SET spec = excluded.spec, model = COALESCE(excluded.model, listing_carousels.model), updated_at = excluded.updated_at`,
    )
    .run(listingId, JSON.stringify(spec), model, updatedAt);
  return { spec, model, updatedAt };
}

export function deleteCarousel(listingId: string): boolean {
  return sqlite.prepare("DELETE FROM listing_carousels WHERE listing_id = ?").run(listingId).changes > 0;
}

// ---- Written by Claude --------------------------------------------------------------

const MODEL = process.env.LISTING_ASSETS_MODEL?.trim() || "claude-sonnet-5-5";
const MAX_PHOTOS_SHOWN = 20;

const CAROUSEL_SYSTEM = `You plan Instagram carousels for ${AGENT.name} of ${AGENT.business} (brokerage: ${AGENT.brokerage}), a luxury-focused REALTOR® in Calgary, Alberta.

The carousel is a run of 1080×1350 slides in an editorial black-and-white look: a large serif headline, a small uppercase eyebrow, short supporting copy and full-bleed listing photos. Each slide uses one layout:

${Object.entries(CAROUSEL_LAYOUTS)
  .map(([k, v]) => `- ${k}: ${v.label}. ${v.photos} photo${v.photos === 1 ? "" : "s"}. points: ${v.points}.`)
  .join("\n")}

How to plan it:
- 7 or 8 slides. Slide 1 is "cover", slide 2 is "overview", the last is "cta". Between them, walk through the home the way a showing would (main floor, primary suite, other bedrooms or lower level, standout extras like a suite or garage, then the neighbourhood), alternating dark and light layouts.
- Headlines: 2–7 words, a confident line rather than a label ("A kitchen built to gather around."). End with a full stop. Use \\n for a deliberate line break in the cover and cta headlines only.
- Eyebrows: 2–5 words, e.g. "The Main Floor". The overview eyebrow stays empty (the address goes there).
- body: one sentence, under 140 characters, on dark-tags, light and overview slides; empty elsewhere except: the cover's body is the street address and city; the cta's body is two lines, the street address and city, then "Offered at $X · MLS® N" (or no price for a sold listing unless a sold price is in the facts).
- points: short, concrete, each under 70 characters. Overview points are "value | label" (e.g. "6 | Bedrooms", "$1.399M | Offered At"). dark-columns points are "heading | text".
- The cover's points hold one line: the open house dates and times when the occasion has them, otherwise a short line like "5 Bed · 4 Bath · 3,420 Sq Ft".
- photos: indexes of the listing photos shown to you. Choose the photo that shows what the slide talks about; the cover gets the strongest exterior. Don't reuse a photo unless there are too few.

Rules:
- Use only the facts given and what the photos plainly show. Never invent features, measurements, prices, dates or school catchments.
- Fair housing: describe the property and location, never the kind of people who should live there.
- Canadian spelling. Avoid clichés ("nestled", "boasts", "dream home", "won't last long").

Also write the Instagram caption to post with the carousel: a first line that stops the scroll, 3–5 short paragraphs, a call to action (DM or link in bio), the brokerage named (${AGENT.brokerage}), and 8–12 relevant hashtags at the end. Under 2,000 characters, no links.

Answer by calling the carousel tool.`;

const CAROUSEL_TOOL: Anthropic.Tool = {
  name: "carousel",
  description: "The planned carousel and its caption.",
  input_schema: {
    type: "object",
    properties: {
      slides: {
        type: "array",
        minItems: 3,
        maxItems: MAX_SLIDES,
        items: {
          type: "object",
          properties: {
            layout: { type: "string", enum: LAYOUT_KEYS },
            eyebrow: { type: "string" },
            headline: { type: "string" },
            body: { type: "string" },
            points: { type: "array", items: { type: "string" } },
            photos: { type: "array", items: { type: "integer" } },
          },
          required: ["layout", "eyebrow", "headline", "body", "points", "photos"],
        },
      },
      caption: { type: "string" },
    },
    required: ["slides", "caption"],
  },
};

/** Keep a written slide inside the limits the renderer and the listing allow. */
export function tidySlides(raw: unknown[], photoCount: number): CarouselSlide[] {
  const out: CarouselSlide[] = [];
  for (const r of raw) {
    const x = r as Record<string, unknown>;
    const parsed = slideSchema.safeParse({
      layout: x.layout,
      eyebrow: String(x.eyebrow ?? "").slice(0, 80),
      headline: String(x.headline ?? "").slice(0, 140),
      body: String(x.body ?? "").slice(0, 400),
      points: Array.isArray(x.points) ? x.points.slice(0, 6).map((p) => String(p).slice(0, 200)) : [],
      photos: Array.isArray(x.photos)
        ? x.photos.map((p) => Math.trunc(Number(p))).filter((p) => Number.isFinite(p) && p >= 0 && p < Math.max(1, photoCount)).slice(0, 2)
        : [],
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out.slice(0, MAX_SLIDES);
}

export async function writeCarousel(
  l: MyListing,
  o: { occasion: Occasion; detail?: string; showSoldPrice?: boolean; notes?: string },
): Promise<{ carousel: SavedCarousel; caption: ListingAsset }> {
  let slides: CarouselSlide[];
  let caption: string;
  let model: string;
  if (process.env.LISTING_ASSETS_FAKE === "1") {
    slides = defaultCarousel(l, o).slides;
    caption = `[Carousel caption] ${OCCASIONS[o.occasion]}: ${streetLine(l)} · ${AGENT.brokerage}`;
    model = "fake";
  } else {
    const shown = Math.min(l.photoCount, MAX_PHOTOS_SHOWN);
    const images: Anthropic.ContentBlockParam[] = [];
    for (let i = 0; i < shown; i++) {
      const p = await fetchListingPhoto(l.id, i, l.listingKey).catch(() => null);
      const type = p?.contentType.split(";")[0].trim();
      if (!p || !type || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) continue;
      images.push({ type: "text", text: `Photo ${i}:` });
      images.push({ type: "image", source: { type: "base64", media_type: type as "image/jpeg", data: p.body.toString("base64") } });
    }
    const facts = listingFacts(l, { ...o, link: publicListingUrl(l.id) });
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: CAROUSEL_SYSTEM,
      tools: [CAROUSEL_TOOL],
      tool_choice: { type: "tool", name: "carousel" },
      messages: [
        {
          role: "user",
          content: [
            ...images,
            {
              type: "text",
              text:
                (images.length ? `Those are the listing photos, by index.\n\n` : `No photos are available; use photos [0] throughout.\n\n`) +
                `<facts>\n${facts}\n</facts>` +
                (o.notes?.trim() ? `\n\nSpencer's notes for this carousel (follow them):\n${o.notes.trim()}` : ""),
            },
          ],
        },
      ],
    });
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to plan this carousel");
    const use = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const input = (use?.input ?? {}) as { slides?: unknown; caption?: unknown };
    slides = tidySlides(Array.isArray(input.slides) ? input.slides : [], l.photoCount);
    if (slides.length < 3) throw new Error("Claude's carousel came back incomplete; try again");
    caption = typeof input.caption === "string" ? input.caption.trim() : "";
    model = msg.model || MODEL;
  }
  const carousel = saveCarousel(l.id, { occasion: o.occasion, slides }, model);
  const asset = saveAsset({ listingId: l.id, kind: "instagram", occasion: o.occasion, content: caption || `${OCCASIONS[o.occasion]} · ${streetLine(l)} · ${AGENT.brokerage}`, model });
  return { carousel, caption: asset };
}

// ---- Zip ----------------------------------------------------------------------------

/** A stored (uncompressed) zip: PNGs don't shrink, and every unzip tool reads it. */
export function zipFiles(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = zlib.crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

export async function renderCarouselZip(l: MyListing, spec: CarouselSpec, slug: string): Promise<Buffer> {
  const files: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < spec.slides.length; i++) {
    files.push({ name: `${slug}-${String(i + 1).padStart(2, "0")}.png`, data: await renderSlide(l, spec, i) });
  }
  return zipFiles(files);
}
