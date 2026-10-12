/**
 * The SEO keyword report's cache and background build.
 *
 * Lifted out of routes.ts so the fix generator (server/seo-fix.ts) can read
 * the latest report and invalidate it after applying a change, without
 * reaching into route-handler closures.
 *
 * A build in flight, if any. The crawl visits ~160 of our own routes and
 * every one is an SSR render, so on the production machine it takes far
 * longer than a request should be held open — long enough that the proxy
 * gave up and answered 502. The report is therefore built off the request
 * path: the endpoint answers straight away with whatever it has and reports
 * that a build is running. Holding the promise also collapses concurrent
 * requests onto one crawl — pressing Rescan repeatedly used to start a new
 * 160-page crawl each time, which is how this page once took the site down.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { storage } from "./storage";
import type { SeoReport } from "./seo-keywords";

export const SEO_REPORT_TTL_MS = 10 * 60 * 1000;

// The last good report is also kept on disk next to the database. The cache
// is otherwise memory-only, so every restart (each deploy) emptied it and
// "Improve" refused to start until a fresh crawl finished — which a run of
// deploys could keep interrupting. Loaded at boot as stale data: readable
// straight away, and the next read of the report page starts a refresh.
const DISK_PATH = nodePath.join(nodePath.dirname(nodePath.resolve(process.env.DB_PATH || "data.db")), "seo-report-cache.json");
const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function loadFromDisk(): { at: number; data: SeoReport } | null {
  try {
    const st = fs.statSync(DISK_PATH);
    if (Date.now() - st.mtimeMs > DISK_MAX_AGE_MS) return null;
    const data = JSON.parse(fs.readFileSync(DISK_PATH, "utf8")) as SeoReport;
    // at: 0 marks it stale, so the report page rebuilds it in the background.
    return data ? { at: 0, data } : null;
  } catch {
    return null;
  }
}

function saveToDisk(data: SeoReport): void {
  try {
    const tmp = DISK_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DISK_PATH); // atomic: never leave a half-written file
  } catch (e: any) {
    console.warn("[seo-keywords] could not save report to disk:", e?.message ?? e);
  }
}

let cache: { at: number; data: SeoReport } | null = loadFromDisk();
let build: Promise<SeoReport | null> | null = null;
let lastError: string | null = null;

export function seoReportState() {
  return { cache, building: !!build, error: lastError };
}

export function cachedSeoReport(): SeoReport | null {
  return cache?.data ?? null;
}

/**
 * Mark the report stale. `keepData` leaves the old report readable (so the
 * fix dialog can still resolve what it was working on) while the next GET
 * rebuilds; without it, the next read shows "building".
 */
export function invalidateSeoReport(opts: { keepData?: boolean } = {}): void {
  if (opts.keepData && cache) cache = { ...cache, at: 0 };
  else cache = null;
}

export function startSeoReportBuild(): Promise<SeoReport | null> {
  if (build) return build;
  lastError = null;
  build = (async () => {
    const { buildSeoReport } = await import("./seo-keywords");
    const overrides: Record<string, string> = {};
    for (const t of storage.listSeoKeywordTargets()) overrides[t.path] = t.focusKeyword;
    // Crawl ourselves over loopback so the analysis sees exactly what a
    // crawler sees, including SSR metadata and the real anchor graph.
    const port = process.env.PORT || "5000";
    const data = await buildSeoReport({ baseUrl: `http://127.0.0.1:${port}`, overrides });
    cache = { at: Date.now(), data };
    saveToDisk(data);
    return data;
  })()
    .catch((err: any) => {
      lastError = err?.message ?? "Failed to build SEO report";
      console.error("[seo-keywords] build failed:", lastError);
      return null;
    })
    .finally(() => {
      build = null;
    });
  return build;
}

/**
 * After boot, build a report if there's none at all (not even on disk), so
 * "Improve" works without anyone first opening the SEO page and waiting.
 * Delayed past the SSR warm-up and the first MLS sync so it doesn't compete
 * with them.
 */
export function scheduleBootSeoReport(delayMs = 3 * 60 * 1000): void {
  setTimeout(() => {
    if (!cache) startSeoReportBuild();
  }, delayMs);
}
