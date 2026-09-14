// Monthly market statistics computed from the feed.
//
// Everything a community market report shows, derived from mls_history (sold
// and off-market listings) plus mls_listings (what is active right now):
//
//   sales             closings in the month
//   medianSoldPrice   the headline price. Spencer chose a median from real
//                     sales over the board's modelled benchmark; it is
//                     labelled as a median everywhere it appears.
//   avgSoldPrice, soldToListRatio, avgDom
//   newListings       listings whose contract date falls in the month
//   activeListings    inventory at month end: listed by then, not yet gone
//   absorptionRate    sales ÷ active, the "odds of selling" figure
//   monthsOfSupply    active ÷ sales
//
// Inventory is reconstructed rather than snapshotted: a listing counts as
// active at a month's end if its list date is on or before that day and its
// off-market date is after it (or it is still active in the feed). That only
// works for months inside the history the feed retains — before the earliest
// off-market row we hold, expiries and withdrawals are missing and the count
// would read high — so months before that are reported as null rather than
// wrong.
//
// Scopes are a city (Calgary, Airdrie, …) or a Pillar 9 subdivision, which is
// what the board calls a community (Springbank Hill, Beltline). Property
// classes follow the board's four: detached, semi-detached, row, apartment.
// Anything else the feed carries (land, mobile, commercial) is left out of
// every class including "all".

import { sqlite } from "./storage";

export const PROPERTY_CLASSES = ["detached", "semi_detached", "row", "apartment"] as const;
export type PropertyClass = (typeof PROPERTY_CLASSES)[number];
export type ClassFilter = PropertyClass | "all";

export const CLASS_LABEL: Record<ClassFilter, string> = {
  detached: "Detached",
  semi_detached: "Semi-Detached",
  row: "Row",
  apartment: "Apartment",
  all: "All residential",
};

export interface Scope {
  /** A whole city, one community, or a board district ("CAL Zone W"). */
  kind: "city" | "subdivision" | "district";
  name: string;
  /** Optional city to disambiguate a subdivision name that exists in two towns. */
  city?: string;
}

export interface MonthStats {
  period: string; // YYYY-MM
  sales: number;
  medianSoldPrice: number | null;
  avgSoldPrice: number | null;
  soldToListRatio: number | null; // e.g. 0.982
  avgDom: number | null;
  newListings: number;
  /** Null when the month predates the history the feed retains. */
  activeListings: number | null;
  absorptionRate: number | null; // percent
  monthsOfSupply: number | null;
  /** True for the current, incomplete month. */
  partial: boolean;
}

/** Below this a "sale" is a data-entry error (the feed has $8 closings). */
const MIN_SANE_PRICE = 25_000;

/**
 * The board's four classes, from the feed's PropertySubType. Order matters:
 * "Semi Detached (Half Duplex)" contains "detached".
 */
const CLASS_SQL = `
  CASE
    WHEN lower(property_sub_type) LIKE '%apartment%' THEN 'apartment'
    WHEN lower(property_sub_type) LIKE '%row%' OR lower(property_sub_type) LIKE '%townhouse%' THEN 'row'
    WHEN lower(property_sub_type) LIKE '%semi%' OR lower(property_sub_type) LIKE '%duplex%' THEN 'semi_detached'
    WHEN lower(property_sub_type) LIKE '%detached%' THEN 'detached'
  END`;

export function classify(propertySubType: string | null | undefined): PropertyClass | null {
  const s = (propertySubType ?? "").toLowerCase();
  if (!s) return null;
  if (s.includes("apartment")) return "apartment";
  if (s.includes("row") || s.includes("townhouse")) return "row";
  if (s.includes("semi") || s.includes("duplex")) return "semi_detached";
  if (s.includes("detached")) return "detached";
  return null;
}

function classWhere(cls: ClassFilter): string {
  return cls === "all" ? `(${CLASS_SQL}) IS NOT NULL` : `(${CLASS_SQL}) = @cls`;
}

function scopeWhere(scope: Scope): string {
  if (scope.kind === "city") return `city = @name`;
  const col = scope.kind === "district" ? "district" : "subdivision";
  return scope.city ? `${col} = @name AND city = @scopeCity` : `${col} = @name`;
}

