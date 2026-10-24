/**
 * Contextual links between detail pages: blog posts, neighbourhoods, condos.
 *
 * Each detail page used to be reachable only from its index (and, for blog
 * posts, from a "More from the journal" strip that showed the three newest
 * posts on every post — 83 links to three posts, none to the other 81). The
 * SEO console counts editorial links in, and three is its bar.
 *
 * Two kinds of link live here:
 *  - Rotations (previous/next post, the next few neighbourhoods or buildings
 *    in a stable order) guarantee every page a fixed number of links in.
 *  - Relevance (posts on the same subject, posts that name a place, places a
 *    post is about) adds the links a reader would actually follow.
 *
 * Everything is computed server-side and returned with the page's data, so it
 * is in the server-rendered HTML Google reads, and the selection is
 * deterministic — the same page always links to the same pages.
 */

export interface PostLink {
  slug: string;
  title: string;
  category: string;
  heroImage: string;
  heroImageAlt: string | null;
}
export interface PlaceLink {
  kind: "neighbourhood" | "condo";
  slug: string;
  name: string;
  /** Neighbourhood zone, or the building's neighbourhood name. */
  context: string | null;
}

interface PostIn {
  slug: string;
  title: string;
  category: string;
  excerpt?: string | null;
  publishedAt: string;
  heroImage: string;
  heroImageAlt?: string | null;
}
interface NeighbourhoodIn { slug: string; name: string; zone?: string | null }
interface CondoIn { slug: string; name: string; neighbourhoodSlug?: string | null; neighbourhood?: string | null }

const toPostLink = (p: PostIn): PostLink => ({
  slug: p.slug,
  title: p.title,
  category: p.category,
  heroImage: p.heroImage,
  heroImageAlt: p.heroImageAlt ?? null,
});

const STOP = new Set([
  "the", "a", "an", "and", "or", "in", "on", "for", "with", "to", "of", "your", "you", "is",
  "are", "at", "by", "from", "that", "this", "it", "as", "our", "how", "what", "why", "when",
  "vs", "do", "i", "my", "not", "which", "its", "it's", "into", "inside", "about",
]);
/** Words nearly every post shares — they say nothing about the subject. */
const GENERIC = new Set([
  "calgary", "calgarys", "alberta", "real", "estate", "home", "homes", "house", "houses",
  "luxury", "guide", "neighbourhood", "neighborhood", "neighbourhoods", "community",
  "communities", "living", "market", "buyers", "sellers", "best", "top", "new", "city",
  "compared", "explained", "complete", "ultimate", "things", "know", "reasons",
]);

function subjectWords(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((w) => w.length > 2 && !STOP.has(w) && !GENERIC.has(w) && !/^\d+$/.test(w)),
  );
}

/** Stable 32-bit hash, so ties break the same way on every render but
 *  differently for each page — spreading links instead of piling them on
 *  whichever post sorts first. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The k items after `index` in a circular list. With the list in a fixed
 *  order, every item is chosen by exactly k others. */
export function rotation<T>(items: T[], index: number, k: number): T[] {
  const out: T[] = [];
  for (let i = 1; i <= Math.min(k, items.length - 1); i++) out.push(items[(index + i) % items.length]);
  return out;
}

function nameRegex(name: string, ignoreCase = false): RegExp {
  const esc = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  return new RegExp(`(^|[^A-Za-z])${esc}([^A-Za-z]|$)`, ignoreCase ? "i" : "");
}

/** All-caps text ("BRITANNIA CALGARY ULTIMATE GUIDE") carries no case to
 *  tell a proper noun from a word, so it's matched ignoring case. */
const shouting = (s: string) => /[A-Z]/.test(s) && !/[a-z]/.test(s);

/** Does the text name this place? Case-sensitive on the proper noun, so
 *  "Mission" the community matches but "our mission" doesn't (all-caps text
 *  is the exception — see shouting). One-word names
 *  must be in the title; longer names can be in the excerpt too. */
function names(post: { title: string; excerpt?: string | null }, name: string): "title" | "excerpt" | null {
  if (name.trim().length < 4) return null;
  if (nameRegex(name, shouting(post.title)).test(post.title)) return "title";
  if (/\s/.test(name.trim()) && post.excerpt && nameRegex(name, shouting(post.excerpt)).test(post.excerpt)) return "excerpt";
  return null;
}

// ---------------------------------------------------------------------------
// Blog posts
// ---------------------------------------------------------------------------

