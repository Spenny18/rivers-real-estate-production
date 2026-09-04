/**
 * Keyword & internal-link intelligence for the admin SEO console.
 *
 * The engine crawls this app's own public routes over loopback HTTP, so the
 * analysis always reflects what Google actually receives (server-rendered
 * title/description/schema + the real anchor graph, nav and footer included)
 * rather than a hand-maintained spreadsheet that drifts from the site.
 *
 * Everything downstream — cluster assignment, the 0-100 score, cannibalization
 * detection, link recommendations, and suggested focus keywords — is derived
 * from that crawl plus optional Search Console data, so it updates itself as
 * pages are added or edited. Nothing here needs to be kept in sync by hand.
 *
 * Search Console note: the manual GSC CSV export splits Queries and Pages into
 * separate dimensions, so it cannot say which page ranks for which query. This
 * module requests the ["page","query"] pairing instead, which is what makes
 * evidence-based (rather than inferred) cannibalization detection possible.
 */

import { storage } from "./storage";
import { metaForPath } from "./seo-inject";

import { publicOrigin } from "./origin";
const ORIGIN = publicOrigin();

/** The other domain Spencer still runs. Links to it leak authority while both
 *  sites target the same market, so the crawler counts them separately. */
const SISTER_DOMAIN = "luxuryhomescalgary.ca";

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

export interface ClusterDef {
  id: string;
  label: string;
  /** The page that should own this cluster's head term. */
  pillar: string;
  /** Head term the pillar owns. Child pages must not target this. */
  headKeyword: string;
  /** Route prefixes whose pages belong to this cluster. */
  prefixes: string[];
  /** Vocabulary used to classify loose pages (blog posts) into the cluster. */
  vocabulary: string[];
  intent: "transactional" | "commercial" | "informational" | "navigational";
}

export const CLUSTERS: ClusterDef[] = [
  {
    id: "condos",
    label: "Condos & Buildings",
    pillar: "/condos",
    headKeyword: "calgary luxury condos",
    prefixes: ["/condos"],
    vocabulary: ["condo", "condos", "tower", "building", "penthouse", "loft", "apartment"],
    intent: "commercial",
  },
  {
    id: "neighbourhoods",
    label: "Neighbourhoods",
    pillar: "/neighbourhoods",
    headKeyword: "calgary luxury neighbourhoods",
    prefixes: ["/neighbourhoods"],
    vocabulary: ["neighbourhood", "neighborhood", "community", "homes for sale", "living in"],
    intent: "commercial",
  },
  {
    id: "work-with",
    label: "Specialization (Work With)",
    pillar: "/work-with",
    headKeyword: "calgary luxury realtor services",
    prefixes: ["/work-with"],
    vocabulary: ["seller", "buyer", "downsizing", "expired", "move-up", "first-time", "relocation"],
    intent: "transactional",
  },
  {
    id: "search",
    label: "Listing Search",
    pillar: "/mls",
    headKeyword: "calgary mls listings",
    prefixes: ["/mls"],
    vocabulary: ["mls", "listings", "for sale", "search"],
    intent: "transactional",
  },
  {
    id: "journal",
    label: "Journal",
    pillar: "/blog",
    headKeyword: "calgary luxury real estate advice",
    prefixes: ["/blog"],
    vocabulary: ["guide", "how to", "tips", "market", "cost", "when to"],
    intent: "informational",
  },
  {
    id: "trust",
    label: "Trust & Conversion",
    pillar: "/about",
    headKeyword: "spencer rivers calgary realtor",
    prefixes: ["/about", "/contact", "/home-evaluation", "/assignments"],
    vocabulary: ["about", "contact", "evaluation", "assignment", "credentials"],
    intent: "navigational",
  },
];

// ---------------------------------------------------------------------------
// Entity vocabulary — the AiM noun / verb / modifier framework, made countable
// ---------------------------------------------------------------------------

