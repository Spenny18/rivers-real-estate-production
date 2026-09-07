/**
 * Server-side rendering pipeline for the public site.
 *
 * seo-inject.ts got the <head> right for crawlers; this gets the <body>
 * right. For SSR-eligible routes we prefetch the page's API data (in-process
 * HTTP to our own express routes, so the JSON is byte-identical to what the
 * browser would fetch), hand it to the client bundle's entry-server render()
 * along with the URL, and splice the resulting HTML + dehydrated React Query
 * state into index.html. The browser then hydrates instead of rendering from
 * scratch.
 *
 * Deliberately NOT server-rendered:
 *   - /mls (map-first interactive search; huge tree). Note this one is a
 *     tradeoff, not a freebie: /mls IS in the sitemap and is indexable, so
 *     non-JS crawlers see an empty page for it.
 *   - /book/manage/* (one person's private booking, noindex)
 *   - /admin/*, /account/* (private, noindex)
 *   - anything unknown (404 shell, as before)
 *
 * Any SSR failure falls back to the CSR shell — worst case is exactly the
 * behaviour the site shipped with before this file existed.
 */

export interface SeedEntry {
  key: unknown[];
  data: unknown;
}
export interface RenderResult {
  html: string;
  dehydratedState: unknown;
}
export type RenderFn = (
  path: string,
  search: string,
  seed: SeedEntry[],
) => Promise<RenderResult>;

/**
 * React Query keys to prefetch per route. Each key must EXACTLY match the
 * queryKey used by the page component — the client's default queryFn joins
 * segments with "/" to form the URL, so the same join gives us the endpoint
 * to fetch here. Returns null for routes that should stay client-rendered.
 */
export function queriesForPath(path: string): unknown[][] | null {
  const p = path === "/" ? "/" : path.replace(/\/$/, "");

  if (p === "/")
    return [
      // CMS block content first — the homepage renders from it, so a render
      // without it would produce the factory page and cache that.
      ["/api/public/pages", "home"],
      ["/api/public/mls/featured"],
      ["/api/public/neighbourhoods"],
      ["/api/public/blog"],
      ["/api/public/testimonials"],
      ["/api/public/stats"],
      ["/api/public/instagram"],
    ];
  if (p === "/blog") return [["/api/public/blog"]];
  if (p.startsWith("/blog/"))
    return [["/api/public/blog", p.slice("/blog/".length)], ["/api/public/blog"]];
  if (p === "/neighbourhoods") return [["/api/public/neighbourhoods"]];
  if (p.startsWith("/neighbourhoods/"))
    return [["/api/public/neighbourhoods", p.slice("/neighbourhoods/".length)]];
  if (p === "/condos") return [["/api/public/condos"]];
  if (p.startsWith("/condos/"))
    return [["/api/public/condos", p.slice("/condos/".length)]];
  // /mls exactly = interactive search, stays CSR. Detail pages render.
  if (p.startsWith("/mls/")) return [["/api/public/mls", p.slice("/mls/".length)]];
  if (p.startsWith("/p/"))
    return [["/api/listings/by-slug", p.slice("/p/".length)]];
  // Booking pages. /book/manage/<uid> is one person's private booking —
  // noindex, and its data is keyed to a uid we must not prefetch, so it
  // stays client-rendered. The index and the per-event-type pages are
  // ordinary public pages: they are in the sitemap and are exactly the kind
  // of content the non-JS AI crawlers we invite in robots.txt come for, so
  // they need a real body, not the empty shell they were serving.
  if (p === "/book") return [["/api/booking/event-types"]];
  if (p.startsWith("/book/manage/")) return null;
  if (p.startsWith("/book/"))
    return [[`/api/booking/event-types/${p.slice("/book/".length)}`]];
  if (
    p === "/about" ||
    p === "/contact" ||
    p === "/home-evaluation" ||
    p === "/assignments" ||
    p === "/work-with" ||
    p.startsWith("/work-with/")
  )
    return [];

  return null;
}

const SELF_ORIGIN = () =>
  `http://127.0.0.1:${parseInt(process.env.PORT || "5000", 10)}`;

