/**
 * Ranks SEO work by likely payoff.
 *
 * The keyword console already knows what is *wrong* with each page. This
 * module answers the question that list can't: what is worth doing first.
 * Every opportunity carries an estimate of the extra organic clicks per month
 * it could win, derived from Search Console's page×query rows against a
 * position→CTR curve, and the working behind that number (GainEstimate) so the
 * console can show exactly where it came from.
 *
 * The estimates are deliberately rough — a CTR curve is an average across the
 * whole web — but they are consistent, so the *ordering* is meaningful: a page
 * at position 6 with 2,000 impressions and a 0.4% CTR really is a better use
 * of an afternoon than a page at position 40 with 30.
 *
 * Every estimate has the same shape: for each query, monthly impressions ×
 * (the click-through rate the fix should reach − the rate it earns today),
 * summed, then scaled by a confidence factor. What differs between task types
 * is only the target rate, and each type's `method` says how it was chosen.
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
  | "orphan"
  | "prune"
  | "external_links"
  | "image_alt"
  | "thin_content"
  | "content_gap"
  | "on_page"
  | "architecture";

/** For type "architecture": which structural problem it is. */
export type ArchitectureSubtype =
  | "pillar_links"
  | "uplinks"
  | "pillar_not_owner"
  | "cluster_candidate"
  | "deep_page";

/** What the work actually is — the console filters the list by this. */
export type TaskCategory =
  | "delete_merge"
  | "orphans"
  | "internal_links"
  | "external_links"
  | "image_alt"
  | "titles_meta"
  | "content"
  | "structure";

export function categoryOf(type: OpportunityType, subtype?: ArchitectureSubtype): TaskCategory {
  switch (type) {
    case "prune":
    case "cannibalization":
      return "delete_merge";
    case "orphan":
      return "orphans";
    case "internal_links":
      return "internal_links";
    case "external_links":
      return "external_links";
    case "image_alt":
      return "image_alt";
    case "ctr_gap":
    case "keyword_mismatch":
    case "on_page":
      return "titles_meta";
    case "striking_distance":
    case "thin_content":
    case "content_gap":
      return "content";
    case "architecture":
      if (subtype === "deep_page") return "orphans";
      if (subtype === "pillar_links" || subtype === "uplinks") return "internal_links";
      return "structure";
  }
}

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

/** One row of the click estimate's working. */
export interface GainLine {
  /** The query, or a description of the traffic for a rolled-up line. */
  label: string;
  path?: string;
  position: number | null;
  /** Impressions per month (the Search Console window scaled to 30 days). */
  monthlyImpressions: number;
  ctrNow: number;
  ctrTarget: number;
  /** monthlyImpressions × (ctrTarget − ctrNow), never negative. */
  clicks: number;
}

/** How estClicksGain was reached: subtotal of the lines × factor. */
export interface GainEstimate {
  /** Plain-English statement of the assumption behind the target rate. */
  method: string;
  /** Largest first, at most MAX_GAIN_LINES. */
  lines: GainLine[];
  /** Lines summed into the subtotal but not listed. */
  otherLines: number;
  otherClicks: number;
  subtotal: number;
  /** Confidence scaling applied to the subtotal (1 = none). */
  factor: number;
  factorReason: string | null;
}

