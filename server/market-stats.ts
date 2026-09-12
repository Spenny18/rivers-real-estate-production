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
  kind: "city" | "subdivision";
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
  return scope.city ? `subdivision = @name AND city = @scopeCity` : `subdivision = @name`;
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

// ---- What scopes exist ------------------------------------------------------

export interface ScopeOption {
  name: string;
  city?: string;
  sales: number; // last 13 months
}

export function listScopes(): { cities: ScopeOption[]; subdivisions: ScopeOption[]; floor: string | null } {
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
  return { cities, subdivisions, floor: historyFloor() };
}