async function prefetch(keys: unknown[][]): Promise<SeedEntry[]> {
  const origin = SELF_ORIGIN();
  const results = await Promise.all(
    keys.map(async (key): Promise<SeedEntry | null> => {
      const url = `${origin}${key.join("/")}`;
      try {
        const res = await fetch(url, {
          // Generous: the shared-cpu Fly machine can be slow right after a
          // deploy while crons and the first requests contend for the CPU.
          signal: AbortSignal.timeout(10000),
          headers: { accept: "application/json" },
        });
        if (!res.ok) return null;
        return { key, data: await res.json() };
      } catch (err) {
        console.error(`[ssr] prefetch failed for ${url}:`, err);
        return null;
      }
    }),
  );
  return results.filter((r): r is SeedEntry => r !== null);
}

/** Serialize state for an inline <script>, hardened against </script> breakout. */
function serializeState(state: unknown): string {
  return JSON.stringify(state).replace(/</g, "\\u003c");
}

/**
 * Splice rendered app HTML + dehydrated state into the index.html template.
 * The inline state script is a classic script, so it executes before the
 * deferred module script (main.tsx) hydrates.
 */
export function injectAppHtml(
  template: string,
  appHtml: string,
  dehydratedState: unknown,
): string {
  return template.replace(
    '<div id="root"></div>',
    `<div id="root" data-ssr="1">${appHtml}</div>\n    <script>window.__RRE_STATE__ = ${serializeState(dehydratedState)};</script>`,
  );
}

export interface SsrPipelineOptions {
  /** Called per request; dev passes vite.ssrLoadModule so HMR stays live. */
  getRender: () => Promise<RenderFn>;
  /** Cache TTL in ms; 0 disables caching (dev). */
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
}

interface CacheEntry {
  html: string;
  at: number;
}

/**
 * Every live pipeline's cache, so a CMS save can drop the stale HTML for the
 * page it just edited instead of waiting out the TTL (5 minutes in prod —
 * long enough that an editor would think the save silently failed).
 */
const liveCaches = new Set<Map<string, CacheEntry>>();

/** Drop cached HTML. Pass a path to target one URL, omit it to clear all. */
export function invalidateSsrCache(path?: string): void {
  liveCaches.forEach((cache) => {
    if (path) cache.delete(path);
    else cache.clear();
  });
}

export function createSsrPipeline(opts: SsrPipelineOptions) {
  const ttl = opts.cacheTtlMs ?? 0;
  const maxEntries = opts.cacheMaxEntries ?? 300;
  const cache = new Map<string, CacheEntry>();
  liveCaches.add(cache);

  /**
   * Render `rawPath` into `template` (index.html with head meta already
   * injected). Returns null when the route is CSR-only or the render fails —
   * caller should fall back to serving the template untouched.
   */
  async function renderInto(
    template: string,
    rawPath: string,
    search: string,
    { cacheable = true }: { cacheable?: boolean } = {},
  ): Promise<string | null> {
    const keys = queriesForPath(rawPath);
    if (keys === null) return null;

    // The CMS preview iframe (/?cmsPreview=1) renders each section inside a
    // click-to-select wrapper the server render doesn't produce, so serving
    // SSR HTML there fails hydration. Preview is an authenticated editor
    // surface with no SEO value — hand it the CSR shell.
    if (new URLSearchParams(search || "").get("cmsPreview") === "1") return null;

    const cached = ttl > 0 && cacheable ? cache.get(rawPath) : undefined;
    if (cached && Date.now() - cached.at < ttl) {
      // Cache holds the complete page (head meta + body). Head and body are
      // built from the same DB read, so they age together — max staleness is
      // one TTL, after which the next request re-renders both.
      return cached.html;
    }

    try {
      const [render, seed] = await Promise.all([
        opts.getRender(),
        prefetch(keys),
      ]);
      const { html, dehydratedState } = await render(rawPath, search, seed);
      const page = injectAppHtml(template, html, dehydratedState);
      // Only cache complete renders. If any prefetch failed (cold start,
      // timeout), the page rendered its loading skeleton — serving that once
      // is fine (the client fetches and renders), but caching it would pin
      // an empty body on the URL for a full TTL. This exact failure shipped
      // the first deploy: /neighbourhoods/* cached skeletons for 5 minutes.
      const complete = seed.length === keys.length;
      if (ttl > 0 && cacheable && complete) {
        if (cache.size >= maxEntries) {
          // Drop the oldest entry (Map preserves insertion order).
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(rawPath, { html: page, at: Date.now() });
      }
      return page;
    } catch (err) {
      console.error(`[ssr] render failed for ${rawPath}, serving CSR shell:`, err);
      return null;
    }
  }

  return { renderInto, cache };
}