export interface PostLinks {
  /** Chronological neighbours, wrapping at the ends so every post has both. */
  newer: PostLink | null;
  older: PostLink | null;
  /** Same subject first, then same category. */
  more: PostLink[];
  /** Neighbourhood and building pages the post is about. */
  places: PlaceLink[];
}

export function linksForPost(
  slug: string,
  posts: PostIn[],
  neighbourhoods: NeighbourhoodIn[],
  condos: CondoIn[],
  moreCount = 3,
): PostLinks {
  const byDate = posts.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug));
  const i = byDate.findIndex((p) => p.slug === slug);
  if (i === -1) return { newer: null, older: null, more: [], places: [] };
  const post = byDate[i];
  const n = byDate.length;
  const newer = n > 1 ? byDate[(i - 1 + n) % n] : null;
  const older = n > 2 ? byDate[(i + 1) % n] : null;

  const mine = subjectWords(`${post.title} ${post.slug}`);
  const taken = new Set([post.slug, newer?.slug, older?.slug]);
  const more = byDate
    .filter((p) => !taken.has(p.slug))
    .map((p) => {
      const theirs = subjectWords(`${p.title} ${p.slug}`);
      let shared = 0;
      mine.forEach((w) => { if (theirs.has(w)) shared++; });
      return { p, score: shared * 2 + (p.category === post.category ? 1 : 0), tie: hash(`${post.slug}>${p.slug}`) };
    })
    .sort((a, b) => b.score - a.score || a.tie - b.tie)
    .slice(0, moreCount)
    .map((x) => toPostLink(x.p));

  const nameOf = new Map(neighbourhoods.map((h) => [h.slug, h.name]));
  const places: PlaceLink[] = [];
  for (const h of neighbourhoods) {
    if (names(post, h.name)) places.push({ kind: "neighbourhood", slug: h.slug, name: h.name, context: h.zone ?? null });
  }
  for (const c of condos) {
    if (names(post, c.name)) {
      places.push({
        kind: "condo", slug: c.slug, name: c.name,
        context: c.neighbourhood ?? (c.neighbourhoodSlug ? nameOf.get(c.neighbourhoodSlug) ?? null : null),
      });
    }
  }
  // A longer name that contains a shorter one ("Elbow Park" vs "Elbow
  // Park Estates") wins; keep the list short.
  const kept = places.filter((p) => !places.some((o) => o !== p && o.name.length > p.name.length && o.name.includes(p.name)));

  return {
    newer: newer ? toPostLink(newer) : null,
    older: older ? toPostLink(older) : null,
    more,
    places: kept.slice(0, 6),
  };
}

/** Posts about a place: the name in the title first, then in the excerpt,
 *  newest first within each. */
export function postsNaming(name: string, posts: PostIn[], count = 3): PostLink[] {
  return posts
    .map((p) => ({ p, where: names(p, name) }))
    .filter((x) => x.where)
    .sort((a, b) =>
      (a.where === "title" ? 0 : 1) - (b.where === "title" ? 0 : 1) ||
      b.p.publishedAt.localeCompare(a.p.publishedAt))
    .slice(0, count)
    .map((x) => toPostLink(x.p));
}

// ---------------------------------------------------------------------------
// Neighbourhoods and condos
// ---------------------------------------------------------------------------

/** The next few neighbourhoods in (zone, name) order — mostly the same zone,
 *  and every neighbourhood is linked from exactly `count` others. */
export function nearbyNeighbourhoods(slug: string, all: NeighbourhoodIn[], count = 4): PlaceLink[] {
  const sorted = all.slice().sort((a, b) =>
    (a.zone ?? "").localeCompare(b.zone ?? "") || a.name.localeCompare(b.name));
  const i = sorted.findIndex((h) => h.slug === slug);
  if (i === -1) return [];
  return rotation(sorted, i, count).map((h) => ({ kind: "neighbourhood", slug: h.slug, name: h.name, context: h.zone ?? null }));
}

/** The next few buildings in (neighbourhood, name) order — same
 *  neighbourhood first, and every building is linked from exactly `count`. */
export function nearbyCondos(slug: string, all: CondoIn[], count = 3): PlaceLink[] {
  const sorted = all.slice().sort((a, b) =>
    (a.neighbourhoodSlug ?? "~").localeCompare(b.neighbourhoodSlug ?? "~") || a.name.localeCompare(b.name));
  const i = sorted.findIndex((c) => c.slug === slug);
  if (i === -1) return [];
  return rotation(sorted, i, count).map((c) => ({ kind: "condo", slug: c.slug, name: c.name, context: c.neighbourhood ?? null }));
}