export interface Opportunity {
  id: string;
  type: OpportunityType;
  category: TaskCategory;
  /** Pages involved. Empty for content_gap (the fix is a new page). */
  paths: string[];
  /** The query the opportunity is about, when there is one. */
  query: string | null;
  subtype?: ArchitectureSubtype;
  /** Architecture items: the cluster (or candidate) it concerns. */
  clusterId?: string;
  candidateId?: string;
  /** Set when one template change fixes every page listed (neighbourhood,
   *  condo and work-with pages share a layout). */
  template?: string;
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
  estimate: GainEstimate;
  effort: Effort;
  /** Clicks weighted by intent and engagement, divided by effort — the
   *  "best value" ordering. */
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

export const EFFORT_COST: Record<Effort, number> = { quick: 1, medium: 2, heavy: 4 };
export const INTENT_WEIGHT: Record<string, number> = {
  transactional: 1.5,
  commercial: 1.2,
  informational: 0.8,
  navigational: 0.5,
};

/** Clicks below this per month are noise, not a quick win. */
export const QUICK_WIN_MIN_GAIN = 3;

export const MAX_GAIN_LINES = 8;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// Estimate builders — shared with server/seo-architecture.ts
// ---------------------------------------------------------------------------

function finishEstimate(
  lines: GainLine[],
  method: string,
  factor: number,
  factorReason: string | null,
): GainEstimate {
  const sorted = lines.filter((l) => l.clicks > 0).sort((a, b) => b.clicks - a.clicks);
  const shown = sorted.slice(0, MAX_GAIN_LINES);
  const rest = sorted.slice(MAX_GAIN_LINES);
  const subtotal = sorted.reduce((s, l) => s + l.clicks, 0);
  return {
    method,
    lines: shown.map((l) => ({
      ...l,
      monthlyImpressions: round1(l.monthlyImpressions),
      ctrNow: round4(l.ctrNow),
      ctrTarget: round4(l.ctrTarget),
      clicks: round1(l.clicks),
    })),
    otherLines: rest.length,
    otherClicks: round1(rest.reduce((s, l) => s + l.clicks, 0)),
    subtotal: round1(subtotal),
    factor,
    factorReason: factor === 1 ? null : factorReason,
  };
}

/** Per-query estimate: each row's monthly impressions × (target − current CTR). */
export function queryEstimate(opts: {
  rows: Array<GscPageRow & { path?: string }>;
  perMonth: number;
  /** The click-through rate this row should reach once the fix works. */
  target: (r: GscPageRow) => number;
  method: string;
  factor?: number;
  factorReason?: string | null;
  /** Label each line with the page it belongs to. */
  withPath?: boolean;
}): GainEstimate {
  const lines = opts.rows.map((r): GainLine => {
    const ctrNow = r.impressions ? r.clicks / r.impressions : 0;
    const ctrTarget = opts.target(r);
    const monthly = r.impressions * opts.perMonth;
    return {
      label: r.query,
      ...(opts.withPath && r.path ? { path: r.path } : {}),
      position: round1(r.position),
      monthlyImpressions: monthly,
      ctrNow,
      ctrTarget,
      clicks: monthly * Math.max(0, ctrTarget - ctrNow),
    };
  });
  return finishEstimate(lines, opts.method, opts.factor ?? 1, opts.factorReason ?? null);
}

/** Position-lift estimate: the fix is assumed to move each query up `lift`
 *  positions, earning the typical CTR of the new position. */
export function liftEstimate(opts: {
  rows: Array<GscPageRow & { path?: string }>;
  perMonth: number;
  lift: number;
  method: string;
  factor?: number;
  factorReason?: string | null;
  withPath?: boolean;
}): GainEstimate {
  return queryEstimate({
    ...opts,
    target: (r) => expectedCtr(Math.max(1, r.position - opts.lift)),
  });
}

/** One rolled-up line, for estimates made on a page's or cluster's traffic
 *  as a whole rather than query by query. */
export function rollupEstimate(opts: {
  label: string;
  impressions: number;
  clicks: number;
  position: number | null;
  perMonth: number;
  ctrTarget: (ctrNow: number) => number;
  method: string;
  factor?: number;
  factorReason?: string | null;
}): GainEstimate {
  const ctrNow = opts.impressions ? opts.clicks / opts.impressions : 0;
  const ctrTarget = opts.ctrTarget(ctrNow);
  const monthly = opts.impressions * opts.perMonth;
  return finishEstimate(
    opts.impressions
      ? [{
          label: opts.label,
          position: opts.position,
          monthlyImpressions: monthly,
          ctrNow,
          ctrTarget,
          clicks: monthly * Math.max(0, ctrTarget - ctrNow),
        }]
      : [],
    opts.method,
    opts.factor ?? 1,
    opts.factorReason ?? null,
  );
}

/** No estimate is possible (or the task earns nothing directly). */
export function noEstimate(method: string): GainEstimate {
  return finishEstimate([], method, 1, null);
}

export const NO_DATA_NOTE =
  "There are no Search Console impressions to multiply, so the estimate is 0 — it sits at the bottom of the click ranking, not because it doesn't matter.";

export function gainOf(e: GainEstimate): number {
  return round1(Math.max(0, e.subtotal * e.factor));
}

/** Most clicks first; ties (e.g. every zero-estimate task) by best value. */
export function sortOpportunities(list: Opportunity[]): Opportunity[] {
  return list.sort((a, b) => b.estClicksGain - a.estClicksGain || b.priority - a.priority);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Pages whose job is a form or a search, not ranking on copy. */
const UTILITY_PATHS = new Set(["/contact", "/home-evaluation", "/mls", "/assignments"]);

/** Pages that share one layout, so a template change fixes all of them. */
export function templateOf(path: string): { id: string; label: string } | null {
  if (/^\/neighbourhoods\/[^/]+$/.test(path)) return { id: "neighbourhood", label: "neighbourhood" };
  if (/^\/condos\/[^/]+$/.test(path)) return { id: "condo", label: "condo building" };
  if (/^\/work-with\/[^/]+$/.test(path)) return { id: "work-with", label: "Work With" };
  return null;
}

/** Sources worth citing, by cluster — suggestions for the action text. */
const CITATION_IDEAS: Record<string, string> = {
  neighbourhoods: "the City of Calgary community profile, the CBE/CCSD school pages, or the community association",
  condos: "the City of Calgary property assessment, the condo corporation, or CREB® market statistics",
  "work-with": "CREB® market statistics, RECA consumer guides, or CMHC",
  search: "CREB® market statistics",
  journal: "CREB® statistics, the City of Calgary, Bank of Canada rates, or RECA",
  trust: "RECA, CREB® or the designations' issuing bodies",
};

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
  const gscConnected = gscRows.length > 0;

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
    o: Omit<Opportunity, "priority" | "quickWin" | "estClicksGain" | "category">,
    intent: string,
    /** 0–1 tie-breaker for items with no search data, so they still sort
     *  sensibly (weakest page first) below everything that has some. */
    fallbackWeight = 0.5,
  ) => {
    const gain = gainOf(o.estimate);
    const mult = o.paths[0] ? engagementMult(o.paths[0]) : 1;
    const priority =
      ((gain || 0.05 * fallbackWeight) * (INTENT_WEIGHT[intent] ?? 1) * mult) / EFFORT_COST[o.effort];
    out.push({
      ...o,
      category: categoryOf(o.type, o.subtype),
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
  const pageMetrics = (path: string, rows: GscPageRow[]) => {
    const t = totals(rows);
    return { ...t, position: rows.length ? t.position : null, ...ga4Metrics(path) };
  };

  // Template-wide problems collect here and become one item per template.
  const templateHits = new Map<string, {
    label: string;
    externalLinks: PageAnalysis[];
    imageAlt: PageAnalysis[];
  }>();
  const templateBucket = (id: string, label: string) => {
    if (!templateHits.has(id)) templateHits.set(id, { label, externalLinks: [], imageAlt: [] });
    return templateHits.get(id)!;
  };

  // ---- per-page opportunities ----
  for (const page of pages) {
    if (page.status !== 200) continue;
    const rows = (rowsByPath.get(page.path) ?? []).slice().sort((a, b) => b.impressions - a.impressions);
    const intent = page.intent;
    const isOrphan = page.issues.some((i) => /Orphan/.test(i));
    const isThin = page.wordCount < 300;
    const tpl = templateOf(page.path);
    const pillar = pages.find((p) => p.cluster === page.cluster && p.isPillar);

    // 0. Dead weight — a post that earns nothing and isn't set up to. Only
    //    called once Search Console is connected (otherwise "no impressions"
    //    means "no data"), and never on a post younger than the data window.
    const impr = rows.reduce((s, r) => s + r.impressions, 0);
    const views = ga4.get(page.path)?.pageviews ?? 0;
    const ageDays = page.publishedAt ? (Date.now() - Date.parse(page.publishedAt)) / 864e5 : Infinity;
    const isDeadWeight =
      gscConnected &&
      page.path.startsWith("/blog/") &&
      !page.isPillar &&
      ageDays >= opts.days &&
      impr < 10 &&
      views < 20 &&
      (isThin || isOrphan || page.conflicts.length > 0);
    if (isDeadWeight) {
      const reasons = [
        isThin && `${page.wordCount} words`,
        isOrphan && "no editorial links point to it",
        page.conflicts.length && `overlaps ${page.conflicts[0].path}`,
      ].filter(Boolean).join(", ");
      const mergeInto = page.conflicts[0]?.path ?? null;
      push({
        id: `prune:${page.path}`,
        type: "prune",
        paths: mergeInto ? [page.path, mergeInto] : [page.path],
        query: page.focusKeyword || null,
        headline: mergeInto
          ? `Dead weight: merge into ${mergeInto}`
          : "Dead weight: delete it, or rewrite it to earn its place",
        why: `${impr} search impression${impr === 1 ? "" : "s"} in ${opts.days} days and ${views} page view${views === 1 ? "" : "s"}, and ${reasons}. Pages like this make Google spend crawl time on the site's weakest copy and dilute what it thinks the site is about.`,
        action: mergeInto
          ? `Move anything useful into ${mergeInto}, 301 this URL to it, then unpublish this post.`
          : `Unpublish it and 301 the URL to ${pillar?.path ?? "its closest related page"} — or, if the topic deserves to rank, rewrite it properly and link to it.`,
        queries: rows.slice(0, 5).map((r) => asQuery(r)),
        metrics: pageMetrics(page.path, rows),
        estimate: noEstimate(
          "Deleting a page adds no clicks directly: it earns almost none today, so there is nothing to gain or lose. The payoff is indirect — less thin copy for Google to judge the site by, and the URL's few signals passed to a stronger page by the 301.",
        ),
        effort: "quick",
        basis: "on-page",
      }, intent, 0.2);
      continue; // no point optimising a page that should go
    }

    // 1. CTR gap — ranking well already, but the snippet isn't earning the
    //    click. A title/meta rewrite is the cheapest fix in SEO.
    const ctrRows = rows.filter(
      (r) => r.position <= 8 && r.impressions >= 40 && ctrOf(r) < expectedCtr(r.position) * 0.6,
    );
    if (ctrRows.length) {
      const top = ctrRows[0];
      const t = totals(ctrRows);
      push({
        id: `ctr_gap:${page.path}`,
        type: "ctr_gap",
        paths: [page.path],
        query: top.query,
        headline: `Ranks #${Math.round(top.position)} for “${top.query}” but few searchers click`,
        why: `${t.impressions.toLocaleString()} impressions at an average position of ${t.position}, with ${pct(t.ctr)} CTR against roughly ${pct(expectedCtr(t.position))} expected. Google already shows this page, so the title and description aren't earning the click.`,
        action: "Rewrite the title and meta description around the query searchers actually use.",
        queries: ctrRows.slice(0, 8).map((r) => asQuery(r)),
        metrics: { ...t, ...ga4Metrics(page.path) },
        estimate: queryEstimate({
          rows: ctrRows,
          perMonth,
          target: (r) => expectedCtr(r.position) * 0.8,
          method: "The page keeps its position; a better title and description lift its click-through rate to 80% of what's typical at that position.",
        }),
        effort: "quick",
        basis: "search-console",
      }, intent);
    }

    // 2. Striking distance — positions 5–20. Moving to the top three is
    //    where nearly all the clicks are.
    const sdRows = rows.filter((r) => r.position > 5 && r.position <= 20 && r.impressions >= 25);
    if (sdRows.length) {
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
        estimate: queryEstimate({
          rows: sdRows,
          perMonth,
          target: () => expectedCtr(3),
          method: `A content refresh moves these queries up to position 3, which typically earns a ${pct(expectedCtr(3))} click-through rate.`,
          factor: 0.5,
          factorReason: "Halved: not every query in the set will reach the top three.",
        }),
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
        estimate: liftEstimate({
          rows: [best],
          perMonth,
          lift: 3,
          method: "Putting the query Google already ranks it for into the title and H1 typically lifts the page about 3 positions for it.",
          factor: 0.5,
          factorReason: "Halved: a retarget doesn't always move the ranking.",
        }),
        effort: "quick",
        basis: "search-console",
      }, intent);
    }

    // 4. Internal links — ranking but under-linked, with pages that already
    //    mention its keyword ready to link. (No links at all is an orphan.)
    const linkRows = rows.filter((r) => r.position > 3 && r.position <= 20);
    if (
      !isOrphan &&
      page.inboundLinks.length > 0 &&
      page.inboundLinks.length < 3 &&
      page.recommendedInboundFrom.length &&
      linkRows.length
    ) {
      const t = totals(linkRows);
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
        estimate: liftEstimate({
          rows: linkRows,
          perMonth,
          lift: 2,
          method: "Contextual links from related pages typically lift a page about 2 positions for the queries it already ranks for.",
          factor: 0.4,
          factorReason: "×0.4: links are one ranking signal among many, so only part of the lift is counted.",
        }),
        effort: "quick",
        basis: "search-console",
      }, intent);
    }

