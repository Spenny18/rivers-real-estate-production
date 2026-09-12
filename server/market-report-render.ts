// The two-page community market report, rendered from the stats engine.
//
// This replaces the PDF Real Info Box produced per community and property
// type. Same two pages, same reading order, so a client who has received the
// old one recognises the new one:
//
//   Page 1  the price. Median sold price with month-over-month and
//           year-over-year change, a 13-month line, and ten-year annual
//           medians for the community and for the city it sits in.
//   Page 2  the activity. Active and sold counts, a 13-month comparison,
//           the listing absorption rate (sold ÷ active — the "odds of
//           selling"), and average days on market, each with 13 months of
//           history.
//
// Two departures from the original, both deliberate. The headline is a median
// of real sales rather than the board's modelled benchmark, by Spencer's
// choice, and it is labelled as a median everywhere. And the absorption donut
// is a meter with a hero number: a donut is the wrong form for one value.
//
// The pages are built as SVG with absolute coordinates — no layout engine —
// rasterised by resvg with the brand fonts bundled in server/assets/fonts,
// and bound into a PDF as two full-page images. Nothing here needs a browser.

import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { PDFDocument } from "pdf-lib";
import {
  annualMedians,
  CLASS_LABEL,
  currentPeriod,
  series,
  shiftPeriod,
  type ClassFilter,
  type MonthStats,
  type Scope,
  type YearStats,
} from "./market-stats";

// ---- Page geometry ------------------------------------------------------------

/** US Letter at 96 dpi. Rasterised at 2× for print. */
const W = 816;
const H = 1056;
const M = 40; // page margin
const LEFT_W = 250; // the stat column
const CHART_X = M + LEFT_W + 30;
const CHART_W = W - M - CHART_X;
const SECTION_Y = [200, 478, 756];
const SECTION_H = 262;

const INK = "#0A0A0A";
const INK_SOFT = "#333333";
const MUTED = "#666666";
const FAINT = "#999999";
const RULE = "#E5E5E5";
const TRACK = "#EEEEEE";
const GOLD = "#D4AF37";
const SURFACE = "#FFFFFF";

const FONT_SANS = "Manrope";
const FONT_SERIF = "Playfair Display";
const FONT_DISPLAY = "Cinzel";

// ---- Data -----------------------------------------------------------------------

export interface ReportData {
  scope: Scope;
  cls: ClassFilter;
  /** The month reported on, YYYY-MM. */
  period: string;
  title: string; // "Springbank Hill"
  subtitle: string; // "Detached"
  cityName: string; // the city the community sits in
  months: MonthStats[]; // 13, ending at `period`
  communityYears: YearStats[]; // 10
  cityYears: YearStats[]; // 10
  generatedAt: string;
}

/** Last complete month: a report dated the 12th should not show a half month. */
export function defaultReportPeriod(now = new Date()): string {
  return shiftPeriod(currentPeriod(now), -1);
}

export function buildReportData(scope: Scope, cls: ClassFilter, period = defaultReportPeriod()): ReportData {
  const cityName = scope.kind === "city" ? scope.name : scope.city ?? "Calgary";
  const cityScope: Scope = { kind: "city", name: cityName };
  const endYear = Number(period.slice(0, 4));
  const at = new Date(Date.UTC(endYear, Number(period.slice(5)) - 1, 15));
  return {
    scope,
    cls,
    period,
    title: scope.name,
    subtitle: CLASS_LABEL[cls],
    cityName,
    months: series(scope, cls, 13, period),
    communityYears: annualMedians(scope, cls, 10, at),
    cityYears: scope.kind === "city" ? [] : annualMedians(cityScope, cls, 10, at),
    generatedAt: new Date().toISOString(),
  };
}

