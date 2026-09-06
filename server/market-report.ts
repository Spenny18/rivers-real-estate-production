// The monthly Calgary market report — the numbers, and the graphic built from
// them.
//
// This replaces the infographic at the centre of the Real Info Box newsletter.
// That graphic carries twenty-one figures a month: a benchmark sold price for
// each of four property types, active and sold listing counts, and average days
// on market — each shown for the current month, the month before, and the same
// month a year earlier, with the percentage change against both.
//
// ---------------------------------------------------------------------------
// WHY THE FIGURES ARE ENTERED RATHER THAN DERIVED
//
// The obvious approach is to compute them from the MLS feed. It does not work,
// and the reason is worth writing down so nobody tries it later.
//
// "Benchmark price" is not an average or a median. It is the Home Price Index
// figure the real estate board publishes — a modelled price for a typical home
// of that type, holding its characteristics constant so month-to-month movement
// reflects the market rather than a change in what happened to sell. It cannot
// be recovered from a list of sold prices, because the model is the point.
//
// A median sale price computed from raw feed data would be a defensible number
// and the wrong one: it would disagree with the board, with the newspaper, and
// with every other agent's newsletter, and Spencer would be the one explaining
// the discrepancy. So the board's published figures are the input, and this
// module's job is arithmetic and presentation, not estimation.
//
// Sold data from the feed still earns its place — it is what makes
// neighbourhood-level statistics possible, which the board's citywide summary
// does not offer. That is a separate feature from this one.

import { storage } from "./storage";