const NOUNS_IDENTITY = [
  "spencer rivers", "rivers real estate", "synterra realty", "realtor", "clhms",
  "listing agent", "million dollar guild",
];
const NOUNS_PLACE = [
  "calgary", "alberta", "springbank hill", "aspen woods", "upper mount royal",
  "elbow park", "britannia", "bel-aire", "bel aire", "mission", "beltline",
  "eau claire", "inglewood", "kensington", "rosedale", "roxboro", "altadore",
];
const VERBS_SERVICE = [
  "sell", "sold", "selling", "list", "listed", "listing", "relist", "buy",
  "purchase", "market", "marketing", "price", "priced", "pricing", "stage",
  "negotiate", "close", "represent", "relocate",
];
const MODIFIERS = [
  "luxury", "expired", "terminated", "stalled", "certified", "professional",
  "private", "written", "top", "best", "experienced", "trusted", "off-market",
];

function countVocab(haystack: string, vocab: string[]): number {
  let n = 0;
  for (const term of vocab) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    n += (haystack.match(re) || []).length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

export interface CrawledPage {
  path: string;
  status: number;
  title: string;
  description: string;
  h1: string;
  headings: string[];
  text: string;
  wordCount: number;
  internalLinks: string[];
  externalLinks: string[];
  sisterDomainLinks: string[];
  schemaTypes: string[];
  canonical: string | null;
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : null;
}

function parsePage(path: string, status: number, html: string): CrawledPage {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descM = html.match(/<meta[^>]+name="description"[^>]*>/i);
  const canonM = html.match(/<link[^>]+rel="canonical"[^>]*>/i);
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const headings = Array.from(html.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi))
    .map((m) => stripTags(m[2]))
    .filter(Boolean);

  // Body text only — drop header/footer so global chrome doesn't inflate every
  // page's keyword counts identically.
  let body = html;
  const mainM = html.match(/<main[\s\S]*?<\/main>/i);
  if (mainM) body = mainM[0];
  else {
    body = body.replace(/<header[\s\S]*?<\/header>/gi, " ")
               .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
               .replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  }
  const text = stripTags(body);

  const internal = new Set<string>();
  const external = new Set<string>();
  const sister = new Set<string>();
  const anchorMatches = Array.from(html.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>/gi));
  for (const m of anchorMatches) {
    const href = m[1].trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    if (href.startsWith("/")) {
      internal.add(href.split("#")[0].split("?")[0].replace(/\/$/, "") || "/");
    } else if (href.startsWith("http")) {
      try {
        const u = new URL(href);
        if (u.hostname.endsWith("riversrealestate.ca")) {
          internal.add(u.pathname.replace(/\/$/, "") || "/");
        } else if (u.hostname.endsWith(SISTER_DOMAIN)) {
          sister.add(href);
        } else {
          external.add(u.hostname);
        }
      } catch { /* malformed href — ignore */ }
    }
  }

  const schemaTypes = Array.from(html.matchAll(/"@type"\s*:\s*"([A-Za-z]+)"/g)).map((m) => m[1]);

  return {
    path,
    status,
    title: titleM ? stripTags(titleM[1]) : "",
    description: descM ? attr(descM[0], "content") || "" : "",
    canonical: canonM ? attr(canonM[0], "href") : null,
    h1: h1M ? stripTags(h1M[1]) : "",
    headings,
    text,
    wordCount: text ? text.split(/\s+/).length : 0,
    internalLinks: Array.from(internal),
    externalLinks: Array.from(external),
    sisterDomainLinks: Array.from(sister),
    schemaTypes: Array.from(new Set(schemaTypes)),
  };
}

/** Every public route worth analysing. MLS detail pages are excluded — there
 *  are thousands, they are excluded from the sitemap by default, and each one
 *  targets a single street address rather than a keyword. */