function params(scope: Scope, cls: ClassFilter, extra: Record<string, unknown> = {}) {
  return { name: scope.name, scopeCity: scope.city ?? null, cls: cls === "all" ? null : cls, ...extra };
}

// ---- Period arithmetic --------------------------------------------------------

export function isValidPeriod(p: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(p)) return false;
  const m = Number(p.slice(5));
  return m >= 1 && m <= 12;
}

export function periodBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, "0")}` };
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The current month in Mountain time, which is the market being reported on. */
export function currentPeriod(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}`;
}

// ---- One month --------------------------------------------------------------

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Earliest off-market date held; inventory before this is unknowable. */
function historyFloor(): string | null {
  const r = sqlite.prepare(`SELECT MIN(off_market_date) AS d FROM mls_history`).get() as { d: string | null };
  return r?.d ?? null;
}

export function monthStats(scope: Scope, cls: ClassFilter, period: string, floor?: string | null): MonthStats {
  const { start, end } = periodBounds(period);
  const p = params(scope, cls, { start, end });
  const where = `${scopeWhere(scope)} AND ${classWhere(cls)}`;

  const prices = (
    sqlite
      .prepare(
        `SELECT close_price AS price, list_price AS list, days_on_market AS dom
         FROM mls_history
         WHERE status = 'S' AND close_date BETWEEN @start AND @end
           AND close_price >= ${MIN_SANE_PRICE}
           AND ${where}`,
      )
      .all(p) as Array<{ price: number; list: number | null; dom: number | null }>
  );
  const sales = prices.length;
  const sorted = prices.map((r) => r.price).sort((a, b) => a - b);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const ratios = prices.filter((r) => r.list && r.list > 0).map((r) => r.price / r.list!);
  const doms = prices.filter((r) => r.dom != null && r.dom >= 0).map((r) => r.dom!);

  const newListings = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT id FROM mls_history
            WHERE list_date BETWEEN @start AND @end AND ${where}
           UNION
           SELECT id FROM mls_listings
            WHERE status = 'Active' AND list_date BETWEEN @start AND @end AND ${where}
         )`,
      )
      .get(p) as { n: number }
  ).n;

  const f = floor === undefined ? historyFloor() : floor;
  let activeListings: number | null = null;
  if (f && start >= f) {
    activeListings = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT id FROM mls_history
              WHERE list_date <= @end AND off_market_date > @end AND ${where}
             UNION
             SELECT id FROM mls_listings
              WHERE status = 'Active' AND list_date <= @end
                AND id NOT IN (SELECT id FROM mls_history)
                AND ${where}
           )`,
        )
        .get(p) as { n: number }
    ).n;
  }

  const avgSold = avg(sorted);
  const avgRatio = avg(ratios);
  const avgDom = avg(doms);
  return {
    period,
    sales,
    medianSoldPrice: median(sorted),
    avgSoldPrice: avgSold == null ? null : Math.round(avgSold),
    soldToListRatio: avgRatio == null ? null : Math.round(avgRatio * 10000) / 10000,
    avgDom: avgDom == null ? null : Math.round(avgDom),
    newListings,
    activeListings,
    absorptionRate:
      activeListings && activeListings > 0 ? Math.round((sales / activeListings) * 10000) / 100 : null,
    monthsOfSupply:
      activeListings != null && sales > 0 ? Math.round((activeListings / sales) * 100) / 100 : null,
    partial: period === currentPeriod(),
  };
}

/** `months` consecutive months ending at `endPeriod` (default: this month). */
export function series(scope: Scope, cls: ClassFilter, months: number, endPeriod = currentPeriod()): MonthStats[] {
  const floor = historyFloor();
  const out: MonthStats[] = [];
  for (let i = months - 1; i >= 0; i--) {
    out.push(monthStats(scope, cls, shiftPeriod(endPeriod, -i), floor));
  }
  return out;
}

// ---- Annual medians (the 10-year chart) ---------------------------------------

export interface YearStats {
  year: number;
  sales: number;
  /** Null when the year has no sales in the history held. */
  medianSoldPrice: number | null;
  /** True for the current, incomplete year. */
  partial: boolean;
}