    // 5. Orphans — nothing in the site's body copy links here, so Google
    //    finds it only through the sitemap and gives it little weight.
    if (isOrphan) {
      const from = page.recommendedInboundFrom.slice(0, 3).map((r) => r.path);
      push({
        id: `orphan:${page.path}`,
        type: "orphan",
        paths: [page.path],
        query: rows[0]?.query ?? (page.focusKeyword || null),
        headline: "Orphan page — no editorial links point here",
        why: `No page links to it from its body copy (nav and footer links don't count — they're on every page). ${rows.length ? `It still earns ${impr.toLocaleString()} impressions, at an average position of ${totals(rows).position}.` : "It earns no search impressions yet."}`,
        action: from.length
          ? `Link to it from ${from.join(", ")} — they already mention “${page.focusKeyword}”.`
          : `Link to it from ${pillar && pillar.path !== page.path ? `its pillar ${pillar.path}` : "a related page"} with descriptive anchor text.`,
        queries: rows.slice(0, 5).map((r) => asQuery(r)),
        metrics: pageMetrics(page.path, rows),
        estimate: rows.length
          ? liftEstimate({
              rows,
              perMonth,
              lift: 2,
              method: "Linking an orphan from related pages typically lifts it about 2 positions for the queries it already ranks for.",
              factor: 0.4,
              factorReason: "×0.4: links are one ranking signal among many, so only part of the lift is counted.",
            })
          : noEstimate(`Linking it lets Google find and value the page. ${NO_DATA_NOTE}`),
        effort: "quick",
        basis: rows.length ? "search-console" : "on-page",
      }, intent, 0.6);
    }

