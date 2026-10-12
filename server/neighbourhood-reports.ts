// Community reports on the public neighbourhood pages.
//
// Each neighbourhood page shows page 1 of its community's latest report as a
// lead magnet; the full PDF is emailed to whoever asks for it. A page maps to
// a report scope through the same CREB subdivision keys the listing match
// uses (neighbourhoodSubdivisionKeys), so "Bridgeland" reads the
// "Bridgeland/Riverside" report and "Bayside (Airdrie)" reads "Bayside".
//
// The preview is for the community's most common property class over the
// last year (Mission → Apartment, Upper Mount Royal → Detached); the visitor
// picks the class they want emailed. The monthly cron pre-generates the
// preview class for every page (ensureNeighbourhoodReports); any other class
// is rendered on demand the first time someone asks for it.

import { sqlite, storage, neighbourhoodSubdivisionKeys, subdivisionNormKey } from "./storage";
import {
  CLASS_LABEL,
  PROPERTY_CLASSES,
  classMix,
  listScopes,
  type ClassFilter,
  type PropertyClass,
  type Scope,
} from "./market-stats";
import { generateReport, toStored, type StoredReport } from "./market-report-store";
import { defaultReportPeriod } from "./market-report-render";
import { periodLong } from "./report-pages";

type Neighbourhood = { slug: string; name: string };

// listScopes() and classMix() group a year of sold history; cache them rather
// than run them on every neighbourhood page view.
const CACHE_TTL_MS = 60 * 60 * 1000;
let scopesCache: { at: number; subdivisions: Array<{ name: string; city: string | null; sales: number }> } | null = null;
const mixCache = new Map<string, { at: number; mix: Array<{ cls: PropertyClass; sales: number }> }>();

function soldSubdivisions() {
  if (!scopesCache || Date.now() - scopesCache.at > CACHE_TTL_MS) {
    scopesCache = { at: Date.now(), subdivisions: listScopes().subdivisions as any };
  }
  return scopesCache.subdivisions;
}

/** The report scope for a page: its busiest matching CREB subdivision, or null. */
export function reportScopeForNeighbourhood(n: Neighbourhood): Scope | null {
  const keys = neighbourhoodSubdivisionKeys(n);
  const match = soldSubdivisions()
    .filter((s) => keys.has(subdivisionNormKey(s.name)))
    .sort((a, b) => b.sales - a.sales)[0];
  return match ? { kind: "subdivision", name: match.name, city: match.city ?? undefined } : null;
}

function scopeMix(scope: Scope) {
  const key = `${scope.name}|${scope.city ?? ""}`;
  const hit = mixCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.mix;
  const mix = classMix(scope);
  mixCache.set(key, { at: Date.now(), mix });
  return mix;
}

/** The community's most common property class over the last year, or "all". */
export function dominantClass(scope: Scope): ClassFilter {
  return scopeMix(scope)[0]?.cls ?? "all";
}

/**
 * The classes a visitor can ask for: every class with sales in the last year,
 * busiest first, then "All residential" when there's more than one.
 */
export function classOptions(scope: Scope): Array<{ value: ClassFilter; label: string }> {
  const mix = scopeMix(scope);
  const opts: Array<{ value: ClassFilter; label: string }> = mix.map((m) => ({
    value: m.cls,
    // The board's "Row" means townhouses; say so on the public form.
    label: m.cls === "row" ? "Townhouse / Row" : CLASS_LABEL[m.cls],
  }));
  if (mix.length !== 1) opts.push({ value: "all", label: CLASS_LABEL.all });
  return opts;
}

function findReport(
  scope: Scope,
  where: string,
  args: Record<string, unknown> = {},
  order = "period DESC",
): StoredReport | null {
  const row = sqlite
    .prepare(
      `SELECT id FROM market_reports
        WHERE kind = 'subdivision' AND name = @name
          AND (@city IS NULL OR city IS NULL OR city = @city)
          AND ${where}
        ORDER BY ${order}
        LIMIT 1`,
    )
    .get({ name: scope.name, city: scope.city ?? null, ...args }) as { id: number } | undefined;
  if (!row) return null;
  const full = storage.getMarketReport(row.id);
  return full ? toStored(full) : null;
}

/**
 * The preview for a page: the latest report for its most common class,
 * falling back to its latest report of any class (newest first, "all"
 * preferred) until the cron has rendered the preview class.
 */
export function previewReport(n: Neighbourhood): { report: StoredReport; scope: Scope } | null {
  const scope = reportScopeForNeighbourhood(n);
  if (!scope) return null;
  const report =
    findReport(scope, "cls = @cls", { cls: dominantClass(scope) }) ??
    findReport(scope, "1 = 1", {}, "period DESC, CASE WHEN cls = 'all' THEN 0 ELSE 1 END, cls");
  return report ? { report, scope } : null;
}