// ---- Formatting -----------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function periodLong(p: string): string {
  return `${MONTHS_LONG[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;
}
function periodShort(p: string): string {
  return `${MONTHS[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;
}

export function money(n: number | null): string {
  if (n == null) return "N/A";
  return `$${Math.round(n).toLocaleString("en-CA")}`;
}

/** $1.67M / $895K — for labels that have to fit above a 22px mark. */
export function moneyCompact(n: number | null): string {
  if (n == null) return "N/A";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

export interface Delta {
  percent: number | null;
  points: number | null; // for rates: percentage-point change
  dir: "up" | "down" | "flat" | null;
}

export function delta(cur: number | null, prev: number | null): Delta {
  if (cur == null || prev == null) return { percent: null, points: null, dir: null };
  const points = Math.round((cur - prev) * 100) / 100;
  const percent = prev === 0 ? null : Math.round(((cur - prev) / prev) * 10000) / 100;
  const basis = percent ?? points;
  return { percent, points, dir: basis > 0.005 ? "up" : basis < -0.005 ? "down" : "flat" };
}

function pct(n: number | null, signed = true): string {
  if (n == null) return "N/A";
  const s = `${Math.abs(n).toFixed(Math.abs(n) >= 10 ? 1 : 2)}%`;
  if (!signed) return s;
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

// ---- SVG primitives ---------------------------------------------------------------

function text(
  x: number,
  y: number,
  s: string,
  o: {
    size: number;
    weight?: number;
    family?: string;
    fill?: string;
    anchor?: "start" | "middle" | "end";
    tracking?: number;
    upper?: boolean;
    rotate?: number;
    opacity?: number;
  },
): string {
  const t = o.upper ? s.toUpperCase() : s;
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${o.family ?? FONT_SANS}"`,
    `font-size="${o.size}"`,
    `font-weight="${o.weight ?? 500}"`,
    `fill="${o.fill ?? INK}"`,
    `text-anchor="${o.anchor ?? "start"}"`,
    o.tracking ? `letter-spacing="${o.tracking}"` : "",
    o.rotate ? `transform="rotate(${o.rotate} ${x} ${y})"` : "",
    o.opacity != null ? `opacity="${o.opacity}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<text ${attrs}>${esc(t)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ""): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke = RULE, width = 1): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`;
}

/** A column with a 4px rounded cap and a square base. */
function column(x: number, top: number, w: number, base: number, fill: string): string {
  const h = Math.max(0, base - top);
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return "";
  return `<path d="M${x} ${base} V${top + r} a${r} ${r} 0 0 1 ${r} -${r} h${w - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} V${base} Z" fill="${fill}"/>`;
}

/** Triangle glyph for a delta direction; a dash for flat or unknown. */
function arrow(x: number, y: number, dir: Delta["dir"]): string {
  if (dir === "up") return `<path d="M${x} ${y + 7} l4.5 -7 l4.5 7 Z" fill="${INK}"/>`;
  if (dir === "down") return `<path d="M${x} ${y} l4.5 7 l4.5 -7 Z" fill="${INK}"/>`;
  return rect(x, y + 3, 9, 1.5, FAINT);
}

/** Estimate rendered width so labels can be placed rather than clipped. */
function textWidth(s: string, size: number): number {
  return s.length * size * 0.58;
}

// ---- Assets -----------------------------------------------------------------------

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * Where the bundle lives. The production server is a CommonJS bundle in dist/
 * so __dirname is dist; the dev server runs source as ES modules, where
 * __dirname does not exist and the cwd-relative candidates take over.
 */
const BUNDLE_DIR = typeof __dirname === "string" ? __dirname : process.cwd();

const ASSET_DIRS = [
  path.resolve(BUNDLE_DIR, "public"), // dist/public in production
  path.resolve(process.cwd(), "dist/public"),
  path.resolve(process.cwd(), "client/public"),
];

const dataUriCache = new Map<string, string | null>();

/** A public image as a data URI, or null if it isn't on disk. */
function imageUri(rel: string): string | null {
  if (dataUriCache.has(rel)) return dataUriCache.get(rel)!;
  const file = firstExisting(ASSET_DIRS.map((d) => path.join(d, rel)));
  let uri: string | null = null;
  if (file) {
    const mime = rel.endsWith(".png") ? "image/png" : "image/jpeg";
    uri = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  }
  dataUriCache.set(rel, uri);
  return uri;
}

export function fontFiles(): string[] {
  const dir = firstExisting([
    path.resolve(BUNDLE_DIR, "assets/fonts"), // dist/assets/fonts in production
    path.resolve(process.cwd(), "server/assets/fonts"),
  ]);
  if (!dir) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ttf"))
    .map((f) => path.join(dir, f));
}

// ---- Page furniture -----------------------------------------------------------------

function header(d: ReportData, page: number): string {
  const parts: string[] = [];
  parts.push(rect(0, 0, W, H, SURFACE));

  // Logo
  const logo = imageUri("rivers-logo.jpg");
  if (logo) {
    parts.push(`<image href="${logo}" x="${M}" y="24" width="128" height="93" preserveAspectRatio="xMidYMid meet"/>`);
  } else {
    parts.push(text(M, 70, "RIVERS", { size: 28, family: FONT_SERIF, weight: 600, tracking: 4 }));
    parts.push(text(M, 88, "REAL ESTATE", { size: 9, weight: 600, tracking: 4, fill: INK_SOFT }));
  }

  // Name block
  const nx = M + 150;
  parts.push(text(nx, 52, "Spencer Rivers", { size: 22, family: FONT_DISPLAY, weight: 600, tracking: 2, upper: true }));
  parts.push(text(nx, 70, "REALTOR® · CLHMS · CNE · CIPS · CCS · Million Dollar Guild", { size: 8.5, weight: 600, tracking: 1.2, fill: MUTED, upper: true }));
  parts.push(text(nx, 88, "luxuryhomescalgary.ca   ·   (403) 966-9237   ·   spencer@riversrealestate.ca", { size: 9.5, weight: 500, fill: INK_SOFT }));

  // Designation marks
  const marks = ["img/designations/clhms-guild.png", "img/designations/cips.png", "img/designations/cne.png", "img/designations/luxe.png", "img/designations/ccs.jpg"];
  let mx = nx;
  for (const rel of marks) {
    const uri = imageUri(rel);
    if (!uri) continue;
    parts.push(`<image href="${uri}" x="${mx}" y="98" width="30" height="30" preserveAspectRatio="xMidYMid meet"/>`);
    mx += 38;
  }

  // Headshot, cropped to a circle
  const shot = imageUri("img/top-realtor-in-calgary-spencer-rivers.jpg");
  if (shot) {
    const cx = W - M - 52;
    const cy = 72;
    const r = 50;
    const s = (2 * r) / 560; // 560px of source around the face fills the circle
    parts.push(
      `<clipPath id="shot${page}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>`,
      `<circle cx="${cx}" cy="${cy}" r="${r + 2}" fill="${GOLD}"/>`,
      `<image href="${shot}" x="${cx - 1085 * s}" y="${cy - 720 * s}" width="${1400 * s}" height="${2104 * s}" clip-path="url(#shot${page})"/>`,
    );
  }

  parts.push(rect(0, 140, W, 2, GOLD));

  // Title band
  parts.push(rect(0, 142, W, 44, INK));
  parts.push(text(M, 171, d.title, { size: 18, family: FONT_SERIF, weight: 600, fill: SURFACE }));
  const tw = textWidth(d.title, 18) * 1.05;
  parts.push(text(M + tw + 14, 170, `· ${d.subtitle}`, { size: 10, weight: 700, tracking: 2, fill: GOLD, upper: true }));
  parts.push(text(W - M, 170, `As of ${periodLong(d.period)}`, { size: 9.5, weight: 700, tracking: 2.5, fill: SURFACE, anchor: "end", upper: true }));

  return parts.join("\n");
}

function footer(page: number): string {
  const y = H - 46;
  return [
    line(M, y, W - M, y),
    text(M, y + 12, "Prepared by Rivers Real Estate from Pillar 9 MLS® System data. Prices are the median of reported sales for the month and area, not the CREB® benchmark.", { size: 7, weight: 500, fill: MUTED }),
    text(M, y + 22, "N/A marks months or years before the sold history the feed retains. Information deemed reliable but not guaranteed. Not intended to solicit properties already under contract.", { size: 7, weight: 500, fill: MUTED }),
    text(M, y + 32, "Spencer Rivers · Synterra Realty · 700, 1816 Crowchild Trail NW, Calgary · luxuryhomescalgary.ca", { size: 7, weight: 500, fill: MUTED }),
    text(W - M, y + 22, `${page} / 2`, { size: 8, weight: 600, fill: FAINT, anchor: "end" }),
  ].join("\n");
}

function sectionLabel(y: number, label: string, chartTitle: string): string {
  return [
    rect(M, y, LEFT_W, 24, INK),
    text(M + 12, y + 16.5, label, { size: 9.5, family: FONT_DISPLAY, weight: 600, tracking: 2, fill: SURFACE, upper: true }),
    text(W - M, y + 16, chartTitle, { size: 8, weight: 700, tracking: 1.5, fill: MUTED, anchor: "end", upper: true }),
  ].join("\n");
}

function deltaRow(x: number, y: number, title: string, d: Delta, phrase: string): string {
  return [
    arrow(x, y - 8, d.dir),
    text(x + 16, y, title, { size: 9, weight: 700 }),
    text(x + 16, y + 13, phrase, { size: 9, weight: 500, fill: MUTED }),
  ].join("\n");
}

function phraseFor(d: Delta, prevLabel: string, kind: "percent" | "points" | "speed"): string {
  if (d.dir == null) return `No comparison for ${prevLabel}`;
  if (kind === "points") {
    if (d.dir === "flat") return `Unchanged from ${prevLabel}`;
    return `${d.dir === "up" ? "Up" : "Down"} ${Math.abs(d.points!).toFixed(1)} pts from ${prevLabel}`;
  }
  if (kind === "speed") {
    if (d.dir === "flat" || d.percent == null) return `Same pace as ${prevLabel}`;
    return `Selling ${pct(d.percent, false)} ${d.dir === "down" ? "faster" : "slower"} than ${prevLabel}`;
  }
  if (d.dir === "flat" || d.percent == null) return `Unchanged from ${prevLabel}`;
  return `${d.dir === "up" ? "Up" : "Down"} ${pct(d.percent, false)} from ${prevLabel}`;
}

// ---- Charts -----------------------------------------------------------------------

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Month labels with a year rule beneath, shared by every 13-month chart. */
function monthAxis(f: Frame, months: MonthStats[]): string {
  const parts: string[] = [];
  const slot = f.w / months.length;
  const base = f.y + f.h;
  parts.push(line(f.x, base, f.x + f.w, base, RULE));
  months.forEach((m, i) => {
    const cx = f.x + slot * (i + 0.5);
    parts.push(text(cx, base + 14, MONTHS[Number(m.period.slice(5)) - 1], { size: 8, weight: 600, fill: INK_SOFT, anchor: "middle" }));
  });
  // Year spans
  let start = 0;
  for (let i = 1; i <= months.length; i++) {
    if (i === months.length || months[i].period.slice(0, 4) !== months[start].period.slice(0, 4)) {
      const x1 = f.x + slot * start + 4;
      const x2 = f.x + slot * i - 4;
      parts.push(line(x1, base + 22, x2, base + 22, FAINT));
      parts.push(text((x1 + x2) / 2, base + 33, months[start].period.slice(0, 4), { size: 8, weight: 600, fill: FAINT, anchor: "middle" }));
      start = i;
    }
  }
  return parts.join("\n");
}

/** Median price over 13 months: a line, because a price series has no natural zero. */
function priceLine(f: Frame, months: MonthStats[]): string {
  const parts: string[] = [];
  const vals = months.map((m) => m.medianSoldPrice);
  const known = vals.filter((v): v is number => v != null);
  const slot = f.w / months.length;
  const plotTop = f.y + 18;
  const plotBase = f.y + f.h - 6;
  if (known.length === 0) {
    parts.push(text(f.x + f.w / 2, f.y + f.h / 2, "No sales in this period", { size: 10, fill: FAINT, anchor: "middle" }));
    return parts.join("\n") + monthAxis(f, months);
  }
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const pad = Math.max((hi - lo) * 0.25, hi * 0.04);
  const yFor = (v: number) => plotBase - ((v - lo + pad) / (hi - lo + 2 * pad)) * (plotBase - plotTop);

  // Recessive guide at the period's value
  const last = vals[vals.length - 1];
  if (last != null) parts.push(line(f.x, yFor(last), f.x + f.w, yFor(last), TRACK));

  // Segments only between consecutive known points
  let dpath = "";
  vals.forEach((v, i) => {
    if (v == null) return;
    const x = f.x + slot * (i + 0.5);
    const y = yFor(v);
    const prevKnown = i > 0 && vals[i - 1] != null;
    dpath += `${prevKnown ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
  });
  parts.push(`<path d="${dpath}" fill="none" stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);

  vals.forEach((v, i) => {
    const x = f.x + slot * (i + 0.5);
    if (v == null) {
      parts.push(text(x, plotBase - 4, "N/A", { size: 7, weight: 600, fill: FAINT, anchor: "middle" }));
      return;
    }
    const y = yFor(v);
    const isLast = i === vals.length - 1;
    parts.push(`<circle cx="${x}" cy="${y}" r="${isLast ? 5 : 4}" fill="${isLast ? GOLD : INK}" stroke="${SURFACE}" stroke-width="2"/>`);
    // Alternate label placement above/below so neighbours never collide.
    const above = i % 2 === 0;
    parts.push(text(x, above ? y - 9 : y + 16, moneyCompact(v), { size: 7.5, weight: isLast ? 800 : 600, fill: isLast ? INK : MUTED, anchor: "middle" }));
  });
  return parts.join("\n") + monthAxis(f, months);
}

/** Annual medians as columns from zero, N/A years marked. */
function annualColumns(f: Frame, years: YearStats[]): string {
  const parts: string[] = [];
  const known = years.map((y) => y.medianSoldPrice).filter((v): v is number => v != null);
  const slot = f.w / years.length;
  const plotTop = f.y + 22;
  const base = f.y + f.h - 4;
  const max = known.length ? Math.max(...known) : 1;
  const barW = Math.min(24, slot - 12);
  parts.push(line(f.x, base, f.x + f.w, base, RULE));
  years.forEach((yr, i) => {
    const cx = f.x + slot * (i + 0.5);
    const x = cx - barW / 2;
    const v = yr.medianSoldPrice;
    const isLast = i === years.length - 1;
    if (v == null) {
      parts.push(rect(x, base - 2, barW, 2, TRACK));
      parts.push(text(cx, base - 8, "N/A", { size: 7, weight: 600, fill: FAINT, anchor: "middle" }));
    } else {
      const top = base - (v / max) * (base - plotTop);
      parts.push(column(x, top, barW, base, isLast ? GOLD : INK));
      parts.push(text(cx, top - 5, moneyCompact(v), { size: 7.5, weight: isLast ? 800 : 600, fill: isLast ? INK : MUTED, anchor: "middle" }));
      const prev = i > 0 ? years[i - 1].medianSoldPrice : null;
      const d = delta(v, prev);
      if (d.percent != null) {
        parts.push(text(cx, base + 24, pct(d.percent), { size: 7, weight: 600, fill: FAINT, anchor: "middle" }));
      }
    }
    parts.push(text(cx, base + 13, `${yr.year}${yr.partial ? "*" : ""}`, { size: 8, weight: 600, fill: INK_SOFT, anchor: "middle" }));
  });
  if (years.some((y) => y.partial)) {
    parts.push(text(f.x + f.w, base + 36, "* year to date", { size: 7, weight: 500, fill: FAINT, anchor: "end" }));
  }
  return parts.join("\n");
}

/** Active vs sold per month: grouped thin columns, one legend. */
function activeSoldColumns(f: Frame, months: MonthStats[]): string {
  const parts: string[] = [];
  const slot = f.w / months.length;
  const plotTop = f.y + 26;
  const base = f.y + f.h - 6;
  const max = Math.max(1, ...months.map((m) => Math.max(m.activeListings ?? 0, m.sales)));
  const barW = Math.min(12, (slot - 8) / 2);
  const gap = 2;

  // Legend
  parts.push(rect(f.x, f.y + 2, 10, 10, GOLD), text(f.x + 15, f.y + 11, "Active at month end", { size: 8, weight: 600, fill: INK_SOFT }));
  parts.push(rect(f.x + 122, f.y + 2, 10, 10, INK), text(f.x + 137, f.y + 11, "Sold in month", { size: 8, weight: 600, fill: INK_SOFT }));

  months.forEach((m, i) => {
    const cx = f.x + slot * (i + 0.5);
    const ax = cx - barW - gap / 2;
    const sx = cx + gap / 2;
    if (m.activeListings == null) {
      parts.push(rect(ax, base - 2, barW, 2, TRACK));
      parts.push(text(ax + barW / 2, base - 7, "N/A", { size: 6.5, weight: 600, fill: FAINT, anchor: "middle" }));
    } else {
      const top = base - (m.activeListings / max) * (base - plotTop);
      parts.push(column(ax, top, barW, base, GOLD));
      parts.push(text(ax + barW / 2, Math.min(top, base - 2) - 4, String(m.activeListings), { size: 7, weight: 600, fill: MUTED, anchor: "middle" }));
    }
    const stop = base - (m.sales / max) * (base - plotTop);
    parts.push(column(sx, stop, barW, base, INK));
    parts.push(text(sx + barW / 2, Math.min(stop, base - 2) - 4, String(m.sales), { size: 7, weight: 700, fill: INK, anchor: "middle" }));
  });
  return parts.join("\n") + monthAxis({ ...f, h: f.h }, months);
}

/** A single count/rate series as columns from zero with a value on each cap. */
function valueColumns(f: Frame, months: MonthStats[], pick: (m: MonthStats) => number | null, fmt: (v: number) => string): string {
  const parts: string[] = [];
  const slot = f.w / months.length;
  const plotTop = f.y + 22;
  const base = f.y + f.h - 6;
  const vals = months.map(pick);
  const known = vals.filter((v): v is number => v != null);
  const max = Math.max(1, ...known);
  const barW = Math.min(22, slot - 12);
  vals.forEach((v, i) => {
    const cx = f.x + slot * (i + 0.5);
    const x = cx - barW / 2;
    const isLast = i === vals.length - 1;
    if (v == null) {
      parts.push(rect(x, base - 2, barW, 2, TRACK));
      parts.push(text(cx, base - 8, "N/A", { size: 7, weight: 600, fill: FAINT, anchor: "middle" }));
      return;
    }
    const top = base - (v / max) * (base - plotTop);
    parts.push(column(x, top, barW, base, isLast ? GOLD : INK));
    parts.push(text(cx, Math.min(top, base - 2) - 5, fmt(v), { size: 7.5, weight: isLast ? 800 : 600, fill: isLast ? INK : MUTED, anchor: "middle" }));
  });
  return parts.join("\n") + monthAxis(f, months);
}

// ---- Tiles -------------------------------------------------------------------------

function heroTile(y: number, label: string, value: string, sub: string, rows: Array<(rowY: number) => string>): string {
  const parts: string[] = [];
  parts.push(text(M, y + 52, label, { size: 8.5, weight: 700, tracking: 1.5, fill: MUTED, upper: true }));
  parts.push(text(M, y + 96, value, { size: value.length > 9 ? 30 : 36, weight: 800, fill: INK }));
  parts.push(text(M, y + 114, sub, { size: 9, weight: 600, fill: MUTED }));
  parts.push(line(M, y + 126, M + LEFT_W, y + 126));
  rows.forEach((row, i) => parts.push(row(y + 152 + i * 36)));
  return parts.join("\n");
}

function twinTile(y: number, x: number, w: number, label: string, value: string, sub: string, mom: Delta, momLabel: string, yoy: Delta, yoyLabel: string, kind: "percent" | "points" | "speed"): string {
  const parts: string[] = [];
  parts.push(text(x, y + 52, label, { size: 8.5, weight: 700, tracking: 1.5, fill: MUTED, upper: true }));
  parts.push(text(x, y + 92, value, { size: 32, weight: 800, fill: INK }));
  parts.push(text(x, y + 108, sub, { size: 8.5, weight: 600, fill: MUTED }));
  parts.push(line(x, y + 120, x + w, y + 120));
  parts.push(arrow(x, y + 132, mom.dir), text(x + 15, y + 140, "Month to month", { size: 8, weight: 700 }));
  parts.push(text(x, y + 153, phraseFor(mom, momLabel, kind), { size: 7.6, weight: 500, fill: MUTED }));
  parts.push(arrow(x, y + 166, yoy.dir), text(x + 15, y + 174, "Year to year", { size: 8, weight: 700 }));
  parts.push(text(x, y + 187, phraseFor(yoy, yoyLabel, kind), { size: 7.6, weight: 500, fill: MUTED }));
  return parts.join("\n");
}

// ---- Pages -------------------------------------------------------------------------

function comparisons(d: ReportData) {
  const cur = d.months[d.months.length - 1];
  const prev = d.months[d.months.length - 2] ?? null;
  const lastYear = d.months[0]?.period === shiftPeriod(d.period, -12) ? d.months[0] : null;
  return {
    cur,
    prev,
    lastYear,
    prevLabel: prev ? periodShort(prev.period) : "last month",
    lastYearLabel: periodShort(shiftPeriod(d.period, -12)),
  };
}

export function renderPage1(d: ReportData): string {
  const { cur, prev, lastYear, prevLabel, lastYearLabel } = comparisons(d);
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  parts.push(header(d, 1));

  // Section 1: the price
  let y = SECTION_Y[0];
  parts.push(sectionLabel(y, "Median sold price", `13 months · ${d.title} ${d.subtitle}`));
  const mom = delta(cur.medianSoldPrice, prev?.medianSoldPrice ?? null);
  const yoy = delta(cur.medianSoldPrice, lastYear?.medianSoldPrice ?? null);
  parts.push(
    heroTile(y, "Median of reported sales", money(cur.medianSoldPrice), `${periodShort(cur.period)} · ${cur.sales} ${cur.sales === 1 ? "sale" : "sales"}`, [
      (ry) => deltaRow(M, ry, "Month to month", mom, phraseFor(mom, prevLabel, "percent")),
      (ry) => deltaRow(M, ry, "Year to year", yoy, phraseFor(yoy, lastYearLabel, "percent")),
    ]),
  );
  parts.push(priceLine({ x: CHART_X, y: y + 34, w: CHART_W, h: 180 }, d.months));

  // Section 2: ten years, the community
  y = SECTION_Y[1];
  parts.push(sectionLabel(y, "Ten year history", `Annual median · ${d.title} ${d.subtitle}`));
  parts.push(scopeGlyph(y, d.title, d.subtitle, d.scope.kind === "city" ? "city" : "community"));
  parts.push(annualColumns({ x: CHART_X, y: y + 34, w: CHART_W, h: 180 }, d.communityYears));

  // Section 3: ten years, the city
  y = SECTION_Y[2];
  if (d.cityYears.length > 0) {
    parts.push(sectionLabel(y, "City comparison", `Annual median · ${d.cityName} ${d.subtitle}`));
    parts.push(scopeGlyph(y, d.cityName, d.subtitle, "city"));
    parts.push(annualColumns({ x: CHART_X, y: y + 34, w: CHART_W, h: 180 }, d.cityYears));
  } else {
    parts.push(sectionLabel(y, "Sold to list", `13 months · ${d.title} ${d.subtitle}`));
    const ratio = cur.soldToListRatio == null ? null : cur.soldToListRatio * 100;
    const rprev = prev?.soldToListRatio == null ? null : prev.soldToListRatio * 100;
    const rly = lastYear?.soldToListRatio == null ? null : lastYear.soldToListRatio * 100;
    parts.push(
      heroTile(y, "Sold price ÷ list price", ratio == null ? "N/A" : `${ratio.toFixed(1)}%`, `${periodShort(cur.period)} average`, [
        (ry) => deltaRow(M, ry, "Month to month", delta(ratio, rprev), phraseFor(delta(ratio, rprev), prevLabel, "points")),
        (ry) => deltaRow(M, ry, "Year to year", delta(ratio, rly), phraseFor(delta(ratio, rly), lastYearLabel, "points")),
      ]),
    );
    parts.push(valueColumns({ x: CHART_X, y: y + 34, w: CHART_W, h: 180 }, d.months, (m) => (m.soldToListRatio == null ? null : m.soldToListRatio * 100), (v) => `${v.toFixed(1)}%`));
  }

  parts.push(footer(1));
  parts.push("</svg>");
  return parts.join("\n");
}

/** The property-type block beside a ten-year chart: an icon and two lines. */
function scopeGlyph(y: number, place: string, cls: string, kind: "community" | "city"): string {
  const cx = M + LEFT_W / 2;
  const gy = y + 60;
  const icon =
    kind === "city"
      ? // A skyline: three blocks and a spire
        `<g fill="${INK}"><rect x="${cx - 44}" y="${gy + 26}" width="18" height="34"/><rect x="${cx - 20}" y="${gy + 8}" width="22" height="52"/><rect x="${cx + 8}" y="${gy + 34}" width="16" height="26"/><rect x="${cx + 30}" y="${gy + 18}" width="12" height="42"/><rect x="${cx - 12}" y="${gy - 6}" width="6" height="14"/></g><rect x="${cx - 52}" y="${gy + 60}" width="104" height="4" fill="${GOLD}"/>`
      : // A house: roof, walls, door
        `<g fill="${INK}"><path d="M${cx} ${gy} l46 32 h-10 v30 h-72 v-30 h-10 Z"/></g><rect x="${cx - 8}" y="${gy + 42}" width="16" height="20" fill="${SURFACE}"/><rect x="${cx - 52}" y="${gy + 62}" width="104" height="4" fill="${GOLD}"/>`;
  return [
    icon,
    text(cx, gy + 96, `Property type: ${cls}`, { size: 8.5, weight: 700, tracking: 1.2, fill: MUTED, anchor: "middle", upper: true }),
    text(cx, gy + 116, place, { size: 13, family: FONT_SERIF, weight: 600, anchor: "middle" }),
  ].join("\n");
}

export function renderPage2(d: ReportData): string {
  const { cur, prev, lastYear, prevLabel, lastYearLabel } = comparisons(d);
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  parts.push(header(d, 2));

  // Section A: active and sold
  let y = SECTION_Y[0];
  parts.push(sectionLabel(y, "Active & sold listings", `13 months · ${d.title} ${d.subtitle}`));
  const half = (LEFT_W - 14) / 2;
  parts.push(
    twinTile(y, M, half, "Active", cur.activeListings == null ? "N/A" : String(cur.activeListings), `${periodShort(cur.period)} · for sale`,
      delta(cur.activeListings, prev?.activeListings ?? null), prevLabel, delta(cur.activeListings, lastYear?.activeListings ?? null), lastYearLabel, "percent"),
  );
  parts.push(
    twinTile(y, M + half + 14, half, "Sold", String(cur.sales), `${periodShort(cur.period)} · closed`,
      delta(cur.sales, prev?.sales ?? null), prevLabel, delta(cur.sales, lastYear?.sales ?? null), lastYearLabel, "percent"),
  );
  parts.push(activeSoldColumns({ x: CHART_X, y: y + 34, w: CHART_W, h: 180 }, d.months));

  // Section B: absorption
  y = SECTION_Y[1];
  parts.push(sectionLabel(y, "Listing absorption rate", `13 months · sold ÷ active`));
  const ab = cur.absorptionRate;
  const abMom = delta(ab, prev?.absorptionRate ?? null);
  const abYoy = delta(ab, lastYear?.absorptionRate ?? null);
  parts.push(text(M, y + 52, "Odds of selling", { size: 8.5, weight: 700, tracking: 1.5, fill: MUTED, upper: true }));
  parts.push(text(M, y + 96, ab == null ? "N/A" : `${ab.toFixed(1)}%`, { size: 36, weight: 800 }));
  parts.push(text(M, y + 114, `${periodShort(cur.period)} · ${cur.sales} sold of ${cur.activeListings ?? "—"} active`, { size: 9, weight: 600, fill: MUTED }));
  // Meter: fill is the rate, capped at the track; the track is a lighter step.
  const meterW = LEFT_W;
  parts.push(`<rect x="${M}" y="${y + 126}" width="${meterW}" height="10" rx="5" fill="${TRACK}"/>`);
  if (ab != null) {
    const fillW = Math.max(10, Math.min(meterW, (Math.min(ab, 100) / 100) * meterW));
    parts.push(`<rect x="${M}" y="${y + 126}" width="${fillW}" height="10" rx="5" fill="${INK}"/>`);
  }
  parts.push(text(M, y + 150, "0%", { size: 7, weight: 600, fill: FAINT }));
  parts.push(text(M + meterW, y + 150, "100%", { size: 7, weight: 600, fill: FAINT, anchor: "end" }));
  parts.push(deltaRow(M, y + 176, "Month to month", abMom, phraseFor(abMom, prevLabel, "points")));
  parts.push(deltaRow(M, y + 210, "Year to year", abYoy, phraseFor(abYoy, lastYearLabel, "points")));
  parts.push(valueColumns({ x: CHART_X, y: y + 34, w: CHART_W, h: 180 }, d.months, (m) => m.absorptionRate, (v) => `${Math.round(v)}%`));

  // Section C: days on market
  y = SECTION_Y[2];
  parts.push(sectionLabel(y, "Average days on market", `13 months · ${d.title} ${d.subtitle}`));
  const domMom = delta(cur.avgDom, prev?.avgDom ?? null);
  const domYoy = delta(cur.avgDom, lastYear?.avgDom ?? null);
  parts.push(
    heroTile(y, "Average days on market", cur.avgDom == null ? "N/A" : `${cur.avgDom} days`, `${periodShort(cur.period)} · ${cur.sales} ${cur.sales === 1 ? "sale" : "sales"}`, [
      (ry) => deltaRow(M, ry, "Month to month", domMom, phraseFor(domMom, prevLabel, "speed")),
      (ry) => deltaRow(M, ry, "Year to year", domYoy, phraseFor(domYoy, lastYearLabel, "speed")),
    ]),
  );
  parts.push(valueColumns({ x: CHART_X, y: y + 34, w: CHART_W, h: 180 }, d.months, (m) => m.avgDom, (v) => String(Math.round(v))));

  parts.push(footer(2));
  parts.push("</svg>");
  return parts.join("\n");
}

// ---- Rasterise + bind -------------------------------------------------------------

export function svgToPng(svg: string, scale = 2): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: W * scale },
    font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: FONT_SANS },
    background: SURFACE,
  });
  return Buffer.from(r.render().asPng());
}

export async function pngsToPdf(pages: Buffer[], meta: { title: string; subject: string }): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(meta.title);
  pdf.setSubject(meta.subject);
  pdf.setAuthor("Spencer Rivers · Rivers Real Estate");
  pdf.setProducer("luxuryhomescalgary.ca");
  for (const png of pages) {
    const img = await pdf.embedPng(png);
    const page = pdf.addPage([612, 792]); // US Letter in points
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  return Buffer.from(await pdf.save());
}

export interface RenderedReport {
  data: ReportData;
  svg: [string, string];
  png: [Buffer, Buffer];
  pdf: Buffer;
}

export async function renderReport(data: ReportData): Promise<RenderedReport> {
  const svg: [string, string] = [renderPage1(data), renderPage2(data)];
  const png: [Buffer, Buffer] = [svgToPng(svg[0]), svgToPng(svg[1])];
  const pdf = await pngsToPdf(png, {
    title: `${data.title} ${data.subtitle} market report — ${periodLong(data.period)}`,
    subject: "Community market report",
  });
  return { data, svg, png, pdf };
}