    // 6. External links — no citations out. A modest trust/relevance signal,
    //    and the one Rank Math users are used to seeing checked.
    if (page.externalDomains.length === 0 && !isThin && !UTILITY_PATHS.has(page.path) && page.path !== "/") {
      if (tpl) templateBucket(tpl.id, tpl.label).externalLinks.push(page);
      else {
        push({
          id: `external_links:${page.path}`,
          type: "external_links",
          paths: [page.path],
          query: rows[0]?.query ?? (page.focusKeyword || null),
          headline: "No external links to sources",
          why: `The page cites nothing outside the site. Linking a claim to an authoritative source shows Google (and readers) the copy is grounded.`,
          action: `Add one or two links to sources that back the copy up — e.g. ${CITATION_IDEAS[page.cluster] ?? CITATION_IDEAS.journal}.`,
          queries: rows.slice(0, 5).map((r) => asQuery(r)),
          metrics: pageMetrics(page.path, rows),
          estimate: rows.length
            ? liftEstimate({
                rows,
                perMonth,
                lift: 0.5,
                method: "Citing authoritative sources is a small trust and relevance signal — assumed to lift the page about half a position for its queries.",
                factor: 0.5,
                factorReason: "Halved: the effect of outbound citations is modest and not guaranteed.",
              })
            : noEstimate(NO_DATA_NOTE),
          effort: "quick",
          basis: rows.length ? "search-console" : "on-page",
        }, intent, 0.3);
      }
    }

