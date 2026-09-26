/**
 * Ranks SEO work by likely payoff.
 *
 * The keyword console already knows what is *wrong* with each page. This
 * module answers the question that list can't: what is worth doing first.
 * Every opportunity carries an estimate of the extra organic clicks per month
 * it could win, derived from Search Console's page×query rows against a
 * position→CTR curve, then weighted by what a visit to that page is worth
 * (search intent, and GA4's engagement / key events) and divided by effort.
 *
 * The estimates are deliberately rough — a CTR curve is an average across the
 * whole web — but they are consistent, so the *ordering* is meaningful: a page
 * at position 6 with 2,000 impressions and a 0.4% CTR really is a better use
 * of an afternoon than a page at position 40 with 30.
 */
import type { PageAnalysis, GscPageRow } from "./seo-keywords";
import { containsKeyword, normalize } from "./seo-keywords";
import type { Ga4PageMetrics } from "./seo-stats";

export type OpportunityType =
  | "ctr_gap"
  | "striking_distance"
  | "keyword_mismatch"
  | "cannibalization"
  | "internal_links"
  | "content_gap"
  | "on_page";

export type Effort = "quick" | "medium" | "heavy";

export interface OpportunityQuery {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  /** For cannibalization: which page earned these numbers. */
  path?: string;
}

export interface Opportunity {
  id: string;
  type: OpportunityType;
  /** Pages involved. Empty for content_gap (the fix is a new page). */
  paths: string[];
  /** The query the opportunity is about, when there is one. */
  query: string | null;
  headline: string;
  why: string;
  action: string;
  queries: OpportunityQuery[];
  metrics: {
    impressions: number;
    clicks: number;
    ctr: number;
    position: number | null;
    pageviews?: number;
    keyEvents?: number;
    organicLandings?: number;
  };
  /** Estimated additional organic clicks per month if the fix works. */
  estClicksGain: number;
  effort: Effort;
  priority: number;
  quickWin: boolean;
  /** Where the estimate came from, so the UI can be honest about it. */
  basis: "search-console" | "on-page";
}

// ---------------------------------------------------------------------------
// Click-through curve
// ---------------------------------------------------------------------------

/** Typical organic CTR by position, positions 1–10 (desktop+mobile blend). */
const CTR_TOP10 = [0.28, 0.155, 0.105, 0.075, 0.055, 0.043, 0.034, 0.028, 0.023, 0.019];

export function expectedCtr(position: number): number {
  if (!Number.isFinite(position) || position <= 0) return 0;
  if (position <= 1) return CTR_TOP10[0];
  if (position <= 10) {
    const lo = Math.floor(position);
    const hi = Math.min(10, lo + 1);
    const t = position - lo;
    return CTR_TOP10[lo - 1] * (1 - t) + CTR_TOP10[hi - 1] * t;
  }
  if (position <= 20) return 0.012 - (position - 10) * 0.0007; // page two
  return 0.003;
}

const EFFORT_COST: Record<Effort, number> = { quick: 1, medium: 2, heavy: 4 };
const INTENT_WEIGHT: Record<string, number> = {
  transactional: 1.5,
  commercial: 1.2,
  informational: 0.8,
  navigational: 0.5,
};