export const PROPERTY_TYPES = ["detached", "semi_detached", "row", "apartment"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Citywide figures are stored against this pseudo-type. */
export const CITYWIDE = "all";

export const TYPE_LABEL: Record<string, string> = {
  detached: "Detached",
  semi_detached: "Semi-Detached",
  row: "Row",
  apartment: "Apartment",
  all: "All types",
};

export interface MarketFigures {
  period: string; // YYYY-MM
  propertyType: string;
  benchmarkPrice: number | null;
  sales: number | null;
  activeListings: number | null;
  avgDom: number | null;
}

// ---- Period arithmetic ------------------------------------------------------

/** "2026-04" → "2026-03". Pure string maths; no Date, so no timezone to get wrong. */
export function previousMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function sameMonthLastYear(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${y - 1}-${String(m).padStart(2, "0")}`;
}

export function isValidPeriod(period: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(period)) return false;
  const m = Number(period.slice(5));
  return m >= 1 && m <= 12;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function periodLabel(period: string, style: "long" | "short" = "long"): string {
  if (!isValidPeriod(period)) return period;
  const [y, m] = period.split("-").map(Number);
  const name = MONTH_NAMES[m - 1];
  return style === "long" ? `${name} ${y}` : `${name.slice(0, 3).toUpperCase()} ${y}`;
}

// ---- The assembled report ---------------------------------------------------

export interface Delta {
  /** Percent change, or null when the comparison period has no figure. */
  percent: number | null;
  direction: "up" | "down" | "flat" | null;
}

export interface TypeRow {
  propertyType: string;
  label: string;
  lastYear: number | null;
  lastMonth: number | null;
  present: number | null;
  vsLastYear: Delta;
  vsLastMonth: Delta;
}

export interface MarketReport {
  period: string;
  periodLabel: string;
  comparisons: { present: string; lastMonth: string; lastYear: string };
  benchmark: TypeRow[];
  listings: {
    active: { lastYear: number | null; lastMonth: number | null; present: number | null };
    sold: { lastYear: number | null; lastMonth: number | null; present: number | null };
  };
  daysOnMarket: { lastYear: number | null; lastMonth: number | null; present: number | null };
  /** Sold ÷ active for the current month, as a percentage. */
  absorptionRate: number | null;
  marketStatus: "Buyer's Market" | "Balanced Market" | "Seller's Market" | null;
  commentary: string | null;
  /** Figures the report wanted and did not find — shown in the admin, never to a client. */
  missing: string[];
  complete: boolean;
}

function delta(present: number | null, prior: number | null): Delta {
  if (present == null || prior == null || prior === 0) return { percent: null, direction: null };
  const pct = ((present - prior) / prior) * 100;
  const rounded = Math.round(pct * 100) / 100;
  return {
    percent: rounded,
    direction: rounded > 0.005 ? "up" : rounded < -0.005 ? "down" : "flat",
  };
}

/**
 * Absorption thresholds. Below 30% more homes are listed than sell in a month
 * and buyers hold the leverage; above 50% the reverse. These are the
 * conventional boundaries and they match the board's own commentary, so the
 * label agrees with what a client reads elsewhere that month.
 */
function statusFor(absorption: number | null): MarketReport["marketStatus"] {
  if (absorption == null) return null;
  if (absorption < 30) return "Buyer's Market";
  if (absorption <= 50) return "Balanced Market";
  return "Seller's Market";
}

export function buildReport(period: string): MarketReport {
  const prevM = previousMonth(period);
  const prevY = sameMonthLastYear(period);

  const rows = storage.listMarketStats([period, prevM, prevY]);
  const at = (p: string, t: string) => rows.find((r) => r.period === p && r.propertyType === t);
  const missing: string[] = [];

  const benchmark: TypeRow[] = PROPERTY_TYPES.map((t) => {
    const present = at(period, t)?.benchmarkPrice ?? null;
    const lastMonth = at(prevM, t)?.benchmarkPrice ?? null;
    const lastYear = at(prevY, t)?.benchmarkPrice ?? null;
    if (present == null) missing.push(`${TYPE_LABEL[t]} benchmark price for ${periodLabel(period)}`);
    return {
      propertyType: t,
      label: TYPE_LABEL[t],
      lastYear,
      lastMonth,
      present,
      vsLastYear: delta(present, lastYear),
      vsLastMonth: delta(present, lastMonth),
    };
  });

  const city = (p: string) => at(p, CITYWIDE);
  const listings = {
    active: {
      present: city(period)?.activeListings ?? null,
      lastMonth: city(prevM)?.activeListings ?? null,
      lastYear: city(prevY)?.activeListings ?? null,
    },
    sold: {
      present: city(period)?.sales ?? null,
      lastMonth: city(prevM)?.sales ?? null,
      lastYear: city(prevY)?.sales ?? null,
    },
  };
  const daysOnMarket = {
    present: city(period)?.avgDom ?? null,
    lastMonth: city(prevM)?.avgDom ?? null,
    lastYear: city(prevY)?.avgDom ?? null,
  };

  if (listings.active.present == null) missing.push(`Active listings for ${periodLabel(period)}`);
  if (listings.sold.present == null) missing.push(`Sales for ${periodLabel(period)}`);
  if (daysOnMarket.present == null) missing.push(`Average days on market for ${periodLabel(period)}`);

  const absorptionRate =
    listings.sold.present != null && listings.active.present && listings.active.present > 0
      ? Math.round((listings.sold.present / listings.active.present) * 10000) / 100
      : null;

  return {
    period,
    periodLabel: periodLabel(period),
    comparisons: { present: period, lastMonth: prevM, lastYear: prevY },
    benchmark,
    listings,
    daysOnMarket,
    absorptionRate,
    marketStatus: statusFor(absorptionRate),
    commentary: storage.getMarketCommentary(period),
    missing,
    complete: missing.length === 0,
  };
}

// ---- Rendering --------------------------------------------------------------
//
// Email HTML, which is a different craft from web HTML: nested tables rather
// than flex or grid, every style inline, no external stylesheet, no webfont
// that matters. Outlook renders through Word and ignores most of CSS; Gmail
// strips <style> blocks in forwarded mail. So the layout has to survive on
// table cells, widths, and background colours alone.
//
// Bars are table cells with a background colour and an explicit height, which
// is the one charting technique that works everywhere.

const INK = "#000000";
const INK_SOFT = "#333333";
const BODY = "#666666";
const META = "#999999";
const RULE = "#E4E4E4";
const GOLD = "#D4AF37";
const SLATE = "#7C8B93";

/** Cormorant Garamond and Montserrat with real fallbacks — mail clients rarely load webfonts. */
const DISPLAY = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";
const SANS = "Montserrat, 'Helvetica Neue', Helvetica, Arial, sans-serif";

function money(n: number | null): string {
  return n == null ? "—" : `$${Math.round(n).toLocaleString("en-CA")}`;
}
function count(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-CA");
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Bar height in px, scaled against the largest of the three so shape reads. */
function barHeight(value: number | null, all: Array<number | null>): number {
  const nums = all.filter((n): n is number => n != null && n > 0);
  if (value == null || nums.length === 0) return 8;
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  // Anchor the floor at 55% of the max rather than zero: three bars within a
  // few percent of each other would otherwise look identical, and the reader
  // is being shown a change of one or two percent.
  const floor = Math.min(min * 0.94, max * 0.55);
  const span = max - floor || 1;
  return Math.round(38 + ((value - floor) / span) * 62);
}

function deltaLine(label: string, d: Delta): string {
  if (d.percent == null) {
    return `<div style="font-family:${SANS};font-size:12px;color:${META};padding:1px 0;">Compared to ${label}, no figure on record.</div>`;
  }
  const up = d.direction === "up";
  const arrow = d.direction === "flat" ? "" : up ? "&#9650;" : "&#9660;";
  const colour = d.direction === "flat" ? BODY : up ? INK : SLATE;
  const word = up ? "more" : "less";
  const abs = Math.abs(d.percent).toFixed(2);
  return (
    `<div style="font-family:${SANS};font-size:12px;color:${INK_SOFT};padding:1px 0;">` +
    `Compared to ${label}, homes are selling for ${abs}% ${word} ` +
    `<span style="color:${colour};">${arrow}</span></div>`
  );
}

/** One three-bar comparison, used for benchmark price and for days on market. */
function barGroup(
  values: Array<{ value: number | null; label: string; sub: string; colour: string }>,
  format: (n: number | null) => string,
): string {
  const all = values.map((v) => v.value);
  const cells = values
    .map((v) => {
      const h = barHeight(v.value, all);
      return (
        `<td width="33%" valign="bottom" align="center" style="padding:0 6px;">` +
        `<div style="font-family:${SANS};font-size:16px;font-weight:700;color:${INK};padding-bottom:6px;">${format(v.value)}</div>` +
        `<div style="background-color:${v.colour};height:${h}px;line-height:${h}px;font-size:0;">&nbsp;</div>` +
        `<div style="font-family:${SANS};font-size:10px;letter-spacing:0.12em;color:${META};padding-top:7px;">${esc(v.sub)}</div>` +
        `<div style="font-family:${SANS};font-size:11px;letter-spacing:0.1em;font-weight:600;color:${v.colour === GOLD ? INK : BODY};">${esc(v.label)}</div>` +
        `</td>`
      );
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>`;
}

function sectionHeading(text: string): string {
  return (
    `<tr><td style="background-color:${INK};padding:9px 16px;">` +
    `<span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.16em;color:#FFFFFF;text-transform:uppercase;">${esc(text)}</span>` +
    `</td></tr>`
  );
}

/**
 * The absorption gauge: a three-segment bar with the month's rate marked.
 *
 * Drawn as one table row of three cells so the segments cannot wrap, with the
 * marker in a row above positioned by percentage-width spacer cells — the only
 * way to place something at an arbitrary point across a width in email HTML.
 */
function gauge(rate: number | null): string {
  if (rate == null) {
    return `<div style="font-family:${SANS};font-size:12px;color:${META};">Absorption rate needs both sales and active listings.</div>`;
  }
  const clamped = Math.max(0, Math.min(100, rate));
  const left = Math.max(0, Math.min(96, clamped - 4));
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr><td style="padding-bottom:3px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="${left}%" style="font-size:0;line-height:0;">&nbsp;</td>` +
    `<td align="left" style="font-family:${SANS};font-size:13px;font-weight:700;color:${INK};white-space:nowrap;">${clamped.toFixed(2)}%&nbsp;&#9660;</td>` +
    `</tr></table></td></tr>` +
    `<tr><td>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="30%" style="background-color:${GOLD};height:9px;line-height:9px;font-size:0;">&nbsp;</td>` +
    `<td width="20%" style="background-color:${SLATE};height:9px;line-height:9px;font-size:0;">&nbsp;</td>` +
    `<td width="50%" style="background-color:${INK};height:9px;line-height:9px;font-size:0;">&nbsp;</td>` +
    `</tr><tr>` +
    `<td style="font-family:${SANS};font-size:10px;letter-spacing:0.08em;color:${BODY};padding-top:5px;">Buyer's</td>` +
    `<td style="font-family:${SANS};font-size:10px;letter-spacing:0.08em;color:${BODY};padding-top:5px;">Balanced</td>` +
    `<td align="right" style="font-family:${SANS};font-size:10px;letter-spacing:0.08em;color:${BODY};padding-top:5px;">Seller's</td>` +
    `</tr></table></td></tr></table>`
  );
}