    // 7. Image alt text — the featured image and any body images.
    const f = page.images.featured;
    const altProblem =
      page.images.missingAlt > 0 ||
      (f && page.focusKeyword && (!f.hasKeyword || f.source === "fallback"));
    if (altProblem && f) {
      if (tpl) templateBucket(tpl.id, tpl.label).imageAlt.push(page);
      else {
        const problems: string[] = [];
        if (f.source === "fallback") problems.push(`the featured image's alt text isn't set, so it falls back to the post title (“${f.alt.slice(0, 70)}”)`);
        else if (!f.alt) problems.push("the featured image has no alt text");
        else if (!f.hasKeyword) problems.push(`the featured image's alt text (“${f.alt.slice(0, 70)}”) doesn't mention “${page.focusKeyword}”`);
        if (page.images.missingAlt > (f.alt ? 0 : 1)) {
          problems.push(`${page.images.missingAlt} image${page.images.missingAlt === 1 ? " has" : "s have"} no alt text at all`);
        }
        push({
          id: `image_alt:${page.path}`,
          type: "image_alt",
          paths: [page.path],
          query: rows[0]?.query ?? (page.focusKeyword || null),
          headline: f.source === "fallback" || !f.alt
            ? "Featured image needs alt text"
            : f.hasKeyword ? "Images missing alt text" : "Featured image alt text doesn't name the keyword",
          why: `${problems.join("; ").replace(/^./, (c) => c.toUpperCase())}. Alt text is what Google Images ranks a photo on, and screen readers read it aloud.`,
          action: page.path.startsWith("/blog/")
            ? `Set the featured image's alt text to describe the photo in a sentence that names “${page.focusKeyword}”.`
            : `Give each image a short description that names “${page.focusKeyword}” where it fits naturally.`,
          queries: rows.slice(0, 5).map((r) => asQuery(r)),
          metrics: pageMetrics(page.path, rows),
          estimate: rows.length
            ? liftEstimate({
                rows,
                perMonth,
                lift: 0.5,
                method: "Descriptive alt text lets Google Images rank the photo and adds a small relevance signal — assumed to lift the page about half a position for its queries.",
                factor: 0.5,
                factorReason: "Halved: alt text is a minor ranking signal for the page itself.",
              })
            : noEstimate(NO_DATA_NOTE),
          effort: "quick",
          basis: rows.length ? "search-console" : "on-page",
        }, intent, 0.4);
      }
    }