/** Clicks below this per month are noise, not a quick win. */
const QUICK_WIN_MIN_GAIN = 3;

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildOpportunities(opts: {
  pages: PageAnalysis[];
  gscRows: GscPageRow[];
  ga4: Map<string, Ga4PageMetrics>;
  /** Length of the GSC window, to convert totals to a monthly rate. */
  days: number;
}): Opportunity[] {
  const { pages, gscRows, ga4 } = opts;
  const perMonth = 30 / Math.max(1, opts.days);
  const byPath = new Map(pages.map((p) => [p.path, p]));

  // ---- normalise GSC rows onto crawled paths ----
  const rowsByPath = new Map<string, GscPageRow[]>();
  const rowsByQuery = new Map<string, Array<GscPageRow & { path: string }>>();
  for (const r of gscRows) {
    let path: string;
    try {
      path = new URL(r.page).pathname;
    } catch {
      continue;
    }
    path = path.length > 1 ? path.replace(/\/+$/, "") : path;
    if (!rowsByPath.has(path)) rowsByPath.set(path, []);
    rowsByPath.get(path)!.push(r);
    const q = r.query.trim().toLowerCase();
    if (!rowsByQuery.has(q)) rowsByQuery.set(q, []);
    rowsByQuery.get(q)!.push({ ...r, path });
  }

  const ctrOf = (r: { clicks: number; impressions: number }) =>
    r.impressions ? r.clicks / r.impressions : 0;
  const asQuery = (r: GscPageRow, path?: string): OpportunityQuery => ({
    query: r.query,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: ctrOf(r),
    position: round1(r.position),
    ...(path ? { path } : {}),
  });

  const engagementMult = (path: string): number => {
    const m = ga4.get(path);
    if (!m || !m.sessions) return 1;
    const conv = Math.min(1, (m.keyEvents / m.sessions) * 10); // 10% conv → full boost
    return 1 + conv + (m.engagementRate >= 0.6 ? 0.2 : 0);
  };
  const ga4Metrics = (path: string) => {
    const m = ga4.get(path);
    return m
      ? { pageviews: m.pageviews, keyEvents: m.keyEvents, organicLandings: m.organicLandings }
      : {};
  };

  const out: Opportunity[] = [];
  const push = (
    o: Omit<Opportunity, "priority" | "quickWin" | "estClicksGain"> & { estClicksGain: number },
    intent: string,
    /** 0–1 tie-breaker for items with no search data, so they still sort
     *  sensibly (weakest page first) below everything that has some. */
    fallbackWeight = 0.5,
  ) => {
    const gain = round1(Math.max(0, o.estClicksGain));
    const mult = o.paths[0] ? engagementMult(o.paths[0]) : 1;
    const priority =
      ((gain || 0.05 * fallbackWeight) * (INTENT_WEIGHT[intent] ?? 1) * mult) / EFFORT_COST[o.effort];
    out.push({
      ...o,
      estClicksGain: gain,
      priority: Math.round(priority * 10000) / 10000,
      quickWin: o.effort === "quick" && gain >= QUICK_WIN_MIN_GAIN,
    });
  };

  const totals = (rows: GscPageRow[]) => {
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    // Impression-weighted mean position — the plain mean overweights the
    // long tail of one-impression queries at position 70.
    const position = impressions
      ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions
      : 0;
    return { impressions, clicks, ctr: impressions ? clicks / impressions : 0, position: round1(position) };
  };

  // ---- per-page opportunities ----
  for (const page of pages) {
    if (page.status !== 200) continue;
    const rows = (rowsByPath.get(page.path) ?? []).slice().sort((a, b) => b.impressions - a.impressions);
    const intent = page.intent;

    // 1. CTR gap — ranking well already, but the snippet isn't earning the
    //    click. A title/meta rewrite is the cheapest fix in SEO.
    const ctrRows = rows.filter(
      (r) => r.position <= 8 && r.impressions >= 40 && ctrOf(r) < expectedCtr(r.position) * 0.6,
    );
    if (ctrRows.length) {
      const gain = ctrRows.reduce(
        (s, r) => s + r.impressions * perMonth * (expectedCtr(r.position) * 0.8 - ctrOf(r)),
        0,
      );
      const top = ctrRows[0];
      const t = totals(ctrRows);
      push({
        id: `ctr_gap:${page.path}`,
        type: "ctr_gap",
        paths: [page.path],
        query: top.query,
        headline: `Ranks #${Math.round(top.position)} for “${top.query}” but few searchers click`,
        why: `${t.impressions.toLocaleString()} impressions at an average position of ${t.position}, with ${(t.ctr * 100).toFixed(1)}% CTR against roughly ${(expectedCtr(t.position) * 100).toFixed(1)}% expected. Google already shows this page, so the title and description aren't earning the click.`,
        action: "Rewrite the title and meta description around the query searchers actually use.",
        queries: ctrRows.slice(0, 8).map((r) => asQuery(r)),
        metrics: { ...t, ...ga4Metrics(page.path) },
        estClicksGain: gain,
        effort: "quick",
        basis: "search-console",
      }, intent);
    }

    // 2. Striking distance — positions 5–20. Moving to the top three is
    //    where nearly all the clicks are.
    const sdRows = rows.filter((r) => r.position > 5 && r.position <= 20 && r.impressions >= 25);
    if (sdRows.length) {
      const gain = sdRows.reduce(
        (s, r) => s + r.impressions * perMonth * Math.max(0, expectedCtr(3) - ctrOf(r)),
        0,
      ) * 0.5; // not every query in the set will move — halve it
      const top = sdRows[0];
      const t = totals(sdRows);
      push({
        id: `striking_distance:${page.path}`,
        type: "striking_distance",
        paths: [page.path],
        query: top.query,
        headline: `Close to page one for “${top.query}” (#${Math.round(top.position)})`,
        why: `${sdRows.length} quer${sdRows.length === 1 ? "y sits" : "ies sit"} between positions 5 and 20 with ${t.impressions.toLocaleString()} impressions between them. A focused content refresh and a few internal links usually move these more than anything else.`,
        action: "Strengthen the page around these queries: headings, a section that answers them directly, and internal links in.",
        queries: sdRows.slice(0, 8).map((r) => asQuery(r)),
        metrics: { ...t, ...ga4Metrics(page.path) },
        estClicksGain: gain,
        effort: "medium",
        basis: "search-console",
      }, intent);
    }

    // 3. Keyword mismatch — Google has decided what this page is about and
    //    it isn't the keyword we set.
    // Only queries Google already ranks it for (top two pages) count as
    // "what Google thinks the page is about".
    const best = rows.find((r) => r.position <= 20);
    if (
      best &&
      best.impressions >= 25 &&
      page.focusKeyword &&
      !containsKeyword(best.query, page.focusKeyword) &&
      !containsKeyword(page.focusKeyword, best.query) &&
      !page.conflicts.length
    ) {
      const gain =
        best.impressions * perMonth *
        Math.max(0, expectedCtr(Math.max(1, best.position - 3)) - ctrOf(best)) * 0.5;
      push({
        id: `keyword_mismatch:${page.path}`,
        type: "keyword_mismatch",
        paths: [page.path],
        query: best.query,
        headline: `Google ranks this page for “${best.query}”, not “${page.focusKeyword}”`,
        why: `Its biggest query (${best.impressions.toLocaleString()} impressions, position ${round1(best.position)}) isn't the focus keyword. Aligning the title, H1 and focus keyword with the demand that already exists is cheap and compounds.`,
        action: `Retarget the page to “${best.query}” (or fold it into the title alongside the current keyword).`,
        queries: rows.slice(0, 5).map((r) => asQuery(r)),
        metrics: { ...totals(rows), ...ga4Metrics(page.path) },
        estClicksGain: gain,
        effort: "quick",
        basis: "search-console",
      }, intent);
    }

    // 4. Internal links — ranking but under-linked, with pages that already
    //    mention its keyword ready to link.
    const linkRows = rows.filter((r) => r.position > 3 && r.position <= 20);
    if (page.inboundLinks.length < 3 && page.recommendedInboundFrom.length && linkRows.length) {
      const t = totals(linkRows);
      const gain =
        t.impressions * perMonth * Math.max(0, expectedCtr(Math.max(1, t.position - 2)) - t.ctr) * 0.4;
      push({
        id: `internal_links:${page.path}`,
        type: "internal_links",
        paths: [page.path],
        query: linkRows[0].query,
        headline: `Only ${page.inboundLinks.length} editorial link${page.inboundLinks.length === 1 ? "" : "s"} in, while ranking #${Math.round(t.position)}`,
        why: `${page.recommendedInboundFrom.length} page${page.recommendedInboundFrom.length === 1 ? " already mentions" : "s already mention"} “${page.focusKeyword}” without linking here. Contextual links are the strongest ranking lever you fully control.`,
        action: `Add contextual links from ${page.recommendedInboundFrom.slice(0, 3).map((r) => r.path).join(", ")}.`,
        queries: linkRows.slice(0, 5).map((r) => asQuery(r)),
        metrics: { ...t, ...ga4Metrics(page.path) },
        estClicksGain: gain,
        effort: "quick",
        basis: "search-console",
      }, intent);
    }

    // 5. On-page problems, weighted by how much traffic the page carries.
    // Orphans and links to the sister domain are common enough to swamp the
    // list, so they only count once the page is earning search impressions.
    const serious = page.issues.filter((i) =>
      /Missing|Thin|old brand/.test(i) || (rows.length > 0 && /Links to|Orphan/.test(i)),
    );
    if (serious.length || page.score < 50) {
      const t = totals(rows);
      const traffic = t.impressions * perMonth;
      const gain = rows.length ? traffic * 0.01 : 0;
      push({
        id: `on_page:${page.path}`,
        type: "on_page",
        paths: [page.path],
        query: rows[0]?.query ?? null,
        headline: `Score ${page.score}/100${serious.length ? ` — ${serious[0].toLowerCase()}` : ""}`,
        why: [
          ...serious,
          ...page.components.filter((c) => c.earned < c.max).slice(0, 3).map((c) => `${c.label}: ${c.detail}`),
        ].join(" · "),
        action: "Fix the missing on-page basics: title, description, H1, keyword placement and links.",
        queries: rows.slice(0, 5).map((r) => asQuery(r)),
        metrics: { ...t, position: rows.length ? t.position : null, ...ga4Metrics(page.path) },
        estClicksGain: gain,
        effort: serious.some((i) => /Thin/.test(i)) ? "medium" : "quick",
        basis: rows.length ? "search-console" : "on-page",
      }, intent, (100 - page.score) / 100);
    }
  }

  // ---- cannibalization: evidence from GSC first ----
  const seenPairs = new Set<string>();
  const pairKey = (a: string, b: string) => [a, b].sort().join("::");
  const cannibalByPair = new Map<string, { paths: string[]; rows: Array<GscPageRow & { path: string }> }>();
  for (const [, qRows] of Array.from(rowsByQuery)) {
    const known = qRows.filter((r) => byPath.has(r.path));
    const total = known.reduce((s, r) => s + r.impressions, 0);
    if (known.length < 2 || total < 30) continue;
    const sharers = known
      .filter((r) => r.impressions / total >= 0.15)
      .sort((a, b) => b.impressions - a.impressions);
    if (sharers.length < 2) continue;
    const key = pairKey(sharers[0].path, sharers[1].path);
    const entry = cannibalByPair.get(key) ?? { paths: [sharers[0].path, sharers[1].path], rows: [] };
    entry.rows.push(...sharers.slice(0, 2));
    cannibalByPair.set(key, entry);
  }
  for (const [key, entry] of Array.from(cannibalByPair)) {
    seenPairs.add(key);
    const t = totals(entry.rows);
    // Queries ranked by combined impressions
    const byQ = new Map<string, number>();
    for (const r of entry.rows) byQ.set(r.query, (byQ.get(r.query) ?? 0) + r.impressions);
    const topQuery = Array.from(byQ).sort((a, b) => b[1] - a[1])[0][0];
    const bestPos = Math.min(...entry.rows.map((r) => r.position));
    const gain =
      t.impressions * perMonth * Math.max(0, expectedCtr(Math.max(1, bestPos - 2)) - t.ctr) * 0.5;
    const intent = byPath.get(entry.paths[0])?.intent ?? "commercial";
    push({
      id: `cannibalization:${key}`,
      type: "cannibalization",
      paths: entry.paths,
      query: topQuery,
      headline: `${entry.paths[0]} and ${entry.paths[1]} split Google's attention for “${topQuery}”`,
      why: `Both pages earn impressions for ${byQ.size} shared quer${byQ.size === 1 ? "y" : "ies"} (${t.impressions.toLocaleString()} impressions combined). When two pages compete, Google tends to rank neither as well as one clear page.`,
      action: "Differentiate the two pages so each owns a distinct query — or consolidate the weaker one into the stronger with a 301.",
      queries: entry.rows
        .slice()
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 10)
        .map((r) => asQuery(r, r.path)),
      metrics: { ...t, ...ga4Metrics(entry.paths[0]) },
      estClicksGain: gain,
      effort: "medium",
      basis: "search-console",
    }, intent);
  }
  // …then the on-page (title similarity) conflicts the crawl found.
  for (const page of pages) {
    for (const c of page.conflicts) {
      const key = pairKey(page.path, c.path);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const rows = [...(rowsByPath.get(page.path) ?? []), ...(rowsByPath.get(c.path) ?? [])];
      const t = totals(rows);
      push({
        id: `cannibalization:${key}`,
        type: "cannibalization",
        paths: [page.path, c.path],
        query: page.focusKeyword || null,
        headline: `${page.path} and ${c.path} both target “${page.focusKeyword}”`,
        why: page.suggestionReason ??
          "Both pages' titles target the same subject, so they compete for the same searches.",
        action: page.suggestedKeyword
          ? `Re-target ${page.path} to “${page.suggestedKeyword}”, or consolidate one into the other.`
          : "Differentiate the two pages, or consolidate one into the other with a 301.",
        queries: [],
        metrics: { ...t, position: rows.length ? t.position : null },
        estClicksGain: rows.length ? t.impressions * perMonth * 0.01 : 0,
        effort: "medium",
        basis: rows.length ? "search-console" : "on-page",
      }, page.intent);
    }
  }

  // ---- content gaps: demand no page is built for ----
  const targetHay = pages.map((p) => normalize(`${p.title} ${p.h1} ${p.focusKeyword}`));
  const gaps: Array<{ query: string; rows: Array<GscPageRow & { path: string }> }> = [];
  for (const [q, qRows] of Array.from(rowsByQuery)) {
    const total = qRows.reduce((s, r) => s + r.impressions, 0);
    if (total < 40) continue;
    const bestPos = Math.min(...qRows.map((r) => r.position));
    if (bestPos <= 20) continue;
    if (q.split(" ").length < 2) continue; // single words are too broad to own
    if (targetHay.some((h) => containsKeyword(h, q))) continue;
    gaps.push({ query: q, rows: qRows });
  }
  gaps.sort((a, b) =>
    b.rows.reduce((s, r) => s + r.impressions, 0) - a.rows.reduce((s, r) => s + r.impressions, 0));
  for (const g of gaps.slice(0, 15)) {
    const t = totals(g.rows);
    push({
      id: `content_gap:${g.query}`,
      type: "content_gap",
      paths: [],
      query: g.query,
      headline: `No page is built for “${g.query}”`,
      why: `${t.impressions.toLocaleString()} impressions, but the best result sits at position ${t.position} on ${g.rows[0].path}, which isn't about this. A page written for the query could compete for the first page.`,
      action: "Draft a new journal post that targets this query (saved as a draft for review).",
      queries: g.rows.slice(0, 5).map((r) => asQuery(r, r.path)),
      metrics: t,
      estClicksGain: t.impressions * perMonth * expectedCtr(8) * 0.5,
      effort: "heavy",
      basis: "search-console",
    }, "informational");
  }

  return out.sort((a, b) => b.priority - a.priority);
}
