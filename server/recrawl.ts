// Ask search engines to recrawl pages the SEO console just changed.
//
// Google has no public API for Search Console's "Request indexing" button:
// the URL Inspection API is read-only, the Indexing API is limited to job
// postings and livestreams (using it for anything else breaks Google's terms),
// and the sitemap ping endpoint was retired in 2023. What Google does honour is
// an accurate <lastmod> in a sitemap it is told to re-read. So for every page
// a fix touches we:
//
//   1. record when it changed — the sitemap routes in routes.ts emit that as
//      the page's <lastmod> (pageChangedAt below);
//   2. resubmit the sitemap to Search Console (search-console.ts), which makes
//      Google re-read it and see the fresh lastmod;
//   3. send the URLs to IndexNow, which Bing (and through it ChatGPT search
//      and Copilot), Yandex, Seznam and Naver crawl from within minutes.
//
// Submission is debounced: applying three fixes in a row sends one batch, and
// it waits long enough for the change to be live before pointing crawlers at it.

import { randomBytes } from "crypto";
import { sqlite, storage } from "./storage";
import { publicOrigin } from "./origin";

sqlite.exec(`
  -- When the SEO console last changed what a page shows. Read by the sitemap
  -- routes as <lastmod>; only real content changes are recorded here.
  CREATE TABLE IF NOT EXISTS seo_page_changes (
    path TEXT PRIMARY KEY,
    changed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seo_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const normPath = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

let changeCache: Map<string, string> | null = null;

function changes(): Map<string, string> {
  if (changeCache) return changeCache;
  const rows = sqlite.prepare("SELECT path, changed_at FROM seo_page_changes").all() as Array<{ path: string; changed_at: string }>;
  changeCache = new Map(rows.map((r) => [r.path, r.changed_at]));
  return changeCache;
}

/** When the console last changed this page (ISO, UTC), or undefined. */
export function pageChangedAt(path: string): string | undefined {
  return changes().get(normPath(path));
}

/**
 * The later of a page's own lastmod and its last console change. Both are W3C
 * datetimes (a bare date counts as that day's start), so compare as instants.
 */
export function freshestLastmod(path: string, own?: string): string | undefined {
  const changed = pageChangedAt(path);
  if (!changed) return own;
  if (!own) return changed;
  const a = Date.parse(own);
  return Number.isNaN(a) || Date.parse(changed) > a ? changed : own;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Long enough for a burst of applies to land in one batch and for the SSR
 *  cache to have been rebuilt with the new content. */
const DEBOUNCE_MS = 2 * 60 * 1000;

const pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;

export interface RecrawlStatus {
  at: string;
  urls: string[];
  google: string;
  indexNow: string;
}
/** The last batch sent, kept in seo_settings so it survives a restart. */
export function lastRecrawl(): RecrawlStatus | null {
  try {
    const row = sqlite.prepare("SELECT value FROM seo_settings WHERE key = 'last_recrawl'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

/**
 * Record that these pages changed and queue a recrawl request for them.
 * Never throws: telling crawlers is best-effort and must not fail the edit.
 */
export function markPagesChanged(paths: string[]): void {
  try {
    const at = new Date().toISOString();
    const upsert = sqlite.prepare(
      `INSERT INTO seo_page_changes (path, changed_at) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET changed_at = excluded.changed_at`,
    );
    for (const raw of paths) {
      if (!raw || !raw.startsWith("/")) continue;
      const p = normPath(raw);
      upsert.run(p, at);
      pending.add(p);
    }
    changeCache = null;
    if (!pending.size) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, DEBOUNCE_MS);
    timer.unref?.();
  } catch (e: any) {
    console.error("[recrawl] could not record page changes:", e?.message ?? e);
  }
}

async function flush(): Promise<void> {
  const paths = Array.from(pending);
  pending.clear();
  if (!paths.length) return;
  const origin = publicOrigin();
  const urls = paths.map((p) => `${origin}${p === "/" ? "/" : p}`);

  if (process.env.NODE_ENV !== "production") {
    console.log(`[recrawl] not production — would request a recrawl of ${urls.join(", ")}`);
    return;
  }

  const [google, indexNow] = await Promise.all([
    resubmitToGoogle().catch((e) => `failed: ${e?.message ?? e}`),
    submitIndexNow(urls).catch((e) => `failed: ${e?.message ?? e}`),
  ]);
  const status: RecrawlStatus = { at: new Date().toISOString(), urls, google, indexNow };
  sqlite
    .prepare("INSERT INTO seo_settings (key, value) VALUES ('last_recrawl', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(status));
  console.log(`[recrawl] ${urls.length} URL(s) — Google: ${google}; IndexNow: ${indexNow}`);
}

async function resubmitToGoogle(): Promise<string> {
  if (process.env.SEARCH_CONSOLE_AUTOSUBMIT === "0") return "off (SEARCH_CONSOLE_AUTOSUBMIT=0)";
  const integ = storage.findActiveIntegration("google");
  if (!integ) return "skipped — Google isn't connected";
  const { submitSitemap } = await import("./search-console");
  // Forced: the daily debounce exists for reboots, and this sitemap really
  // has changed since the last submit.
  const r = await submitSitemap(integ.userId, { force: true });
  return r.ok ? "sitemap resubmitted" : `not done — ${r.error ?? r.reason}`;
}

// ---------------------------------------------------------------------------
// IndexNow
// ---------------------------------------------------------------------------

/** Served at /indexnow-key.txt; proves to IndexNow that we own the host. */
export const INDEXNOW_KEY_PATH = "/indexnow-key.txt";

let keyCache: string | null = null;

/** INDEXNOW_KEY if set, else a key generated once and kept in the database. */
export function indexNowKey(): string {
  if (keyCache) return keyCache;
  const env = process.env.INDEXNOW_KEY?.trim();
  if (env) return (keyCache = env);
  const row = sqlite.prepare("SELECT value FROM seo_settings WHERE key = 'indexnow_key'").get() as { value: string } | undefined;
  if (row) return (keyCache = row.value);
  const key = randomBytes(16).toString("hex");
  sqlite.prepare("INSERT OR IGNORE INTO seo_settings (key, value) VALUES ('indexnow_key', ?)").run(key);
  return (keyCache = key);
}

async function submitIndexNow(urls: string[]): Promise<string> {
  if (process.env.INDEXNOW === "0") return "off (INDEXNOW=0)";
  const origin = publicOrigin();
  const r = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(origin).host,
      key: indexNowKey(),
      keyLocation: `${origin}${INDEXNOW_KEY_PATH}`,
      urlList: urls,
    }),
  });
  // 200 = accepted; 202 = accepted, key check still pending (first use).
  if (r.status === 200 || r.status === 202) return `accepted (${r.status})`;
  return `rejected: ${r.status} ${(await r.text()).slice(0, 200)}`;
}