    // 8. Thin content — too little copy to rank for anything competitive.
    if (isThin && !UTILITY_PATHS.has(page.path)) {
      push({
        id: `thin_content:${page.path}`,
        type: "thin_content",
        paths: [page.path],
        query: rows[0]?.query ?? (page.focusKeyword || null),
        headline: `Thin page — ${page.wordCount} words`,
        why: `Under 300 words is rarely enough to answer a search fully, so Google tends to rank a fuller page instead. ${rows.length ? `It already earns ${impr.toLocaleString()} impressions to build on.` : "It earns no impressions yet."}`,
        action: `Expand it to answer “${page.focusKeyword || rows[0]?.query || "its topic"}” properly: the questions a buyer or seller asks, with specifics only this site can give.`,
        queries: rows.slice(0, 5).map((r) => asQuery(r)),
        metrics: pageMetrics(page.path, rows),
        estimate: rows.length
          ? liftEstimate({
              rows,
              perMonth,
              lift: 3,
              method: "Expanding a thin page to answer the query fully typically lifts it about 3 positions.",
              factor: 0.5,
              factorReason: "Halved: more words help only if they answer the search better.",
            })
          : noEstimate(NO_DATA_NOTE),
        effort: "medium",
        basis: rows.length ? "search-console" : "on-page",
      }, intent, (100 - page.score) / 100);
    }