export function publicRoutes(): string[] {
  const routes = [
    "/", "/mls", "/neighbourhoods", "/condos", "/about", "/blog",
    "/contact", "/home-evaluation", "/work-with", "/assignments",
  ];
  const safe = <T,>(fn: () => T[], map: (x: any) => string): string[] => {
    try { return fn().map(map); } catch { return []; }
  };
  routes.push(...safe(() => storage.listNeighbourhoods() as any[], (n) => `/neighbourhoods/${n.slug}`));
  routes.push(...safe(() => storage.listCondoBuildings() as any[], (c) => `/condos/${c.slug}`));
  routes.push(
    ...safe(
      () => (storage.listBlogPosts() as any[]).filter((p) => p.status !== "draft"),
      (p) => `/blog/${p.slug}`,
    ),
  );
  routes.push(...WORK_WITH_SLUGS.map((s) => `/work-with/${s}`));
  return Array.from(new Set(routes));
}

/** Work-with slugs live in the client bundle; metaForPath is the server-side
 *  mirror, so probe it rather than duplicating the list. */
const WORK_WITH_SLUGS = [
  "luxury-properties", "first-time-home-sellers", "expired-listings",
  "empty-nesters", "first-time-home-buyers", "innercity-properties",
  "move-ups", "family-focused-properties", "urban-properties",
].filter((s) => {
  try { return metaForPath(`/work-with/${s}`) !== null; } catch { return false; }
});

async function fetchRoute(base: string, path: string): Promise<CrawledPage> {
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "User-Agent": "RiversSeoConsole/1.0" },
      redirect: "follow",
    });
    const html = await res.text();
    return parsePage(path, res.status, html);
  } catch (e: any) {
    return {
      path, status: 0, title: "", description: "", h1: "", headings: [], text: "",
      wordCount: 0, internalLinks: [], externalLinks: [], sisterDomainLinks: [],
      schemaTypes: [], canonical: null,
    };
  }
}

async function crawl(base: string, paths: string[], concurrency = 8): Promise<CrawledPage[]> {
  const out: CrawledPage[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (i < paths.length) {
      const idx = i++;
      out.push(await fetchRoute(base, paths[idx]));
    }
  });
  await Promise.all(workers);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Focus keyword derivation
// ---------------------------------------------------------------------------

const STOP = new Set([
  "the", "a", "an", "and", "or", "in", "on", "for", "with", "to", "of", "your",
  "you", "is", "are", "at", "by", "from", "that", "this", "it", "as", "our",
]);

/** Derive the keyword a page is currently targeting from its own title. The
 *  brand suffix after the last separator is stripped — it is not the target. */
