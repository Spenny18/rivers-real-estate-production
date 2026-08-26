import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import session from "express-session";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { storage, stripUser } from "./storage";
import { seedDatabase } from "./seed";
import { signUpSchema, signInSchema, inquirySchema } from "@shared/schema";
import { runSync } from "./rets-sync";
import { fetchListingPhoto } from "./rets-photos";
import { pushLeadToFollowUpBoss } from "./follow-up-boss";
import { getNeighbourhoodPolygon } from "./neighbourhood-polygons";
import { pointInGeometry } from "./point-in-polygon";
import { fetchValuation } from "./gnowise";
import { sendEmail, buildValuationEmailHtml } from "./email";
import {
  getPageContent,
  getPublicPageContent,
  savePageContent,
  resetPageContent,
  isCmsPage,
  CMS_PAGES,
} from "./page-content";
import { normalizeBlocks, normalizeSeo } from "@shared/home-content";
import { invalidateSsrCache } from "./ssr";

const execFileAsync = promisify(execFile);

// Where admin-uploaded images live. In production on Fly this is the
// persistent volume mounted at /data, so files survive redeploys. In dev
// we fall back to a local folder under client/public/ so the dev server
// can serve them too.
const UPLOADS_ROOT = process.env.UPLOADS_ROOT
  || (process.env.NODE_ENV === "production" ? "/data/uploads" : path.resolve(process.cwd(), "client/public/uploads"));
