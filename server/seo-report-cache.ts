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
import { storage } from "./storage";
import type { SeoReport } from "./seo-keywords";

export const SEO_REPORT_TTL_MS = 10 * 60 * 1000;

let cache: { at: number; data: SeoReport } | null = null;
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