export function derivedKeyword(page: CrawledPage): string {
  const t = (page.title || page.h1 || "").trim();
  if (!t) return "";
  const head = t.split(/\s+[|–—-]\s+/)[0].trim();
  const words = head
    .replace(/[?!.,:]+$/g, "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !STOP.has(w));

  // A title written as a full sentence is not a keyword. Fall back to the slug,
  // which is a truer statement of what the page is about.
  if (words.length > 6 || words.length < 1) {
    const slug = page.path.split("/").filter(Boolean).pop() ?? "";
    const fromSlug = slug.replace(/-/g, " ").split(" ").filter((w) => !STOP.has(w));
    if (fromSlug.length && fromSlug.length <= 8) return fromSlug.join(" ");
  }
  return words.slice(0, 6).join(" ");
}

function normalize(kw: string): string {
  return kw.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Tokens that mark a genuinely different place or audience. If one keyword
 *  carries one of these and the other does not, they are not competing —
 *  "elbow valley" and "elbow valley west" are separate communities, and
 *  "first-time home buyers" and "first-time home sellers" are opposite sides
 *  of the transaction. Without this guard the register fills with false
 *  positives that train the reader to ignore it. */
const DISTINGUISHERS = new Set([
  "west", "east", "north", "south", "upper", "lower", "inner", "outer",
  "old", "new", "greater", "buyer", "buyers", "seller", "sellers",
  "buying", "selling", "rent", "rental",
]);

/** Generic real-estate filler. Stripping it leaves the SUBJECT of a keyword —
 *  the entity the page is actually about — so "rideau park" and "rideau park
 *  homes for sale" are recognised as the same target while "elbow valley" and
 *  "elbow valley west" are not. */
const GENERIC = new Set([
  "homes", "home", "house", "houses", "sale", "sales", "buy", "sell",
  "calgary", "alberta", "real", "estate", "listings", "listing", "property",
  "properties", "guide", "ultimate", "best", "top", "condos", "condo",
]);

function subjectTokens(kw: string): string[] {
  return normalize(kw)
    .split(" ")
    .filter((w) => w && !STOP.has(w) && !GENERIC.has(w) && !/^\d+$/.test(w));
}

/** How strongly two keywords compete, 0–1.
 *
 *  Exact token overlap is not enough on its own: it reports adjacent
 *  communities as duplicates (dividing by the smaller set makes any subset
 *  score 1.0) and it misses genuine head/long-tail pairs like "rideau park"
 *  vs "rideau park homes for sale". So this works in three steps:
 *
 *   1. A distinguishing token on exactly one side (west/upper/buyers/…) means
 *      different targets — return 0 immediately.
 *   2. Identical SUBJECTS (generic filler removed) mean the same target
 *      regardless of length — return 1.
 *   3. Otherwise fall back to overlap over the larger set. */
function similarity(a: string, b: string): number {
  const toks = (x: string) => normalize(x).split(" ").filter((w) => w && !STOP.has(w));
  const A = new Set(toks(a));
  const B = new Set(toks(b));
  if (!A.size || !B.size) return 0;

  const onlyA: string[] = [];
  const onlyB: string[] = [];
  A.forEach((w) => { if (!B.has(w)) onlyA.push(w); });
  B.forEach((w) => { if (!A.has(w)) onlyB.push(w); });
  if (onlyA.concat(onlyB).some((w) => DISTINGUISHERS.has(w))) return 0;

  const sa = subjectTokens(a);
  const sb = subjectTokens(b);
  if (sa.length && sb.length) {
    const setA = new Set(sa);
    const setB = new Set(sb);
    if (setA.size === setB.size && sa.every((w) => setB.has(w))) return 1;
  }

  let hit = 0;
  A.forEach((w) => { if (B.has(w)) hit++; });
  return hit / Math.max(A.size, B.size);
}

/** Does `haystack` contain `keyword`?
 *
 *  Substring matching fails here: focus keywords are stored stopword-stripped
 *  ("downsizing empty nesters calgary") while the page text keeps them
 *  ("Downsizing & Empty Nesters in Calgary"), so a literal includes() reports
 *  a miss on a page that is a perfect match. Instead require every significant
 *  keyword token to appear in the haystack, in order. */
function containsKeyword(haystack: string, keyword: string): boolean {
  const kw = normalize(keyword).split(" ").filter((w) => w && !STOP.has(w));
  if (!kw.length) return false;
  const hay = normalize(haystack).split(" ");
  let at = 0;
  for (const tok of kw) {
    const found = hay.indexOf(tok, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

/** Occurrences of the keyword's rarest token — a proxy for how often the page
 *  actually discusses the subject, tolerant of phrasing changes. */
function keywordOccurrences(haystack: string, keyword: string): number {
  const kw = normalize(keyword).split(" ").filter((w) => w && !STOP.has(w) && !GENERIC.has(w));
  if (!kw.length) return 0;
  const hay = normalize(haystack).split(" ");
  const counts = kw.map((t) => hay.filter((w) => w === t).length);
  return Math.min(...counts);
}

function clusterFor(path: string, page: CrawledPage): ClusterDef {
  const byPrefix = CLUSTERS.find((c) =>
    c.prefixes.some((p) => path === p || path.startsWith(p + "/")),
  );
  if (byPrefix && byPrefix.id !== "journal") return byPrefix;
  if (path === "/") return CLUSTERS.find((c) => c.id === "trust")!;

  // Blog posts get classified by vocabulary so they can be checked against the
  // pillar they actually compete with, not just filed under "journal".
  if (path.startsWith("/blog/")) {
    const hay = `${page.title} ${page.h1} ${page.headings.join(" ")}`.toLowerCase();
    let best: ClusterDef | null = null;
    let bestScore = 0;
    for (const c of CLUSTERS) {
      if (c.id === "journal" || c.id === "trust") continue;
      const score = countVocab(hay, c.vocabulary);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best && bestScore >= 2) return best;
  }
  return byPrefix || CLUSTERS.find((c) => c.id === "journal")!;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreComponent {
  id: string;
  label: string;
  earned: number;
  max: number;
  detail: string;
}

export interface PageAnalysis {
  path: string;
  status: number;
  title: string;
  description: string;
  h1: string;
  wordCount: number;
  cluster: string;
  clusterLabel: string;
  intent: string;
  isPillar: boolean;
  focusKeyword: string;
  focusSource: "override" | "derived";
  score: number;
  grade: "strong" | "fair" | "weak";
  components: ScoreComponent[];
  inboundLinks: string[];
  outboundLinks: string[];
  externalDomains: string[];
  sisterDomainLinks: string[];
  schemaTypes: string[];
  conflicts: { path: string; keyword: string; similarity: number }[];
  recommendedInboundFrom: { path: string; reason: string }[];
  suggestedKeyword: string | null;
  suggestionReason: string | null;
  gsc?: { clicks: number; impressions: number; position: number; topQuery: string | null };
  issues: string[];
}

function band(score: number): PageAnalysis["grade"] {
  return score >= 75 ? "strong" : score >= 50 ? "fair" : "weak";
}

// ---------------------------------------------------------------------------
// Search Console enrichment (page + query pairing)
// ---------------------------------------------------------------------------

export interface GscPageRow {
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

async function fetchGscPageQueries(days: number): Promise<GscPageRow[]> {
  const { getAccessTokenForSeo, gscQueryRaw, gscSiteUrl } = await import("./seo-stats");
  const token = await getAccessTokenForSeo();
  if (!token) throw new Error("Search Console is not connected (no Google credentials configured)");
  const end = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const json = await gscQueryRaw(token, gscSiteUrl(), {
    startDate: start,
    endDate: end,
    dimensions: ["page", "query"],
    rowLimit: 5000,
  });
  return (json.rows || []).map((r: any) => ({
    page: r.keys[0],
    query: r.keys[1],
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    position: r.position || 0,
  }));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface SeoReport {
  generatedAt: string;
  origin: string;
  pageCount: number;
  crawlMs: number;
  gsc: { ok: boolean; message?: string; rows: number };
  summary: {
    avgScore: number;
    strong: number;
    fair: number;
    weak: number;
    conflicts: number;
    orphans: number;
    missingKeyword: number;
  };
  clusters: {
    id: string;
    label: string;
    pillar: string;
    headKeyword: string;
    intent: string;
    pages: number;
    avgScore: number;
    conflicts: number;
  }[];
  pages: PageAnalysis[];
}

export async function buildSeoReport(opts: {
  baseUrl: string;
  overrides?: Record<string, string>;
  gscDays?: number;
}): Promise<SeoReport> {
  const t0 = Date.now();
  const routes = publicRoutes();
  const crawled = await crawl(opts.baseUrl, routes);
  const crawlMs = Date.now() - t0;

  // ---- Search Console (optional; the console works fully without it) ----
  let gscRows: GscPageRow[] = [];
  let gscState: { ok: boolean; message?: string; rows: number } = { ok: false, message: "Not connected", rows: 0 };
  try {
    gscRows = await fetchGscPageQueries(opts.gscDays ?? 90);
    gscState = { ok: true, rows: gscRows.length, message: undefined };
  } catch (e: any) {
    gscState = { ok: false, message: e?.message?.slice(0, 200) ?? "unavailable", rows: 0 };
  }
  const gscByPath = new Map<string, GscPageRow[]>();
  for (const r of gscRows) {
    let p: string;
    try { p = new URL(r.page).pathname.replace(/\/$/, "") || "/"; } catch { continue; }
    if (!gscByPath.has(p)) gscByPath.set(p, []);
    gscByPath.get(p)!.push(r);
  }

  // ---- inbound link graph ----
  const inbound = new Map<string, Set<string>>();
  for (const p of crawled) {
    for (const href of p.internalLinks) {
      const target = href.replace(/\/$/, "") || "/";
      if (target === p.path) continue;
      if (!inbound.has(target)) inbound.set(target, new Set());
      inbound.get(target)!.add(p.path);
    }
  }
  // Links present on every page are site chrome, not editorial signals.
  const GLOBAL_LINK_THRESHOLD = crawled.length * 0.8;
  const isChrome = (target: string) =>
    (inbound.get(target)?.size ?? 0) >= GLOBAL_LINK_THRESHOLD;

  // ---- keywords ----
  const keywordOf = new Map<string, { kw: string; src: "override" | "derived" }>();
  for (const p of crawled) {
    const ov = opts.overrides?.[p.path];
    keywordOf.set(p.path, ov
      ? { kw: ov, src: "override" }
      : { kw: derivedKeyword(p), src: "derived" });
  }

  const analyses: PageAnalysis[] = crawled.map((page) => {
    const { kw, src } = keywordOf.get(page.path)!;
    const cluster = clusterFor(page.path, page);
    const isPillar = cluster.pillar === page.path;
    const hayTitle = page.title.toLowerCase();
    const hayDesc = page.description.toLowerCase();
    const hayH1 = page.h1.toLowerCase();
    const hayBody = page.text.toLowerCase();
    const nk = normalize(kw);

    // -- keyword conflicts (evidence-first: GSC pairing, then title similarity)
    const conflicts: PageAnalysis["conflicts"] = [];
    for (const other of crawled) {
      if (other.path === page.path) continue;
      const ok = keywordOf.get(other.path)!.kw;
      if (!ok || !nk) continue;
      const sim = similarity(kw, ok);
      if (sim >= 0.85) conflicts.push({ path: other.path, keyword: ok, similarity: Number(sim.toFixed(2)) });
    }
    // A child page targeting its own pillar's head term is always a conflict.
    if (
      !isPillar && nk &&
      similarity(kw, cluster.headKeyword) >= 0.85 &&
      !conflicts.some((c) => c.path === cluster.pillar)
    ) {
      conflicts.push({ path: cluster.pillar, keyword: cluster.headKeyword, similarity: 1 });
    }

    const inboundAll = Array.from(inbound.get(page.path) ?? []);
    // Pages linked from site chrome (nav/footer) receive a link from nearly
    // every page; those are not editorial signals, so they are not counted.
    const inboundEditorial = isChrome(page.path) ? [] : inboundAll;
    const outbound = page.internalLinks
      .map((h) => h.replace(/\/$/, "") || "/")
      .filter((h) => h !== page.path && !isChrome(h));

    // -- components --
    const C: ScoreComponent[] = [];
    const has = (h: string) => Boolean(nk) && containsKeyword(h, kw);
    const push = (id: string, label: string, ok: boolean, max: number, detail: string) =>
      C.push({ id, label, earned: ok ? max : 0, max, detail });

    push("title", "Focus keyword in title", has(hayTitle), 15,
      has(hayTitle) ? "Present" : `"${kw || "—"}" not found in <title>`);
    push("desc", "Focus keyword in meta description", has(hayDesc), 10,
      has(hayDesc) ? "Present" : "Not found in meta description");
    push("h1", "Focus keyword in H1", has(hayH1), 10,
      has(hayH1) ? "Present" : `H1 reads "${page.h1.slice(0, 60) || "—"}"`);
    const bodyHits = nk ? keywordOccurrences(hayBody, kw) : 0;
    push("body", "Focus keyword used in body", bodyHits >= 2, 10,
      `${bodyHits} occurrence${bodyHits === 1 ? "" : "s"} in body copy`);

    const tl = page.title.length;
    push("titleLen", "Title length", tl >= 35 && tl <= 65, 5, `${tl} chars (target 35–65)`);
    const dl = page.description.length;
    push("descLen", "Description length", dl >= 110 && dl <= 165, 5, `${dl} chars (target 110–165)`);

    push("unique", "Focus keyword is unowned elsewhere", conflicts.length === 0, 20,
      conflicts.length === 0
        ? "No other page targets this"
        : `Contested by ${conflicts.length} page${conflicts.length === 1 ? "" : "s"}`);

    const inCount = inboundEditorial.length;
    push("inbound", "Editorial inbound links", inCount >= 3, 15,
      `${inCount} contextual link${inCount === 1 ? "" : "s"} in (target ≥3)`);
    push("outbound", "Editorial outbound links", outbound.length >= 2, 5,
      `${outbound.length} contextual link${outbound.length === 1 ? "" : "s"} out (target ≥2)`);

    const entity = countVocab(hayBody, NOUNS_IDENTITY) + countVocab(hayBody, NOUNS_PLACE)
      + countVocab(hayBody, VERBS_SERVICE) + countVocab(hayBody, MODIFIERS);
    const per100 = page.wordCount ? (entity / page.wordCount) * 100 : 0;
    push("entities", "Noun / verb / modifier density", per100 >= 4, 5,
      `${entity} entity terms · ${per100.toFixed(1)} per 100 words (target ≥4)`);

    const score = C.reduce((s, c) => s + c.earned, 0);

    // -- link recommendations: same-cluster pages that already discuss this
    //    page's keyword in body copy but do not link to it yet.
    const recommendedInboundFrom: PageAnalysis["recommendedInboundFrom"] = [];
    if (inCount < 3 && nk) {
      for (const other of crawled) {
        if (other.path === page.path) continue;
        if (other.internalLinks.some((h) => (h.replace(/\/$/, "") || "/") === page.path)) continue;
        const mentions = containsKeyword(other.text, kw);
        if (!mentions) continue;
        const sameCluster = clusterFor(other.path, other).id === cluster.id;
        recommendedInboundFrom.push({
          path: other.path,
          reason: sameCluster
            ? `Same cluster and already mentions "${kw}" without linking`
            : `Mentions "${kw}" in body copy without linking`,
        });
        if (recommendedInboundFrom.length >= 6) break;
      }
    }

    // -- suggested keyword --
    let suggestedKeyword: string | null = null;
    let suggestionReason: string | null = null;
    const rows = gscByPath.get(page.path) ?? [];
    const bestQuery = rows.slice().sort((a, b) => b.impressions - a.impressions)[0] ?? null;

    if (!nk) {
      suggestedKeyword = bestQuery?.query ?? null;
      suggestionReason = bestQuery
        ? "No keyword set; this is the query the page already earns most impressions for"
        : "No keyword set and no Search Console history yet — set one manually";
    } else if (conflicts.length) {
      // Prefer a real query this page (and not its rival) already surfaces for.
      const rivalPaths = new Set(conflicts.map((c) => c.path));
      const distinct = rows
        .filter((r) => similarity(r.query, kw) < 0.85)
        .filter((r) => {
          for (const rp of Array.from(rivalPaths)) {
            const rr = gscByPath.get(rp) ?? [];
            if (rr.some((x) => x.query === r.query && x.impressions > r.impressions)) return false;
          }
          return true;
        })
        .sort((a, b) => b.impressions - a.impressions)[0];
      if (distinct) {
        suggestedKeyword = distinct.query;
        suggestionReason = `Contested by ${conflicts[0].path}. This page already ranks separately for this query (${distinct.impressions} impressions, pos ${distinct.position.toFixed(1)})`;
      } else if (isPillar) {
        suggestedKeyword = cluster.headKeyword;
        suggestionReason = `Pillar of ${cluster.label} — keep the head term here and re-target the child page instead`;
      } else {
        const modifier = page.path.split("/").pop()?.replace(/-/g, " ") ?? "";
        suggestedKeyword = normalize(
          /\bcalgary\b/.test(modifier) ? modifier : `${modifier} calgary`,
        );
        suggestionReason = `Contested by ${conflicts[0].path}. Narrow to this page's own subject so the pillar keeps the head term`;
      }
    } else if (bestQuery && similarity(bestQuery.query, kw) < 0.5 && bestQuery.impressions >= 25) {
      suggestedKeyword = bestQuery.query;
      suggestionReason = `Google already ranks this page for "${bestQuery.query}" (${bestQuery.impressions} impressions, pos ${bestQuery.position.toFixed(1)}) rather than the keyword set`;
    }

    // -- issues --
    const issues: string[] = [];
    if (page.status !== 200) issues.push(`Returns HTTP ${page.status}`);
    if (!page.title) issues.push("Missing <title>");
    if (!page.description) issues.push("Missing meta description");
    if (!page.h1) issues.push("Missing H1");
    if (inCount === 0 && !isChrome(page.path)) issues.push("Orphan — no editorial links point here");
    if (page.sisterDomainLinks.length) {
      issues.push(`Links to ${SISTER_DOMAIN} ×${page.sisterDomainLinks.length} — passes authority to the competing domain`);
    }
    if (page.title.toLowerCase().includes("luxury homes calgary") && !page.path.startsWith("/blog")) {
      issues.push("Title carries the old brand rather than Rivers Real Estate");
    }
    if (!page.schemaTypes.some((t) => t === "BreadcrumbList") && page.path !== "/") {
      issues.push("No BreadcrumbList schema");
    }
    if (page.wordCount < 300 && page.status === 200) issues.push(`Thin — ${page.wordCount} words`);

    return {
      path: page.path,
      status: page.status,
      title: page.title,
      description: page.description,
      h1: page.h1,
      wordCount: page.wordCount,
      cluster: cluster.id,
      clusterLabel: cluster.label,
      intent: cluster.intent,
      isPillar,
      focusKeyword: kw,
      focusSource: src,
      score,
      grade: band(score),
      components: C,
      inboundLinks: inboundEditorial,
      outboundLinks: outbound,
      externalDomains: page.externalLinks,
      sisterDomainLinks: page.sisterDomainLinks,
      schemaTypes: page.schemaTypes,
      conflicts,
      recommendedInboundFrom,
      suggestedKeyword,
      suggestionReason,
      gsc: rows.length
        ? {
            clicks: rows.reduce((s, r) => s + r.clicks, 0),
            impressions: rows.reduce((s, r) => s + r.impressions, 0),
            position: bestQuery ? bestQuery.position : 0,
            topQuery: bestQuery ? bestQuery.query : null,
          }
        : undefined,
      issues,
    };
  });

  const clusters = CLUSTERS.map((c) => {
    const pages = analyses.filter((a) => a.cluster === c.id);
    return {
      id: c.id,
      label: c.label,
      pillar: c.pillar,
      headKeyword: c.headKeyword,
      intent: c.intent,
      pages: pages.length,
      avgScore: pages.length ? Math.round(pages.reduce((s, p) => s + p.score, 0) / pages.length) : 0,
      conflicts: pages.filter((p) => p.conflicts.length).length,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    origin: ORIGIN,
    pageCount: analyses.length,
    crawlMs,
    gsc: gscState,
    summary: {
      avgScore: analyses.length
        ? Math.round(analyses.reduce((s, p) => s + p.score, 0) / analyses.length) : 0,
      strong: analyses.filter((p) => p.grade === "strong").length,
      fair: analyses.filter((p) => p.grade === "fair").length,
      weak: analyses.filter((p) => p.grade === "weak").length,
      conflicts: analyses.filter((p) => p.conflicts.length).length,
      orphans: analyses.filter((p) => p.inboundLinks.length === 0).length,
      missingKeyword: analyses.filter((p) => !p.focusKeyword).length,
    },
    clusters,
    pages: analyses.sort((a, b) => a.score - b.score),
  };
}