/** `years` calendar years ending with the current one. */
export function annualMedians(scope: Scope, cls: ClassFilter, years: number, now = new Date()): YearStats[] {
  const thisYear = Number(currentPeriod(now).slice(0, 4));
  const firstYear = thisYear - (years - 1);
  const where = `${scopeWhere(scope)} AND ${classWhere(cls)}`;
  const rows = sqlite
    .prepare(
      `SELECT substr(close_date, 1, 4) AS y, close_price AS price
         FROM mls_history
        WHERE status = 'S' AND close_date >= @from AND close_price >= ${MIN_SANE_PRICE}
          AND ${where}
        ORDER BY y, price`,
    )
    .all(params(scope, cls, { from: `${firstYear}-01-01` })) as Array<{ y: string; price: number }>;
  const byYear = new Map<number, number[]>();
  for (const r of rows) {
    const y = Number(r.y);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(r.price);
  }
  const out: YearStats[] = [];
  for (let y = firstYear; y <= thisYear; y++) {
    const prices = byYear.get(y) ?? [];
    out.push({ year: y, sales: prices.length, medianSoldPrice: median(prices), partial: y === thisYear });
  }
  return out;
}

// ---- Sales by price band ------------------------------------------------------
//
// Where the sales actually happen. A month in one community is a handful of
// closings, so the breakdown covers twelve months and marks the month's own
// sales inside each band. The bands adapt to the place: Beltline apartments
// get $100K steps from $200K, Springbank Hill detached gets $250K steps from
// $750K, both with round edges. Above the grid, a scope that sells past $2M
// gets its tail split at $2M, $2.5M and $3M, so the top of the market reads
// as more than one bar. Eleven bands at most.

export interface PriceBand {
  label: string;
  /** Inclusive lower edge; null for the open bottom band. */
  from: number | null;
  /** Exclusive upper edge; null for the open top band. */
  to: number | null;
  sales: number;
  /** Of all sales in the window, 0–100. */
  share: number;
  /** Sales in the report month alone. */
  monthSales: number;
  medianPrice: number | null;
  avgDom: number | null;
  soldToListRatio: number | null;
}

export interface PriceBands {
  months: number;
  fromPeriod: string;
  toPeriod: string;
  total: number;
  monthTotal: number;
  medianPrice: number | null;
  bands: PriceBand[];
}

