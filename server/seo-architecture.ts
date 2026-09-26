/**
 * Site architecture audit: is each topic cluster wired as a hub, does its
 * pillar own the head term, what is it missing, and which new clusters are
 * forming on their own?
 *
 * The page-level console (seo-keywords.ts, seo-opportunities.ts) judges each
 * page in isolation. Rankings in a competitive local market are won at the
 * cluster level instead: one strong pillar that covers a topic broadly and
 * links down to a child page per sub-topic, each child going deep and linking
 * back up, with no two pages chasing the same query. This module measures
 * that structure from the crawl's link graph and Search Console, and turns
 * the gaps into ranked opportunities that "Plan with Claude" can act on.
 *
 * Everything here is computed; nothing calls Claude.
 */
import type { ClusterDef, GscPageRow, PageAnalysis } from "./seo-keywords";
import { containsKeyword, normalize, subjectTokens } from "./seo-keywords";
import type { Ga4PageMetrics } from "./seo-stats";
import {
  EFFORT_COST,
  INTENT_WEIGHT,
  QUICK_WIN_MIN_GAIN,
  expectedCtr,
  type Effort,
  type Opportunity,
} from "./seo-opportunities";

export interface ClusterAudit {
  id: string;
  label: string;
  pillar: string;
  headKeyword: string;
  intent: string;
  factory: boolean;
  /** HTTP status of the pillar in this crawl, null when it wasn't crawled. */
  pillarStatus: number | null;
  /** Live child pages (the cluster minus its pillar). */
  children: string[];
  /** Children the pillar links to from its body copy. */
  linkedFromPillar: number;
  /** Children that link back up to the pillar from their body copy. */
  linkingUp: number;
  missingDownLinks: string[];
  missingUpLinks: string[];
  /** Mean share of children's editorial links that leave the cluster. */
  offClusterLinkShare: number;
  avgDepth: number | null;
  deepPages: string[];
  headTerm: {
    /** Page earning the most search demand for the head term. */
    owner: string | null;
    ownerImpressions: number;
    ownerPosition: number | null;
    pillarImpressions: number;
    pillarPosition: number | null;
    queries: number;
  } | null;
  /** Searches in this cluster's territory that no page targets. */
  gaps: Array<{ query: string; impressions: number; position: number; bestPage: string }>;
  flags: string[];
  /** 0–100 structural health. */
  health: number;
}

export interface ClusterCandidate {
  id: string;
  label: string;
  subject: string;
  headKeyword: string;
  pages: string[];
  suggestedPillar: string | null;
  impressions: number;
  why: string;
}

export interface ArchitectureReport {
  clusters: ClusterAudit[];
  candidates: ClusterCandidate[];
}

/** Topics too generic to anchor a cluster on their own. */
const WEAK_SUBJECTS = new Set([
  "luxury", "market", "markets", "tips", "new", "year", "update", "updates", "report", "news",
  "family", "families", "life", "living", "things", "know", "need", "why", "what", "how", "ways",
  "step", "steps", "complete", "quick", "first", "time", "price", "prices", "value", "cost",
  "agent", "realtor", "realtors", "spencer", "rivers", "january", "february", "march", "april",
  "may", "june", "july", "august", "september", "october", "november", "december", "q1", "q2",
  "q3", "q4", "vs", "via", "into", "most", "more", "every", "your", "their",
]);

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Every significant token of `kw` appears in `query`, in any order. */
function matchesAllTokens(query: string, kw: string): boolean {
  const q = new Set(normalize(query).split(" "));
  const k = normalize(kw).split(" ").filter((w) => w.length > 2 && !["the", "and", "for", "in"].includes(w));
  return k.length > 0 && k.every((w) => q.has(w));
}