function ensureUploadsDir(sub: string): string {
  const dir = path.join(UPLOADS_ROOT, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseJsonArr(s: string | null | undefined): any[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Parse a Calgary street address like "1188 3 Street SE, Calgary, AB T2G 1H8"
// into {number: "1188", name: "3 Street SE"}. Returns null if it can't find a
// leading numeric street number. Used by the condo endpoint to match listings
// by Pillar 9's separate StreetNumber + StreetName columns.
function parseStreetAddress(full: string): { number: string; name: string } | null {
  if (!full) return null;
  const firstChunk = full.split(",")[0].trim();
  const m = firstChunk.match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  return { number: m[1], name: m[2].trim() };
}

// ---------- POI helper (shared by /api/mls/:id/pois + /api/condo/:slug/pois) ----------
// Fetches schools / restaurants / parks / transit / shops within `radius`
// metres of a point via Overpass. Caches the JSON in pois_cache for 24h. The
// helper returns the same shape the routes already used so the consumers can
// pass the result straight through after wrapping with center/radius/cached.
type PoiBucket = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distance: number;
  kind: string;
  cuisine?: string | null;
  shop?: string;
  tags?: any;
};
type PoiResultPayload = {
  schools: PoiBucket[];
  restaurants: PoiBucket[];
  parks: PoiBucket[];
  transit: PoiBucket[];
};
type FetchPoisResult =
  | { ok: true; payload: PoiResultPayload; cached: boolean }
  | { ok: false; error: string; lastStatus: number | null };

const POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const POI_FAILURE_TTL_MS = 5 * 60 * 1000;
const POI_TOTAL_TIMEOUT_MS = 5_000;
const POI_MIRROR_TIMEOUT_MS = 1_500;
const poiRequests = new Map<string, Promise<FetchPoisResult>>();
const poiFailures = new Map<string, number>();

async function fetchPoisForPoint(
  lat: number,
  lng: number,
  radius = 1000,
): Promise<FetchPoisResult> {
  const cacheId = `${lat.toFixed(4)}:${lng.toFixed(4)}:${radius}`;
  const cached = storage.getPoisCacheById(cacheId);
  const dayAgo = Date.now() - POI_CACHE_TTL_MS;
  if (cached && new Date(cached.fetchedAt).getTime() > dayAgo) {
    try {
      const payload = JSON.parse(cached.payload) as PoiResultPayload;
      return { ok: true, payload, cached: true };
    } catch {
      // fall through and re-fetch
    }
  }

  // Do not let a failed third-party service repeatedly occupy the only app
  // process. An expired cache is preferable to an empty map while Overpass is
  // unavailable; otherwise use a short negative cache.
  if ((poiFailures.get(cacheId) ?? 0) > Date.now()) {
    if (cached) {
      try {
        return { ok: true, payload: JSON.parse(cached.payload), cached: true };
      } catch {}
    }
    return { ok: false, error: "Amenities temporarily unavailable", lastStatus: null };
  }
  const inFlight = poiRequests.get(cacheId);
  if (inFlight) return inFlight;

  const request = fetchPoisUncached(lat, lng, radius, cacheId, cached);
  poiRequests.set(cacheId, request);
  try {
    return await request;
  } finally {
    poiRequests.delete(cacheId);
  }
}

async function fetchPoisUncached(
  lat: number,
  lng: number,
  radius: number,
  cacheId: string,
  staleCache: ReturnType<typeof storage.getPoisCacheById>,
): Promise<FetchPoisResult> {

  const ql = `[out:json][timeout:3];
(
  node[amenity~"^(school|college|university|kindergarten)$"](around:${radius},${lat},${lng});
  way[amenity~"^(school|college|university|kindergarten)$"](around:${radius},${lat},${lng});
  node[amenity~"^(restaurant|cafe|fast_food|pub|bar|bistro)$"](around:${radius},${lat},${lng});
  node["leisure"~"^(park|playground|garden|nature_reserve|pitch|sports_centre|fitness_centre)$"](around:${radius},${lat},${lng});
  way["leisure"~"^(park|playground|garden|nature_reserve|pitch|sports_centre|fitness_centre)$"](around:${radius},${lat},${lng});
  node["public_transport"~"^(station|stop_position|platform)$"](around:${radius},${lat},${lng});
  node["highway"="bus_stop"](around:${radius},${lat},${lng});
  node["railway"~"^(station|halt|tram_stop)$"](around:${radius},${lat},${lng});
  node["shop"~"^(supermarket|mall|convenience|department_store|bakery|deli|greengrocer)$"](around:${radius},${lat},${lng});
);
out center tags;`;
  const OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
  ];
  let overpassData: any = null;
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  const deadline = Date.now() + POI_TOTAL_TIMEOUT_MS;
  for (const url of OVERPASS_MIRRORS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json,text/plain,*/*",
          "User-Agent": "RiversRealEstate/1.0 (https://riversrealestate.ca)",
        },
        body: "data=" + encodeURIComponent(ql),
        signal: AbortSignal.timeout(Math.min(POI_MIRROR_TIMEOUT_MS, remaining)),
      });
      if (!response.ok) {
        lastStatus = response.status;
        lastError = `${url} -> ${response.status}`;
        console.warn("[pois] mirror failed:", lastError);
        continue;
      }
      overpassData = await response.json();
      if (overpassData) break;
    } catch (e: any) {
      lastError = `${url} -> ${e?.message ?? "fetch failed"}`;
      console.warn("[pois] mirror error:", lastError);
    }
  }
  if (!overpassData) {
    poiFailures.set(cacheId, Date.now() + POI_FAILURE_TTL_MS);
    if (staleCache) {
      try {
        return { ok: true, payload: JSON.parse(staleCache.payload), cached: true };
      } catch {}
    }
    return {
      ok: false,
      error: `Overpass mirrors unavailable (last status ${lastStatus ?? "n/a"})`,
      lastStatus,
    };
  }

  const elements: any[] = overpassData.elements ?? [];
  const haversine = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const sa =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(sa));
  };

  const schools: PoiBucket[] = [];
  const restaurants: PoiBucket[] = [];
  const parks: PoiBucket[] = [];
  const transit: PoiBucket[] = [];
  for (const el of elements) {
    const elat = el.lat ?? el.center?.lat;
    const elng = el.lon ?? el.center?.lon;
    if (elat == null || elng == null) continue;
    const tags = el.tags ?? {};
    const name = tags.name ?? tags["name:en"] ?? null;
    if (!name) continue;
    const dist = Math.round(haversine({ lat, lng }, { lat: elat, lng: elng }));
    const base: PoiBucket = {
      id: `${el.type}/${el.id}`,
      name,
      lat: elat,
      lng: elng,
      distance: dist,
      kind: "",
      tags,
    };
    if (tags.amenity && ["school", "college", "university", "kindergarten"].includes(tags.amenity)) {
      schools.push({ ...base, kind: tags.amenity });
    } else if (
      tags.amenity &&
      ["restaurant", "cafe", "fast_food", "pub", "bar", "bistro"].includes(tags.amenity)
    ) {
      restaurants.push({ ...base, kind: tags.amenity, cuisine: tags.cuisine ?? null });
    } else if (tags.leisure) {
      parks.push({ ...base, kind: tags.leisure });
    } else if (tags.public_transport || tags.railway || tags.highway === "bus_stop") {
      let kind = "transit";
      if (tags.railway === "station" || tags.railway === "tram_stop") kind = "train";
      else if (tags.highway === "bus_stop") kind = "bus";
      transit.push({ ...base, kind });
    } else if (tags.shop) {
      transit.push({ ...base, kind: "shop", shop: tags.shop });
    }
  }
  const sortByDist = (arr: PoiBucket[]) =>
    arr.sort((a, b) => a.distance - b.distance).slice(0, 25);
  const payload: PoiResultPayload = {
    schools: sortByDist(schools),
    restaurants: sortByDist(restaurants),
    parks: sortByDist(parks),
    transit: sortByDist(transit),
  };
  storage.upsertPoisCache({
    id: cacheId,
    lat,
    lng,
    radius,
    payload: JSON.stringify(payload),
  });
  poiFailures.delete(cacheId);
  return { ok: true, payload, cached: false };
}

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

// Bearer-token store (used because the deploy proxy strips Set-Cookie headers,
// so the iframe-hosted app cannot use real cookie sessions). Tokens live in
// memory and clear on server restart — acceptable for a single-tenant demo app.
const bearerTokens = new Map<string, { userId: number; createdAt: number }>();
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function issueToken(userId: number): string {
  const token = randomBytes(24).toString("base64url");
  bearerTokens.set(token, { userId, createdAt: Date.now() });
  return token;
}

function resolveUserId(req: Request): number | null {
  // Prefer Authorization: Bearer <token>
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const entry = bearerTokens.get(token);
    if (entry && Date.now() - entry.createdAt < TOKEN_TTL_MS) {
      return entry.userId;
    }
  }
  // Fall back to session cookie (works in dev / direct origin)
  if (req.session?.userId) return req.session.userId;
  return null;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = resolveUserId(req);
  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  (req as any).authUserId = userId;
  next();
}

// Tiny in-memory rate limiter. Tracks request counts per IP per route.
// Sufficient for a single-instance deploy; resets on restart.
function rateLimit(opts: { windowMs: number; max: number; key: string }) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const key = `${opts.key}:${ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (bucket.count >= opts.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res
        .status(429)
        .json({ message: "Too many requests. Please try again shortly." });
    }
    bucket.count += 1;
    next();
  };
}

const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  key: "signin",
});
const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  key: "inquiry",
});
const valuationLimiter = rateLimit({
  // The Gnowise calls cost real money per request, so we cap aggressively.
  // Generous per-window to allow address-correction retries but not abuse.
  windowMs: 60 * 60 * 1000,
  max: 20,
  key: "valuation",
});

async function sendInquiryEmail(opts: {
  name: string;
  email: string;
  phone?: string;
  message: string;
  listingTitle?: string;
  listingAddress?: string;
}) {
  const subject = opts.listingTitle
    ? `New inquiry — ${opts.listingTitle}`
    : `New inquiry from ${opts.name}`;

  const body = [
    `New inquiry received via riversrealestate.ca`,
    ``,
    `Property: ${opts.listingTitle ?? "(general inquiry)"}`,
    opts.listingAddress ? `Address: ${opts.listingAddress}` : "",
    ``,
    `From: ${opts.name}`,
    `Email: ${opts.email}`,
    opts.phone ? `Phone: ${opts.phone}` : "",
    ``,
    `Message:`,
    opts.message,
    ``,
    `—`,
    `Sent automatically from riversrealestate.ca`,
  ]
    .filter(Boolean)
    .join("\n");

  const payload = {
    source_id: "gcal",
    tool_name: "send_email",
    arguments: {
      action: {
        action: "send",
        to: ["spencer@riversrealestate.ca"],
        cc: [],
        bcc: [],
        subject,
        body,
      },
    },
  };

  try {
    const { stdout } = await execFileAsync("external-tool", [
      "call",
      JSON.stringify(payload),
    ], { timeout: 20_000 });
    return { ok: true, response: stdout };
  } catch (err: any) {
    console.error("[inquiry email] failed:", err?.stderr || err?.message || err);
    return { ok: false, error: String(err?.stderr || err?.message || err) };
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // Seed on startup (idempotent)
  try {
    seedDatabase();
  } catch (e) {
    console.error("[seed] failed:", e);
  }

  // Consumer portal (/account/*) endpoints — magic-link auth + favorites.
  // Mounted before the SPA catch-all so /api/account/* routes are served.
  try {
    const { registerAccountRoutes } = await import("./account");
    registerAccountRoutes(app);
  } catch (e) {
    console.error("[account] failed to register portal routes:", e);
  }

  // Home evaluation widget — POST /api/home-value proxies to Gnowise's AVM
  // API and captures a lead. See server/home-value.ts.
  try {
    const { registerHomeValueRoutes } = await import("./home-value");
    registerHomeValueRoutes(app);
  } catch (e) {
    console.error("[home-value] failed to register routes:", e);
  }

  // Serve admin-uploaded media (condo heroes, etc.) from the persistent
  // uploads root. Prefix /uploads/ so it never collides with Vite's
  // client/public/ assets that also live at the site root.
  try {
    if (!fs.existsSync(UPLOADS_ROOT)) fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
    app.use(
      "/uploads",
      express.static(UPLOADS_ROOT, {
        // Hero images change rarely. Browser-cache for 1 day, but bust on
        // each new upload by appending ?v={timestamp} from the seed/db.
        maxAge: "1d",
        fallthrough: true,
      }),
    );
    console.log(`[uploads] serving ${UPLOADS_ROOT} at /uploads`);
  } catch (e) {
    console.error("[uploads] failed to set up uploads dir:", e);
  }

  // ---------- SEO MIGRATION: 301 REDIRECTS ----------
  // Old WordPress URL patterns from luxuryhomescalgary.ca → new SPA routes.
  // Critical for preserving search rankings when the domain is pointed at
  // this app. Each redirect uses 301 (permanent) so Google passes link
  // equity. Express 5 uses path-to-regexp v8 — plain regex routes can crash
  // route registration, so we use string params instead.
  //
  // Coverage: ~232 indexed WP URLs collapse into the categories below.
  //   * /calgary-condos/:slug AND /condos-calgary/:slug → /condos/:slug
  //   * /neighbourhood/:slug-homes-for-sale → /neighbourhoods/:slug
  //   * /listing-detail/:wpId/:address (165 WP listings) → /mls (search shell)
  //   * /properties/:slug (67 WP property pages) → /mls
  //   * /tag/:slug → /blog
  //   * Old marketing pages (buyers, selling, mortgage-calculator, etc.)
  //     → closest equivalent on the React app.
  const slugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/-homes-for-sale$/i, "")
      .replace(/-condos-calgary$/i, "")
      .replace(/-condos$/i, "")
      .replace(/-calgary$/i, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // Condo URL patterns (both WP variants exist in the wild).
  app.get("/calgary-condos/:slug", (req, res) => {
    res.redirect(301, `/condos/${slugify(req.params.slug)}`);
  });
  app.get("/calgary-condos", (_req, res) => res.redirect(301, "/condos"));
  app.get("/condos-calgary/:slug", (req, res) => {
    res.redirect(301, `/condos/${slugify(req.params.slug)}`);
  });
  app.get("/condos-calgary", (_req, res) => res.redirect(301, "/condos"));

  // Neighbourhood URL patterns. WP uses /neighbourhood/aspen-woods-homes-for-sale,
  // React app uses /neighbourhoods/aspen-woods.
  app.get("/neighbourhood/:slug", (req, res) => {
    res.redirect(301, `/neighbourhoods/${slugify(req.params.slug)}`);
  });
  app.get("/neighbourhood", (_req, res) => res.redirect(301, "/neighbourhoods"));
  app.get("/calgary-neighbourhoods/:slug", (req, res) => {
    res.redirect(301, `/neighbourhoods/${slugify(req.params.slug)}`);
  });
  app.get("/calgary-neighbourhoods", (_req, res) => res.redirect(301, "/neighbourhoods"));
  app.get("/neighborhoods", (_req, res) => res.redirect(301, "/neighbourhoods"));

  // WP "listing-detail" pages (165 indexed). The Pillar 9 numeric IDs in
  // WP URLs don't map 1:1 to the React app's MLS letter-prefixed IDs, so
  // we send everyone to the live MLS search rather than a stale 404.
  app.get("/listing-detail/:wpId/:address", (_req, res) => res.redirect(301, "/mls"));
  app.get("/listing-detail/:wpId", (_req, res) => res.redirect(301, "/mls"));
  app.get("/listing-detail", (_req, res) => res.redirect(301, "/mls"));

  // WP "properties" pages (67 indexed) — likely sold listings whose specific
  // pages aren't worth migrating. Push to live search.
  app.get("/properties/:slug", (_req, res) => res.redirect(301, "/mls"));
  app.get("/properties", (_req, res) => res.redirect(301, "/mls"));

  // Other listing-search aliases.
  app.get("/listings", (_req, res) => res.redirect(301, "/mls"));
  app.get("/search", (_req, res) => res.redirect(301, "/mls"));
  app.get("/home-search", (_req, res) => res.redirect(301, "/mls"));

  // WP tag archives → blog index.
  app.get("/tag/:slug", (_req, res) => res.redirect(301, "/blog"));
  app.get("/tag", (_req, res) => res.redirect(301, "/blog"));

  // WP marketing pages → React equivalents.
  app.get("/luxury-real-estate-agent", (_req, res) => res.redirect(301, "/about"));
  app.get("/calgary-luxury-realtor", (_req, res) => res.redirect(301, "/about"));
  app.get("/buyers", (_req, res) => res.redirect(301, "/contact"));
  app.get("/sellers", (_req, res) => res.redirect(301, "/home-evaluation"));
  app.get("/selling-a-luxury-home", (_req, res) => res.redirect(301, "/home-evaluation"));
  app.get("/selling-a-luxury-home-in-calgary", (_req, res) => res.redirect(301, "/home-evaluation"));
  app.get("/mortgage-calculator", (_req, res) => res.redirect(301, "/mls"));
  // NOTE: do not register a redirect for /home-evaluation — the React page
  // owns that path now. Old WP traffic at /valuation funnels into it.
  app.get("/valuation", (_req, res) => res.redirect(301, "/home-evaluation"));

  // ---------- SEO: XML SITEMAPS ----------
  // Split-sitemap setup. Previously this was a single ~5,100-URL document
  // where every URL shared the same per-request `lastmod` timestamp — Google
  // (correctly) interpreted that as a fake signal and stopped trusting our
  // lastmod hints. Worse, the 5,000 MLS listing URLs were drowning the 41
  // blog posts and 73 neighbourhood pages we actually want indexed.
  //
  // New shape: a top-level sitemap *index* points at five purpose-specific
  // sitemaps, each with real per-entity lastmod values (or no lastmod when
  // we don't have a meaningful one — better than a lie). The split lets
  // Search Console report indexation rates per content type and lets us
  // toggle the MLS sitemap off entirely while authority is still low.
  const escapeXml = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  type SitemapUrl = {
    loc: string;
    lastmod?: string;
    priority?: string;
    changefreq?: string;
  };

  const renderUrlset = (urls: SitemapUrl[]): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map((u) => {
        const parts = [`<loc>${escapeXml(u.loc)}</loc>`];
        if (u.lastmod) parts.push(`<lastmod>${u.lastmod}</lastmod>`);
        if (u.changefreq) parts.push(`<changefreq>${u.changefreq}</changefreq>`);
        if (u.priority) parts.push(`<priority>${u.priority}</priority>`);
        return `  <url>${parts.join("")}</url>`;
      })
      .join("\n") +
    `\n</urlset>\n`;

  // Toggle: include the 5,000+ MLS listing URLs in the sitemap index?
  // Default OFF until the domain has enough authority that Google's crawl
  // budget can comfortably absorb them. The /mls search page is still in
  // the pages sitemap and MLS detail pages are still reachable + indexable
  // via internal links + the homepage feed — they just won't be promoted
  // via sitemap, so they don't compete with blog/neighbourhood content for
  // crawl priority.
  const INCLUDE_MLS_SITEMAP = process.env.SITEMAP_INCLUDE_MLS === "1";

  // Sitemap index — entry point Google should pick up from robots.txt.
  app.get("/sitemap.xml", (_req, res) => {
    const origin = process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca";
    const children = [
      `${origin}/sitemap-pages.xml`,
      `${origin}/sitemap-blog.xml`,
      `${origin}/sitemap-neighbourhoods.xml`,
      `${origin}/sitemap-condos.xml`,
    ];
    if (INCLUDE_MLS_SITEMAP) children.push(`${origin}/sitemap-mls.xml`);

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      children
        .map((loc) => `  <sitemap><loc>${escapeXml(loc)}</loc></sitemap>`)
        .join("\n") +
      `\n</sitemapindex>\n`;
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  });

  // Static pages — no lastmod (these change infrequently and we don't track
  // edit timestamps for them; omitting lastmod is preferred over fabricating
  // one).
  app.get("/sitemap-pages.xml", (_req, res) => {
    const origin = process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca";
    const urls: SitemapUrl[] = [
      { loc: `${origin}/`, priority: "1.0", changefreq: "weekly" },
      { loc: `${origin}/mls`, priority: "0.9", changefreq: "daily" },
      { loc: `${origin}/neighbourhoods`, priority: "0.9", changefreq: "weekly" },
      { loc: `${origin}/condos`, priority: "0.9", changefreq: "weekly" },
      { loc: `${origin}/blog`, priority: "0.8", changefreq: "weekly" },
      { loc: `${origin}/about`, priority: "0.6", changefreq: "monthly" },
      { loc: `${origin}/contact`, priority: "0.4", changefreq: "monthly" },
      { loc: `${origin}/home-evaluation`, priority: "0.7", changefreq: "monthly" },
      { loc: `${origin}/work-with`, priority: "0.6", changefreq: "monthly" },
      { loc: `${origin}/assignments`, priority: "0.8", changefreq: "weekly" },
      ...[
        "luxury-properties",
        "first-time-home-sellers",
        "expired-listings",
        "empty-nesters",
        "first-time-home-buyers",
        "innercity-properties",
        "move-ups",
        "family-focused-properties",
        "urban-properties",
      ].map((slug) => ({
        loc: `${origin}/work-with/${slug}`,
        priority: "0.7",
        changefreq: "monthly" as const,
      })),
    ];
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(renderUrlset(urls));
  });

  // Blog posts — uses publishedAt as lastmod (real signal). Drafts excluded.
  app.get("/sitemap-blog.xml", (_req, res) => {
    const origin = process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca";
    const urls: SitemapUrl[] = [];
    try {
      for (const p of storage.listBlogPosts()) {
        if ((p as any).status === "draft") continue;
        urls.push({
          loc: `${origin}/blog/${p.slug}`,
          lastmod: (p as any).publishedAt || undefined,
          priority: "0.8",
          changefreq: "monthly",
        });
      }
    } catch (e) {
      console.error("[sitemap] blog:", e);
    }
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(renderUrlset(urls));
  });

  // Neighbourhoods — no per-entity timestamp in schema, so we omit lastmod.
  app.get("/sitemap-neighbourhoods.xml", (_req, res) => {
    const origin = process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca";
    const urls: SitemapUrl[] = [];
    try {
      for (const n of storage.listNeighbourhoods()) {
        urls.push({
          loc: `${origin}/neighbourhoods/${n.slug}`,
          priority: "0.8",
          changefreq: "weekly",
        });
      }
    } catch (e) {
      console.error("[sitemap] neighbourhoods:", e);
    }
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(renderUrlset(urls));
  });

  // Condo buildings — same reasoning as neighbourhoods.
  app.get("/sitemap-condos.xml", (_req, res) => {
    const origin = process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca";
    const urls: SitemapUrl[] = [];
    try {
      for (const c of storage.listCondoBuildings()) {
        urls.push({
          loc: `${origin}/condos/${c.slug}`,
          priority: "0.7",
          changefreq: "weekly",
        });
      }
    } catch (e) {
      console.error("[sitemap] condos:", e);
    }
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(renderUrlset(urls));
  });

  // MLS listings — only served when SITEMAP_INCLUDE_MLS=1. Uses the most
  // recent meaningful timestamp (priceChangedAt > listDate > createdAt) so
  // Google's lastmod signal reflects real changes, not sync churn.
  app.get("/sitemap-mls.xml", (_req, res) => {
    const origin = process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca";
    if (!INCLUDE_MLS_SITEMAP) {
      res.status(404).set("Content-Type", "application/xml; charset=utf-8");
      res.send(renderUrlset([]));
      return;
    }
    const urls: SitemapUrl[] = [];
    try {
      const listings = storage.searchMlsListings({ limit: 5000 } as any);
      const items = (listings as any).items ?? [];
      for (const l of items as any[]) {
        urls.push({
          loc: `${origin}/mls/${l.seoSlug || storage.getMlsSeoSlug(l)}`,
          lastmod: l.priceChangedAt || l.listDate || l.createdAt || undefined,
          priority: "0.5",
          changefreq: "weekly",
        });
      }
    } catch (e) {
      console.error("[sitemap] mls:", e);
    }
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(renderUrlset(urls));
  });

  // ---------- SEO: robots.txt ----------
  // /api/ is disallowed wholesale, with one deliberate exception: the listing
  // photo proxy (/api/mls/:id/photo/:idx). Those URLs are the real image
  // assets behind every listing's <img>, og:image, and JSON-LD `image` —
  // blocking them meant Google could see the URLs (they're in the rendered
  // HTML) but never fetch them, which produced two problems:
  //   1. "Indexed, though blocked by robots.txt" in Search Console — Google
  //      indexed the photo URL itself, contentless, because it was referenced
  //      but uncrawlable.
  //   2. No listing photo available for image search, rich results, or social
  //      link previews, since og:image pointed at a blocked URL.
  // Allowing the photo path fixes both. Google's rule is longest-match-wins,
  // so this Allow beats `Disallow: /api/` for photos only; every other API
  // route stays blocked.
  app.get("/robots.txt", (_req, res) => {
    const origin = process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca";
    res.set("Content-Type", "text/plain");
    res.send(
      `User-agent: *\n` +
        `Allow: /\n` +
        `Allow: /api/mls/*/photo/\n` +
        `Disallow: /admin\n` +
        `Disallow: /api/\n` +
        `Disallow: /account\n` +
        `\n` +
        `Sitemap: ${origin}/sitemap.xml\n`,
    );
  });

  // ---------- SEO: llms.txt ----------
  // Emerging convention (https://llmstxt.org) — a curated, AI-friendly
  // markdown index of the site. Directory sections are generated from the
  // DB so newly published editorial content appears without a code deploy.
  app.get("/llms.txt", (_req, res) => {
    const HOST = process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca";
    const lines: string[] = [];
    lines.push("# Rivers Real Estate — Luxury Homes Calgary");
    lines.push("");
    lines.push(
      "> Spencer Rivers is a Calgary luxury real estate agent (Synterra Realty) specialising in inner-city and west-side communities: Springbank Hill, Aspen Woods, Upper Mount Royal, Elbow Park, Britannia, and Bel-Aire.",
    );
    lines.push("");
    lines.push(
      "Spencer holds CLHMS, CIPS, CNE, CCS, and LLS designations and is a Million Dollar Guild member. He provides hand-prepared market analyses (not algorithmic Zestimates) for sellers, and full-service buyer representation focused on $1M+ properties. Every market analysis is built personally by Spencer; typical turnaround is one business day.",
    );
    lines.push("");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    lines.push("## Core pages");
    lines.push("");
    lines.push(`- [Home](${HOST}/): Spencer's overview, featured listings, and links into the rest of the site`);
    lines.push(
      `- [Home evaluation](${HOST}/home-evaluation): Request a hand-prepared market analysis or run an instant AVM estimate`,
    );
    lines.push(`- [About Spencer](${HOST}/about): Background, designations, market focus`);
    lines.push(`- [Contact](${HOST}/contact): Phone, email, and inquiry form`);
    lines.push(`- [Who we work with](${HOST}/work-with): Services for Calgary buyers and sellers`);
    lines.push(`- [Assignments](${HOST}/assignments): Calgary assignment opportunities`);
    for (const [slug, label] of [
      ["luxury-properties", "Luxury properties"],
      ["first-time-home-sellers", "First-time home sellers"],
      ["expired-listings", "Expired listings"],
      ["empty-nesters", "Empty nesters"],
      ["first-time-home-buyers", "First-time home buyers"],
      ["innercity-properties", "Inner-city properties"],
      ["move-ups", "Move-up buyers"],
      ["family-focused-properties", "Family-focused properties"],
      ["urban-properties", "Urban properties"],
    ]) {
      lines.push(`- [${label}](${HOST}/work-with/${slug})`);
    }
    lines.push("");
    lines.push("## MLS search");
    lines.push("");
    lines.push(
      `- [Calgary MLS search](${HOST}/mls): Searchable, filterable inventory of active Calgary listings. Updated daily from Pillar 9 (CREB feed).`,
    );
    lines.push(`- Individual listing pages live at \`${HOST}/mls/<MLS-NUMBER>\``);
    lines.push("");
    lines.push("## Neighbourhoods");
    lines.push("");
    try {
      for (const n of storage.listNeighbourhoods()) {
        if (!n?.slug) continue;
        lines.push(`- [${n.name ?? n.slug}](${HOST}/neighbourhoods/${n.slug})`);
      }
    } catch {
      /* keep the rest of the index available on schema errors */
    }
    lines.push(`- [All neighbourhoods](${HOST}/neighbourhoods): Calgary communities with active listings, condo buildings, schools, and FAQs`);
    lines.push("");
    try {
      const condos = storage.listCondoBuildings();
      if (condos.length) {
        lines.push("## Condo buildings");
        lines.push("");
        for (const c of condos) {
          if (!c?.slug) continue;
          lines.push(`- [${c.name ?? c.slug}](${HOST}/condos/${c.slug})`);
        }
        lines.push(`- [All condo buildings](${HOST}/condos)`);
        lines.push("");
      }
    } catch {
      /* skip condo section on schema errors */
    }
    lines.push("## Content");
    lines.push("");
    lines.push(`- [Blog](${HOST}/blog): Articles on Calgary luxury pricing strategy, seller and buyer guides, market updates`);
    try {
      const recentPosts = storage
        .listBlogPosts()
        .filter((p) => p.status !== "draft")
        .slice(0, 20);
      for (const p of recentPosts) {
        if (!p?.slug) continue;
        const date = p.publishedAt ? ` — ${p.publishedAt.slice(0, 10)}` : "";
        lines.push(`- [${p.title}](${HOST}/blog/${p.slug})${date}`);
      }
    } catch {
      /* keep the rest of the index available on schema errors */
    }
    lines.push("");
    lines.push("## Contact");
    lines.push("");
    lines.push("- Phone: +1 (403) 966-9237");
    lines.push("- Email: spencer@riversrealestate.ca");
    lines.push("- Brokerage: Synterra Realty, Calgary, Alberta");
    lines.push("");
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=300");
    res.send(lines.join("\n"));
  });

  // Sessions — cookie-based, no localStorage needed.
  // The deployed site is loaded inside an iframe and the API is proxied
  // through a different origin, so cookies must be SameSite=None+Secure to
  // be accepted in that third-party context. In dev we use lax+insecure.
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) app.set("trust proxy", 1);

  // Resolve session secret. In production we REFUSE to start without one
  // so a forgeable hardcoded fallback can't ship to a live URL.
  let sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProd) {
      // Generate a random per-process secret. Sessions reset on restart,
      // but they cannot be forged.
      sessionSecret = randomBytes(48).toString("base64url");
      console.warn(
        "[auth] SESSION_SECRET not set \u2014 using ephemeral random secret. Sessions reset on restart.",
      );
    } else {
      sessionSecret = "rivers-dev-only-secret";
    }
  }

  app.use(
    session({
      // Published *.pplx.app sites strip any cookie whose name doesn't
      // start with __Host-. Use that prefix in production so the session
      // cookie survives the proxy.
      name: isProd ? "__Host-rivers-sid" : "rivers.sid",
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: isProd ? "none" : "lax",
        secure: isProd,
        path: "/",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  // ---------- AUTH ----------
  // This is a single-tenant back-office for Spencer Rivers. Public sign-up
  // is disabled — the seed user is the only legitimate account. Returning
  // 404 hides the endpoint entirely from probing.
  app.post("/api/auth/sign-up", async (_req, res) => {
    return res.status(404).json({ message: "Not found" });
  });

  app.post("/api/auth/sign-in", signInLimiter, async (req, res) => {
    const parsed = signInSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid credentials" });
    }
    const user = storage.getUserByEmail(parsed.data.email);
    if (!user || !bcrypt.compareSync(parsed.data.password, user.passwordHash)) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    req.session.userId = user.id;
    const token = issueToken(user.id);
    res.json({ user: stripUser(user), token });
  });

  app.post("/api/auth/sign-out", (req, res) => {
    // Invalidate Bearer token if present
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      bearerTokens.delete(auth.slice(7));
    }
    req.session?.destroy?.(() => {
      res.json({ ok: true });
    });
  });

  app.get("/api/auth/me", (req, res) => {
    const userId = resolveUserId(req);
    if (!userId) return res.json({ user: null });
    const user = storage.getUserById(userId);
    if (!user) return res.json({ user: null });
    res.json({ user: stripUser(user) });
  });

  // ---------- LISTINGS ----------
  // Public: list all active listings (used on agent dashboard + public listing page)
  app.get("/api/listings", (_req, res) => {
    res.json(storage.listListings());
  });

  // Public: get listing by slug (public-facing property page)
  app.get("/api/listings/by-slug/:slug", (req, res) => {
    const listing = storage.getListingBySlug(req.params.slug);
    if (!listing) return res.status(404).json({ message: "Listing not found" });
    storage.incrementViews(listing.id);
    res.json(listing);
  });

  // Authenticated: get by id (for editing)
  app.get("/api/listings/:id", requireAuth, (req, res) => {
    const listing = storage.getListingById(req.params.id);
    if (!listing) return res.status(404).json({ message: "Listing not found" });
    res.json(listing);
  });

  app.post("/api/listings", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    try {
      const created = storage.createListing(req.body, userId);
      res.json(created);
    } catch (e: any) {
      res.status(400).json({ message: e.message ?? "Could not create listing" });
    }
  });

  app.patch("/api/listings/:id", requireAuth, (req, res) => {
    const updated = storage.updateListing(req.params.id, req.body);
    if (!updated) return res.status(404).json({ message: "Listing not found" });
    res.json(updated);
  });

  app.delete("/api/listings/:id", requireAuth, (req, res) => {
    const ok = storage.deleteListing(req.params.id);
    res.json({ ok });
  });

  // ---------- LEADS ----------
  // Manual lead creation from /admin/leads UI.
  // PUBLIC: visitor unlock form on listing detail pages. No auth — anyone
  // viewing a listing can submit name + email to unlock photos & details.
  // Creates a Lead with source=listing_unlock so Spencer sees the inbound
  // signal in /admin/leads.
  app.post("/api/public/leads/unlock", (req, res) => {
    const b = req.body ?? {};
    const firstName = (b.firstName || "").toString().trim();
    const lastName = (b.lastName || "").toString().trim();
    const email = (b.email || "").toString().trim();
    if (!firstName) return res.status(400).json({ message: "First name required" });
    if (!email || !email.includes("@")) {
      return res.status(400).json({ message: "Valid email required" });
    }
    const name = lastName ? `${firstName} ${lastName}` : firstName;
    const listingId = typeof b.listingId === "string" ? b.listingId : null;
    const lead = storage.createLead({
      listingId,
      name,
      email,
      phone: null,
      message: listingId ? `Unlocked listing ${listingId}` : "Unlocked listings",
      source: "listing_unlock",
      status: "new",
    });
    pushLeadToFollowUpBoss({
      name,
      email,
      message: listingId ? `Unlocked listing ${listingId}` : "Unlocked listings",
      source: "listing_unlock",
    }).then((r) => {
      if (!r.ok && !r.skipped) console.warn("[unlock] FUB push failed:", r.error);
    });
    res.json({ ok: true, leadId: lead.id });
  });

  app.post("/api/leads", requireAuth, (req, res) => {
    const b = req.body ?? {};
    if (!b.name || typeof b.name !== "string") {
      return res.status(400).json({ message: "Name required" });
    }
    if (!b.email || typeof b.email !== "string") {
      return res.status(400).json({ message: "Email required" });
    }
    const lead = storage.createLead({
      listingId: b.listingId || null,
      name: b.name,
      email: b.email,
      phone: b.phone || null,
      message: b.message || "",
      source: b.source || "manual",
      status: b.status || "new",
    });
    res.json(lead);
  });

  app.get("/api/leads", requireAuth, (_req, res) => {
    res.json(storage.listLeads());
  });

  app.patch("/api/leads/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!req.body.status) return res.status(400).json({ message: "status required" });
    const updated = storage.updateLeadStatus(id, req.body.status);
    if (!updated) return res.status(404).json({ message: "Lead not found" });
    res.json(updated);
  });

  // ---------- MESSAGES ----------
  app.get("/api/leads/:id/messages", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    res.json(storage.listMessagesByLead(id));
  });

  app.post("/api/leads/:id/messages", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!req.body.body) return res.status(400).json({ message: "body required" });
    const msg = storage.createMessage({
      leadId: id,
      fromAgent: true,
      body: req.body.body,
    });
    res.json(msg);
  });

  // ---------- LEAD EMAIL ALERTS (alias to saved_searches) ----------
  // Preserved for backward compat. Lead-attached alerts now live in
  // saved_searches with leadId set; these endpoints are thin proxies that
  // map field names (label -> name) and force leadId.
  app.get("/api/leads/:id/alerts", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const items = storage.listSavedSearchesByLead(id).map((s: any) => ({
      // Legacy shape: id, leadId, label, filters, frequency, instant, active,
      // lastSentAt, lastMatchCount, createdAt — front-end reads these names.
      id: s.id,
      leadId: s.leadId,
      label: s.name,
      filters: (() => { try { return JSON.parse(s.filters); } catch { return {}; } })(),
      frequency: s.frequency ?? "daily",
      instant: !!s.instant,
      active: s.active !== false,
      alertType: s.alertType ?? "listings",
      lastSentAt: s.lastSentAt,
      lastMatchCount: s.lastMatchCount ?? 0,
      createdAt: s.createdAt,
    }));
    res.json(items);
  });

  app.post("/api/leads/:id/alerts", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const { label, filters, frequency, instant, active, alertType } = req.body ?? {};
    if (!label || typeof label !== "string") {
      return res.status(400).json({ message: "Label required" });
    }
    const created = storage.createSavedSearch({
      userId,
      leadId: id,
      name: label,
      filters: filters ?? {},
      emailAlerts: true,
      alertType: alertType ?? "listings",
      frequency: frequency ?? "daily",
      instant: instant === true || frequency === "instant",
      active: active !== false,
    } as any);
    res.json({
      id: created.id,
      leadId: (created as any).leadId,
      label: created.name,
      filters: (() => { try { return JSON.parse(created.filters); } catch { return {}; } })(),
      frequency: (created as any).frequency,
      instant: !!(created as any).instant,
      active: (created as any).active !== false,
      alertType: (created as any).alertType ?? "listings",
      createdAt: created.createdAt,
    });
  });

  app.patch("/api/leads/:leadId/alerts/:alertId", requireAuth, (req, res) => {
    const alertId = parseInt(req.params.alertId, 10);
    if (!Number.isFinite(alertId)) return res.status(400).json({ message: "Invalid id" });
    const patch: any = { ...(req.body ?? {}) };
    // Map legacy field name 'label' -> 'name'
    if (patch.label && !patch.name) {
      patch.name = patch.label;
      delete patch.label;
    }
    if (patch.filters && typeof patch.filters !== "string") {
      patch.filters = JSON.stringify(patch.filters);
    }
    if (patch.frequency === "instant") patch.instant = true;
    if (patch.frequency && patch.frequency !== "instant") patch.instant = false;
    const updated = storage.updateSavedSearch(alertId, patch);
    if (!updated) return res.status(404).json({ message: "Alert not found" });
    res.json(updated);
  });

  app.delete("/api/leads/:leadId/alerts/:alertId", requireAuth, (req, res) => {
    const alertId = parseInt(req.params.alertId, 10);
    if (!Number.isFinite(alertId)) return res.status(400).json({ message: "Invalid id" });
    res.json({ ok: storage.deleteSavedSearch(alertId) });
  });

  // Manual fire — emails the alert immediately regardless of frequency cadence.
  app.post("/api/leads/:leadId/alerts/:alertId/send", requireAuth, async (req, res) => {
    const alertId = parseInt(req.params.alertId, 10);
    if (!Number.isFinite(alertId)) return res.status(400).json({ message: "Invalid id" });
    const alert = storage.getSavedSearchById(alertId);
    if (!alert) return res.status(404).json({ message: "Alert not found" });
    const { processAlert } = await import("./lead-alert-cron");
    const r = await processAlert(alert as any, { force: true });
    res.json({
      scanned: 1,
      sent: r.status === "sent" ? 1 : 0,
      skipped: r.status === "skipped" ? 1 : 0,
      errors: r.status === "error" ? 1 : 0,
      matches: r.matches ?? 0,
      error: r.error,
    });
  });

  // Manual "Send now" — fires this specific saved-search alert immediately,
  // bypassing the cron's due-check (which excludes instant alerts) and the
  // empty-digest skip. Returns {sent, errors, matches} so the client can
  // surface a useful toast.
  app.post("/api/saved-searches/:id/send", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const alert = storage.getSavedSearchById(id);
    if (!alert) return res.status(404).json({ message: "Saved search not found" });
    const { processAlert } = await import("./lead-alert-cron");
    const r = await processAlert(alert as any, { force: true });
    res.json({
      scanned: 1,
      sent: r.status === "sent" ? 1 : 0,
      skipped: r.status === "skipped" ? 1 : 0,
      errors: r.status === "error" ? 1 : 0,
      matches: r.matches ?? 0,
      error: r.error,
    });
  });

  // GET /api/saved-searches/:id/preview — render the email HTML for this
  // saved search WITHOUT sending. Returns text/html so the admin can pop it
  // open in a new tab. Optional ?mode=json returns metadata + html as JSON.
  app.get("/api/saved-searches/:id/preview", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const { buildAlertPreview } = await import("./lead-alert-cron");
    const preview = buildAlertPreview(id);
    if (!preview) return res.status(404).json({ message: "Saved search not found" });
    if (req.query.mode === "json") {
      return res.json({
        subject: preview.subject,
        recipient: preview.recipient,
        recipientName: preview.recipientName,
        alertType: preview.alertType,
        matches: preview.matches,
        html: preview.html,
      });
    }
    // Default: serve the HTML directly so a new browser tab renders it.
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(preview.html);
  });

  // ---------- MARKET SNAPSHOT ----------
  // GET /api/admin/market-snapshot?<filters>&daysBack=30
  // Returns counts of new / sold / terminated / price-reduction listings
  // matching the filter set over the last `daysBack` days.
  app.get("/api/admin/market-snapshot", requireAuth, (req, res) => {
    const q = req.query;
    const num = (v: any) => (v != null && v !== "" ? Number(v) : undefined);
    const str = (v: any) => (typeof v === "string" && v.length ? v : undefined);
    const filters: any = {
      minPrice: num(q.minPrice),
      maxPrice: num(q.maxPrice),
      beds: num(q.beds),
      baths: num(q.baths),
      propertyType: str(q.propertyType),
      neighbourhood: str(q.neighbourhood),
      minSqft: num(q.minSqft),
      maxSqft: num(q.maxSqft),
    };
    const daysBack = num(q.daysBack) ?? 30;
    const snap = storage.marketSnapshot({ filters, daysBack });
    res.json(snap);
  });

  // ---------- GOOGLE CALENDAR INTEGRATION ----------
  app.get("/api/admin/google/status", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    const integ = storage.getUserIntegration(userId, "google");
    res.json({
      connected: !!(integ && integ.active),
      configured: !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      accountEmail: integ?.accountEmail ?? null,
      expiresAt: integ?.expiresAt ?? null,
    });
  });

  app.get("/api/admin/google/connect", requireAuth, async (req, res) => {
    const { googleConfigured, buildAuthUrl } = await import("./google-calendar");
    if (!googleConfigured()) {
      return res.status(400).json({
        message: "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set on server",
      });
    }
    const userId = (req as any).authUserId as number;
    // Use userId as state so the callback can map back. In a multi-tenant
    // app this should be a signed nonce, but Spencer is the only user.
    const state = String(userId);
    res.json({ url: buildAuthUrl(state) });
  });

  // Public callback endpoint (Google redirects here). Auth via the `state`
  // param identifying which user initiated the flow.
  app.get("/api/admin/google/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const error = typeof req.query.error === "string" ? req.query.error : "";
    if (error) {
      return res.redirect(`/admin/calendar?google_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      return res.redirect("/admin/calendar?google_error=missing_code_or_state");
    }
    const userId = parseInt(state, 10);
    if (!Number.isFinite(userId)) {
      return res.redirect("/admin/calendar?google_error=bad_state");
    }
    try {
      const { exchangeCode, persistTokens } = await import("./google-calendar");
      const tokens = await exchangeCode(code);
      await persistTokens(userId, tokens);
      res.redirect("/admin/calendar?google_connected=1");
    } catch (e: any) {
      console.error("[google-cal] callback failed:", e?.message);
      res.redirect(`/admin/calendar?google_error=${encodeURIComponent(e?.message ?? "exchange_failed")}`);
    }
  });

  app.post("/api/admin/google/disconnect", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    res.json({ ok: storage.deleteUserIntegration(userId, "google") });
  });

  // ---------- MAKE.COM SOCIAL WEBHOOK ----------
  // POST /api/admin/social/post — fires the configured Make webhook with the
  // full post payload. Make handles the multi-platform routing.
  app.post("/api/admin/social/post", requireAuth, async (req, res) => {
    const url = process.env.MAKE_SOCIAL_WEBHOOK_URL;
    if (!url) {
      return res
        .status(400)
        .json({ message: "MAKE_SOCIAL_WEBHOOK_URL not set on server" });
    }
    const body = req.body ?? {};
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        return res.status(502).json({ message: `Make webhook ${r.status}`, body: text });
      }
      res.json({ ok: true, makeResponse: text.slice(0, 500) });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "fetch failed" });
    }
  });

  // ---------- TOURS ----------
  app.get("/api/tours", requireAuth, (_req, res) => {
    res.json(storage.listTours());
  });

  app.post("/api/tours", requireAuth, async (req, res) => {
    try {
      const tour = storage.createTour(req.body) as any;
      const userId = (req as any).authUserId as number;
      // Mirror to Google Calendar if user has connected.
      try {
        const { syncTourToGoogle } = await import("./google-calendar");
        const listing = tour.listingId ? storage.getListingById(tour.listingId) : undefined;
        const lead = tour.leadId ? storage.getLead(tour.leadId) : undefined;
        const r = await syncTourToGoogle(userId, tour, listing as any, lead as any);
        if (r.ok && r.eventId) {
          storage.updateTourGoogleEventId(tour.id, r.eventId);
          tour.googleEventId = r.eventId;
        }
      } catch (e: any) {
        console.warn("[google-cal] tour sync (create) failed:", e?.message);
      }
      res.json(tour);
    } catch (e: any) {
      res.status(400).json({ message: e.message ?? "Invalid tour data" });
    }
  });

  app.patch("/api/tours/:id", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const status = (req.body ?? {}).status;
    if (!status || typeof status !== "string") {
      return res.status(400).json({ message: "Status required" });
    }
    const updated = storage.updateTourStatus(id, status) as any;
    if (!updated) return res.status(404).json({ message: "Tour not found" });
    const userId = (req as any).authUserId as number;
    try {
      const { syncTourToGoogle, deleteTourFromGoogle } = await import("./google-calendar");
      if (status === "cancelled") {
        await deleteTourFromGoogle(userId, updated);
        storage.updateTourGoogleEventId(updated.id, null);
      } else {
        const listing = updated.listingId ? storage.getListingById(updated.listingId) : undefined;
        const lead = updated.leadId ? storage.getLead(updated.leadId) : undefined;
        const r = await syncTourToGoogle(userId, updated, listing as any, lead as any);
        if (r.ok && r.eventId && r.eventId !== updated.googleEventId) {
          storage.updateTourGoogleEventId(updated.id, r.eventId);
        }
      }
    } catch (e: any) {
      console.warn("[google-cal] tour sync (patch) failed:", e?.message);
    }
    res.json(updated);
  });

  // ---------- PUBLIC INQUIRY ----------
  // Creates a lead row + sends Spencer an email via Gmail (gcal connector).
  app.post("/api/inquiry", inquiryLimiter, async (req, res) => {
    const parsed = inquirySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0].message });
    }
    const lead = storage.createLead({
      listingId: parsed.data.listingId,
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      message: parsed.data.message,
      source: parsed.data.source ?? "Landing page",
      status: "new",
    } as any);

    // Look up listing details for the email
    let listingTitle: string | undefined;
    let listingAddress: string | undefined;
    if (parsed.data.listingId) {
      const l = storage.getListingById(parsed.data.listingId);
      if (l) {
        listingTitle = l.title;
        listingAddress = l.address;
      }
    }

    // Fire-and-forget email; don't block the response on it
    sendInquiryEmail({
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      message: parsed.data.message,
      listingTitle,
      listingAddress,
    }).then((r) => {
      if (!r.ok) console.warn("[inquiry] email did not send:", r.error);
    });

    // Fire-and-forget push into Follow Up Boss (soft-skips without FUB_API_KEY)
    pushLeadToFollowUpBoss({
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      message: parsed.data.message,
      listingTitle,
      listingAddress,
      source: parsed.data.source ?? "Landing page",
    }).then((r) => {
      if (!r.ok && !r.skipped) console.warn("[inquiry] FUB push failed:", r.error);
    });

    res.json({ ok: true, leadId: lead.id });
  });

  // ---------- INSTANT VALUATION (Gnowise Unified Valuation API v2) --------
  const valNum = (v: unknown): number | undefined => {
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const valStr = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    return s.length ? s : undefined;
  };
  // Gnowise §4 refinement attributes forwarded from the widget — these are
  // what turn a near-empty $268K record into an accurate $1.8M+ estimate.
  const extractAttrs = (body: any) => ({
    propertyType: valStr(body?.propertyType),
    style: valStr(body?.style),
    bedrooms: valNum(body?.bedrooms),
    den: valNum(body?.den),
    washrooms: valNum(body?.washrooms),
    kitchens: valNum(body?.kitchens),
    parkingSpaces: valNum(body?.parkingSpaces),
    pool: valStr(body?.pool),
    basement: valStr(body?.basement),
    roomsArea: valNum(body?.roomsArea),
    lotArea: valNum(body?.lotArea),
    age: valStr(body?.age),
    ac: valStr(body?.ac),
    garageType: valStr(body?.garageType),
    garageSpaces: valNum(body?.garageSpaces),
    buildingArea: valNum(body?.buildingArea),
    maintenanceFee: valNum(body?.maintenanceFee),
    maintenanceFeeYear: valNum(body?.maintenanceFeeYear),
    histValue: valNum(body?.histValue),
    histValueDate: valStr(body?.histValueDate),
    histPropertyType: valStr(body?.histPropertyType),
  });

  // POST /api/public/valuation — Gnowise instant address-to-value proxy.
  // The API key never leaves the server; the browser only ever sees the
  // sanitized estimate. Rate-limited because each call costs real money.
  app.post("/api/public/valuation", valuationLimiter, async (req, res) => {
    const address = String(req.body?.address ?? "").trim();
    if (address.length < 6) {
      return res.json({
        ok: false,
        message: "Please enter a valid street address (with city and postal code).",
      });
    }
    const aptNum = String(req.body?.aptNum ?? "").trim();
    const isCondo = !!req.body?.isCondo || !!aptNum;
    const condition = valNum(req.body?.condition) ?? 3;
    const postalCode = String(req.body?.postalCode ?? "").trim();
    const municipality = String(req.body?.municipality ?? "").trim();
    const province = String(req.body?.province ?? "").trim();
    const result = await fetchValuation({
      address,
      aptNum: aptNum || undefined,
      isCondo,
      condition,
      postalCode: postalCode || undefined,
      municipality: municipality || undefined,
      province: province || undefined,
      ...extractAttrs(req.body),
    });
    res.json(result);
  });

  // POST /api/public/valuation/email — email a valuation report. Recomputes
  // server-side rather than trusting a client-supplied number; creates a
  // lead, notifies Spencer, and pushes to Follow Up Boss.
  app.post("/api/public/valuation/email", valuationLimiter, async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const email = String(req.body?.email ?? "").trim();
    const phone = String(req.body?.phone ?? "").trim();
    const address = String(req.body?.address ?? "").trim();
    const aptNum = String(req.body?.aptNum ?? "").trim();
    const isCondo = !!req.body?.isCondo || !!aptNum;
    if (!email.includes("@") || address.length < 6 || name.length < 2) {
      return res
        .status(400)
        .json({ ok: false, message: "Name, email, and address are required." });
    }
    const postalCode = String(req.body?.postalCode ?? "").trim();
    const municipality = String(req.body?.municipality ?? "").trim();
    const province = String(req.body?.province ?? "").trim();
    const result = await fetchValuation({
      address,
      aptNum: aptNum || undefined,
      isCondo,
      condition: valNum(req.body?.condition) ?? 3,
      postalCode: postalCode || undefined,
      municipality: municipality || undefined,
      province: province || undefined,
      ...extractAttrs(req.body),
    });
    if (!result.ok || result.estimate == null) {
      return res.json({
        ok: false,
        message: result.message ?? "Couldn't generate an estimate for that address.",
      });
    }

    const origin = process.env.PUBLIC_ORIGIN ?? "https://riversrealestate.ca";
    const firstName = name.split(/\s+/)[0];

    // 1. Email the visitor with their valuation report.
    const visitorHtml = buildValuationEmailHtml({
      recipientFirstName: firstName,
      address: aptNum ? `${address} (Unit ${aptNum})` : address,
      estimate: result.estimate,
      valueLow: result.valueLow,
      valueHigh: result.valueHigh,
      confidence: result.confidence,
      estimatedLease: result.estimatedLease,
      capRate: result.capRate,
      parameters: result.parameters,
      origin,
    });
    const visitorEmail = await sendEmail({
      to: email,
      subject: `Your instant home valuation — ${address}`,
      html: visitorHtml,
      replyTo: "spencer@riversrealestate.ca",
    });

    // 2. Capture the visitor as a lead so it lands in /admin/leads + the
    //    Resend notification to Spencer + the FUB push fire.
    const messageLines = [
      `Instant valuation requested via /home-evaluation widget.`,
      ``,
      `Address: ${aptNum ? `${address} (Unit ${aptNum})` : address}`,
      `Estimate: $${Math.round(result.estimate).toLocaleString("en-CA")}`,
      result.valueLow != null && result.valueHigh != null
        ? `Range: $${Math.round(result.valueLow).toLocaleString("en-CA")} – $${Math.round(result.valueHigh).toLocaleString("en-CA")}`
        : "",
      result.confidence != null
        ? `Confidence: ${Math.round(result.confidence * 100)}% (${result.valuationSource === "A" ? "AVM" : result.valuationSource === "H" ? "HPI" : "HPI adjusted"})`
        : "",
      result.estimatedLease != null
        ? `Rent est: $${Math.round(result.estimatedLease).toLocaleString("en-CA")}/mo`
        : "",
      result.capRate != null ? `Cap rate: ${(result.capRate * 100).toFixed(2)}%` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const lead = storage.createLead({
      listingId: null as any,
      name,
      email,
      phone: phone || (null as any),
      message: messageLines,
      source: "Home valuation widget",
      status: "new",
    } as any);

    // Mirror the inquiry pipeline: notify Spencer + push to FUB.
    sendInquiryEmail({
      name,
      email,
      phone: phone || undefined,
      message: messageLines,
      listingTitle: "Instant home valuation",
      listingAddress: aptNum ? `${address} (Unit ${aptNum})` : address,
    }).then((r) => {
      if (!r.ok) console.warn("[valuation email] spencer notify failed:", r.error);
    });
    pushLeadToFollowUpBoss({
      name,
      email,
      phone: phone || undefined,
      message: messageLines,
      source: "Home valuation widget",
    }).then((r) => {
      if (!r.ok && !r.skipped)
        console.warn("[valuation email] FUB push failed:", r.error);
    });

    // Return the full valuation result alongside the email-send status so
    // the widget can render the inline estimate immediately.
    res.json({
      ok: visitorEmail.ok,
      leadId: lead.id,
      result,
      message: visitorEmail.ok
        ? "Sent."
        : "Couldn't deliver the email — try again or contact Spencer directly.",
    });
  });

  // ---------- PUBLIC MLS / MARKETING API ----------
  // GET /api/public/mls/distinct?field=subdivision|district|city|neighbourhood
  // Returns sorted unique non-empty values currently in the database. Used
  // by the public search to render dynamic checkbox lists for high-cardinality
  // free-text columns (Pillar 9 has hundreds of subdivisions across Alberta).
  app.get("/api/public/mls/distinct", (req, res) => {
    const field = String(req.query.field ?? "");
    const allowed = new Set(["subdivision", "district", "city", "neighbourhood", "structureType", "architecturalStyle"]);
    if (!allowed.has(field)) {
      return res.status(400).json({ message: "Field not allowed" });
    }
    const values = storage.distinctMlsValues(field as any);
    res.json({ field, values });
  });

  // GET /api/public/mls/search — paginated, filterable MLS search
  app.get("/api/public/mls/search", (req, res) => {
    const q = req.query;
    const num = (v: any) => (v != null && v !== "" ? Number(v) : undefined);
    const str = (v: any) => (typeof v === "string" && v.length ? v : undefined);
    const bool = (v: any) => v === "true" || v === "1";
    // Multi-value list — accept either repeated `key=a&key=b` or comma-separated.
    const list = (v: any): string[] | undefined => {
      let arr: string[] = [];
      if (Array.isArray(v)) arr = v.filter((x) => typeof x === "string") as string[];
      else if (typeof v === "string") arr = v.split(",");
      arr = arr.map((s) => s.trim()).filter(Boolean);
      return arr.length ? arr : undefined;
    };
    const result = storage.searchMlsListings({
      q: str(q.q),
      minPrice: num(q.minPrice),
      maxPrice: num(q.maxPrice),
      beds: num(q.beds),
      baths: num(q.baths),
      propertyType: str(q.propertyType),
      propertySubTypes: list(q.propertySubTypes ?? q.propertySubType),
      cities: list(q.cities ?? q.city),
      neighbourhood: str(q.neighbourhood),
      postalCode: str(q.postalCode),
      statuses: list(q.statuses ?? q.status) ?? ["Active"],
      minSqft: num(q.minSqft),
      maxSqft: num(q.maxSqft),
      yearMin: num(q.yearMin),
      yearMax: num(q.yearMax),
      garageMin: num(q.garageMin),
      domMax: num(q.domMax),
      hasPhotos: bool(q.hasPhotos),
      // Boolean toggles
      garageYn: q.garageYn != null ? bool(q.garageYn) : undefined,
      poolYn: q.poolYn != null ? bool(q.poolYn) : undefined,
      waterfrontYn: q.waterfrontYn != null ? bool(q.waterfrontYn) : undefined,
      airConditioned: q.airConditioned != null ? bool(q.airConditioned) : undefined,
      suiteYn: q.suiteYn != null ? bool(q.suiteYn) : undefined,
      legalSuiteYn: q.legalSuiteYn != null ? bool(q.legalSuiteYn) : undefined,
      suiteLocations: list(q.suiteLocations),
      // Multi-value structured filters — match if ANY value appears in the
      // listing's RETS string (so basement=Walkout&basement=Finished returns
      // listings that have either Walkout or Finished in their basement field).
      basements: list(q.basements ?? q.basement),
      basementDevelopments: list(q.basementDevelopments),
      parkingFeatures: list(q.parkingFeatures),
      lotFeatures: list(q.lotFeatures),
      laundryFeatures: list(q.laundryFeatures),
      appliances: list(q.appliances),
      levels: list(q.levels),
      structureTypes: list(q.structureTypes),
      architecturalStyles: list(q.architecturalStyles),
      accessibilityFeatures: list(q.accessibilityFeatures),
      associationAmenities: list(q.associationAmenities),
      views: list(q.views),
      subdivisions: list(q.subdivisions ?? q.subdivision),
      districts: list(q.districts ?? q.district),
      keywords: str(q.keywords),
      condoFeeMax: num(q.condoFeeMax),
      sort: q.sort as any,
      limit: num(q.limit) ?? 24,
      offset: num(q.offset) ?? 0,
    });
    res.json(result);
  });

  // GET /api/public/mls/featured
  app.get("/api/public/mls/featured", (_req, res) => {
    res.json(storage.listFeaturedMls(6));
  });

  // GET /api/admin/rets/object-types — debug endpoint that queries Pillar 9
  // GetMetadata for OBJECT and returns the supported photo type names. Use
  // this to find the right value for RETS_PHOTO_TYPE (e.g. LargePhoto, Photo,
  // Thumbnail, HiRes). Returns the parsed XML so we can see all valid types.
  app.get("/api/admin/rets/object-types", requireAuth, async (_req, res) => {
    try {
      const { RetsClient } = await import("./rets-client");
      const c = new RetsClient({
        loginUrl: process.env.RETS_LOGIN_URL!,
        username: process.env.RETS_USERNAME!,
        password: process.env.RETS_PASSWORD!,
        userAgent: process.env.RETS_USER_AGENT ?? "RiversRealEstate/1.0",
        uaPassword: process.env.RETS_UA_PASSWORD || undefined,
      });
      await c.login();
      const meta = await c.getMetadata({ type: "METADATA-OBJECT", id: "Property" });
      res.json(meta);
    } catch (err: any) {
      res.status(500).json({ message: err?.message ?? "Metadata fetch failed" });
    }
  });

  // GET /api/mls/:id/photo/:idx — proxy real RETS photos through our server
  // so the browser never sees Pillar 9 credentials. Photos are cached for 24h
  // in memory (LRU, max 500 entries). Falls back to 404 → client placeholder.
  app.get("/api/mls/:id/photo/:idx", async (req, res) => {
    const id = req.params.id;
    const idx = parseInt(req.params.idx, 10);
    if (!id || !Number.isFinite(idx) || idx < 0 || idx > 49) {
      return res.status(400).json({ message: "Invalid photo request" });
    }
    // First check the listing exists and has at least idx+1 photos
    const listing = storage.getMlsListingById(id);
    if (!listing) return res.status(404).json({ message: "Listing not found" });
    if ((listing.photoCount ?? 0) <= idx) {
      return res.status(404).json({ message: "Photo index out of range" });
    }
    try {
      const photo = await fetchListingPhoto(id, idx);
      if (!photo) return res.status(404).json({ message: "Photo not available" });
      res.setHeader("Content-Type", photo.contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      return res.end(photo.body);
    } catch (err: any) {
      console.error("[photo proxy] failure:", err?.message ?? err);
      return res.status(502).json({ message: "Photo backend unavailable" });
    }
  });

  // GET /api/public/mls/:id
  app.get("/api/public/mls/:id", (req, res) => {
    const listing = storage.getMlsListingBySeoSlug(req.params.id) ?? storage.getMlsListingById(req.params.id);
    if (!listing) return res.status(404).json({ message: "Listing not found" });
    const safeParse = (s: string | null | undefined): any[] => {
      if (!s) return [];
      try { return JSON.parse(s); } catch { return []; }
    };
    const similar = storage.listSimilarMls(listing, 4);
    res.json({
      ...listing,
      seoSlug: storage.getMlsSeoSlug(listing),
      gallery: safeParse(listing.gallery as any),
      features: safeParse(listing.features as any),
      similar: similar.map((item: any) => ({ ...item, seoSlug: item.seoSlug || storage.getMlsSeoSlug(item) })),
    });
  });

  // GET /api/public/neighbourhoods (list). Counts and averages are refreshed
  // after MLS sync, so this hot directory endpoint must not rescan thousands
  // of listings once or twice for every neighbourhood on every page view.
  app.get("/api/public/neighbourhoods", (_req, res) => {
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const items = storage.listNeighbourhoods().map((n) => ({
      slug: n.slug,
      name: n.name,
      tagline: n.tagline,
      zone: n.zone,
      heroImage: n.heroImage,
      activeCount: n.activeCount,
      avgPrice: n.avgPrice,
      sortOrder: n.sortOrder,
    }));
    res.json(items);
  });

  // GET /api/public/condos (list)
  app.get("/api/public/condos", (_req, res) => {
    const items = storage.listCondoBuildings().map((c) => ({
      ...c,
      intro: parseJsonArr(c.intro),
      residencesCopy: parseJsonArr(c.residencesCopy),
      architecturalCopy: parseJsonArr(c.architecturalCopy),
      locationCopy: parseJsonArr((c as any).locationCopy),
      diningCopy: parseJsonArr((c as any).diningCopy),
      shoppingCopy: parseJsonArr((c as any).shoppingCopy),
      communityCopy: parseJsonArr((c as any).communityCopy),
      schoolsCopy: parseJsonArr((c as any).schoolsCopy),
      amenities: parseJsonArr(c.amenities),
      gallery: parseJsonArr(c.gallery),
    }));
    res.json(items);
  });

  // GET /api/public/condos/:slug
  app.get("/api/public/condos/:slug", (req, res) => {
    const c = storage.getCondoBuildingBySlug(req.params.slug);
    if (!c) return res.status(404).json({ message: "Condo building not found" });
    // Match by street number + street name. Pillar 9 now syncs StreetNumber
    // and StreetName as separate columns so this is the precise way to find
    // every unit in the building. Address parser handles e.g.
    // "1188 3 Street SE, Calgary, AB T2G 1H8" → number "1188", name "3 Street SE".
    // Some buildings span multiple street numbers (e.g. The River = 135 + 137
    // 26 Ave SW); `addressAliases` is a comma-separated list of additional
    // numbers at the same street name.
    const parsed = parseStreetAddress(c.address);
    let raw: any[] = [];
    if (parsed) {
      const numbers = [parsed.number];
      if ((c as any).addressAliases) {
        for (const alias of String((c as any).addressAliases).split(",")) {
          const n = alias.trim();
          if (n && !numbers.includes(n)) numbers.push(n);
        }
      }
      const seen = new Set<string>();
      for (const num of numbers) {
        const matches = storage.listMlsAtBuilding(num, parsed.name, 60);
        for (const m of matches) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            raw.push(m);
          }
        }
      }
    }
    // Fallbacks for listings synced before StreetNumber/StreetName were
    // populated: GPS first, then address substring.
    if (raw.length === 0) {
      raw = storage.listingsAtBuilding(c.lat, c.lng, 75, 60);
    }
    if (raw.length === 0) {
      const addressKey = c.address.split(",")[0].trim();
      raw = storage.listingsAtAddress(addressKey, 60);
    }
    const listings = raw.map((l) => ({
      id: l.id,
      mlsNumber: l.mlsNumber,
      seoSlug: storage.getMlsSeoSlug(l),
      fullAddress: l.fullAddress,
      subdivision: l.subdivision,
      city: l.city,
      listPrice: l.listPrice,
      beds: l.beds,
      baths: l.baths,
      sqft: l.sqft,
      photoCount: l.photoCount,
      heroImage: l.heroImage,
      status: l.status,
      neighbourhood: l.neighbourhood,
      lat: l.lat,
      lng: l.lng,
    }));
    res.json({
      ...c,
      intro: parseJsonArr(c.intro),
      residencesCopy: parseJsonArr(c.residencesCopy),
      architecturalCopy: parseJsonArr(c.architecturalCopy),
      locationCopy: parseJsonArr((c as any).locationCopy),
      diningCopy: parseJsonArr((c as any).diningCopy),
      shoppingCopy: parseJsonArr((c as any).shoppingCopy),
      communityCopy: parseJsonArr((c as any).communityCopy),
      schoolsCopy: parseJsonArr((c as any).schoolsCopy),
      amenities: parseJsonArr(c.amenities),
      gallery: parseJsonArr(c.gallery),
      listings,
    });
  });

  // ==========================================================================
  // ADMIN — Condo CMS endpoints
  //
  // Spencer manages condo content (text, hero images, subdivisions, etc.) via
  // /admin/condos. The seed only INSERTS new condos on first boot — once
  // a condo is in the db, the admin UI is the source of truth (see seed.ts).
  // ==========================================================================

  // Helper: convert raw DB row -> client-friendly condo (parses JSON arrays).
  const adminCondoToJson = (c: any) => ({
    ...c,
    intro: parseJsonArr(c.intro),
    residencesCopy: parseJsonArr(c.residencesCopy),
    architecturalCopy: parseJsonArr(c.architecturalCopy),
    locationCopy: parseJsonArr(c.locationCopy),
    diningCopy: parseJsonArr(c.diningCopy),
    shoppingCopy: parseJsonArr(c.shoppingCopy),
    communityCopy: parseJsonArr(c.communityCopy),
    schoolsCopy: parseJsonArr(c.schoolsCopy),
    amenities: parseJsonArr(c.amenities),
    gallery: parseJsonArr(c.gallery),
  });
  // Helper: serialize incoming JSON arrays back to TEXT for SQLite.
  const adminCondoToRow = (data: any): any => {
    const out: any = { ...data };
    for (const f of [
      "intro", "residencesCopy", "architecturalCopy",
      "locationCopy", "diningCopy", "shoppingCopy", "communityCopy", "schoolsCopy",
      "amenities", "gallery",
    ]) {
      if (Array.isArray(out[f])) out[f] = JSON.stringify(out[f]);
    }
    return out;
  };

  app.get("/api/admin/condos", requireAuth, (_req, res) => {
    const rows = storage.listCondoBuildings();
    res.json(rows.map(adminCondoToJson));
  });

  app.get("/api/admin/condos/:slug", requireAuth, (req, res) => {
    const c = storage.getCondoBuildingBySlug(req.params.slug);
    if (!c) return res.status(404).json({ message: "Condo not found" });
    res.json(adminCondoToJson(c));
  });

  // PATCH — partial update. Slug is the row key and cannot be changed.
  app.patch("/api/admin/condos/:slug", requireAuth, (req, res) => {
    const slug = req.params.slug;
    const existing = storage.getCondoBuildingBySlug(slug);
    if (!existing) return res.status(404).json({ message: "Condo not found" });
    try {
      const row = adminCondoToRow(req.body);
      delete row.slug; // Never allow slug rename via PATCH
      const updated = storage.updateCondoBuilding(slug, row);
      res.json(adminCondoToJson(updated));
    } catch (err: any) {
      console.error("[admin] update condo failed:", err);
      res.status(500).json({ message: err?.message ?? "Update failed" });
    }
  });

  // POST — create a brand-new condo. Slug is required + must not collide.
  app.post("/api/admin/condos", requireAuth, (req, res) => {
    const body = req.body || {};
    if (!body.slug || !/^[a-z0-9-]+$/.test(body.slug)) {
      return res.status(400).json({ message: "Slug is required (lowercase + hyphens only)" });
    }
    if (storage.getCondoBuildingBySlug(body.slug)) {
      return res.status(409).json({ message: "A condo with this slug already exists" });
    }
    const row = adminCondoToRow({
      slug: body.slug,
      name: body.name || body.slug,
      tagline: body.tagline || "",
      intro: body.intro ?? [],
      residencesCopy: body.residencesCopy ?? [],
      architecturalCopy: body.architecturalCopy ?? [],
      locationCopy: body.locationCopy ?? [],
      diningCopy: body.diningCopy ?? [],
      shoppingCopy: body.shoppingCopy ?? [],
      communityCopy: body.communityCopy ?? [],
      schoolsCopy: body.schoolsCopy ?? [],
      amenities: body.amenities ?? [],
      address: body.address || "",
      addressAliases: body.addressAliases ?? null,
      neighbourhoodSlug: body.neighbourhoodSlug || "beltline",
      neighbourhood: body.neighbourhood || "",
      quadrant: body.quadrant || "city-centre",
      units: body.units ?? null,
      stories: body.stories ?? null,
      builtIn: body.builtIn ?? null,
      developer: body.developer ?? null,
      architect: body.architect ?? null,
      lat: body.lat ?? 51.05,
      lng: body.lng ?? -114.07,
      heroImage: body.heroImage || "/condo-heroes/placeholder.png",
      gallery: body.gallery ?? [],
      sortOrder: body.sortOrder ?? 999,
      featured: body.featured ?? false,
    });
    try {
      const created = storage.upsertCondoBuilding(row);
      res.status(201).json(adminCondoToJson(created));
    } catch (err: any) {
      res.status(500).json({ message: err?.message ?? "Create failed" });
    }
  });

  // DELETE — remove a condo from the db.
  app.delete("/api/admin/condos/:slug", requireAuth, (req, res) => {
    const ok = storage.deleteCondoBuilding(req.params.slug);
    if (!ok) return res.status(404).json({ message: "Condo not found" });
    res.json({ ok: true });
  });

  // POST — upload a hero image as a base64 data URL. Server decodes, writes to
  // the persistent uploads volume, and updates the condo row to point at the
  // new public URL.
  app.post("/api/admin/condos/:slug/hero", requireAuth, (req, res) => {
    const slug = req.params.slug;
    const c = storage.getCondoBuildingBySlug(slug);
    if (!c) return res.status(404).json({ message: "Condo not found" });
    const dataUrl: string | undefined = req.body?.dataUrl;
    if (!dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ message: "dataUrl is required (data:image/...;base64,...)" });
    }
    const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/);
    if (!m) return res.status(400).json({ message: "dataUrl must be a base64 image (png|jpg|jpeg|webp|gif)" });
    let extRaw = m[1].toLowerCase();
    if (extRaw === "jpeg") extRaw = "jpg";
    const ext = extRaw;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 10 * 1024 * 1024) {
      return res.status(413).json({ message: "Image too large (max 10MB)" });
    }
    try {
      const dir = ensureUploadsDir("condo-heroes");
      // Write to a temp file then rename so the static server never serves a
      // half-written PNG. Cache-bust via ?v=timestamp on the saved URL.
      const tmp = path.join(dir, `${slug}.${ext}.tmp`);
      const final = path.join(dir, `${slug}.${ext}`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, final);
      // Clean up any stale alternate-extension file (e.g. uploaded PNG before, JPG now)
      for (const otherExt of ["png", "jpg", "webp", "gif"]) {
        if (otherExt === ext) continue;
        const stale = path.join(dir, `${slug}.${otherExt}`);
        if (fs.existsSync(stale)) {
          try { fs.unlinkSync(stale); } catch {}
        }
      }
      const heroUrl = `/uploads/condo-heroes/${slug}.${ext}?v=${Date.now()}`;
      const updated = storage.updateCondoBuilding(slug, { heroImage: heroUrl } as any);
      res.json({ heroImage: heroUrl, condo: adminCondoToJson(updated) });
    } catch (err: any) {
      console.error("[admin] hero upload failed:", err);
      res.status(500).json({ message: err?.message ?? "Hero upload failed" });
    }
  });

  // GET /api/public/neighbourhoods/:slug
  app.get("/api/public/neighbourhoods/:slug", async (req, res) => {
    const n = storage.getNeighbourhoodBySlug(req.params.slug);
    if (!n) return res.status(404).json({ message: "Neighbourhood not found" });
    // Canonical match cascade (subdivision → legacy name → eponymous street →
    // tight GPS). Shared with the POI route so the two agree.
    // OSM boundary polygon (lazy-fetched from Nominatim, cached in the row).
    // Fetched BEFORE matching so the cascade's guess-based steps (legacy
    // neighbourhood field, GPS proximity) can be geofenced at the source.
    let polygon: unknown = null;
    try {
      polygon = await getNeighbourhoodPolygon(n.slug, n.name, n.centerLat, n.centerLng);
    } catch (err) {
      console.warn(`[polygons] lookup failed for ${n.slug}:`, err);
    }
    let activeMatches = storage.listMlsForNeighbourhood(n, 5000, polygon as any);
    // When a boundary exists, geofence the remaining (authoritative) matches
    // too — but never let a coarse or wrong polygon blank a community that
    // has real inventory.
    try {
      if (polygon) {
        const inside = activeMatches.filter(
          (l: any) =>
            typeof l.lat === "number" &&
            typeof l.lng === "number" &&
            pointInGeometry(l.lng, l.lat, polygon as any),
        );
        if (inside.length > 0) activeMatches = inside;
      }
    } catch (err) {
      console.warn(`[polygons] lookup failed for ${n.slug}:`, err);
    }
    const listings = activeMatches.slice(0, 24);
    const liveActiveCount = activeMatches.length;
    const liveAvgPrice =
      liveActiveCount > 0
        ? Math.round(activeMatches.reduce((s, l) => s + (l.listPrice || 0), 0) / liveActiveCount)
        : n.avgPrice;
    // Use the listings' centroid as the display center — the stored
    // center_lat/center_lng has drifted km off for several neighbourhoods, and
    // the centroid keeps the map pin + POIs sitting on the actual homes.
    const center = storage.neighbourhoodDisplayCenter(n, activeMatches);
    // Condo buildings section — dedicated condo pages in this neighbourhood
    // (linkable, listed first) merged with the researched name list stored on
    // the row. Deduped by normalized name so a building that gains its own
    // page later automatically upgrades from plain text to a link.
    const condoPages = storage
      .listCondoBuildings()
      .filter((c) => c.neighbourhoodSlug === n.slug);
    const normName = (s: string) =>
      s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
    const seenNames = new Set(condoPages.map((c) => normName(c.name)));
    const condoBuildingsMerged = [
      ...condoPages.map((c) => ({
        name: c.name,
        address: c.address,
        slug: c.slug,
      })),
      ...(parseJsonArr((n as any).condoBuildingsList) as Array<{ name?: string; address?: string }>)
        .filter((b) => b && typeof b.name === "string" && b.name.trim().length > 0)
        .filter((b) => {
          const k = normName(b.name!);
          if (seenNames.has(k)) return false;
          seenNames.add(k);
          return true;
        })
        .map((b) => ({ name: b.name!.trim(), address: b.address || undefined, slug: undefined })),
    ];
    // Photo attribution for CC-licensed heroes (JSON string in the column).
    let heroCredit: unknown = null;
    try { heroCredit = (n as any).heroCredit ? JSON.parse((n as any).heroCredit) : null; } catch { heroCredit = null; }
    res.json({
      ...n,
      centerLat: center.lat,
      centerLng: center.lng,
      heroCredit,
      polygon,
      condoBuildings: condoBuildingsMerged,
      activeCount: liveActiveCount,
      avgPrice: liveAvgPrice,
      story: parseJsonArr(n.story),
      outsideCopy: parseJsonArr(n.outsideCopy),
      amenitiesCopy: parseJsonArr(n.amenitiesCopy),
      shopDineCopy: parseJsonArr(n.shopDineCopy),
      realEstateCopy: parseJsonArr(n.realEstateCopy),
      lifeCopy: parseJsonArr(n.lifeCopy),
      schools: parseJsonArr(n.schools),
      gallery: parseJsonArr(n.gallery),
      borders: (() => { try { return JSON.parse(n.borders); } catch { return {}; } })(),
      listings,
    });
  });

  // GET /api/public/config — exposes runtime config the public site needs
  // at the client (currently: Google Maps API key for the home-evaluation
  // address autocomplete). The key is meant to be public — security comes
  // from HTTP-referrer restrictions on the Google Cloud Console side, not
  // from hiding the value.
  // ---------- PAGE CMS (/admin/home) ----------
  // The homepage renders from an ordered list of content blocks stored in
  // the `pages` table (shape + factory defaults: shared/home-content.ts).
  // Reads fall back to the factory page when no row exists, so the site is
  // never blank on a fresh database.

  /** Editing "/" invalidates the cached SSR HTML for it, so saves show up
   * immediately instead of after the 5-minute render cache expires. */
  function currentUserEmail(req: Request): string | null {
    const id = resolveUserId(req);
    if (id == null) return null;
    return storage.getUserById(id)?.email ?? null;
  }

  function invalidatePageCache(slug: string) {
    const path = CMS_PAGES[slug]?.path;
    if (path) invalidateSsrCache(path);
  }

  // GET /api/public/pages/:slug — enabled blocks only, for the public site.
  app.get("/api/public/pages/:slug", (req, res) => {
    const slug = req.params.slug;
    if (!isCmsPage(slug)) return res.status(404).json({ message: "Page not found" });
    res.json(getPublicPageContent(slug));
  });

  // GET /api/admin/pages — the list of CMS-managed pages.
  app.get("/api/admin/pages", requireAuth, (_req, res) => {
    res.json(
      Object.entries(CMS_PAGES).map(([slug, meta]) => {
        const page = getPageContent(slug);
        return {
          slug,
          name: meta.name,
          path: meta.path,
          blockCount: page.blocks.length,
          updatedAt: page.updatedAt ?? null,
        };
      }),
    );
  });

  // GET /api/admin/pages/:slug — full content including hidden blocks.
  app.get("/api/admin/pages/:slug", requireAuth, (req, res) => {
    const slug = req.params.slug;
    if (!isCmsPage(slug)) return res.status(404).json({ message: "Page not found" });
    res.json(getPageContent(slug));
  });

  // PUT /api/admin/pages/:slug — save blocks and/or SEO. The previous state
  // is snapshotted into page_revisions first so an edit can be rolled back.
  app.put("/api/admin/pages/:slug", requireAuth, (req, res) => {
    const slug = req.params.slug;
    if (!isCmsPage(slug)) return res.status(404).json({ message: "Page not found" });
    const body = req.body || {};
    try {
      const saved = savePageContent(slug, {
        seo: body.seo ? normalizeSeo(body.seo) : undefined,
        blocks: Array.isArray(body.blocks) ? normalizeBlocks(body.blocks) : undefined,
        updatedBy: currentUserEmail(req),
      });
      invalidatePageCache(slug);
      res.json(saved);
    } catch (err: any) {
      console.error("[cms] save page failed:", err);
      res.status(500).json({ message: err?.message ?? "Save failed" });
    }
  });

  // POST /api/admin/pages/:slug/reset — restore the factory page.
  app.post("/api/admin/pages/:slug/reset", requireAuth, (req, res) => {
    const slug = req.params.slug;
    if (!isCmsPage(slug)) return res.status(404).json({ message: "Page not found" });
    try {
      const saved = resetPageContent(
        slug,
        currentUserEmail(req),
      );
      invalidatePageCache(slug);
      res.json(saved);
    } catch (err: any) {
      console.error("[cms] reset page failed:", err);
      res.status(500).json({ message: err?.message ?? "Reset failed" });
    }
  });

  // GET /api/admin/pages/:slug/revisions — snapshot list (newest first).
  app.get("/api/admin/pages/:slug/revisions", requireAuth, (req, res) => {
    const slug = req.params.slug;
    if (!isCmsPage(slug)) return res.status(404).json({ message: "Page not found" });
    const rows = storage.listPageRevisions(slug);
    res.json(
      rows.map((r) => {
        let blockCount = 0;
        try {
          blockCount = (JSON.parse(r.snapshot)?.blocks ?? []).length;
        } catch {}
        return {
          id: r.id,
          label: r.label,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
          blockCount,
        };
      }),
    );
  });

  // POST /api/admin/pages/:slug/revisions/:id/restore — roll back to a snapshot.
  app.post("/api/admin/pages/:slug/revisions/:id/restore", requireAuth, (req, res) => {
    const slug = req.params.slug;
    if (!isCmsPage(slug)) return res.status(404).json({ message: "Page not found" });
    const rev = storage.getPageRevision(parseInt(req.params.id, 10));
    if (!rev || rev.pageSlug !== slug) {
      return res.status(404).json({ message: "Revision not found" });
    }
    try {
      const snapshot = JSON.parse(rev.snapshot) as { seo?: unknown; blocks?: unknown };
      const saved = savePageContent(slug, {
        seo: snapshot.seo ? normalizeSeo(snapshot.seo) : undefined,
        blocks: Array.isArray(snapshot.blocks) ? normalizeBlocks(snapshot.blocks) : undefined,
        updatedBy: currentUserEmail(req),
        revisionLabel: `Before restoring #${rev.id}`,
      });
      invalidatePageCache(slug);
      res.json(saved);
    } catch (err: any) {
      console.error("[cms] restore revision failed:", err);
      res.status(500).json({ message: err?.message ?? "Restore failed" });
    }
  });

  // POST /api/admin/media — upload an image for any CMS image field.
  // Accepts a base64 data URL (same convention as the condo hero upload),
  // writes it to the persistent uploads volume, returns the public URL.
  app.post("/api/admin/media", requireAuth, (req, res) => {
    const dataUrl: string | undefined = req.body?.dataUrl;
    if (!dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ message: "dataUrl is required (data:image/...;base64,...)" });
    }
    const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif|avif);base64,(.+)$/);
    if (!m) {
      return res
        .status(400)
        .json({ message: "dataUrl must be a base64 image (png|jpg|jpeg|webp|gif|avif)" });
    }
    let ext = m[1].toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 10 * 1024 * 1024) {
      return res.status(413).json({ message: "Image too large (max 10MB)" });
    }
    try {
      const dir = ensureUploadsDir("cms");
      // Slugified caller-supplied name, plus randomness so re-uploading an
      // image under the same name can never serve a stale cached file.
      const base = String(req.body?.name || "image")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "image";
      const file = `${base}-${randomBytes(4).toString("hex")}.${ext}`;
      const tmp = path.join(dir, `${file}.tmp`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(dir, file));
      res.json({ url: `/uploads/cms/${file}` });
    } catch (err: any) {
      console.error("[cms] media upload failed:", err);
      res.status(500).json({ message: err?.message ?? "Upload failed" });
    }
  });

  app.get("/api/public/config", (_req, res) => {
    res.json({
      googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null,
    });
  });

  // GET /api/public/blog — only published posts (drafts hidden from public).
  app.get("/api/public/blog", (_req, res) => {
    const all = storage.listBlogPosts();
    res.json(all.filter((p: any) => (p.status ?? "published") === "published"));
  });

  // GET /api/public/blog/:slug — 404 on drafts so they don't leak.
  app.get("/api/public/blog/:slug", (req, res) => {
    const post = storage.getBlogBySlug(req.params.slug);
    if (!post || ((post as any).status ?? "published") !== "published") {
      return res.status(404).json({ message: "Post not found" });
    }
    res.json(post);
  });

  // GET /api/public/testimonials
  app.get("/api/public/testimonials", (_req, res) => {
    res.json(storage.listTestimonials());
  });

  // GET /api/public/instagram — real posts for the homepage feed strip.
  // Extracted from the PUBLIC rendered HTML of luxuryhomescalgary.ca, whose
  // Smash Balloon widget keeps the feed fresh — nothing on the WP side had
  // to change for this. The fetch carries a unique query param so
  // Cloudflare's 30-day page cache can't serve stale HTML (the embedded
  // cdninstagram URLs are signed and expire, so freshness matters).
  // In-memory cache: 1h when we have posts, 5min after a miss; fails soft
  // to last-known data so the homepage never blocks on Instagram.
  let igCache: { data: unknown[]; at: number } | null = null;
  app.get("/api/public/instagram", async (_req, res) => {
    const TTL = (igCache?.data.length ? 60 : 5) * 60 * 1000;
    if (igCache && Date.now() - igCache.at < TTL) {
      return res.json(igCache.data);
    }
    try {
      const bust = Math.floor(Date.now() / (60 * 60 * 1000)); // hourly bucket
      const r = await fetch(`https://luxuryhomescalgary.ca/?sr_ig=${bust}`, {
        signal: AbortSignal.timeout(10000),
        headers: { "user-agent": "Mozilla/5.0 (riversrealestate.ca feed sync)" },
      });
      const html = r.ok ? await r.text() : "";
      const posts: Array<{ image: string; permalink: string; caption: string }> = [];
      // Each Smash Balloon post is one `sbi_item` block containing the post
      // permalink and a `data-full-res` image URL.
      for (const chunk of html.split('class="sbi_item').slice(1)) {
        const permalink = chunk.match(/href="(https:\/\/www\.instagram\.com\/p\/[^"]+)"/)?.[1];
        // WP escapes ampersands as &#038; (or &amp;) — both must decode or
        // the CDN URL's signature params are mangled and Instagram 403s.
        const image = chunk
          .match(/data-full-res="([^"]+)"/)?.[1]
          ?.replace(/&(amp|#0?38);/g, "&");
        const caption =
          chunk.match(/alt="([^"]{1,140})/)?.[1]?.replace(/&(amp|#0?38);/g, "&") ?? "";
        if (permalink && image) posts.push({ image, permalink, caption });
        if (posts.length >= 12) break;
      }
      igCache = { data: posts.length ? posts : (igCache?.data ?? []), at: Date.now() };
    } catch {
      igCache = { data: igCache?.data ?? [], at: Date.now() };
    }
    res.json(igCache.data);
  });

  // GET /api/public/stats — site stats for the homepage
  app.get("/api/public/stats", (_req, res) => {
    const activeCount = storage.countActiveMlsListings();
    const total = storage.countMlsListings();
    const lastSync = storage.getLatestSyncRun();
    res.json({
      activeListings: activeCount,
      totalListings: total,
      lastSyncAt: lastSync?.finishedAt ?? null,
      lastSyncStatus: lastSync?.status ?? null,
    });
  });

  // GET /api/admin/mls-sync (auth) — recent sync runs for admin sidebar
  app.get("/api/admin/mls-sync", requireAuth, (_req, res) => {
    res.json(storage.listRecentSyncRuns(15));
  });

  // -------------------- ADMIN: BLOG POSTS ---------------------------------
  // Slug-keyed CRUD for the public blog. Body content uses the same simple
  // markdown subset rendered by client/src/pages/blog-detail.tsx (## h2,
  // ### h3, > blockquote, **bold**, paragraphs).
  //
  // Auth model:
  //   - GET / PATCH require the cookie-based admin session (requireAuth).
  //   - POST (new draft) ALSO accepts a Bearer token via ADMIN_API_TOKEN
  //     env var so the BOFU auto-blog scheduled task can drop new drafts
  //     without needing a browser session.

  // Allow either a valid admin session OR a matching bearer token.
  function requireAdminOrToken(req: Request, res: Response, next: NextFunction) {
    const tok = process.env.ADMIN_API_TOKEN;
    const header = String(req.headers.authorization || "");
    if (tok && header === `Bearer ${tok}`) return next();
    return requireAuth(req, res, next);
  }

  app.get("/api/admin/blog", requireAuth, (_req, res) => {
    res.json(storage.listBlogPosts());
  });
  app.get("/api/admin/blog/:slug", requireAuth, (req, res) => {
    const p = storage.getBlogBySlug(req.params.slug);
    if (!p) return res.status(404).json({ message: "Post not found" });
    res.json(p);
  });

  // Fallback hero pool for new posts: Unsplash images verified by eye
  // (2026-07-31 audit) and not assigned to any existing post at that time.
  // Used when a creator submits no heroImage, or one already on another post
  // — the old BOFU cadence shared one image per 3-post cluster, which left
  // the blog index full of repeats. Every post keeps a unique hero.
  const HERO_IMAGE_POOL = [
    "photo-1615873968403-89e068629265", // styled living room, green feature wall
    "photo-1586023492125-27b2c045efd7", // staged living room, yellow armchair
    "photo-1600489000022-c2086d79f9d4", // modern grey kitchen
    "photo-1505693416388-ac5ce068fe85", // staged primary bedroom
    "photo-1522708323590-d24dbb6b0267", // furnished condo living room
    "photo-1617806118233-18e1de247200", // formal dining room
    "photo-1620626011761-996317b8d101", // modern bathroom, freestanding tub
    "photo-1600607687920-4e2a09cf159d", // open-plan interior with staircase
    "photo-1600607687939-ce8a6c25118c", // contemporary living space
    "photo-1560518883-ce09059eeffa",    // house model with keys
    "photo-1554224155-6726b3ff858f",    // finance paperwork and calculator
    "photo-1469474968028-56623f02e42e", // mountain landscape at sunrise
  ];
  const heroUrlFor = (id: string) => `https://images.unsplash.com/${id}?w=1600&q=85&fm=jpg&auto=format`;
  const pickUnusedHeroImage = (): string | null => {
    const used = storage.listBlogPosts().map((p) => p.heroImage || "");
    const id = HERO_IMAGE_POOL.find((cand) => !used.some((u) => u.includes(cand)));
    return id ? heroUrlFor(id) : null;
  };
  // Focus-keyword-ish alt derived from the title (lead clause before any
  // subtitle separator) when the creator didn't supply heroImageAlt.
  const altFromTitle = (t: string) => t.split(/\s*[—:?]\s*/)[0].trim() || t.trim();

  // POST — create a new post. Defaults to status="draft" unless explicitly
  // overridden. Used by the BOFU auto-blog pipeline.
  app.post("/api/admin/blog", requireAdminOrToken, (req, res) => {
    const body = req.body || {};
    if (!body.slug || typeof body.slug !== "string" || !/^[a-z0-9-]+$/i.test(body.slug)) {
      return res.status(400).json({ message: "slug is required (lowercase letters, digits, hyphens)" });
    }
    if (storage.getBlogBySlug(body.slug)) {
      return res.status(409).json({ message: "A post with this slug already exists" });
    }
    if (!body.title || !body.body) {
      return res.status(400).json({ message: "title and body are required" });
    }
    try {
      let heroImage = String(body.heroImage ?? "");
      const heroInUse = heroImage && storage.listBlogPosts().some((p) => p.heroImage === heroImage);
      if (!heroImage || heroInUse) {
        const fresh = pickUnusedHeroImage();
        if (fresh) {
          console.log(`[blog] hero for "${body.slug}" was ${heroImage ? "already in use" : "empty"} — assigned unique pool image`);
          heroImage = fresh;
        } else if (heroInUse) {
          console.warn(`[blog] hero pool exhausted — "${body.slug}" keeps a duplicate hero image`);
        }
      }
      const created = storage.upsertBlogPost({
        slug: String(body.slug).toLowerCase(),
        title: String(body.title),
        excerpt: String(body.excerpt ?? "").slice(0, 280),
        body: String(body.body),
        category: String(body.category ?? "Guide"),
        heroImage,
        heroImageAlt: typeof body.heroImageAlt === "string" ? body.heroImageAlt : altFromTitle(String(body.title)),
        authorName: String(body.authorName ?? "Spencer Rivers"),
        authorAvatar: body.authorAvatar ?? null,
        readMinutes: Number(body.readMinutes) || Math.max(3, Math.ceil(String(body.body).split(/\s+/).length / 220)),
        status: body.status === "published" ? "published" : "draft",
        publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : new Date().toISOString(),
      } as any);
      res.status(201).json(created);
    } catch (err: any) {
      console.error("[admin] create blog failed:", err);
      res.status(500).json({ message: err?.message ?? "Create failed" });
    }
  });

  app.patch("/api/admin/blog/:slug", requireAuth, (req, res) => {
    const existing = storage.getBlogBySlug(req.params.slug);
    if (!existing) return res.status(404).json({ message: "Post not found" });
    const body = req.body || {};
    try {
      const updated = storage.upsertBlogPost({
        slug: existing.slug, // never rename via PATCH
        title: typeof body.title === "string" ? body.title : existing.title,
        excerpt: typeof body.excerpt === "string" ? body.excerpt : existing.excerpt,
        body: typeof body.body === "string" ? body.body : existing.body,
        category: typeof body.category === "string" ? body.category : existing.category,
        heroImage: typeof body.heroImage === "string" ? body.heroImage : existing.heroImage,
        heroImageAlt: typeof body.heroImageAlt === "string" || body.heroImageAlt === null ? body.heroImageAlt : existing.heroImageAlt,
        authorName: typeof body.authorName === "string" ? body.authorName : existing.authorName,
        authorAvatar: typeof body.authorAvatar === "string" ? body.authorAvatar : existing.authorAvatar,
        readMinutes: typeof body.readMinutes === "number" ? body.readMinutes : existing.readMinutes,
        status: body.status === "draft" || body.status === "published" ? body.status : (existing as any).status,
        publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : existing.publishedAt,
      } as any);
      res.json(updated);
    } catch (err: any) {
      console.error("[admin] update blog failed:", err);
      res.status(500).json({ message: err?.message ?? "Update failed" });
    }
  });

  // -------------------- ADMIN: NEIGHBOURHOODS -----------------------------
  // Slug-keyed CRUD for the editorial neighbourhood pages.
  const neighbourhoodToJson = (n: any) => ({
    ...n,
    story: safeJsonParse(n.story, []),
    outsideCopy: safeJsonParse(n.outsideCopy, []),
    amenitiesCopy: safeJsonParse(n.amenitiesCopy, []),
    shopDineCopy: safeJsonParse(n.shopDineCopy, []),
    realEstateCopy: safeJsonParse(n.realEstateCopy, []),
    lifeCopy: safeJsonParse(n.lifeCopy, []),
    borders: safeJsonParse(n.borders, {}),
    schools: safeJsonParse(n.schools, []),
    gallery: safeJsonParse(n.gallery, []),
    condoBuildingsList: safeJsonParse(n.condoBuildingsList, []),
  });
  function safeJsonParse(s: any, fallback: any) {
    if (typeof s !== "string") return s ?? fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  }
  app.get("/api/admin/neighbourhoods", requireAuth, (_req, res) => {
    res.json(storage.listNeighbourhoods().map(neighbourhoodToJson));
  });
  app.get("/api/admin/neighbourhoods/:slug", requireAuth, (req, res) => {
    const n = storage.getNeighbourhoodBySlug(req.params.slug);
    if (!n) return res.status(404).json({ message: "Neighbourhood not found" });
    res.json(neighbourhoodToJson(n));
  });
  app.patch("/api/admin/neighbourhoods/:slug", requireAuth, (req, res) => {
    const existing = storage.getNeighbourhoodBySlug(req.params.slug);
    if (!existing) return res.status(404).json({ message: "Neighbourhood not found" });
    const body = req.body || {};
    const stringifyIfArray = (v: any, fallback: any) =>
      v === undefined ? fallback : typeof v === "string" ? v : JSON.stringify(v);
    try {
      const updated = storage.upsertNeighbourhood({
        slug: existing.slug,
        name: typeof body.name === "string" ? body.name : existing.name,
        tagline: typeof body.tagline === "string" ? body.tagline : existing.tagline,
        story: stringifyIfArray(body.story, existing.story),
        outsideCopy: stringifyIfArray(body.outsideCopy, existing.outsideCopy),
        amenitiesCopy: stringifyIfArray(body.amenitiesCopy, existing.amenitiesCopy),
        shopDineCopy: stringifyIfArray(body.shopDineCopy, existing.shopDineCopy),
        realEstateCopy: stringifyIfArray(body.realEstateCopy, existing.realEstateCopy),
        lifeCopy: stringifyIfArray(body.lifeCopy, existing.lifeCopy),
        quadrant: typeof body.quadrant === "string" ? body.quadrant : existing.quadrant,
        zone: typeof body.zone === "string" ? body.zone : existing.zone,
        borders: stringifyIfArray(body.borders, existing.borders),
        schools: stringifyIfArray(body.schools, existing.schools),
        condoBuildingsList: stringifyIfArray(body.condoBuildingsList, existing.condoBuildingsList),
        heroCredit: typeof body.heroCredit === "string" ? body.heroCredit : (existing as any).heroCredit,
        heroImage: typeof body.heroImage === "string" ? body.heroImage : existing.heroImage,
        gallery: stringifyIfArray(body.gallery, existing.gallery),
        centerLat: typeof body.centerLat === "number" ? body.centerLat : existing.centerLat,
        centerLng: typeof body.centerLng === "number" ? body.centerLng : existing.centerLng,
        avgPrice: typeof body.avgPrice === "number" ? body.avgPrice : existing.avgPrice,
        activeCount: typeof body.activeCount === "number" ? body.activeCount : existing.activeCount,
        sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : existing.sortOrder,
      } as any);
      res.json(neighbourhoodToJson(updated));
    } catch (err: any) {
      console.error("[admin] update neighbourhood failed:", err);
      res.status(500).json({ message: err?.message ?? "Update failed" });
    }
  });

  // POST /api/admin/mls-sync/run (auth) — manually trigger a sync run
  app.post("/api/admin/mls-sync/run", requireAuth, async (_req, res) => {
    try {
      // Fire-and-forget so the request returns quickly; the table will
      // pick up the new run on its next refetch.
      runSync().catch((err) => {
        console.error("[mls-sync] manual run failed:", err);
      });
      res.json({ ok: true, message: "Sync started" });
    } catch (err: any) {
      res.status(500).json({ ok: false, message: err?.message ?? "Sync failed" });
    }
  });

  // POST /api/admin/mls-sync/reset (auth) — drop & recreate mls_listings table
  // (used to recover from "database disk image is malformed" after a publish
  // restored a corrupt SQLite snapshot; sync immediately starts after rebuild).
  app.post("/api/admin/mls-sync/reset", requireAuth, async (_req, res) => {
    try {
      const { db } = await import("./storage");
      const { sql } = await import("drizzle-orm");
      // Drop the corrupt tables
      try { db.run(sql`DROP TABLE IF EXISTS mls_listings`); } catch (e) { console.error("[reset] drop mls_listings:", e); }
      try { db.run(sql`DROP TABLE IF EXISTS mls_sync_runs`); } catch (e) { console.error("[reset] drop mls_sync_runs:", e); }
      // Rebuild the file to recover any corrupt pages left behind
      try { db.run(sql`VACUUM`); console.log("[reset] VACUUM ok"); } catch (e) { console.error("[reset] VACUUM failed:", e); }
      // Recreate fresh schemas (mirror of CREATE TABLE in storage.ts)
      db.run(sql`
        CREATE TABLE IF NOT EXISTS mls_listings (
          id TEXT PRIMARY KEY,
          mls_number TEXT,
          listing_key INTEGER,
          source TEXT,
          status TEXT,
          list_price INTEGER,
          original_price INTEGER,
          beds INTEGER,
          beds_above INTEGER,
          beds_below INTEGER,
          baths REAL,
          half_baths INTEGER,
          sqft INTEGER,
          sqft_below INTEGER,
          year_built INTEGER,
          property_type TEXT,
          property_sub_type TEXT,
          street_number TEXT,
          street_name TEXT,
          street_suffix TEXT,
          street_dir_suffix TEXT,
          unit_number TEXT,
          city TEXT,
          province TEXT,
          postal_code TEXT,
          neighbourhood TEXT,
          full_address TEXT,
          lat REAL,
          lng REAL,
          description TEXT,
          features TEXT,
          gallery TEXT,
          hero_image TEXT,
          photo_count INTEGER,
          lot_size TEXT,
          parking TEXT,
          garage_spaces INTEGER,
          days_on_market INTEGER,
          list_office TEXT,
          list_agent TEXT,
          modification_timestamp TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(sql`
        CREATE TABLE IF NOT EXISTS mls_sync_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at TEXT,
          status TEXT,
          source TEXT,
          fetched INTEGER,
          upserted INTEGER,
          removed INTEGER,
          error_message TEXT
        )
      `);
      // Kick off fresh sync
      runSync().catch((err) => {
        console.error("[mls-sync] post-reset run failed:", err);
      });
      res.json({ ok: true, message: "Tables reset; sync started" });
    } catch (err: any) {
      res.status(500).json({ ok: false, message: err?.message ?? "Reset failed" });
    }
  });

  // ---------- POIs (Overpass API) ----------
  // GET /api/mls/:id/pois — schools, restaurants, parks, transit within 1km
  // of the listing. Cached 24h via fetchPoisForPoint().
  app.get("/api/mls/:id/pois", async (req, res) => {
    const listing = storage.getMlsListingById(req.params.id);
    if (!listing) return res.status(404).json({ message: "Listing not found" });
    if (listing.lat == null || listing.lng == null) {
      return res.json({
        center: { lat: null, lng: null },
        radius: 1000,
        schools: [], restaurants: [], parks: [], transit: [],
        cached: false, message: "No coordinates for listing",
      });
    }
    const lat = Number(listing.lat);
    const lng = Number(listing.lng);
    const radius = 1000;
    try {
      const result = await fetchPoisForPoint(lat, lng, radius);
      if (!result.ok) {
        return res.json({
          center: { lat, lng },
          radius,
          schools: [], restaurants: [], parks: [], transit: [],
          cached: false,
          error: result.error,
        });
      }
      res.json({ ...result.payload, center: { lat, lng }, radius, cached: result.cached });
    } catch (err: any) {
      console.error("[pois] error:", err?.message ?? err);
      res.json({
        center: { lat, lng },
        radius,
        schools: [], restaurants: [], parks: [], transit: [],
        cached: false,
        error: err?.message ?? "Overpass error",
      });
    }
  });

  // GET /api/public/condos/:slug/pois — same shape as /api/mls/:id/pois but
  // centered on the condo building's coordinates instead of a single listing.
  app.get("/api/public/condos/:slug/pois", async (req, res) => {
    const c = storage.getCondoBuildingBySlug(req.params.slug);
    if (!c) return res.status(404).json({ message: "Condo building not found" });
    const lat = Number(c.lat);
    const lng = Number(c.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.json({
        center: { lat: null, lng: null },
        radius: 1000,
        schools: [], restaurants: [], parks: [], transit: [],
        cached: false, message: "No coordinates for building",
      });
    }
    const radius = 1000;
    try {
      const result = await fetchPoisForPoint(lat, lng, radius);
      if (!result.ok) {
        return res.json({
          center: { lat, lng },
          radius,
          schools: [], restaurants: [], parks: [], transit: [],
          cached: false,
          error: result.error,
        });
      }
      res.json({ ...result.payload, center: { lat, lng }, radius, cached: result.cached });
    } catch (err: any) {
      console.error("[pois] condo error:", err?.message ?? err);
      res.json({
        center: { lat, lng },
        radius,
        schools: [], restaurants: [], parks: [], transit: [],
        cached: false,
        error: err?.message ?? "Overpass error",
      });
    }
  });

  // GET /api/public/neighbourhoods/:slug/pois — same shape as the MLS/condo
  // POI routes, centered on the neighbourhood's center coordinates so the
  // detail page can render schools / restaurants / parks / transit nearby.
  app.get("/api/public/neighbourhoods/:slug/pois", async (req, res) => {
    const n = storage.getNeighbourhoodBySlug(req.params.slug);
    if (!n) return res.status(404).json({ message: "Neighbourhood not found" });
    // Do not rescan the MLS table just to calculate a centroid on every POI
    // request. The detail response already uses its live centroid for the map;
    // this endpoint can use the neighbourhood's persisted centre and remain a
    // cheap, browser-only enhancement when the external service is unhealthy.
    const lat = Number(n.centerLat);
    const lng = Number(n.centerLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.json({
        center: { lat: null, lng: null },
        radius: 1000,
        schools: [], restaurants: [], parks: [], transit: [],
        cached: false, message: "No coordinates for neighbourhood",
      });
    }
    const radius = 1000;
    try {
      const result = await fetchPoisForPoint(lat, lng, radius);
      if (!result.ok) {
        return res.json({
          center: { lat, lng },
          radius,
          schools: [], restaurants: [], parks: [], transit: [],
          cached: false,
          error: result.error,
        });
      }
      res.json({ ...result.payload, center: { lat, lng }, radius, cached: result.cached });
    } catch (err: any) {
      console.error("[pois] neighbourhood error:", err?.message ?? err);
      res.json({
        center: { lat, lng },
        radius,
        schools: [], restaurants: [], parks: [], transit: [],
        cached: false,
        error: err?.message ?? "Overpass error",
      });
    }
  });

  // ---------- ROUTING (OSRM) ----------
  // GET /api/route?fromLat=..&fromLng=..&toLat=..&toLng=..&profile=foot|driving|bike
  // Returns { distance (m), duration (s), geometry (GeoJSON LineString) }
  app.get("/api/route", async (req, res) => {
    const fromLat = parseFloat(String(req.query.fromLat ?? ""));
    const fromLng = parseFloat(String(req.query.fromLng ?? ""));
    const toLat = parseFloat(String(req.query.toLat ?? ""));
    const toLng = parseFloat(String(req.query.toLng ?? ""));
    const profile = String(req.query.profile ?? "foot");
    if (![fromLat, fromLng, toLat, toLng].every((x) => Number.isFinite(x))) {
      return res.status(400).json({ message: "Invalid coordinates" });
    }
    if (!["foot", "driving", "bike"].includes(profile)) {
      return res.status(400).json({ message: "Invalid profile" });
    }
    // OSRM uses {lng},{lat} order. Multiple public mirrors fall back if main is rate-limited.
    const OSRM_MIRRORS = [
      "https://router.project-osrm.org",
      "https://routing.openstreetmap.de/routed-foot",
    ];
    // The second mirror only handles foot — only try it for foot profile.
    const mirrors = profile === "foot" ? OSRM_MIRRORS : [OSRM_MIRRORS[0]];
    let lastError: string | null = null;
    for (const base of mirrors) {
      // For routing.openstreetmap.de, the profile is part of the host path.
      // For project-osrm, it's part of the URL path.
      const url = base.includes("routed-foot")
        ? `${base}/route/v1/foot/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`
        : `${base}/route/v1/${profile}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
      try {
        const r = await fetch(url, {
          headers: {
            "Accept": "application/json",
            "User-Agent": "RiversRealEstate/1.0 (https://riversrealestate.ca)",
          },
        });
        if (!r.ok) {
          lastError = `${base} -> ${r.status}`;
          console.warn("[route] mirror failed:", lastError);
          continue;
        }
        const data: any = await r.json();
        if (data.code !== "Ok" || !data.routes?.[0]) {
          lastError = `${base} -> code=${data.code}`;
          console.warn("[route] mirror no route:", lastError);
          continue;
        }
        const route = data.routes[0];
        return res.json({
          profile,
          distance: route.distance, // meters
          duration: route.duration, // seconds
          geometry: route.geometry, // GeoJSON LineString
        });
      } catch (e: any) {
        lastError = `${base} -> ${e?.message ?? "fetch failed"}`;
        console.warn("[route] mirror error:", lastError);
      }
    }
    console.error("[route] all OSRM mirrors failed:", lastError);
    return res.status(502).json({ message: "Routing service unavailable", error: lastError });
  });

  // ---------- SAVED SEARCHES (auth) ----------
  app.get("/api/saved-searches", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    const leadIdStr = typeof req.query.leadId === "string" ? req.query.leadId : "";
    const leadId = leadIdStr ? parseInt(leadIdStr, 10) : null;
    let rows = leadId
      ? storage.listSavedSearchesByLead(leadId)
      : storage.listSavedSearches(userId);
    const items = rows.map((s: any) => ({
      ...s,
      filters: (() => { try { return JSON.parse(s.filters); } catch { return {}; } })(),
    }));
    res.json(items);
  });
  app.post("/api/saved-searches", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    const {
      name,
      filters,
      emailAlerts,
      leadId,
      emailRecipient,
      alertType,
      frequency,
      instant,
      active,
    } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ message: "Name required" });
    }
    if (alertType && !["listings", "snapshot"].includes(alertType)) {
      return res.status(400).json({ message: "Invalid alertType" });
    }
    const created = storage.createSavedSearch({
      userId,
      leadId: leadId ?? null,
      emailRecipient: emailRecipient ?? null,
      name,
      filters: filters ?? {},
      emailAlerts: emailAlerts !== false,
      alertType: alertType ?? "listings",
      frequency: frequency ?? "daily",
      instant,
      active,
    } as any);
    res.json(created);
  });
  app.patch("/api/saved-searches/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const updated = storage.updateSavedSearch(id, req.body ?? {});
    if (!updated) return res.status(404).json({ message: "Not found" });
    res.json(updated);
  });
  app.delete("/api/saved-searches/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    res.json({ ok: storage.deleteSavedSearch(id) });
  });

  // ---------- SOCIAL POSTS (auth) ----------
  app.get("/api/social-posts", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    const items = storage.listSocialPosts(userId).map((p) => ({
      ...p,
      channels: (() => { try { return JSON.parse(p.channels); } catch { return []; } })(),
      variants: (() => { try { return JSON.parse((p as any).variants ?? "{}"); } catch { return {}; } })(),
    }));
    res.json(items);
  });
  app.post("/api/social-posts", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    const { caption, imageUrl, linkUrl, channels, variants, scheduledFor, status, listingId } = req.body ?? {};
    if (!caption || typeof caption !== "string") {
      return res.status(400).json({ message: "Caption required" });
    }
    const created = storage.createSocialPost({
      userId,
      caption,
      imageUrl: imageUrl ?? null,
      linkUrl: linkUrl ?? null,
      channels: Array.isArray(channels) ? channels : [],
      variants: typeof variants === "object" && variants !== null ? variants : {},
      scheduledFor: scheduledFor ?? null,
      status: status ?? "draft",
      listingId: listingId ?? null,
    } as any);
    res.json({
      ...created,
      channels: (() => { try { return JSON.parse(created.channels); } catch { return []; } })(),
      variants: (() => { try { return JSON.parse((created as any).variants ?? "{}"); } catch { return {}; } })(),
    });
  });
  app.patch("/api/social-posts/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const patch: any = {};
    const b = req.body ?? {};
    if (typeof b.caption === "string") patch.caption = b.caption;
    if ("imageUrl" in b) patch.imageUrl = b.imageUrl;
    if ("linkUrl" in b) patch.linkUrl = b.linkUrl;
    if ("scheduledFor" in b) patch.scheduledFor = b.scheduledFor;
    if ("status" in b) patch.status = b.status;
    if ("listingId" in b) patch.listingId = b.listingId;
    if (Array.isArray(b.channels)) patch.channels = b.channels;
    if (b.variants && typeof b.variants === "object") patch.variants = b.variants;
    const updated = storage.updateSocialPost(id, patch);
    if (!updated) return res.status(404).json({ message: "Not found" });
    res.json(updated);
  });
  app.post("/api/social-posts/:id/post", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    const post: any = storage.getSocialPost(id);
    if (!post) return res.status(404).json({ message: "Not found" });

    // Resolve channels + variants. Each platform gets {caption, imageUrl,
    // linkUrl, scheduledFor} merged from master + variant overrides.
    const channels = (() => { try { return JSON.parse(post.channels); } catch { return []; } })() as string[];
    const variants = (() => { try { return JSON.parse(post.variants ?? "{}"); } catch { return {}; } })() as Record<string, any>;
    const posts: Record<string, any> = {};
    for (const ch of channels) {
      const v = variants[ch] ?? {};
      posts[ch] = {
        caption: typeof v.caption === "string" && v.caption.trim() ? v.caption : post.caption,
        imageUrl: v.imageUrl ?? post.imageUrl ?? null,
        linkUrl: v.linkUrl ?? post.linkUrl ?? null,
        scheduledFor: v.scheduledFor ?? post.scheduledFor ?? null,
      };
    }

    // Fire the Make webhook (if configured) with a per-platform payload.
    const url = process.env.MAKE_SOCIAL_WEBHOOK_URL;
    let dispatched = false;
    let webhookError: string | null = null;
    if (url && channels.length > 0) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            postId: post.id,
            listingId: post.listingId,
            platforms: channels, // backwards-compat with router filters
            posts,
            // backwards-compat top-level master fields
            caption: post.caption,
            imageUrl: post.imageUrl,
            linkUrl: post.linkUrl,
          }),
        });
        dispatched = r.ok;
        if (!r.ok) webhookError = `Webhook ${r.status}: ${await r.text()}`;
      } catch (e: any) {
        webhookError = e?.message ?? "fetch failed";
      }
    } else if (!url) {
      webhookError = "MAKE_SOCIAL_WEBHOOK_URL not set";
    }

    const updated = storage.updateSocialPost(id, {
      status: dispatched ? "posted" : "failed",
      postedAt: dispatched ? new Date().toISOString() : null,
    } as any);
    res.json({ ...updated, dispatched, webhookError, channels, posts });
  });
  app.delete("/api/social-posts/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    res.json({ ok: storage.deleteSocialPost(id) });
  });

  // ---------- ANALYTICS (auth) ----------
  // Lightweight read-only analytics derived from existing tables.
  // GSC + GA4 traffic stats for /admin/analytics. Dynamic import + caching
  // (1h in seo-stats.ts) so the page is snappy without burning API quota.
  // ---------- SEO KEYWORD CONSOLE ----------
  // Crawls the app's own public routes over loopback and returns per-page
  // keyword scoring, cluster membership, the internal-link graph, and
  // suggested targets. Cached because a full crawl costs a few seconds;
  // ?refresh=1 forces a rebuild after content edits.
  let seoReportCache: { at: number; data: unknown } | null = null;
  const SEO_REPORT_TTL_MS = 10 * 60 * 1000;

  app.get("/api/admin/seo/keywords", requireAuth, async (req, res) => {
    try {
      const refresh = req.query.refresh === "1";
      if (!refresh && seoReportCache && Date.now() - seoReportCache.at < SEO_REPORT_TTL_MS) {
        return res.json({ ok: true, cached: true, ...(seoReportCache.data as object) });
      }
      const { buildSeoReport } = await import("./seo-keywords");
      const overrides: Record<string, string> = {};
      for (const t of storage.listSeoKeywordTargets()) overrides[t.path] = t.focusKeyword;

      // Crawl ourselves over loopback so the analysis sees exactly what a
      // crawler sees, including SSR metadata and the real anchor graph.
      const port = process.env.PORT || "5000";
      const baseUrl = `http://127.0.0.1:${port}`;
      const data = await buildSeoReport({ baseUrl, overrides });
      seoReportCache = { at: Date.now(), data };
      res.json({ ok: true, cached: false, ...data });
    } catch (err: any) {
      console.error("[seo-keywords] build failed:", err?.message ?? err);
      res.status(500).json({ ok: false, message: err?.message ?? "Failed to build SEO report" });
    }
  });

  app.put("/api/admin/seo/keywords", requireAuth, (req, res) => {
    const { path: pagePath, focusKeyword, note } = req.body ?? {};
    if (typeof pagePath !== "string" || !pagePath.startsWith("/")) {
      return res.status(400).json({ ok: false, message: "path must be a site-relative path" });
    }
    if (typeof focusKeyword !== "string") {
      return res.status(400).json({ ok: false, message: "focusKeyword is required" });
    }
    storage.setSeoKeywordTarget(pagePath, focusKeyword, note ?? null);
    seoReportCache = null; // next read reflects the new target
    res.json({ ok: true });
  });

  app.delete("/api/admin/seo/keywords", requireAuth, (req, res) => {
    const pagePath = String(req.query.path ?? "");
    if (!pagePath.startsWith("/")) {
      return res.status(400).json({ ok: false, message: "path is required" });
    }
    storage.clearSeoKeywordTarget(pagePath);
    seoReportCache = null;
    res.json({ ok: true });
  });

  app.get("/api/analytics/seo-stats", requireAuth, async (req, res) => {
    const days = Number(req.query.days);
    const safeDays = Number.isFinite(days) && days > 0 ? days : 28;
    try {
      const { fetchSeoStats } = await import("./seo-stats");
      const payload = await fetchSeoStats(safeDays);
      res.json(payload);
    } catch (err: any) {
      console.error("[seo-stats] route error:", err?.message ?? err);
      res.status(500).json({ ok: false, message: err?.message ?? "seo-stats failed" });
    }
  });

  app.get("/api/analytics/summary", requireAuth, (_req, res) => {
    const allListings = storage.listListings();
    const allLeads = storage.listLeads();
    const allTours = storage.listTours();
    const activeMls = storage.countActiveMlsListings();
    const totalMls = storage.countMlsListings();

    // Bucket leads by week (last 12 weeks)
    const now = new Date();
    const weeks: { weekStart: string; leads: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      const ws = new Date(d);
      ws.setDate(d.getDate() - d.getDay());
      ws.setHours(0, 0, 0, 0);
      weeks.push({ weekStart: ws.toISOString().slice(0, 10), leads: 0 });
    }
    for (const lead of allLeads) {
      const t = new Date(lead.createdAt).getTime();
      for (let i = weeks.length - 1; i >= 0; i--) {
        const ws = new Date(weeks[i].weekStart).getTime();
        if (t >= ws) {
          weeks[i].leads++;
          break;
        }
      }
    }
    // Lead sources breakdown
    const sourceMap = new Map<string, number>();
    for (const l of allLeads) {
      sourceMap.set(l.source, (sourceMap.get(l.source) ?? 0) + 1);
    }
    const sources = Array.from(sourceMap.entries()).map(([source, count]) => ({ source, count }));

    // Lead status pipeline
    const statusMap = new Map<string, number>();
    for (const l of allLeads) {
      statusMap.set(l.status, (statusMap.get(l.status) ?? 0) + 1);
    }
    const pipeline = Array.from(statusMap.entries()).map(([status, count]) => ({ status, count }));

    // Top neighbourhoods by lead count
    const nbMap = new Map<string, number>();
    for (const l of allLeads) {
      if (!l.listingId) continue;
      const lst = storage.getListingById(l.listingId);
      if (lst?.neighbourhood) {
        nbMap.set(lst.neighbourhood, (nbMap.get(lst.neighbourhood) ?? 0) + 1);
      }
    }
    const neighbourhoods = Array.from(nbMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, leads]) => ({ name, leads }));

    // Aggregate views & list price
    const totalViews = allListings.reduce((s, l) => s + (l.views ?? 0), 0);
    const portfolioValue = allListings.reduce((s, l) => s + (l.price ?? 0), 0);

    res.json({
      kpis: {
        activeMls,
        totalMls,
        managedListings: allListings.length,
        totalLeads: allLeads.length,
        upcomingTours: allTours.filter((t) => t.status === "requested" || t.status === "confirmed").length,
        totalViews,
        portfolioValue,
        conversionRate: allLeads.length
          ? Math.round((allLeads.filter((l) => l.status === "qualified" || l.status === "closed").length / allLeads.length) * 1000) / 10
          : 0,
      },
      weeklyLeads: weeks,
      sources,
      pipeline,
      neighbourhoods,
    });
  });

  return httpServer;
}