/**
 * The infographic, as an email-safe HTML fragment 600px wide.
 *
 * Returned as a fragment rather than a whole document so it can sit inside the
 * newsletter or stand alone in the admin preview.
 */
export function renderInfographic(report: MarketReport): string {
  const { comparisons: c } = report;
  const cols = (v: { lastYear: number | null; lastMonth: number | null; present: number | null }) => [
    { value: v.lastYear, label: "LAST YEAR", sub: periodLabel(c.lastYear, "short"), colour: SLATE },
    { value: v.lastMonth, label: "LAST MONTH", sub: periodLabel(c.lastMonth, "short"), colour: INK },
    { value: v.present, label: "PRESENT", sub: periodLabel(c.present, "short"), colour: GOLD },
  ];

  const benchmarkRows = report.benchmark
    .map(
      (row) =>
        `<tr><td style="padding:20px 16px 14px;border-bottom:1px solid ${RULE};">` +
        `<div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;color:${INK};text-transform:uppercase;padding-bottom:12px;">${esc(row.label)}</div>` +
        barGroup(
          [
            { value: row.lastYear, label: "LAST YEAR", sub: periodLabel(c.lastYear, "short"), colour: SLATE },
            { value: row.lastMonth, label: "LAST MONTH", sub: periodLabel(c.lastMonth, "short"), colour: INK },
            { value: row.present, label: "PRESENT", sub: periodLabel(c.present, "short"), colour: GOLD },
          ],
          money,
        ) +
        `<div style="padding-top:11px;">${deltaLine("last year", row.vsLastYear)}${deltaLine("last month", row.vsLastMonth)}</div>` +
        `</td></tr>`,
    )
    .join("");

  const activeSold = [
    { p: c.lastYear, a: report.listings.active.lastYear, s: report.listings.sold.lastYear, label: "LAST YEAR", colour: SLATE },
    { p: c.lastMonth, a: report.listings.active.lastMonth, s: report.listings.sold.lastMonth, label: "LAST MONTH", colour: INK },
    { p: c.present, a: report.listings.active.present, s: report.listings.sold.present, label: "PRESENT", colour: GOLD },
  ]
    .map(
      (x) =>
        `<td width="33%" align="center" valign="bottom" style="padding:0 6px;">` +
        `<div style="font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:0.1em;color:${BODY};padding-bottom:5px;">ACTIVE ${count(x.a)}</div>` +
        `<div style="background-color:${x.colour};padding:14px 4px;">` +
        `<span style="font-family:${SANS};font-size:14px;font-weight:700;color:#FFFFFF;">SOLD ${count(x.s)}</span></div>` +
        `<div style="font-family:${SANS};font-size:10px;letter-spacing:0.12em;color:${META};padding-top:7px;">${periodLabel(x.p, "short")}</div>` +
        `<div style="font-family:${SANS};font-size:11px;letter-spacing:0.1em;font-weight:600;color:${x.colour === GOLD ? INK : BODY};">${x.label}</div>` +
        `</td>`,
    )
    .join("");

  return (
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#FFFFFF;border:1px solid ${RULE};">` +
    // Market status
    sectionHeading(`Market Status — Calgary`) +
    `<tr><td style="padding:18px 16px 20px;border-bottom:1px solid ${RULE};">` +
    `<div style="font-family:${SANS};font-size:12px;color:${BODY};">We are currently in a</div>` +
    `<div style="font-family:${DISPLAY};font-size:30px;line-height:1.15;color:${INK};padding:2px 0 10px;">${esc(report.marketStatus ?? "Market status unavailable")}</div>` +
    gauge(report.absorptionRate) +
    (report.absorptionRate != null
      ? `<div style="font-family:${SANS};font-size:12px;line-height:1.5;color:${BODY};padding-top:12px;">` +
        `A listing absorption rate of ${report.absorptionRate.toFixed(2)}% means that ${report.absorptionRate.toFixed(2)}% of all active listings in ${esc(report.periodLabel)} sold.</div>`
      : "") +
    `</td></tr>` +
    // Benchmark price
    sectionHeading("Benchmark Sold Price") +
    benchmarkRows +
    // Active & sold
    sectionHeading("Active & Sold Listings") +
    `<tr><td style="padding:20px 16px;border-bottom:1px solid ${RULE};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${activeSold}</tr></table>` +
    `</td></tr>` +
    // Days on market
    sectionHeading("Average Days on Market") +
    `<tr><td style="padding:20px 16px;">` +
    barGroup(cols(report.daysOnMarket), (n) => (n == null ? "—" : `${n} DAYS`)) +
    `</td></tr>` +
    // Attribution. The board requires its data be credited, and a client
    // reading a number should be able to see where it came from.
    `<tr><td style="background-color:#F4F4F4;padding:12px 16px;">` +
    `<div style="font-family:${SANS};font-size:10px;line-height:1.5;color:${META};">` +
    `Figures for ${esc(report.periodLabel)} as published by the Calgary Real Estate Board. ` +
    `Benchmark price is the board's Home Price Index — a modelled price for a typical home of that type, ` +
    `not an average of sales. Believed reliable but not guaranteed; not intended to solicit properties already listed.` +
    `</div></td></tr>` +
    `</table>`
  );
}