export function buildArchitecture(opts: {
  pages: PageAnalysis[];
  clusters: ClusterDef[];
  links: Map<string, string[]>;
  bodyLinks: Map<string, string[]>;
  gscRows: GscPageRow[];
  ga4: Map<string, Ga4PageMetrics>;
  days: number;
}): { report: ArchitectureReport; opportunities: Opportunity[] } {
  const { pages, clusters, links, bodyLinks, ga4 } = opts;
  const perMonth = 30 / Math.max(1, opts.days);
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const live = (p: string) => byPath.get(p)?.status === 200;

  // ---- GSC rows onto paths ----
  const rowsByPath = new Map<string, GscPageRow[]>();
  const rowsByQuery = new Map<string, Array<GscPageRow & { path: string }>>();
  for (const r of opts.gscRows) {
    let path: string;
    try { path = new URL(r.page).pathname; } catch { continue; }
    path = path.length > 1 ? path.replace(/\/+$/, "") : path;
    if (!rowsByPath.has(path)) rowsByPath.set(path, []);
    rowsByPath.get(path)!.push(r);
    const q = r.query.trim().toLowerCase();
    if (!rowsByQuery.has(q)) rowsByQuery.set(q, []);
    rowsByQuery.get(q)!.push({ ...r, path });
  }
  const impressionsOf = (path: string) => (rowsByPath.get(path) ?? []).reduce((s, r) => s + r.impressions, 0);

  // ---- click depth from the homepage (every link counts: depth is reach) ----
  const depth = new Map<string, number>([["/", 0]]);
  const queue = ["/"];
  while (queue.length) {
    const at = queue.shift()!;
    for (const next of links.get(at) ?? []) {
      if (!depth.has(next) && byPath.has(next)) {
        depth.set(next, depth.get(at)! + 1);
        queue.push(next);
      }
    }
  }

  // ---- which pages each page's title/H1/keyword targets (for gap tests) ----
  const targetHay = pages.map((p) => ({ path: p.path, hay: normalize(`${p.title} ${p.h1} ${p.focusKeyword}`) }));
  const targeted = (q: string) => targetHay.some((t) => containsKeyword(t.hay, q));

  const audits: ClusterAudit[] = [];
  const opportunities: Opportunity[] = [];

  const push = (
    o: Omit<Opportunity, "priority" | "quickWin" | "type">,
    intent: string,
    fallbackWeight: number,
  ) => {
    const gain = round1(Math.max(0, o.estClicksGain));
    const g = o.paths[0] ? ga4.get(o.paths[0]) : undefined;
    const mult = g && g.sessions
      ? 1 + Math.min(1, (g.keyEvents / g.sessions) * 10) + (g.engagementRate >= 0.6 ? 0.2 : 0)
      : 1;
    const priority = ((gain || 0.05 * fallbackWeight) * (INTENT_WEIGHT[intent] ?? 1) * mult) / EFFORT_COST[o.effort];
    opportunities.push({
      ...o,
      type: "architecture",
      estClicksGain: gain,
      priority: Math.round(priority * 10000) / 10000,
      quickWin: o.effort === "quick" && gain >= QUICK_WIN_MIN_GAIN,
    });
  };
  const totals = (rows: GscPageRow[]) => {
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const position = impressions ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : 0;
    return { impressions, clicks, ctr: impressions ? clicks / impressions : 0, position: impressions ? round1(position) : null };
  };
  const codeOwned = (path: string) => !/^\/blog\/[^/]+$/.test(path);

  for (const c of clusters) {
    const members = pages.filter((p) => p.cluster === c.id);
    const pillar = byPath.get(c.pillar);
    const children = members.filter((p) => p.path !== c.pillar && p.status === 200).map((p) => p.path);
    const pillarBody = new Set(bodyLinks.get(c.pillar) ?? []);
    const missingDownLinks = children.filter((ch) => !pillarBody.has(ch));
    const missingUpLinks = children.filter((ch) => !(bodyLinks.get(ch) ?? []).includes(c.pillar));
    const memberSet = new Set(members.map((m) => m.path));

    // Off-cluster share: of each child's editorial links, how many leave.
    const shares = children
      .map((ch) => byPath.get(ch)!.outboundLinks)
      .filter((out) => out.length)
      .map((out) => out.filter((o) => !memberSet.has(o)).length / out.length);
    const offClusterLinkShare = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;

    const depths = members.map((m) => depth.get(m.path)).filter((d): d is number => d !== undefined);
    const avgDepth = depths.length ? round1(depths.reduce((a, b) => a + b, 0) / depths.length) : null;
    const deepPages = members
      .filter((m) => (depth.get(m.path) ?? 99) > 3 && m.status === 200)
      .map((m) => m.path);

    // Head-term ownership: which page earns the demand for the head term.
    let headTerm: ClusterAudit["headTerm"] = null;
    const headRows = opts.gscRows.length
      ? Array.from(rowsByQuery.values()).flat().filter((r) => matchesAllTokens(r.query, c.headKeyword))
      : [];
    if (headRows.length) {
      const perPage = new Map<string, GscPageRow[]>();
      for (const r of headRows) {
        if (!perPage.has(r.path)) perPage.set(r.path, []);
        perPage.get(r.path)!.push(r);
      }
      const ranked = Array.from(perPage, ([path, rows]) => ({ path, ...totals(rows) }))
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const owner = ranked[0];
      const pil = ranked.find((r) => r.path === c.pillar);
      headTerm = {
        owner: owner?.path ?? null,
        ownerImpressions: owner?.impressions ?? 0,
        ownerPosition: owner?.position ?? null,
        pillarImpressions: pil?.impressions ?? 0,
        pillarPosition: pil?.position ?? null,
        queries: new Set(headRows.map((r) => r.query)).size,
      };
    }

    // Gaps: searches in this cluster's territory with no page built for them.
    const gaps: ClusterAudit["gaps"] = [];
    for (const [q, qRows] of Array.from(rowsByQuery)) {
      const total = qRows.reduce((s, r) => s + r.impressions, 0);
      if (total < 30 || q.split(" ").length < 2) continue;
      const best = qRows.slice().sort((a, b) => a.position - b.position)[0];
      if (best.position <= 15) continue;
      const inTerritory =
        memberSet.has(best.path) ||
        c.vocabulary.some((v) => containsKeyword(q, v)) ||
        subjectTokens(c.headKeyword).some((t) => normalize(q).split(" ").includes(t));
      if (!inTerritory || targeted(q)) continue;
      gaps.push({ query: q, impressions: total, position: round1(best.position), bestPage: best.path });
    }
    gaps.sort((a, b) => b.impressions - a.impressions);

    const flags: string[] = [];
    if (!pillar || pillar.status !== 200) flags.push("pillar_missing");
    if (children.length < 3 && c.id !== "trust") flags.push("thin");
    if (children.length > 40) flags.push("sprawl");
    if (headTerm?.owner && headTerm.owner !== c.pillar && headTerm.ownerImpressions > headTerm.pillarImpressions * 1.2) {
      flags.push("pillar_not_owner");
    }
    if ((avgDepth ?? 0) > 3) flags.push("deep");

    const down = children.length ? (children.length - missingDownLinks.length) / children.length : 1;
    const up = children.length ? (children.length - missingUpLinks.length) / children.length : 1;
    const health = Math.max(0, Math.round(
      100
      - (flags.includes("pillar_missing") ? 40 : 0)
      - (1 - down) * 25
      - (1 - up) * 20
      - (flags.includes("pillar_not_owner") ? 15 : 0)
      - (flags.includes("thin") ? 10 : 0)
      - (flags.includes("deep") ? 10 : 0),
    ));

    audits.push({
      id: c.id,
      label: c.label,
      pillar: c.pillar,
      headKeyword: c.headKeyword,
      intent: c.intent,
      factory: Boolean(c.factory ?? true),
      pillarStatus: pillar?.status ?? null,
      children,
      linkedFromPillar: children.length - missingDownLinks.length,
      linkingUp: children.length - missingUpLinks.length,
      missingDownLinks: missingDownLinks.slice(0, 40),
      missingUpLinks: missingUpLinks.slice(0, 40),
      offClusterLinkShare: Math.round(offClusterLinkShare * 100) / 100,
      avgDepth,
      deepPages: deepPages.slice(0, 20),
      headTerm,
      gaps: gaps.slice(0, 10),
      flags,
      health,
    });

    // ---- architecture opportunities for this cluster ----
    if (c.id === "journal" || c.id === "trust") continue; // not hub-shaped by design
    const childImpr = children.reduce((s, ch) => s + impressionsOf(ch), 0);
    if (children.length >= 2 && missingDownLinks.length) {
      const share = missingDownLinks.length / children.length;
      push({
        id: `architecture:pillar_links:${c.id}`,
        subtype: "pillar_links",
        clusterId: c.id,
        paths: [c.pillar],
        query: c.headKeyword,
        headline: `${c.pillar} links to ${children.length - missingDownLinks.length} of its ${children.length} ${c.label.toLowerCase()} pages`,
        why: `A pillar passes authority and topical context down through contextual links. ${missingDownLinks.length} child page${missingDownLinks.length === 1 ? "" : "s"} (e.g. ${missingDownLinks.slice(0, 3).join(", ")}) get no link from the pillar's body copy.`,
        action: "Add a section or links on the pillar that introduce each missing child page by its sub-topic.",
        queries: [],
        metrics: { ...totals(rowsByPath.get(c.pillar) ?? []) },
        estClicksGain: childImpr * perMonth * 0.004 * share,
        effort: codeOwned(c.pillar) ? "medium" : "quick",
        basis: opts.gscRows.length ? "search-console" : "on-page",
      }, c.intent, share);
    }
    if (children.length >= 2 && missingUpLinks.length) {
      const share = missingUpLinks.length / children.length;
      const blogKids = missingUpLinks.filter((p) => p.startsWith("/blog/")).length;
      push({
        id: `architecture:uplinks:${c.id}`,
        subtype: "uplinks",
        clusterId: c.id,
        paths: [c.pillar],
        query: c.headKeyword,
        headline: `${missingUpLinks.length} ${c.label.toLowerCase()} page${missingUpLinks.length === 1 ? " doesn't" : "s don't"} link back to ${c.pillar}`,
        why: `Children linking up to the pillar with head-term anchor text (“${c.headKeyword}”) tell Google which page should rank for it. Nav links don't count here; they're on every page.`,
        action: `Add one contextual link to ${c.pillar} in the body of each page that's missing it.`,
        queries: [],
        metrics: { ...totals(rowsByPath.get(c.pillar) ?? []) },
        estClicksGain: impressionsOf(c.pillar) * perMonth * 0.01 * share,
        effort: blogKids === missingUpLinks.length ? "quick" : "medium",
        basis: opts.gscRows.length ? "search-console" : "on-page",
      }, c.intent, share * 0.8);
    }
    if (flags.includes("pillar_not_owner") && headTerm) {
      const t = totals(headRows);
      push({
        id: `architecture:pillar_not_owner:${c.id}`,
        subtype: "pillar_not_owner",
        clusterId: c.id,
        paths: [c.pillar, headTerm.owner!],
        query: c.headKeyword,
        headline: `${headTerm.owner} outranks the pillar ${c.pillar} for “${c.headKeyword}”`,
        why: `Google sends more head-term demand to ${headTerm.owner} (${headTerm.ownerImpressions.toLocaleString()} impressions${headTerm.ownerPosition ? `, pos ${headTerm.ownerPosition}` : ""}) than to the pillar (${headTerm.pillarImpressions.toLocaleString()}). Either strengthen the pillar and point the child at a narrower query, or promote the child to pillar.`,
        action: "Decide which page should own the head term, then align titles, links and the cluster definition.",
        queries: headRows.slice().sort((a, b) => b.impressions - a.impressions).slice(0, 8).map((r) => ({
          query: r.query, impressions: r.impressions, clicks: r.clicks,
          ctr: r.impressions ? r.clicks / r.impressions : 0, position: round1(r.position), path: r.path,
        })),
        metrics: t,
        estClicksGain: t.impressions * perMonth * Math.max(0, expectedCtr(Math.max(1, (headTerm.ownerPosition ?? 10) - 2)) - t.ctr) * 0.4,
        effort: "medium",
        basis: "search-console",
      }, c.intent, 1);
    }
  }

  // Deep pages with search demand — Google reaches them late and rarely.
  for (const p of pages) {
    const d = depth.get(p.path);
    const impr = impressionsOf(p.path);
    if (p.status !== 200 || !impr || (d !== undefined && d <= 3)) continue;
    push({
      id: `architecture:deep_page:${p.path}`,
      subtype: "deep_page",
      clusterId: p.cluster,
      paths: [p.path],
      query: null,
      headline: d === undefined
        ? `${p.path} can't be reached by links from the homepage`
        : `${p.path} is ${d} clicks from the homepage`,
      why: `It earns ${impr.toLocaleString()} impressions but sits deep in the site, so it gets crawled less and inherits little authority. Linking it from its pillar or a popular page lifts it.`,
      action: "Link it from its cluster pillar or another well-linked page.",
      queries: [],
      metrics: totals(rowsByPath.get(p.path) ?? []),
      estClicksGain: impr * perMonth * 0.005,
      effort: "quick",
      basis: "search-console",
    }, p.intent, 0.5);
  }

  // ---- emerging clusters among journal / unclustered posts ----
  const clusterWords = new Set<string>();
  for (const c of clusters) {
    for (const t of [...subjectTokens(c.headKeyword), ...subjectTokens(c.label), ...c.vocabulary.flatMap((v) => normalize(v).split(" "))]) {
      clusterWords.add(t);
    }
  }
  const loose = pages.filter((p) => p.status === 200 && p.path.startsWith("/blog/") && p.cluster === "journal");
  const bySubject = new Map<string, Set<string>>();
  for (const p of loose) {
    const words = normalize(`${p.focusKeyword} ${p.title.split(/\s+[|–—-]\s+/)[0]}`)
      .split(" ")
      .filter((w) => w.length > 3 && !WEAK_SUBJECTS.has(w) && !/^\d+$/.test(w));
    const subjects = new Set<string>();
    for (const w of subjectTokens(words.join(" "))) if (!WEAK_SUBJECTS.has(w)) subjects.add(w);
    for (let i = 0; i + 1 < words.length; i++) subjects.add(`${words[i]} ${words[i + 1]}`);
    for (const s of Array.from(subjects)) {
      if (!bySubject.has(s)) bySubject.set(s, new Set());
      bySubject.get(s)!.add(p.path);
    }
  }
  const groups = Array.from(bySubject, ([subject, set]) => ({ subject, pages: Array.from(set) }))
    .filter((g) => g.pages.length >= 3)
    .filter((g) => !g.subject.split(" ").every((w) => clusterWords.has(w)));
  // A bigram that covers the same pages as its words is the better label.
  const kept = groups.filter((g) =>
    g.subject.includes(" ") ||
    !groups.some((o) => o.subject.includes(" ") && o.subject.split(" ").includes(g.subject) &&
      o.pages.length >= g.pages.length));
  // Drop groups whose pages are a subset of a larger kept group.
  const candidates: ClusterCandidate[] = [];
  for (const g of kept.sort((a, b) => b.pages.length - a.pages.length)) {
    if (candidates.some((c) => g.pages.every((p) => c.pages.includes(p)))) continue;
    const impressions = g.pages.reduce((s, p) => s + impressionsOf(p), 0);
    // Head keyword: the group's biggest query that mentions the subject.
    const groupQueries = g.pages.flatMap((p) => rowsByPath.get(p) ?? [])
      .filter((r) => normalize(r.query).includes(g.subject))
      .sort((a, b) => b.impressions - a.impressions);
    const headKeyword = groupQueries[0]?.query ?? `${g.subject} calgary`;
    // Pillar: an existing page anywhere whose path or title names the subject
    // (e.g. /neighbourhoods/aspen-woods), else the group's strongest post.
    const slug = g.subject.replace(/ /g, "-");
    const named = pages.find((p) => p.status === 200 && !p.path.startsWith("/blog/") &&
      (p.path.endsWith(`/${slug}`) || normalize(p.h1) === g.subject));
    const strongest = g.pages.slice().sort((a, b) => impressionsOf(b) - impressionsOf(a) ||
      (byPath.get(b)!.inboundLinks.length - byPath.get(a)!.inboundLinks.length))[0];
    const suggestedPillar = named?.path ?? strongest ?? null;
    const label = g.subject.replace(/\b\w/g, (ch) => ch.toUpperCase());
    candidates.push({
      id: `cand:${slug}`,
      label,
      subject: g.subject,
      headKeyword,
      pages: g.pages,
      suggestedPillar,
      impressions,
      why: `${g.pages.length} journal posts cover “${g.subject}” but no cluster owns it, so they compete with each other instead of supporting one page.${named ? ` ${named.path} is the natural pillar.` : ""}`,
    });
    if (candidates.length >= 6) break;
  }
  for (const cand of candidates) {
    push({
      id: `architecture:cluster_candidate:${cand.id}`,
      subtype: "cluster_candidate",
      candidateId: cand.id,
      paths: cand.suggestedPillar ? [cand.suggestedPillar] : [],
      query: cand.headKeyword,
      headline: `New cluster forming: ${cand.label} (${cand.pages.length} posts)`,
      why: cand.why,
      action: "Adopt it as a cluster with one pillar, then link the posts to it and give each a distinct angle.",
      queries: [],
      metrics: totals(cand.pages.flatMap((p) => rowsByPath.get(p) ?? [])),
      estClicksGain: cand.impressions * perMonth * 0.01,
      effort: "heavy",
      basis: cand.impressions ? "search-console" : "on-page",
    }, "informational", Math.min(1, cand.pages.length / 6));
  }

  return { report: { clusters: audits, candidates }, opportunities };
}