/**
 * The report for one class, generating it when the latest period hasn't
 * been rendered for that class yet. Used when a visitor asks for the PDF.
 */
export async function reportForClass(scope: Scope, cls: ClassFilter): Promise<StoredReport> {
  const period = defaultReportPeriod();
  return (
    findReport(scope, "cls = @cls AND period = @period", { cls, period }) ??
    (await generateReport({ kind: "subdivision", name: scope.name, city: scope.city ?? null, cls, period }))
  );
}

export function isClassFilter(v: unknown): v is ClassFilter {
  return v === "all" || (PROPERTY_CLASSES as readonly unknown[]).includes(v);
}

/** What the public page may see: page 1 only — the PDF stays behind the form. */
export function publicReportTeaser(r: StoredReport, scope: Scope) {
  return {
    title: r.title,
    subtitle: r.subtitle,
    cls: r.cls,
    period: r.period,
    periodLabel: periodLong(r.period),
    previewUrl: r.png1Url,
    pages: r.png3Url ? 3 : 2,
    classOptions: classOptions(scope),
    months: medianSeries(r.id),
  };
}

/**
 * The 13-month median sold price series from a stored report — the same
 * figures as page 1's "Median sold price" chart, for the page to draw live.
 */
function medianSeries(reportId: number): Array<{ period: string; median: number | null; sales: number }> {
  try {
    const raw = storage.getMarketReport(reportId)?.statsJson;
    const data = raw ? JSON.parse(raw) : null;
    return (data?.months ?? []).map((m: any) => ({
      period: String(m.period),
      median: typeof m.medianSoldPrice === "number" ? m.medianSoldPrice : null,
      sales: Number(m.sales ?? 0),
    }));
  } catch {
    return [];
  }
}

// Scopes that failed to render this process, per period — retried after a
// restart or next month, not on every hourly tick.
const failed = new Set<string>();

// The fill is background work on the same small machine that serves the
// site: each report is heavy sales-history SQL on the main thread plus a
// ~230MB render worker. Run it overnight only, with a pause between
// reports, so it never competes with visitors (on 2026-10-12 a daytime fill
// plus an SEO crawl starved the server and Fly's health check failed).
const FILL_WINDOW_HOURS = { start: 1, end: 6 }; // America/Edmonton, [start, end)
const PAUSE_BETWEEN_MS = 60 * 1000;

function edmontonHour(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", hour: "numeric", hourCycle: "h23" }).format(now),
  );
}

export function inFillWindow(now = new Date()): boolean {
  const h = edmontonHour(now);
  return h >= FILL_WINDOW_HOURS.start && h < FILL_WINDOW_HOURS.end;
}

/**
 * Generate the preview-class report for every neighbourhood page that doesn't
 * have one for `period`. Runs after the preset batch in the monthly cron;
 * renders are queued one at a time by render-host, so this is slow but cheap.
 */
export async function ensureNeighbourhoodReports(
  period: string,
  opts: { anyTime?: boolean } = {},
): Promise<{ generated: number; errors: string[] }> {
  if (!opts.anyTime && !inFillWindow()) return { generated: 0, errors: [] };
  const have = new Set(
    storage
      .listMarketReports(period)
      .filter((r) => r.kind === "subdivision")
      .map((r) => `${r.name}|${r.city ?? ""}|${r.cls}`),
  );
  const seen = new Set<string>();
  let generated = 0;
  const errors: string[] = [];
  for (const n of storage.listNeighbourhoods()) {
    const scope = reportScopeForNeighbourhood(n);
    if (!scope) continue;
    const cls = dominantClass(scope);
    const key = `${scope.name}|${scope.city ?? ""}|${cls}`;
    if (have.has(key) || seen.has(key) || failed.has(`${period}|${key}`)) continue;
    seen.add(key);
    // Stop when the overnight window closes; the next night picks up the rest.
    if (!opts.anyTime && !inFillWindow()) break;
    if (generated > 0 || errors.length > 0) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_MS));
    try {
      await generateReport({ kind: "subdivision", name: scope.name, city: scope.city ?? null, cls, period });
      generated++;
    } catch (e: any) {
      failed.add(`${period}|${key}`);
      errors.push(`${n.name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  if (generated || errors.length) {
    console.log(`[market-reports] ${period}: neighbourhood pages — generated ${generated}, ${errors.length} failed`);
    for (const e of errors.slice(0, 5)) console.warn(`[market-reports]   ${e}`);
  }
  return { generated, errors };
}