    // 9. On-page basics — missing title, description or H1, or a low score
    //    the specific tasks above don't already explain. Links to the sister
    //    site are housekeeping, never a reason on their own to flag a page.
    const serious = page.issues.filter((i) => /Missing/.test(i));
    if (serious.length || page.score < 50) {
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
        action: "Fix the missing on-page basics: title, description, H1 and keyword placement.",
        queries: rows.slice(0, 5).map((r) => asQuery(r)),
        metrics: pageMetrics(page.path, rows),
        estimate: rows.length
          ? liftEstimate({
              rows,
              perMonth,
              lift: 1,
              method: "Getting the keyword into the title, description and H1 typically lifts a page about one position.",
              factor: 0.5,
              factorReason: "Halved: on-page basics are table stakes, not a guaranteed move.",
            })
          : noEstimate(NO_DATA_NOTE),
        effort: "quick",
        basis: rows.length ? "search-console" : "on-page",
      }, intent, (100 - page.score) / 100);
    }
  }

  // ---- template-wide tasks: one item, one code change, every page fixed ----
  for (const [id, hit] of Array.from(templateHits)) {
    const byImpr = (list: PageAnalysis[]) =>
      list.slice().sort((a, b) =>
        (rowsByPath.get(b.path) ?? []).reduce((s, r) => s + r.impressions, 0) -
        (rowsByPath.get(a.path) ?? []).reduce((s, r) => s + r.impressions, 0));
    const rowsFor = (list: PageAnalysis[]) =>
      list.flatMap((p) => (rowsByPath.get(p.path) ?? []).map((r) => ({ ...r, path: p.path })));
    const intent = hit.externalLinks[0]?.intent ?? hit.imageAlt[0]?.intent ?? "commercial";

    if (hit.externalLinks.length) {
      const list = byImpr(hit.externalLinks);
      const rows = rowsFor(list);
      push({
        id: `external_links:template:${id}`,
        type: "external_links",
        template: id,
        paths: list.map((p) => p.path),
        query: null,
        headline: `${list.length} ${hit.label} page${list.length === 1 ? " has" : "s have"} no external links`,
        why: `These pages share one layout and none of them cites a source outside the site. A "Sources" line in the template fixes every one at once.`,
        action: `Add a short sources line to the ${hit.label} template linking to ${CITATION_IDEAS[list[0].cluster] ?? CITATION_IDEAS.journal}.`,
        queries: [],
        metrics: { ...totals(rows), position: rows.length ? totals(rows).position : null },
        estimate: rows.length
          ? liftEstimate({
              rows,
              perMonth,
              withPath: true,
              lift: 0.5,
              method: "Citing authoritative sources is a small trust and relevance signal — assumed to lift each page about half a position for its queries.",
              factor: 0.5,
              factorReason: "Halved: the effect of outbound citations is modest and not guaranteed.",
            })
          : noEstimate(NO_DATA_NOTE),
        effort: "medium",
        basis: rows.length ? "search-console" : "on-page",
      }, intent, 0.3);
    }

    if (hit.imageAlt.length) {
      const list = byImpr(hit.imageAlt);
      const rows = rowsFor(list);
      const missing = list.reduce((s, p) => s + p.images.missingAlt, 0);
      const noKw = list.filter((p) => p.images.featured && !p.images.featured.hasKeyword).length;
      push({
        id: `image_alt:template:${id}`,
        type: "image_alt",
        template: id,
        paths: list.map((p) => p.path),
        query: null,
        headline: `Image alt text on ${list.length} ${hit.label} page${list.length === 1 ? "" : "s"}`,
        why: [
          noKw && `${noKw} featured image${noKw === 1 ? "'s" : "s'"} alt text doesn't name the page's keyword`,
          missing && `${missing} image${missing === 1 ? " has" : "s have"} no alt text`,
        ].filter(Boolean).join("; ").replace(/^./, (c) => c.toUpperCase()) +
          ". The alt text comes from the shared template, so one change fixes them all.",
        action: `Update the ${hit.label} template so every image's alt text describes it and names the place (e.g. “Aspen Woods homes for sale — street view”).`,
        queries: [],
        metrics: { ...totals(rows), position: rows.length ? totals(rows).position : null },
        estimate: rows.length
          ? liftEstimate({
              rows,
              perMonth,
              withPath: true,
              lift: 0.5,
              method: "Descriptive alt text lets Google Images rank the photos and adds a small relevance signal — assumed to lift each page about half a position for its queries.",
              factor: 0.5,
              factorReason: "Halved: alt text is a minor ranking signal for the page itself.",
            })
          : noEstimate(NO_DATA_NOTE),
        effort: "medium",
        basis: rows.length ? "search-console" : "on-page",
      }, intent, 0.4);
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
    // One line per query: when both pages show for a search, each logs an
    // impression, so the larger of the two is the number of searches.
    const perQuery = new Map<string, GscPageRow>();
    for (const r of entry.rows) {
      const cur = perQuery.get(r.query);
      perQuery.set(r.query, cur
        ? { ...cur, impressions: Math.max(cur.impressions, r.impressions), clicks: cur.clicks + r.clicks, position: Math.min(cur.position, r.position) }
        : { ...r });
    }
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
      estimate: queryEstimate({
        rows: Array.from(perQuery.values()),
        perMonth,
        target: () => expectedCtr(Math.max(1, bestPos - 2)),
        method: `One clear page typically ranks about 2 positions above the better of the two today (#${round1(bestPos)}), earning ${pct(expectedCtr(Math.max(1, bestPos - 2)))} click-through on the shared queries.`,
        factor: 0.5,
        factorReason: "Halved: consolidation can take months to settle and doesn't always win the higher spot.",
      }),
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
        estimate: rows.length
          ? rollupEstimate({
              label: "Both pages' searches combined",
              impressions: t.impressions,
              clicks: t.clicks,
              position: t.position,
              perMonth,
              ctrTarget: (now) => now + 0.01,
              method: "Search Console shows no shared queries yet, so this assumes one extra percentage point of click-through across both pages once each has its own target.",
            })
          : noEstimate(NO_DATA_NOTE),
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
      estimate: rollupEstimate({
        label: `“${g.query}”`,
        impressions: t.impressions,
        clicks: t.clicks,
        position: t.position,
        perMonth,
        ctrTarget: () => expectedCtr(8),
        method: `A page written for the query could reasonably reach position 8, which typically earns ${pct(expectedCtr(8))} click-through.`,
        factor: 0.5,
        factorReason: "Halved: a new page takes time to rank and may land lower.",
      }),
      effort: "heavy",
      basis: "search-console",
    }, "informational");
  }

  return sortOpportunities(out);
}