const BAND_STEPS = [50_000, 100_000, 150_000, 200_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
/** The adaptive grid: up to six closed bands plus an open one at each end. */
const MAX_BANDS = 8;
/** Fixed edges the tail is split at when a scope sells past them; up to three more bands. */
const LUXURY_EDGES = [2_000_000, 2_500_000, 3_000_000];

export function bandMoney(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `$${Number.isInteger(m) ? m : m.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
  }
  return `$${Math.round(n / 1000)}K`;
}

export function priceBands(scope: Scope, cls: ClassFilter, period: string, months = 12): PriceBands {
  const fromPeriod = shiftPeriod(period, -(months - 1));
  const { start } = periodBounds(fromPeriod);
  const { start: mStart, end } = periodBounds(period);
  const where = `${scopeWhere(scope)} AND ${classWhere(cls)}`;
  const rows = sqlite
    .prepare(
      `SELECT close_price AS price, list_price AS list, days_on_market AS dom, close_date AS closed
         FROM mls_history
        WHERE status = 'S' AND close_date BETWEEN @start AND @end AND close_price >= ${MIN_SANE_PRICE}
          AND ${where}
        ORDER BY price`,
    )
    .all(params(scope, cls, { start, end })) as Array<{ price: number; list: number | null; dom: number | null; closed: string }>;

  const empty: PriceBands = { months, fromPeriod, toPeriod: period, total: rows.length, monthTotal: 0, medianPrice: null, bands: [] };
  if (rows.length === 0) return empty;

  const prices = rows.map((r) => r.price);
  const at = (q: number) => prices[Math.min(prices.length - 1, Math.max(0, Math.floor(q * (prices.length - 1))))];
  // Fit the closed bands to the middle 80% of sales; the tails go in the two
  // open bands, so one $4M sale does not stretch a $250K grid across the page.
  const p10 = at(0.1);
  const p90 = at(0.9);
  let step = BAND_STEPS[BAND_STEPS.length - 1];
  for (const s of BAND_STEPS) {
    if (Math.ceil((p90 - p10) / s) + 1 <= MAX_BANDS - 2) {
      step = s;
      break;
    }
  }
  let low = Math.floor(p10 / step) * step;
  let high = Math.ceil(p90 / step) * step;
  if (high <= low) high = low + step;
  // The open bands only exist when something falls in them.
  const hasBelow = prices[0] < low;
  const topSale = prices[prices.length - 1];
  const hasAbove = topSale >= high;

  const edges: Array<{ from: number | null; to: number | null; label: string }> = [];
  if (hasBelow) edges.push({ from: null, to: low, label: `Under ${bandMoney(low)}` });
  for (let e = low; e < high; e += step) edges.push({ from: e, to: e + step, label: `${bandMoney(e)} – ${bandMoney(e + step)}` });
  // The top of the market is where the reader's own home usually sits, so it
  // is never one lump: when a scope has sales past $2M the tail is split at
  // fixed luxury edges, each shown only when something sold in it, and the
  // last one left open.
  const luxuryEdges = LUXURY_EDGES.filter((e) => e > high);
  if (topSale >= LUXURY_EDGES[0] && luxuryEdges.length > 0) {
    let prev = high;
    for (const e of luxuryEdges) {
      if (topSale < e) break;
      edges.push({ from: prev, to: e, label: `${bandMoney(prev)} – ${bandMoney(e)}` });
      prev = e;
    }
    edges.push({ from: prev, to: null, label: `${bandMoney(prev)}+` });
  } else if (hasAbove) {
    edges.push({ from: high, to: null, label: `${bandMoney(high)}+` });
  }

  const bands: PriceBand[] = edges.map((e) => {
    const inBand = rows.filter((r) => (e.from == null || r.price >= e.from) && (e.to == null || r.price < e.to));
    const inMonth = inBand.filter((r) => r.closed >= mStart && r.closed <= end);
    const doms = inBand.filter((r) => r.dom != null && r.dom >= 0).map((r) => r.dom!);
    const ratios = inBand.filter((r) => r.list && r.list > 0).map((r) => r.price / r.list!);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const avgDom = avg(doms);
    const avgRatio = avg(ratios);
    return {
      label: e.label,
      from: e.from,
      to: e.to,
      sales: inBand.length,
      share: Math.round((inBand.length / rows.length) * 1000) / 10,
      monthSales: inMonth.length,
      medianPrice: median(inBand.map((r) => r.price)),
      avgDom: avgDom == null ? null : Math.round(avgDom),
      soldToListRatio: avgRatio == null ? null : Math.round(avgRatio * 10000) / 10000,
    };
  });

  return {
    months,
    fromPeriod,
    toPeriod: period,
    total: rows.length,
    monthTotal: rows.filter((r) => r.closed >= mStart && r.closed <= end).length,
    medianPrice: median(prices),
    bands,
  };
}

// ---- What scopes exist ------------------------------------------------------

export interface ScopeOption {
  name: string;
  city?: string;
  sales: number; // last 13 months
}

export function listScopes(): { cities: ScopeOption[]; subdivisions: ScopeOption[]; districts: ScopeOption[]; floor: string | null } {
  const since = periodBounds(shiftPeriod(currentPeriod(), -12)).start;
  const cities = sqlite
    .prepare(
      `SELECT city AS name, COUNT(*) AS sales FROM mls_history
        WHERE status = 'S' AND close_date >= @since AND city IS NOT NULL
        GROUP BY city ORDER BY sales DESC`,
    )
    .all({ since }) as ScopeOption[];
  const subdivisions = sqlite
    .prepare(
      `SELECT subdivision AS name, city, COUNT(*) AS sales FROM mls_history
        WHERE status = 'S' AND close_date >= @since AND subdivision IS NOT NULL
        GROUP BY subdivision, city ORDER BY sales DESC`,
    )
    .all({ since }) as ScopeOption[];
  const districts = sqlite
    .prepare(
      `SELECT district AS name, city, COUNT(*) AS sales FROM mls_history
        WHERE status = 'S' AND close_date >= @since AND district IS NOT NULL AND district <> ''
        GROUP BY district, city ORDER BY sales DESC`,
    )
    .all({ since }) as ScopeOption[];
  return { cities, subdivisions, districts, floor: historyFloor() };
}
