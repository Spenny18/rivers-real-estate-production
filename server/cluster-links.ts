/**
 * Hub-and-spoke links, driven by the SEO console's cluster map.
 *
 * The console groups every page into a topic cluster with one pillar
 * (server/seo-keywords.ts, editable at /admin/seo). Two links per cluster make
 * that structure real for Google:
 *
 *  - up:     each child page links to its pillar from its body copy, using the
 *            pillar's head term as anchor text ("Calgary luxury neighbourhoods"),
 *            which is how Google learns which page should own that term;
 *  - guides: each pillar links down to the journal posts in its cluster, which
 *            otherwise reach it only through the blog index.
 *
 * The report flagged both, page by page (47 neighbourhood pages, 13 condo
 * pages and 12 Work With pages with no link up; 35 + 7 + 5 + 4 + 3 posts the
 * pillars never mention), and fixing them one page at a time would have
 * meant hundreds of hand edits that drift every time a post is added. Here
 * the links follow the cluster map: adopt a post into a cluster in the console
 * and the pillar picks it up on the next report build.
 *
 * Membership comes from the last SEO report (blog posts are classified by
 * vocabulary there). Before any report exists, URL prefixes still give every
 * template page its up-link; only the guide lists wait for the first build.
 */
import { stripSiteName } from "@shared/blog-title";

export interface ClusterRef {
  id: string;
  label: string;
  pillar: string;
  headKeyword: string;
  prefixes: string[];
}

export interface ClusterPageRef {
  path: string;
  cluster: string;
  isPillar: boolean;
  title: string;
  status: number;
}

export interface ClusterLinkPillar {
  path: string;
  /** The pillar's head term, cased for reading. */
  anchor: string;
  label: string;
}

export interface ClusterLinksResult {
  /** Pillars this page sits under (its own cluster's, then its section's). */
  up: ClusterLinkPillar[];
  /** For a pillar: the journal posts in its cluster. */
  guides: Array<{ path: string; title: string }>;
}

/** The journal index already lists every post, and the trust pages (about,
 *  contact, valuation) are conversion pages, not topics. */
const NOT_TOPICS = new Set(["journal", "trust"]);

const UPPER = new Set(["mls", "mls®", "gst", "crea", "creb", "reca"]);

/** "calgary luxury neighbourhoods" → "Calgary luxury neighbourhoods";
 *  "springbank hill calgary" (label "Springbank Hill") → "Springbank Hill Calgary". */
export function anchorFor(headKeyword: string, label: string): string {
  const proper = new Set(
    label.split(/[^A-Za-z]+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w.toLowerCase()),
  );
  proper.add("calgary");
  proper.add("alberta");
  // A label's generic words ("Condos & Buildings") are not proper nouns.
  for (const w of ["condos", "buildings", "neighbourhoods", "listing", "search", "specialization", "work", "with", "journal"]) {
    proper.delete(w);
  }
  return headKeyword
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (UPPER.has(lw)) return lw.toUpperCase();
      if (proper.has(lw) || i === 0) return lw.charAt(0).toUpperCase() + lw.slice(1);
      return lw;
    })
    .join(" ");
}

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

function prefixOwner(path: string, clusters: ClusterRef[]): ClusterRef | null {
  let best: ClusterRef | null = null;
  let bestLen = -1;
  for (const c of clusters) {
    for (const pre of c.prefixes) {
      const pp = norm(pre);
      if ((path === pp || path.startsWith(pp + "/")) && pp.length > bestLen) {
        best = c;
        bestLen = pp.length;
      }
    }
  }
  return best;
}

export function clusterLinksFor(
  rawPath: string,
  clusters: ClusterRef[],
  pages: ClusterPageRef[],
): ClusterLinksResult {
  const path = norm(rawPath);
  const page = pages.find((p) => p.path === path) ?? null;
  const byId = new Map(clusters.map((c) => [c.id, c]));

  const up: ClusterLinkPillar[] = [];
  const addUp = (c: ClusterRef | null | undefined) => {
    if (!c || NOT_TOPICS.has(c.id) || norm(c.pillar) === path) return;
    if (up.some((u) => u.path === norm(c.pillar))) return;
    up.push({ path: norm(c.pillar), anchor: anchorFor(c.headKeyword, c.label), label: c.label });
  };
  // Its own cluster first (e.g. a post in the Springbank Hill cluster links to
  // /neighbourhoods/springbank-hill), then the section its URL sits in (so the
  // Springbank Hill page, a pillar itself, still links up to /neighbourhoods).
  if (page) addUp(byId.get(page.cluster));
  addUp(prefixOwner(path, clusters));

  const guides: Array<{ path: string; title: string }> = [];
  const owned = clusters.find((c) => norm(c.pillar) === path && !NOT_TOPICS.has(c.id));
  if (owned) {
    for (const p of pages) {
      if (p.cluster !== owned.id || p.path === path || p.status !== 200) continue;
      if (!p.path.startsWith("/blog/")) continue;
      guides.push({ path: p.path, title: stripSiteName(p.title) || p.path });
    }
    guides.sort((a, b) => a.title.localeCompare(b.title));
  }
  return { up, guides };
}

/** Live version: the stored cluster map and the last report's membership. */
export async function liveClusterLinks(path: string): Promise<ClusterLinksResult> {
  const [{ activeClusters }, { cachedSeoReport }] = await Promise.all([
    import("./seo-keywords"),
    import("./seo-report-cache"),
  ]);
  const report = cachedSeoReport();
  const pages: ClusterPageRef[] = (report?.pages ?? []).map((p) => ({
    path: p.path, cluster: p.cluster, isPillar: p.isPillar, title: p.title, status: p.status,
  }));
  return clusterLinksFor(path, activeClusters(), pages);
}
