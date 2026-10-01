/**
 * "Fix with Claude" for the SEO console.
 *
 * Flow: the admin clicks a button on an opportunity, a cannibalization pair or
 * a page → proposeFix() records a proposal and asks Claude, in the background,
 * for a set of typed changes → every change is validated against the live
 * content (does that slug exist, does that sentence appear exactly once in the
 * post) → the admin sees a before/after per change and applies the ones they
 * want → applyFix() snapshots what it overwrites, writes through the same
 * storage calls the admin editors use, and undoFix() can put it back.
 *
 * Claude never writes anything itself. It returns a JSON document; this
 * module decides what that document is allowed to touch.
 *
 * Content that lives in source code (static page copy, /work-with/*) can't be
 * changed at runtime. Those changes become a GitHub issue addressed to
 * @claude, which the Claude Code GitHub Action (.github/workflows/claude.yml)
 * turns into a pull request. Without GITHUB_TOKEN/GITHUB_REPO the dialog
 * shows the same text as a prompt to paste into Claude Code instead.
 */
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import { storage, sqlite } from "./storage";
import { invalidateSsrCache } from "./ssr";
import { getPageContent, savePageContent } from "./page-content";
import {
  addConsoleRedirect,
  consoleRedirectFor,
  createFixProposal,
  deleteCluster,
  getStoredCluster,
  slugifyClusterId,
  upsertCluster,
  type StoredCluster,
  getFixProposal,
  getMetaOverride,
  getSeoSetting,
  listFixProposals,
  removeConsoleRedirect,
  setMetaOverride,
  updateFixProposal,
  type FixProposalRow,
  type MetaOverride,
} from "./seo-store";
import { cachedSeoReport, invalidateSeoReport } from "./seo-report-cache";
import {
  containsKeyword,
  lastReportContext,
  normalize,
  similarity,
  subjectTokens,
  type PageAnalysis,
  type SeoReport,
} from "./seo-keywords";
import type { Opportunity } from "./seo-opportunities";
import type { ClusterAudit, ClusterCandidate } from "./seo-architecture";
import { questionContext, hostOf, ENGINE_LABELS, type QuestionContext } from "./ai-visibility";

/** Claude Opus 5 unless overridden. */
const MODEL = process.env.SEO_FIX_MODEL?.trim() || "claude-opus-5";

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FixSubject =
  | { kind: "opportunity"; opportunityId: string }
  | { kind: "cannibalization"; paths: string[] }
  | { kind: "page"; path: string }
  | { kind: "cluster"; clusterId: string }
  | { kind: "candidate"; candidateId: string }
  | { kind: "topic"; clusterId: string; query: string; title: string }
  /** Win one AI Visibility question (server/ai-visibility.ts). */
  | { kind: "ai_question"; promptId: number };

const NEIGHBOURHOOD_FIELDS = [
  "tagline", "story", "realEstateCopy", "lifeCopy", "outsideCopy", "amenitiesCopy", "shopDineCopy",
] as const;
const CONDO_FIELDS = [
  "tagline", "intro", "residencesCopy", "architecturalCopy", "locationCopy", "diningCopy",
  "shoppingCopy", "communityCopy", "schoolsCopy",
] as const;

export type FixOp =
  | { type: "set_meta"; path: string; title: string | null; description: string | null; reason: string }
  | { type: "set_focus_keyword"; path: string; keyword: string; reason: string }
  | {
      type: "edit_blog"; slug: string; title: string | null; excerpt: string | null;
      heroImageAlt: string | null; bodyEdits: Array<{ find: string; replace: string }>; reason: string;
    }
  | {
      type: "edit_entity_copy"; kind: "neighbourhood" | "condo"; slug: string; field: string;
      text: string | null; paragraphs: string[]; reason: string;
    }
  | { type: "add_redirect"; from: string; to: string; reason: string }
  | { type: "unpublish_blog"; slug: string; reason: string }
  | {
      type: "create_blog_draft"; slug: string; title: string; excerpt: string; body: string;
      category: string; reason: string;
    }
  | { type: "code_change"; path: string; files: string[]; instructions: string; reason: string }
  | {
      type: "set_cluster"; clusterId: string; isNew: boolean; label: string; pillar: string;
      headKeyword: string; intent: StoredCluster["intent"]; vocabulary: string[]; members: string[];
      prefixes: string[]; reason: string;
    };

/** One row of the before/after the dialog renders. */
export interface PreviewRow {
  label: string;
  before: string;
  after: string;
}

export interface FixChange {
  index: number;
  op: FixOp;
  heading: string;
  rows: PreviewRow[];
  /** Redirects and unpublishing take a page out of the index. */
  destructive: boolean;
  /** Alternatives the owner chooses one of (e.g. three title/description
   *  angles). Scoped to one target, so "meta" on two pages are two groups. */
  variantGroup?: string;
  /** code_change only: will it open a GitHub issue, or fall back to a prompt? */
  delivery?: "github" | "prompt";
  prompt?: string;
  applied?: boolean;
  result?: { ok: boolean; message?: string; issueUrl?: string };
}

/** What applyFix overwrote, so undoFix can restore it. */
type SnapshotEntry =
  | { index: number; kind: "meta"; path: string; before: MetaOverride | null; after: MetaOverride }
  | { index: number; kind: "home_meta"; before: { title: string; description: string }; after: { title: string; description: string } }
  | { index: number; kind: "focus"; path: string; before: string | null; after: string }
  | { index: number; kind: "blog"; slug: string; before: BlogFields; after: BlogFields }
  | { index: number; kind: "entity"; entity: "neighbourhood" | "condo"; slug: string; field: string; before: string; after: string }
  | { index: number; kind: "redirect"; from: string; beforeTo: string | null; after: string }
  | { index: number; kind: "draft"; slug: string }
  | { index: number; kind: "issue"; url: string }
  | { index: number; kind: "cluster"; id: string; before: StoredCluster | null; after: StoredCluster };

interface BlogFields {
  title: string;
  excerpt: string;
  body: string;
  heroImageAlt: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Where a path's content lives
// ---------------------------------------------------------------------------

type ContentHome =
  | { type: "blog"; slug: string }
  | { type: "neighbourhood"; slug: string }
  | { type: "condo"; slug: string }
  | { type: "home" }
  | { type: "code"; files: string[] };

/** Source files that own each code-built page, for the PR instructions. */
export function codeFilesFor(path: string): string[] {
  const meta = "server/seo-inject.ts (metaForPath — server-rendered title/description/schema)";
  // Detail templates: one change here affects every page of that type.
  if (path.startsWith("/neighbourhoods/")) {
    return [
      "client/src/pages/neighbourhood-detail.tsx (page template + SeoHead strings — shared by every neighbourhood page)",
      "server/seo-inject.ts (the /neighbourhoods/:slug block of metaForPath — must match the client strings)",
    ];
  }
  if (path.startsWith("/condos/")) {
    return [
      "client/src/pages/condo-detail.tsx (page template + SeoHead strings — shared by every condo page)",
      "server/seo-inject.ts (the /condos/:slug block of metaForPath — must match the client strings)",
    ];
  }
  if (path.startsWith("/blog/")) {
    return ["client/src/pages/blog-detail.tsx (post template — shared by every blog post; post copy itself is in the database)"];
  }
  if (path.startsWith("/work-with/")) {
    return [
      "server/seo-inject.ts (WORK_WITH_META — must match the client strings)",
      "client/src/pages/work-with.tsx (page copy + SeoHead strings)",
    ];
  }
  const pages: Record<string, string> = {
    "/work-with": "client/src/pages/work-with.tsx (WorkWithIndexPage)",
    "/mls": "client/src/pages/mls-search.tsx",
    "/neighbourhoods": "client/src/pages/neighbourhoods-index.tsx",
    "/condos": "client/src/pages/condos-index.tsx",
    "/about": "client/src/pages/about.tsx",
    "/blog": "client/src/pages/blog-index.tsx",
    "/contact": "client/src/pages/contact.tsx",
    "/home-evaluation": "client/src/pages/home-evaluation.tsx",
    "/assignments": "client/src/pages/assignments.tsx",
  };
  return pages[path] ? [meta, pages[path]] : [meta];
}

export function contentHome(path: string): ContentHome {
  if (path === "/") return { type: "home" };
  const m = path.match(/^\/(blog|neighbourhoods|condos)\/([a-z0-9-]+)$/i);
  if (m) {
    const slug = m[2];
    try {
      if (m[1] === "blog" && storage.getBlogBySlug(slug)) return { type: "blog", slug };
      if (m[1] === "neighbourhoods" && storage.getNeighbourhoodBySlug(slug)) return { type: "neighbourhood", slug };
      if (m[1] === "condos" && storage.getCondoBuildingBySlug(slug)) return { type: "condo", slug };
    } catch {
      /* fall through */
    }
  }
  return { type: "code", files: codeFilesFor(path) };
}

const jsonArray = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Context for Claude
// ---------------------------------------------------------------------------

interface ResolvedSubject {
  kind: FixSubject["kind"];
  paths: string[];
  opportunity: Opportunity | null;
  label: string;
  cluster?: ClusterAudit;
  candidate?: ClusterCandidate;
  topic?: { query: string; title: string };
  aiQuestion?: QuestionContext;
}

function resolveSubject(subject: FixSubject, report: SeoReport): ResolvedSubject {
  if (subject.kind === "ai_question") {
    const ctx = questionContext(subject.promptId);
    if (!ctx) throw new Error("That question is no longer tracked.");
    if (!ctx.results.length) throw new Error("Run a visibility check first — there are no answers for this question yet.");
    return {
      kind: "ai_question",
      paths: pagesForQuestion(ctx, report),
      opportunity: null,
      label: `Win in AI answers: “${ctx.question}”`,
      aiQuestion: ctx,
    };
  }
  if (subject.kind === "opportunity") {
    const opp = report.opportunities.find((o) => o.id === subject.opportunityId);
    if (!opp) throw new Error("That opportunity is no longer in the report — rescan and try again.");
    // Architecture findings are cluster-shaped: plan them with the whole
    // cluster (or candidate group) in view, focused on this finding.
    if (opp.type === "architecture" && opp.candidateId) {
      const cand = report.architecture?.candidates.find((c) => c.id === opp.candidateId);
      if (cand) return { kind: "candidate", paths: cand.pages, opportunity: opp, label: opp.headline, candidate: cand };
    }
    if (opp.type === "architecture" && opp.clusterId && opp.subtype !== "deep_page") {
      const cl = report.architecture?.clusters.find((c) => c.id === opp.clusterId);
      if (cl) return { kind: "cluster", paths: [cl.pillar], opportunity: opp, label: opp.headline, cluster: cl };
    }
    return { kind: "opportunity", paths: opp.paths, opportunity: opp, label: opp.headline };
  }
  if (subject.kind === "cluster" || subject.kind === "topic") {
    const cl = report.architecture?.clusters.find((c) => c.id === subject.clusterId);
    if (!cl) throw new Error("That cluster isn't in the latest report — rescan and try again.");
    if (subject.kind === "topic") {
      return {
        kind: "topic", paths: [cl.pillar], opportunity: null, cluster: cl,
        topic: { query: subject.query, title: subject.title },
        label: `Draft: ${subject.title}`,
      };
    }
    return { kind: "cluster", paths: [cl.pillar], opportunity: null, cluster: cl, label: `Plan the ${cl.label} cluster` };
  }
  if (subject.kind === "candidate") {
    const cand = report.architecture?.candidates.find((c) => c.id === subject.candidateId);
    if (!cand) throw new Error("That suggested cluster isn't in the latest report — rescan and try again.");
    return { kind: "candidate", paths: cand.pages, opportunity: null, candidate: cand, label: `Plan a new cluster: ${cand.label}` };
  }
  if (subject.kind === "cannibalization") {
    const paths = subject.paths.filter((p) => report.pages.some((x) => x.path === p));
    if (paths.length < 2) throw new Error("Both pages of the pair must be in the latest report.");
    const opp = report.opportunities.find(
      (o) => o.type === "cannibalization" &&
        o.paths.length === 2 &&
        [...o.paths].sort().join("::") === [...paths].sort().join("::"),
    ) ?? null;
    return {
      kind: "cannibalization",
      paths: paths.slice(0, 2),
      opportunity: opp,
      label: `Cannibalization: ${paths[0]} vs ${paths[1]}`,
    };
  }
  const page = report.pages.find((p) => p.path === subject.path);
  if (!page) throw new Error(`${subject.path} is not in the latest report.`);
  return { kind: "page", paths: [page.path], opportunity: null, label: `Improve ${page.path}` };
}

function describePage(page: PageAnalysis): string {
  const ctx = lastReportContext();
  const rows = (ctx?.gscByPath.get(page.path) ?? [])
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25);
  const home = contentHome(page.path);
  const lines: string[] = [];
  lines.push(`### Page ${page.path}`);
  lines.push(`Cluster: ${page.clusterLabel}${page.isPillar ? " (PILLAR — owns the cluster head term)" : ""} · intent: ${page.intent}`);
  lines.push(`Where its content lives: ${
    home.type === "code"
      ? `source code (${home.files.join("; ")}). Body copy can only change through a code_change; title/description can change through set_meta.`
      : home.type === "home"
        ? "the homepage CMS. set_meta edits its title/description."
        : home.type === "blog"
          ? `the database (blog post "${home.slug}") — title, excerpt and body are directly editable. The page layout is ${codeFilesFor(page.path).join("; ")}.`
          : `the database (${home.type} "${home.slug}") for its copy — directly editable. Its title, description and H1 are generated by a template shared by every ${home.type} page (${codeFilesFor(page.path).join("; ")}); set_meta overrides them for this one page, and a code_change to the template affects all of them.`
  }`);
  lines.push(`Title (${page.title.length} chars): ${page.title}`);
  lines.push(`Meta description (${page.description.length} chars): ${page.description}`);
  lines.push(`H1: ${page.h1}`);
  lines.push(`Focus keyword: ${page.focusKeyword || "(none)"}${page.focusSource === "override" ? " (set by hand)" : " (derived from title)"}`);
  lines.push(`Score ${page.score}/100. Missing: ${page.components.filter((c) => c.earned < c.max).map((c) => `${c.label} — ${c.detail}`).join("; ") || "nothing"}`);
  if (page.issues.length) lines.push(`Issues: ${page.issues.join("; ")}`);
  lines.push(`Editorial links in (${page.inboundLinks.length}): ${page.inboundLinks.join(", ") || "none"}`);
  if (page.recommendedInboundFrom.length) {
    lines.push(`Pages that mention its keyword but don't link: ${page.recommendedInboundFrom.map((r) => r.path).join(", ")}`);
  }
  if (page.conflicts.length) {
    lines.push(`Title-level conflicts: ${page.conflicts.map((c) => `${c.path} ("${c.keyword}")`).join(", ")}`);
  }
  if (page.ga4) {
    const g = page.ga4;
    lines.push(`GA4 (90d): ${g.pageviews} views, ${g.sessions} sessions, ${(g.engagementRate * 100).toFixed(0)}% engaged, ${g.keyEvents} key events, ${g.organicLandings} organic landings`);
  }
  if (rows.length) {
    lines.push(`Search Console queries (90d, top ${rows.length} by impressions):`);
    for (const r of rows) {
      const ctr = r.impressions ? ((r.clicks / r.impressions) * 100).toFixed(1) : "0";
      lines.push(`  - "${r.query}" — ${r.impressions} impr, ${r.clicks} clicks, ${ctr}% CTR, pos ${r.position.toFixed(1)}`);
    }
  } else {
    lines.push("Search Console: no query data for this page.");
  }

  // Current editable content, verbatim — edits must quote it exactly.
  try {
    if (home.type === "blog") {
      const post = storage.getBlogBySlug(home.slug)!;
      lines.push(`Blog post fields — title: ${post.title}\nexcerpt (used as meta description): ${post.excerpt}\nheroImageAlt: ${post.heroImageAlt ?? "(none)"}\nstatus: ${post.status}`);
      lines.push(`Body (lightweight markdown: blank-line paragraphs, "## " / "### " headings, "- " bullets, [text](/path) links, **bold**):\n<<<BODY\n${post.body}\nBODY>>>`);
    } else if (home.type === "neighbourhood" || home.type === "condo") {
      const row: any = home.type === "neighbourhood"
        ? storage.getNeighbourhoodBySlug(home.slug)
        : storage.getCondoBuildingBySlug(home.slug);
      const fields = home.type === "neighbourhood" ? NEIGHBOURHOOD_FIELDS : CONDO_FIELDS;
      // Hard facts for specific, clickable copy — the only numbers Claude may cite.
      const money = (n: unknown) => (typeof n === "number" && n > 0 ? `$${Math.round(n).toLocaleString("en-CA")}` : null);
      const facts = home.type === "neighbourhood"
        ? [
            row?.activeCount != null && `${row.activeCount} active MLS listings right now`,
            money(row?.avgPrice) && `average active list price ${money(row?.avgPrice)}`,
            row?.zone && `area: ${row.zone}`,
            row?.quadrant && `quadrant: ${row.quadrant}`,
          ]
        : [
            row?.units && `${row.units} units`,
            row?.stories && `${row.stories} storeys`,
            row?.builtIn && `built ${row.builtIn}`,
            row?.developer && `developer ${row.developer}`,
            row?.neighbourhood && `in ${row.neighbourhood}`,
            row?.address && `address ${row.address}`,
          ];
      const factLine = facts.filter(Boolean).join("; ");
      if (factLine) lines.push(`Facts you may cite: ${factLine}.`);
      lines.push(`Editable ${home.type} fields (plain text; array fields are lists of paragraphs, no markdown or links):`);
      for (const f of fields) {
        const v = f === "tagline" ? String(row?.[f] ?? "") : JSON.stringify(jsonArray(row?.[f]));
        lines.push(`  ${f}: ${v}`);
      }
    } else if (home.type === "home") {
      const seo = getPageContent("home").seo;
      lines.push(`Homepage CMS SEO — title: ${seo.title}\ndescription: ${seo.description}`);
    }
  } catch (e: any) {
    lines.push(`(Could not read current content: ${e?.message ?? e})`);
  }
  return lines.join("\n");
}

function describeCluster(cl: ClusterAudit, report: SeoReport, opts: { brief?: boolean } = {}): string {
  const ctx = lastReportContext();
  const lines: string[] = [];
  lines.push(`### Cluster "${cl.label}" (id ${cl.id})`);
  lines.push(`Pillar: ${cl.pillar}${cl.pillarStatus !== 200 ? ` (HTTP ${cl.pillarStatus ?? "not crawled"} — BROKEN)` : ""} · head term: "${cl.headKeyword}" · intent: ${cl.intent} · health ${cl.health}/100`);
  if (cl.flags.length) lines.push(`Flags: ${cl.flags.join(", ")}`);
  lines.push(`Pillar links down to ${cl.linkedFromPillar}/${cl.children.length} children; ${cl.linkingUp}/${cl.children.length} children link back up (body-copy links only — nav doesn't count).`);
  if (cl.headTerm) {
    lines.push(`Head-term demand: ${cl.headTerm.queries} matching queries. Most goes to ${cl.headTerm.owner} (${cl.headTerm.ownerImpressions} impr, pos ${cl.headTerm.ownerPosition ?? "?"}); pillar gets ${cl.headTerm.pillarImpressions} impr${cl.headTerm.pillarPosition ? ` at pos ${cl.headTerm.pillarPosition}` : ""}.`);
  }
  if (cl.gaps.length) {
    lines.push(`Uncovered searches in this cluster's territory (no page targets them):\n${cl.gaps.map((g) => `  - "${g.query}" — ${g.impressions} impr, best pos ${g.position} on ${g.bestPage}`).join("\n")}`);
  }
  if (opts.brief) return lines.join("\n");
  lines.push("Children (path | title | focus keyword | top queries | links):");
  for (const path of cl.children.slice(0, 60)) {
    const p = report.pages.find((x) => x.path === path);
    if (!p) continue;
    const q = (ctx?.gscByPath.get(path) ?? []).slice().sort((a, b) => b.impressions - a.impressions).slice(0, 3)
      .map((r) => `"${r.query}" ${r.impressions}i p${r.position.toFixed(0)}`).join(", ");
    const down = cl.missingDownLinks.includes(path) ? "no link from pillar" : "linked from pillar";
    const up = cl.missingUpLinks.includes(path) ? "NO up-link" : "links up";
    lines.push(`  - ${path} | ${p.title.slice(0, 70)} | ${p.focusKeyword} | ${q || "no search data"} | ${down}, ${up}`);
  }
  if (cl.children.length > 60) lines.push(`  …and ${cl.children.length - 60} more`);
  return lines.join("\n");
}

function describeCandidate(cand: ClusterCandidate, report: SeoReport): string {
  return [
    `### Suggested new cluster "${cand.label}" (id ${cand.id})`,
    cand.why,
    `Posts in the group: ${cand.pages.join(", ")}`,
    `Suggested pillar: ${cand.suggestedPillar ?? "none yet — may need a new pillar page"} · suggested head term: "${cand.headKeyword}"`,
    `Existing cluster ids (do not reuse for a new cluster): ${report.clusters.map((c) => c.id).join(", ")}`,
  ].join("\n");
}

/**
 * Pages best placed to win an AI question: our own pages the assistants
 * already cite for it, then the pages whose focus keyword or title is
 * closest to the question. Capped — the fix is reviewed by a person.
 */
function pagesForQuestion(ctx: QuestionContext, report: SeoReport): string[] {
  const live = report.pages.filter((p) => p.status === 200);
  const livePaths = new Set(live.map((p) => p.path));
  const out: string[] = [];
  for (const r of ctx.results) {
    for (const c of r.citations) {
      const host = hostOf(c.url);
      if (!host.endsWith("riversrealestate.ca") && !host.endsWith("luxuryhomescalgary.ca")) continue;
      let path = "/";
      try {
        path = new URL(c.url).pathname.replace(/\/+$/, "") || "/";
      } catch {
        continue;
      }
      if (livePaths.has(path) && !out.includes(path)) out.push(path);
    }
  }
  const ranked = live
    .map((p) => ({
      path: p.path,
      s: Math.max(similarity(ctx.question, p.focusKeyword), similarity(ctx.question, p.title) * 0.9),
    }))
    .filter((x) => x.s >= 0.2 && !out.includes(x.path))
    .sort((a, b) => b.s - a.s);
  for (const x of ranked) {
    if (out.length >= 3) break;
    out.push(x.path);
  }
  return out.slice(0, 4);
}

function describeAiQuestion(ctx: QuestionContext): string {
  const lines = [
    `# AI assistant visibility for: "${ctx.question}"`,
    `Checked ${ctx.checkedAt ? ctx.checkedAt.slice(0, 10) : "recently"} by asking each assistant the question with web search on.`,
  ];
  for (const r of ctx.results) {
    const label = ENGINE_LABELS[r.engine] ?? r.engine;
    if (r.error) {
      lines.push(`\n## ${label}: the check failed (${r.error.slice(0, 120)})`);
      continue;
    }
    if (!r.shown) {
      lines.push(`\n## ${label}: Google showed no AI answer for this search`);
      continue;
    }
    const status = r.mentioned
      ? `names Spencer${r.position ? ` at #${r.position} of the agents it recommends` : ""}${r.cited ? " and cites our site" : ""}`
      : "does NOT name Spencer";
    lines.push(`\n## ${label} ${status}`);
    if (r.competitors.length) lines.push(`Named instead: ${r.competitors.slice(0, 10).join(", ")}`);
    if (r.citations.length) {
      lines.push(`Sources it relied on:\n${r.citations.slice(0, 10).map((c) => `  - ${hostOf(c.url)} — ${c.title ?? c.url}`).join("\n")}`);
    }
    lines.push(`Answer (excerpt):\n${r.answer.slice(0, 1800)}`);
  }
  lines.push(`
# How to win this question
Goal: make Spencer Rivers a name ChatGPT, Perplexity and Google's AI answers give when asked this question. All of them search the web, then quote pages that answer the question directly and credibly, and repeat names that many sources agree on. In priority order:
1. Strengthen the page best placed to answer it (the pages detailed below): open the relevant section with a direct 2–3 sentence answer that mirrors the question's wording, add specific facts from the supplied content, and name Spencer consistently as "Spencer Rivers, REALTOR®, CLHMS" with Rivers Real Estate and Calgary, so the entity is unambiguous.
2. Add a question-and-answer block. On blog posts, use edit_blog to add or extend a "## Frequently Asked Questions" section with "### <the question>" followed by a 2–4 sentence answer. The site turns that section into FAQPage schema automatically, which is the structured data AI engines read. On pages whose copy lives in code (e.g. /work-with/*, which already has FAQ arrays that emit FAQPage schema), use code_change to add the Q&A to that page's FAQ list.
3. Add internal links to the page that answers it from related posts (edit_blog), with anchor text close to the question.
4. If no existing page genuinely answers this question, create one draft (create_blog_draft) that answers it in the first paragraph, has a FAQ section as above, and links to the relevant neighbourhood/condo pages.
5. Adjust titles/descriptions only if they obscure that the page answers this question.
Off-site work can't be done from here but matters most when the assistants cite third-party sites (directories, review sites, brokerage profiles, news). Name those specific sources from the lists above in the rationale as next steps for the owner (e.g. get a profile or review there). Put further pages worth writing in plannedTopics.`);
  return lines.join("\n");
}

function buildPrompt(resolved: ResolvedSubject, report: SeoReport): string {
  const parts: string[] = [];
  parts.push(`# Task\n${resolved.label}`);
  if (resolved.opportunity) {
    const o = resolved.opportunity;
    parts.push(`Opportunity type: ${o.type}\nWhy it was flagged: ${o.why}\nSuggested direction: ${o.action}\nEstimated upside: ~${o.estClicksGain} extra organic clicks/month.`);
    if (o.queries.length) {
      parts.push(`Queries behind it:\n${o.queries.map((q) => `  - "${q.query}"${q.path ? ` on ${q.path}` : ""} — ${q.impressions} impr, ${q.clicks} clicks, pos ${q.position}`).join("\n")}`);
    }
  }
  if (resolved.kind === "cannibalization") {
    parts.push(`Resolve the cannibalization between these two pages. Decide between:
- DIFFERENTIATE: give each page a distinct target (usually the narrower page takes a more specific query it already earns impressions for), update titles/descriptions/H1-bearing copy and focus keywords, and link the narrower page to the broader one.
- CONSOLIDATE: when one page is clearly weaker and not meaningfully distinct, fold its useful content into the stronger page (blog body edits) and add_redirect from the weaker to the stronger (plus unpublish_blog if the weaker is a blog post).
Prefer differentiating when both pages earn meaningful impressions for different queries; prefer consolidating when the weaker one earns almost nothing. Never redirect a pillar page.`);
  }
  if (resolved.kind === "cluster") {
    parts.push(`Plan this topic cluster as a hub. Within one review-sized set of changes:
- Fix the structure first: pillar ↔ child links (blog bodies via edit_blog; a code-owned pillar via one code_change listing every child it should introduce), and head-term ownership (align titles/focus keywords so only the pillar targets "${resolved.cluster?.headKeyword}"; if a child clearly deserves to be the pillar, say so and use set_cluster to promote it).
- Give children that compete with each other distinct targets.
- Put the sub-topics the cluster is missing into plannedTopics (best first, up to 8), each with the query it should target. Draft at most 2 of them now with create_blog_draft, only the strongest.
- Use set_cluster only to change the cluster definition (pillar, head term, vocabulary, explicit members).`);
  }
  if (resolved.kind === "candidate") {
    parts.push(`These posts share a topic no cluster owns. Decide whether it deserves its own cluster. If yes: one set_cluster change creating it (clusterId "", a short label, pillar = the best existing page or the suggested one, head term, vocabulary words, members = the posts), edit_blog changes that link each post up to the pillar, differentiated targets for posts that overlap, and plannedTopics for missing angles. If a whole new pillar page is needed, draft it with create_blog_draft and set it as pillar using its future path /blog/<slug>. If it does not deserve a cluster, return no changes and explain why.`);
  }
  if (resolved.opportunity?.type === "content_gap") {
    parts.push(`No page targets this query yet. Propose one create_blog_draft that would genuinely answer it for a Calgary buyer or seller, plus edit_blog link insertions on 1–2 existing related posts pointing to the new slug (only if a natural sentence exists to link from).`);
  }

  if (resolved.kind === "ai_question" && resolved.aiQuestion) parts.push(describeAiQuestion(resolved.aiQuestion));

  if (resolved.cluster && resolved.kind !== "topic") parts.push(describeCluster(resolved.cluster, report));
  if (resolved.candidate) parts.push(describeCandidate(resolved.candidate, report));
  if (resolved.kind === "topic" && resolved.cluster && resolved.topic) {
    parts.push(`Write the planned post "${resolved.topic.title}" targeting "${resolved.topic.query}" for the ${resolved.cluster.label} cluster (pillar ${resolved.cluster.pillar}, head term "${resolved.cluster.headKeyword}"). Return one create_blog_draft that links up to the pillar with head-term anchor text and to 1–3 sibling pages, plus edit_blog link insertions on up to 2 related posts pointing to the new slug where a natural sentence exists. Add the draft's future path to the cluster with a set_cluster change (members) only if it would not be picked up by the cluster's URL prefixes or vocabulary.`);
    parts.push(describeCluster(resolved.cluster, report, { brief: true }));
  }

  // Page detail. Cluster plans already carry per-child detail, so only the
  // pillar gets the full treatment there; candidate plans carry their posts.
  const detailed = resolved.kind === "candidate"
    ? resolved.paths.slice(0, 6)
    : resolved.paths;
  for (const path of detailed) {
    const page = report.pages.find((p) => p.path === path);
    if (page) parts.push(describePage(page));
  }
  if (resolved.kind === "cluster" && resolved.cluster) {
    // Blog children that need an up-link get their full body so edits can
    // quote it exactly. Capped: a plan is reviewed by a person.
    const needUp = resolved.cluster.missingUpLinks.filter((p) => p.startsWith("/blog/")).slice(0, 5);
    for (const path of needUp) {
      const page = report.pages.find((p) => p.path === path);
      if (page) parts.push(describePage(page));
    }
  }

  const cluster = report.clusters
    .map((c) => `- ${c.label}: pillar ${c.pillar} owns "${c.headKeyword}"`)
    .join("\n");
  parts.push(`# Site structure\nClusters (child pages must not target their pillar's head term):\n${cluster}`);
  const pending = countConsoleDrafts();
  parts.push(pending >= MAX_PENDING_CONSOLE_DRAFTS
    ? `# Drafts\nThe owner already has ${pending} unpublished console drafts (the limit is ${MAX_PENDING_CONSOLE_DRAFTS}). Do not create any new post; put ideas in plannedTopics.`
    : `# Drafts\n${pending} of ${MAX_PENDING_CONSOLE_DRAFTS} console drafts are waiting to be published. ${resolved.kind === "topic" || resolved.kind === "cluster" || resolved.kind === "candidate" || resolved.kind === "ai_question" || resolved.opportunity?.type === "content_gap" ? "A new post is allowed only if it passes the content policy." : "This is a single-page fix: do not create posts."}`);
  const list = report.pages
    .filter((p) => p.status === 200)
    .map((p) => `${p.path} | ${p.title.slice(0, 80)} | kw: ${p.focusKeyword}`)
    .join("\n");
  parts.push(`All live pages (valid internal link / redirect targets):\n${list}`);
  return parts.join("\n\n");
}

const SYSTEM_PROMPT = `You are the SEO editor for riversrealestate.ca — Rivers Real Estate, the Calgary luxury real estate practice of Spencer Rivers (REALTOR®, CLHMS, Certified Condo Specialist, Synterra Realty). The audience is Calgary buyers and sellers, mostly at the $1M+ end, plus condo buyers and downsizers.

You receive one SEO problem with the page data, Search Console queries and current content. Return the smallest set of concrete changes that fixes it, as JSON matching the schema. The site owner reviews every change before it goes live, one by one, so each change must stand on its own and its "reason" must say, in a sentence, what it does and why.

Writing rules:
- Canadian spelling (neighbourhood, centre). Confident, specific, no hype, no exclamation marks. Never invent facts, statistics, prices, dates or awards: use only the supplied content, the "Facts you may cite" line, and the proof points below.
- Prefer queries the page already earns impressions for over invented keywords.
- Internal links go in blog bodies as [anchor text](/path) using descriptive anchors, only to paths from the live page list.

Titles and meta descriptions are ads in the search results. Their only job is to earn the click over nine other results that all say "homes for sale". A keyword with a list of features attached earns nothing.
- Title: at most 60 characters. The query near the front in natural word order, then a hook: a real number (active listings, a price point), a specific that competitors can't claim, or an access angle. Keep the page's existing brand suffix exactly as it is; do not add one where there is none.
- Brand: "Luxury Homes Calgary" in neighbourhood, condo and listing titles is deliberate (that format carries rankings from the old site). Never replace it with "Rivers Real Estate" or remove it.
- Description: 140–155 characters. Open with what the searcher gets, include one concrete detail or number, and end with a soft call to action ("See today's listings.", "Book a private showing.", "Get the building's sales history.").
- Banned: comma-lists of amenities ("schools, parks and lifestyle"), and the words nestled, boasts, wonderland, luxurious living, look no further, dream home.
- Proof points you may use (all stated on the site already): Spencer Rivers is a CLHMS and Certified Condo Specialist; 12 years in Calgary's luxury market, top 1% in Canada, $100M+ in career sales; listings on this site can appear up to 48 hours before Realtor.ca.
- Whenever you change a title or description, give THREE alternatives with genuinely different angles (for example market data, insider access, lifestyle). They share one variantGroup (e.g. "meta"), and each reason starts with its angle name in capitals, e.g. "MARKET DATA — …". The owner picks one. Use variantGroup "" for every other change.

Content policy — the site must not sprawl into dozens of thin, overlapping posts:
- Never write a new post to fix a single page. Strengthen that page, and fix "few links in" by adding links from existing related posts (edit_blog).
- A new post must answer a distinct question that no existing page covers. Never write "<Place> real estate/homes guide" when /neighbourhoods/<place> or /condos/<building> exists: that page IS the guide.
- If you think more posts are warranted, list them in plannedTopics rather than drafting them.

Change types and the fields each uses (set every unused field to "" — an empty string — or [] for arrays):
- set_meta: path, title and/or description (plus variantGroup for alternatives). Works on any page. For blog posts prefer edit_blog (title/excerpt, also with variantGroup) instead, since those ARE the post's title and description.
- set_focus_keyword: path, keyword — the query the page should own from now on.
- edit_blog: slug, optional title / excerpt / heroImageAlt, and bodyEdits: [{find, replace}]. Each "find" must be copied EXACTLY from the supplied body and appear exactly once — use a whole sentence or paragraph. To add a new section, find the last sentence of the paragraph it should follow and replace it with that sentence + "\\n\\n## Heading\\n\\nNew paragraph". Keep edits surgical; do not rewrite whole posts.
- edit_entity_copy: kind ("neighbourhood" | "condo"), slug, field, and either text (for "tagline") or paragraphs (the COMPLETE new list for that array field). Plain text only.
- add_redirect: from, to — 301 a weaker page into a stronger one. Only for consolidation.
- unpublish_blog: slug — only alongside an add_redirect from that post.
- create_blog_draft: slug (lowercase-hyphenated, new), title, excerpt, body (lightweight markdown, 700–1200 words, answers the query directly in the first paragraph, ## sections, 2–4 internal links), category (one of Market, Buying, Selling, Neighbourhoods, Condos, Lifestyle).
- set_cluster: clusterId (an existing id to change it, or "" to create one), label, pillar (a live path, or /blog/<slug> of a draft created in this same answer), headKeyword, intent (transactional | commercial | informational | navigational), vocabulary (lowercase words that classify posts into it), members (explicit page paths). Only for changing the cluster map.
- code_change: path, files, instructions — for page copy that lives in source code. Write instructions a developer (Claude Code) can execute without further context: exact current strings to find, exact replacements, and which strings must stay in sync between server and client. Only name files listed under "Where its content lives"; never guess or invent paths. Say plainly when a change to a shared template affects every page of that type.

Site architecture (hub and spoke):
- Each cluster has one pillar that covers the topic broadly, owns the head term, and links to every child from its body copy.
- Each child goes deep on one sub-topic, targets its own narrower query, and links back up to the pillar with head-term anchor text. No two pages target the same query.
- Link across clusters only where it genuinely helps the reader. Keep important pages within 3 clicks of the homepage.
- plannedTopics lists pages worth writing next (title, targetQuery, why); they are a roadmap for the owner, not applied. Use [] when there's nothing to plan.

If the right answer is to change nothing, return an empty changes list and explain why in the rationale.`;

/** Flat JSON schema — every field present, unused ones "" or [] — which is
 *  what structured outputs handles most reliably. Fields are plain strings,
 *  not string|null: the API caps a schema at 16 union-typed parameters, and
 *  the validator already treats "" as absent (see str()). */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "rationale", "changes", "plannedTopics"],
  properties: {
    summary: { type: "string", description: "One line: what this fix does." },
    plannedTopics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "targetQuery", "why"],
        properties: { title: { type: "string" }, targetQuery: { type: "string" }, why: { type: "string" } },
      },
    },
    rationale: { type: "string", description: "2–5 sentences: the diagnosis and why these changes fix it." },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type", "reason", "path", "slug", "kind", "field", "title", "description", "excerpt",
          "heroImageAlt", "keyword", "text", "paragraphs", "bodyEdits", "from", "to", "body",
          "category", "files", "instructions", "clusterId", "label", "pillar", "headKeyword",
          "intent", "vocabulary", "members", "variantGroup",
        ],
        properties: {
          type: {
            type: "string",
            enum: [
              "set_meta", "set_focus_keyword", "edit_blog", "edit_entity_copy", "add_redirect",
              "unpublish_blog", "create_blog_draft", "code_change", "set_cluster",
            ],
          },
          reason: { type: "string" },
          path: { type: "string" },
          slug: { type: "string" },
          kind: { type: "string", description: "neighbourhood | condo (edit_entity_copy only)" },
          field: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          excerpt: { type: "string" },
          heroImageAlt: { type: "string" },
          keyword: { type: "string" },
          text: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" } },
          bodyEdits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["find", "replace"],
              properties: { find: { type: "string" }, replace: { type: "string" } },
            },
          },
          from: { type: "string" },
          to: { type: "string" },
          body: { type: "string" },
          category: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          instructions: { type: "string" },
          clusterId: { type: "string" },
          label: { type: "string" },
          pillar: { type: "string" },
          headKeyword: { type: "string" },
          intent: { type: "string" },
          vocabulary: { type: "array", items: { type: "string" } },
          members: { type: "array", items: { type: "string" } },
          variantGroup: { type: "string", description: "Same non-empty value on alternatives the owner chooses between; \"\" otherwise." },
        },
      },
    },
  },
} as const;

interface RawOutput {
  summary: string;
  rationale: string;
  changes: Array<Record<string, any>>;
  plannedTopics?: Array<{ title: string; targetQuery: string; why: string }>;
}

async function askClaude(system: string, prompt: string): Promise<{ output: RawOutput; model: string }> {
  if (process.env.SEO_FIX_FAKE === "1") {
    // Local testing: SEO_FIX_FAKE_DUMP=<file> records what Claude would have been sent.
    if (process.env.SEO_FIX_FAKE_DUMP) fs.writeFileSync(process.env.SEO_FIX_FAKE_DUMP, `${system}\n\n=====\n\n${prompt}`);
    return { output: fakeOutput(prompt), model: "fake" };
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set on this server. Add it with `fly secrets set ANTHROPIC_API_KEY=…` to enable Fix with Claude.",
    );
  }
  const client = new Anthropic();
  const useFallback = FALLBACK_MODELS.has(MODEL);
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: OUTPUT_SCHEMA as any } },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    throw new Error("Claude declined this request. Try again, or make the change by hand.");
  }
  if (msg.stop_reason === "max_tokens") {
    throw new Error("Claude's answer was cut off before it finished. Try again.");
  }
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let output: RawOutput;
  try {
    output = JSON.parse(text);
  } catch {
    throw new Error("Claude returned something that wasn't valid JSON. Try again.");
  }
  if (!output || !Array.isArray(output.changes)) throw new Error("Claude's answer was missing its list of changes.");
  return { output, model: msg.model || MODEL };
}

/** Deterministic stand-in for local testing without an API key (SEO_FIX_FAKE=1). */
function fakeOutput(prompt: string): RawOutput {
  const path = prompt.match(/### Page (\S+)/)?.[1] ?? "/";
  const body = prompt.match(/<<<BODY\n([\s\S]*?)\nBODY>>>/)?.[1];
  const firstPara = body?.split(/\n\s*\n/).find((p) => p.trim() && !p.startsWith("#"))?.trim();
  const blank = {
    path: null, slug: null, kind: null, field: null, title: null, description: null, excerpt: null,
    heroImageAlt: null, keyword: null, text: null, paragraphs: [], bodyEdits: [], from: null, to: null,
    body: null, category: null, files: [], instructions: null, clusterId: null, label: null,
    pillar: null, headKeyword: null, intent: null, vocabulary: [], members: [], variantGroup: "",
  };
  const fakeTopics = [
    { title: "Test planned topic one", targetQuery: "test planned query one", why: "Fake roadmap entry." },
    { title: "Test planned topic two", targetQuery: "test planned query two", why: "Fake roadmap entry." },
  ];
  // Cluster-shaped subjects get cluster-shaped fake answers.
  const clusterM = prompt.match(/### Cluster "([^"]+)" \(id ([^)]+)\)\nPillar: (\S+) · head term: "([^"]+)"/);
  const candM = prompt.match(/### Suggested new cluster "([^"]+)" \(id ([^)]+)\)/);
  const topicM = prompt.match(/Write the planned post "([^"]+)" targeting "([^"]+)"/);
  if (topicM) {
    const slug = `fake-${topicM[2].replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 60);
    return {
      summary: "Fake draft for testing", rationale: "SEO_FIX_FAKE=1.", plannedTopics: [],
      changes: [{ ...blank, type: "create_blog_draft", slug, title: topicM[1], excerpt: "A fake excerpt long enough to pass validation for the planned post in this test run.", body: "## Fake\n\nFake body.", category: "Market", reason: "Fake: exercise create_blog_draft." }],
    };
  }
  if (candM) {
    const posts = (prompt.match(/Posts in the group: (.+)/)?.[1] ?? "").split(", ").filter(Boolean);
    return {
      summary: "Fake new cluster for testing", rationale: "SEO_FIX_FAKE=1.", plannedTopics: fakeTopics,
      changes: [{ ...blank, type: "set_cluster", clusterId: null, label: candM[1], pillar: posts[0] ?? "/blog",
        headKeyword: `${candM[1].toLowerCase()} calgary`, intent: "informational", vocabulary: [candM[1].toLowerCase()],
        members: posts, reason: "Fake: exercise set_cluster (create)." }],
    };
  }
  if (clusterM) {
    return {
      summary: "Fake cluster plan for testing", rationale: "SEO_FIX_FAKE=1.", plannedTopics: fakeTopics,
      changes: [{ ...blank, type: "set_cluster", clusterId: clusterM[2], label: `${clusterM[1]} (edited)`, pillar: clusterM[3],
        headKeyword: clusterM[4], intent: "commercial", vocabulary: ["fake-term"], members: [],
        reason: "Fake: exercise set_cluster (edit)." }],
    };
  }
  const changes: Array<Record<string, any>> = [
    ...["MARKET DATA", "INSIDER ACCESS", "LIFESTYLE"].map((angle, i) => ({
      ...blank, type: "set_meta", path, variantGroup: "meta",
      title: `Test Title Option ${i + 1} for the Fix Flow | Rivers Real Estate`,
      description: `Fake ${angle.toLowerCase()} description ${i + 1}: long enough to pass validation so the choose-one preview can be tested end to end.`,
      reason: `${angle} — fake variant ${i + 1}.`,
    })),
    { ...blank, type: "set_focus_keyword", path, keyword: "test focus keyword", reason: "Fake: exercise set_focus_keyword." },
  ];
  const slug = path.match(/^\/blog\/(.+)$/)?.[1];
  if (slug && firstPara) {
    changes.push({ ...blank, type: "edit_blog", slug, bodyEdits: [{ find: firstPara, replace: `${firstPara} See our [Calgary neighbourhood guides](/neighbourhoods).` }], reason: "Fake: exercise edit_blog." });
  }
  changes.push({ ...blank, type: "code_change", path, files: ["server/seo-inject.ts"], instructions: "Fake: no-op instructions.", reason: "Fake: exercise code_change." });
  return { summary: "Fake fix for testing", rationale: "SEO_FIX_FAKE=1 is set, so this proposal was generated without calling Claude.", changes, plannedTopics: [] };
}

// ---------------------------------------------------------------------------
// Validation: raw Claude output → typed, checked changes with previews
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const normPath = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    n++;
    at = hay.indexOf(needle, at + needle.length);
  }
  return n;
}

function snippet(s: string, max = 600): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function githubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

/** Unpublished drafts the console can create before it stops (Spencer's call:
 *  keep the pipeline small enough to actually review and publish). */
export const MAX_PENDING_CONSOLE_DRAFTS = 5;

/** Drafts created by applied fixes that are still unpublished. */
export function countConsoleDrafts(): number {
  const slugs = new Set<string>();
  for (const p of listFixProposals(500)) {
    for (const s of p.snapshot as SnapshotEntry[]) if (s.kind === "draft") slugs.add(s.slug);
  }
  let n = 0;
  for (const slug of Array.from(slugs)) if (storage.getBlogBySlug(slug)?.status === "draft") n++;
  return n;
}

/** Words that don't make a post about a place a different topic from the
 *  place's own page ("<Place> buyer's guide" is still the place page). */
const NOT_A_SUBTOPIC = new Set([
  "buyer", "buyers", "seller", "sellers", "guide", "living", "live", "life", "overview", "community",
  "neighbourhood", "neighborhood", "area", "moving", "insider", "complete", "everything", "know",
  "need", "why", "what", "how", "about", "inside", "look", "profile", "spotlight", "tour",
]);

/**
 * Why a proposed post would compete with a page that already exists, or null
 * if it's genuinely a new topic. Catches both "same focus keyword" and the
 * softer "<Neighbourhood> real estate guide" when /neighbourhoods/<x> exists.
 */
export function draftCompetesWith(title: string, slug: string, report: SeoReport): string | null {
  const text = normalize(`${title} ${slug.replace(/-/g, " ")}`);
  for (const p of report.pages) {
    if (p.status !== 200) continue;
    if (p.focusKeyword && similarity(title, p.focusKeyword) >= 0.85) {
      return `it targets the same thing as ${p.path} (“${p.focusKeyword}”)`;
    }
    const m = p.path.match(/^\/(neighbourhoods|condos)\/([a-z0-9-]+)$/);
    if (!m) continue;
    const entity = m[2].replace(/-/g, " ");
    if (!containsKeyword(text, entity)) continue;
    const entityTokens = new Set(normalize(entity).split(" "));
    const rest = subjectTokens(text).filter((t) => t.length > 1 && !entityTokens.has(t) && !NOT_A_SUBTOPIC.has(t));
    if (!rest.length) {
      return `${p.path} already is the page about ${entity.replace(/\b\w/g, (c) => c.toUpperCase())} — strengthen it instead`;
    }
  }
  return null;
}

export function validateChanges(
  raw: Array<Record<string, any>>,
  report: SeoReport,
  subject: ResolvedSubject,
): { changes: FixChange[]; dropped: Array<{ type: string; reason: string }> } {
  const live = new Map(report.pages.filter((p) => p.status === 200).map((p) => [p.path, p]));
  const pillars = new Set(report.clusters.map((c) => c.pillar));
  const changes: FixChange[] = [];
  const dropped: Array<{ type: string; reason: string }> = [];
  const drop = (type: string, reason: string) => dropped.push({ type, reason });
  // Blog bodies are edited sequentially, so later edits validate against the
  // result of earlier ones in the same proposal.
  const workingBodies = new Map<string, string>();
  const redirectsFrom = new Set<string>();
  const pendingDrafts = raw.some((c) => c.type === "create_blog_draft") ? countConsoleDrafts() : 0;

  for (const c of raw) {
    const type = String(c.type ?? "");
    const reason = str(c.reason) ?? "";
    const index = changes.length;
    const countBefore = changes.length;
    try {
      switch (type) {
        case "set_meta": {
          const path = normPath(str(c.path) ?? "");
          const page = live.get(path);
          if (!page) throw new Error(`${path || "(no path)"} is not a live page`);
          const title = str(c.title);
          const description = str(c.description);
          if (!title && !description) throw new Error("no title or description given");
          if (title && (title.length < 15 || title.length > 80)) throw new Error(`title is ${title.length} characters`);
          if (description && (description.length < 50 || description.length > 200)) {
            throw new Error(`description is ${description.length} characters`);
          }
          const rows: PreviewRow[] = [];
          if (title) rows.push({ label: "Title", before: page.title, after: title });
          if (description) rows.push({ label: "Meta description", before: page.description, after: description });
          changes.push({
            index, destructive: false, rows,
            heading: `Title & description — ${path}`,
            op: { type: "set_meta", path, title, description, reason },
          });
          break;
        }
        case "set_focus_keyword": {
          const path = normPath(str(c.path) ?? "");
          const page = live.get(path);
          if (!page) throw new Error(`${path || "(no path)"} is not a live page`);
          const keyword = str(c.keyword);
          if (!keyword || keyword.length > 80) throw new Error("keyword missing or too long");
          changes.push({
            index, destructive: false,
            heading: `Focus keyword — ${path}`,
            rows: [{ label: "Focus keyword", before: page.focusKeyword, after: keyword.toLowerCase() }],
            op: { type: "set_focus_keyword", path, keyword: keyword.toLowerCase(), reason },
          });
          break;
        }
        case "edit_blog": {
          const slug = str(c.slug) ?? "";
          const post = storage.getBlogBySlug(slug);
          if (!post) throw new Error(`no blog post "${slug}"`);
          let body = workingBodies.get(slug) ?? post.body;
          const rows: PreviewRow[] = [];
          const title = str(c.title);
          const excerpt = str(c.excerpt);
          const heroImageAlt = str(c.heroImageAlt);
          if (title) {
            if (title.length < 15 || title.length > 110) throw new Error(`title is ${title.length} characters`);
            rows.push({ label: "Title / H1", before: post.title, after: title });
          }
          if (excerpt) {
            if (excerpt.length < 50 || excerpt.length > 220) throw new Error(`excerpt is ${excerpt.length} characters`);
            rows.push({ label: "Excerpt (meta description)", before: post.excerpt, after: excerpt });
          }
          if (heroImageAlt) rows.push({ label: "Hero image alt text", before: post.heroImageAlt ?? "", after: heroImageAlt });
          const edits: Array<{ find: string; replace: string }> = [];
          for (const e of Array.isArray(c.bodyEdits) ? c.bodyEdits : []) {
            const find = typeof e?.find === "string" ? e.find : "";
            const replace = typeof e?.replace === "string" ? e.replace : "";
            if (!find.trim()) continue;
            const n = countOccurrences(body, find);
            if (n !== 1) {
              drop("edit_blog", `A body edit on "${slug}" was skipped: the text to replace appears ${n} times, not once ("${snippet(find, 80)}")`);
              continue;
            }
            body = body.replace(find, () => replace);
            edits.push({ find, replace });
            rows.push({ label: "Body", before: snippet(find), after: snippet(replace) });
          }
          if (!rows.length) throw new Error("nothing left to change after validation");
          workingBodies.set(slug, body);
          changes.push({
            index, destructive: false, rows,
            heading: `Blog post — /blog/${slug}`,
            op: { type: "edit_blog", slug, title, excerpt, heroImageAlt, bodyEdits: edits, reason },
          });
          break;
        }
        case "edit_entity_copy": {
          const kind = c.kind === "condo" ? "condo" : c.kind === "neighbourhood" ? "neighbourhood" : null;
          if (!kind) throw new Error("kind must be neighbourhood or condo");
          const slug = str(c.slug) ?? "";
          const row: any = kind === "neighbourhood"
            ? storage.getNeighbourhoodBySlug(slug)
            : storage.getCondoBuildingBySlug(slug);
          if (!row) throw new Error(`no ${kind} "${slug}"`);
          const field = String(c.field ?? "");
          const allowed: readonly string[] = kind === "neighbourhood" ? NEIGHBOURHOOD_FIELDS : CONDO_FIELDS;
          if (!allowed.includes(field)) throw new Error(`field "${field}" can't be edited`);
          const text = field === "tagline" ? str(c.text) : null;
          const paragraphs = field === "tagline"
            ? []
            : (Array.isArray(c.paragraphs) ? c.paragraphs : []).map((p: unknown) => String(p).trim()).filter(Boolean);
          if (field === "tagline" ? !text : !paragraphs.length) throw new Error("no new copy given");
          const before = field === "tagline" ? String(row.tagline ?? "") : jsonArray(row[field]).join("\n\n");
          const after = field === "tagline" ? text! : paragraphs.join("\n\n");
          const base = kind === "neighbourhood" ? "/neighbourhoods" : "/condos";
          changes.push({
            index, destructive: false,
            heading: `${kind === "neighbourhood" ? "Neighbourhood" : "Condo"} copy — ${base}/${slug}`,
            rows: [{ label: field, before, after }],
            op: { type: "edit_entity_copy", kind, slug, field, text, paragraphs, reason },
          });
          break;
        }
        case "add_redirect": {
          const from = normPath(str(c.from) ?? "");
          const to = normPath(str(c.to) ?? "");
          if (!live.has(from)) throw new Error(`${from} is not a live page`);
          if (!live.has(to)) throw new Error(`${to} is not a live page returning 200`);
          if (from === to) throw new Error("a page can't redirect to itself");
          if (from === "/" || pillars.has(from)) throw new Error(`${from} is a pillar or the homepage and must not be redirected`);
          if (!subject.paths.includes(from)) throw new Error(`${from} isn't one of the pages this fix is about`);
          redirectsFrom.add(from);
          changes.push({
            index, destructive: true,
            heading: `301 redirect — ${from}`,
            rows: [{ label: "Redirect", before: `${from} serves its own page`, after: `${from} → 301 → ${to}` }],
            op: { type: "add_redirect", from, to, reason },
          });
          break;
        }
        case "unpublish_blog": {
          const slug = str(c.slug) ?? "";
          const post = storage.getBlogBySlug(slug);
          if (!post) throw new Error(`no blog post "${slug}"`);
          if (post.status === "draft") throw new Error("already a draft");
          changes.push({
            index, destructive: true,
            heading: `Unpublish — /blog/${slug}`,
            rows: [{ label: "Status", before: "published", after: "draft (hidden from the journal and sitemap)" }],
            op: { type: "unpublish_blog", slug, reason },
          });
          break;
        }
        case "create_blog_draft": {
          const slug = (str(c.slug) ?? "").toLowerCase();
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`"${slug}" isn't a valid slug`);
          if (storage.getBlogBySlug(slug)) throw new Error(`a post with slug "${slug}" already exists`);
          const title = str(c.title);
          const body = str(c.body);
          if (!title || !body) throw new Error("title and body are required");
          const draftsAllowed =
            subject.kind === "topic" || subject.kind === "cluster" || subject.kind === "candidate" ||
            subject.kind === "ai_question" || subject.opportunity?.type === "content_gap";
          if (!draftsAllowed) {
            throw new Error("single-page fixes don't create posts — strengthen the existing page instead");
          }
          if (changes.filter((x) => x.op.type === "create_blog_draft").length >= 2) {
            throw new Error("only two new drafts per fix — the rest belong in the roadmap");
          }
          if (pendingDrafts + changes.filter((x) => x.op.type === "create_blog_draft").length >= MAX_PENDING_CONSOLE_DRAFTS) {
            throw new Error(`${MAX_PENDING_CONSOLE_DRAFTS} console drafts are already waiting — publish or delete some first`);
          }
          const competes = draftCompetesWith(title, slug, report);
          if (competes) throw new Error(`“${title}” would compete with an existing page: ${competes}`);
          const excerpt = str(c.excerpt) ?? body.split(/\n\s*\n/)[0].slice(0, 160);
          const category = str(c.category) ?? "Market";
          changes.push({
            index, destructive: false,
            heading: `New draft post — /blog/${slug}`,
            rows: [
              { label: "Title", before: "", after: title },
              { label: "Excerpt", before: "", after: excerpt },
              { label: "Body", before: "", after: body },
            ],
            op: { type: "create_blog_draft", slug, title, excerpt, body, category, reason },
          });
          break;
        }
        case "code_change": {
          const path = normPath(str(c.path) ?? "");
          if (!live.has(path)) throw new Error(`${path || "(no path)"} is not a live page`);
          const instructions = str(c.instructions);
          if (!instructions) throw new Error("no instructions given");
          const files = (Array.isArray(c.files) ? c.files : []).map(String).filter(Boolean);
          const op: FixOp = {
            type: "code_change", path, reason, instructions,
            files: files.length ? files : codeFilesFor(path),
          };
          changes.push({
            index, destructive: false,
            heading: `Code change (pull request) — ${path}`,
            rows: [{ label: "Instructions", before: "", after: instructions }],
            delivery: githubConfigured() ? "github" : "prompt",
            prompt: codeChangePrompt(op, subject),
            op,
          });
          break;
        }
        case "set_cluster": {
          const existingId = str(c.clusterId);
          const existing = existingId ? getStoredCluster(existingId) : null;
          if (existingId && !existing) throw new Error(`no cluster "${existingId}"`);
          const label = str(c.label) ?? existing?.label;
          if (!label) throw new Error("a new cluster needs a label");
          const pillar = normPath(str(c.pillar) ?? existing?.pillar ?? "");
          // The pillar may be a draft created in this same proposal.
          const draftedHere = raw.some((o) => o.type === "create_blog_draft" && `/blog/${String(o.slug ?? "").toLowerCase()}` === pillar);
          if (!live.has(pillar) && !draftedHere) throw new Error(`pillar ${pillar || "(none)"} is not a live page`);
          const clash = report.clusters.find((x) => x.pillar === pillar && x.id !== existing?.id);
          if (clash) throw new Error(`${pillar} is already the pillar of "${clash.label}"`);
          const headKeyword = (str(c.headKeyword) ?? existing?.headKeyword ?? "").toLowerCase();
          if (!headKeyword) throw new Error("head keyword is required");
          const intents = ["transactional", "commercial", "informational", "navigational"];
          const intent = (intents.includes(String(c.intent)) ? c.intent : existing?.intent ?? "informational") as StoredCluster["intent"];
          const vocabulary = (Array.isArray(c.vocabulary) ? c.vocabulary : []).map((v: unknown) => String(v).toLowerCase().trim()).filter(Boolean);
          const askedMembers = (Array.isArray(c.members) ? c.members : []).map((m: unknown) => normPath(String(m).trim())).filter(Boolean);
          const members = askedMembers.filter((m: string) => live.has(m) ||
            raw.some((o) => o.type === "create_blog_draft" && `/blog/${String(o.slug ?? "").toLowerCase()}` === m));
          const unknown = askedMembers.filter((m: string) => !members.includes(m));
          if (unknown.length) drop("set_cluster", `Left out of the cluster (not live pages): ${unknown.join(", ")}`);
          // New ids come from the label; never collide with an existing one.
          let clusterId = existing?.id ?? slugifyClusterId(label);
          if (!existing) {
            let n = 2;
            const base = clusterId;
            while (getStoredCluster(clusterId) || report.clusters.some((x) => x.id === clusterId)) clusterId = `${base}-${n++}`;
          }
          const finalVocab = vocabulary.length ? vocabulary : existing?.vocabulary ?? [];
          const finalMembers = askedMembers.length ? members : existing?.members ?? [];
          const describe = (x: { label: string; pillar: string; headKeyword: string; intent: string; vocabulary: string[]; members: string[] } | null) =>
            x ? `${x.label}\npillar ${x.pillar} · owns “${x.headKeyword}” · ${x.intent}\nvocabulary: ${x.vocabulary.join(", ") || "—"}\nmembers: ${x.members.join(", ") || "—"}` : "";
          changes.push({
            index, destructive: false,
            heading: existing ? `Cluster — ${existing.label}` : `New cluster — ${label}`,
            rows: [{
              label: "Cluster definition",
              before: describe(existing),
              after: describe({ label, pillar, headKeyword, intent, vocabulary: finalVocab, members: finalMembers }),
            }],
            op: {
              type: "set_cluster", clusterId, isNew: !existing, label, pillar, headKeyword, intent,
              vocabulary: finalVocab, members: finalMembers, prefixes: existing?.prefixes ?? [], reason,
            },
          });
          break;
        }
        default:
          throw new Error("unknown change type");
      }
      // Scope the variant group to its target so "meta" on two pages can't
      // collide.
      const group = str(c.variantGroup);
      if (group && changes.length > countBefore) {
        const op: any = changes[changes.length - 1].op;
        changes[changes.length - 1].variantGroup = `${group}:${op.path ?? op.slug ?? ""}`;
      }
    } catch (e: any) {
      drop(type || "unknown", `${type || "change"} skipped: ${e?.message ?? e}`);
    }
  }

  // A "group" of one is just a change.
  const groupSizes = new Map<string, number>();
  for (const ch of changes) if (ch.variantGroup) groupSizes.set(ch.variantGroup, (groupSizes.get(ch.variantGroup) ?? 0) + 1);
  for (const ch of changes) if (ch.variantGroup && groupSizes.get(ch.variantGroup)! < 2) delete ch.variantGroup;

  // Unpublishing without a redirect throws the page's links and rankings
  // away. Only allow it as part of a consolidation.
  const kept: FixChange[] = [];
  for (const ch of changes) {
    if (ch.op.type === "unpublish_blog" && !redirectsFrom.has(`/blog/${ch.op.slug}`)) {
      drop("unpublish_blog", `Unpublishing /blog/${ch.op.slug} was skipped: it needs a redirect to go with it`);
      continue;
    }
    kept.push({ ...ch, index: kept.length });
  }
  return { changes: kept, dropped };
}

// ---------------------------------------------------------------------------
// GitHub: code changes become an issue for the Claude Code Action
// ---------------------------------------------------------------------------

function codeChangePrompt(op: Extract<FixOp, { type: "code_change" }>, subject: ResolvedSubject): string {
  const opp = subject.opportunity;
  const evidence = opp?.queries.length
    ? `\n\nSearch Console evidence (last 90 days):\n${opp.queries.slice(0, 8).map((q) => `- "${q.query}"${q.path ? ` on ${q.path}` : ""}: ${q.impressions} impressions, ${q.clicks} clicks, position ${q.position}`).join("\n")}`
    : "";
  return `SEO fix for ${op.path} on riversrealestate.ca, drafted from the /admin/seo console.

Why: ${op.reason}${opp ? `\nOpportunity: ${opp.headline} — ${opp.why}` : ""}${evidence}

Files: ${op.files.join("; ")}

Instructions:
${op.instructions}

Constraints:
- Title/description strings in server/seo-inject.ts must stay identical to the page component's <SeoHead> strings (see the comment in client/src/components/seo-head.tsx).
- Keep the change limited to this page. Canadian spelling.
- Run \`npm run check\` and make sure you haven't added any new type errors.
- Open a pull request against main; do not push to main.`;
}

async function openGithubIssue(op: Extract<FixOp, { type: "code_change" }>, prompt: string): Promise<string> {
  const token = process.env.GITHUB_TOKEN!;
  const repo = process.env.GITHUB_REPO!;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GITHUB_REPO "${repo}" should look like owner/name`);
  const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "RiversSeoConsole/1.0",
    },
    body: JSON.stringify({
      title: `SEO fix: ${op.path} — ${op.reason.slice(0, 80)}`,
      body: `@claude please implement this and open a pull request.\n\n${prompt}`,
      labels: ["seo-fix"],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`GitHub refused the issue (${r.status}): ${text.slice(0, 200)}`);
  }
  const json: any = await r.json();
  return String(json.html_url);
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

/** Start a proposal. Returns immediately; Claude runs in the background. */
/** The owner's standing instructions, appended to every system prompt. */
export const HOUSE_STYLE_KEY = "house_style";

function systemPrompt(): string {
  let style: string | null = null;
  try { style = getSeoSetting(HOUSE_STYLE_KEY); } catch { style = null; }
  return style
    ? `${SYSTEM_PROMPT}\n\nOwner's standing instructions (these win over the defaults above):\n${style}`
    : SYSTEM_PROMPT;
}

/** A previous draft and the owner's reaction to it, for "Revise with a note". */
interface Feedback {
  note: string;
  previous: string;
}

function describePrevious(p: FixProposalRow): string {
  const lines = [`Summary: ${p.summary ?? ""}`];
  for (const c of p.changes as FixChange[]) {
    lines.push(`- ${c.heading}`);
    for (const r of c.rows) lines.push(`    ${r.label}: ${r.after.slice(0, 400)}`);
  }
  for (const t of (p.planned ?? []) as Array<{ title: string }>) lines.push(`- planned topic: ${t.title}`);
  return lines.join("\n");
}

export function proposeFix(subject: FixSubject, feedback?: Feedback): FixProposalRow {
  const report = cachedSeoReport();
  if (!report) throw new Error("The SEO report hasn't been built yet — wait for the scan to finish.");
  const resolved = resolveSubject(subject, report);
  const row = createFixProposal(subject.kind, {
    ...subject,
    label: resolved.label,
    paths: resolved.paths,
    opportunityType: resolved.opportunity?.type ?? null,
    clusterId: resolved.cluster?.id ?? null,
  });

  (async () => {
    try {
      let prompt = buildPrompt(resolved, report);
      if (feedback) {
        prompt += `\n\n# Owner feedback on your previous draft\nPrevious draft:\n${feedback.previous}\n\nThe owner said: "${feedback.note}"\nRevise accordingly. Keep what they didn't object to; change what they did.`;
      }
      const { output, model } = await askClaude(systemPrompt(), prompt);
      // Validate against the content as it is *now*, not as it was when the
      // report was built — the admin may have edited a post meanwhile.
      const { changes, dropped } = validateChanges(output.changes, cachedSeoReport() ?? report, resolved);
      updateFixProposal(row.id, {
        status: "ready",
        summary: String(output.summary ?? "").slice(0, 300),
        rationale: String(output.rationale ?? ""),
        changes,
        dropped,
        planned: (Array.isArray(output.plannedTopics) ? output.plannedTopics : [])
          .filter((t) => t && typeof t.title === "string" && typeof t.targetQuery === "string")
          .slice(0, 8)
          .map((t) => ({
            title: t.title,
            targetQuery: t.targetQuery,
            why: String(t.why ?? ""),
            // A new-cluster plan's topics belong to the cluster it creates.
            clusterId: resolved.cluster?.id ??
              (changes.find((c) => c.op.type === "set_cluster")?.op as { clusterId?: string } | undefined)?.clusterId ??
              null,
          })),
        model,
      });
    } catch (e: any) {
      console.error("[seo-fix] proposal failed:", e?.message ?? e);
      updateFixProposal(row.id, { status: "failed", error: String(e?.message ?? e).slice(0, 500) });
    }
  })();

  return row;
}

// ---------------------------------------------------------------------------
// Apply / undo
// ---------------------------------------------------------------------------

function readBlog(slug: string): BlogFields {
  const p = storage.getBlogBySlug(slug);
  if (!p) throw new Error(`blog post "${slug}" no longer exists`);
  return { title: p.title, excerpt: p.excerpt, body: p.body, heroImageAlt: p.heroImageAlt ?? null, status: p.status };
}

function writeBlog(slug: string, f: Partial<BlogFields>): void {
  storage.upsertBlogPost({ slug, ...f } as any);
}

function readEntityField(kind: "neighbourhood" | "condo", slug: string, field: string): string {
  const row: any = kind === "neighbourhood"
    ? storage.getNeighbourhoodBySlug(slug)
    : storage.getCondoBuildingBySlug(slug);
  if (!row) throw new Error(`${kind} "${slug}" no longer exists`);
  return String(row[field] ?? "");
}

function writeEntityField(kind: "neighbourhood" | "condo", slug: string, field: string, raw: string): void {
  if (kind === "neighbourhood") storage.upsertNeighbourhood({ slug, [field]: raw } as any);
  else storage.updateCondoBuilding(slug, { [field]: raw } as any);
}

async function applyOne(ch: FixChange, proposal: FixProposalRow): Promise<{ snap: SnapshotEntry; message?: string; issueUrl?: string }> {
  const op = ch.op;
  const index = ch.index;
  switch (op.type) {
    case "set_meta": {
      if (op.path === "/") {
        // The homepage's title/description belong to its CMS row, which keeps
        // its own revision history — write there rather than shadowing it.
        const cur = getPageContent("home").seo;
        const before = { title: cur.title, description: cur.description };
        const after = { title: op.title ?? cur.title, description: op.description ?? cur.description };
        savePageContent("home", { seo: after, updatedBy: "SEO console (Claude)", revisionLabel: `Before SEO fix #${proposal.id}` });
        return { snap: { index, kind: "home_meta", before, after } };
      }
      const before = getMetaOverride(op.path);
      const after: MetaOverride = {
        title: op.title ?? before?.title ?? null,
        description: op.description ?? before?.description ?? null,
      };
      setMetaOverride(op.path, after);
      return { snap: { index, kind: "meta", path: op.path, before, after } };
    }
    case "set_focus_keyword": {
      const before = storage.listSeoKeywordTargets().find((t) => t.path === op.path)?.focusKeyword ?? null;
      storage.setSeoKeywordTarget(op.path, op.keyword, `Set by SEO fix #${proposal.id}`);
      return { snap: { index, kind: "focus", path: op.path, before, after: op.keyword } };
    }
    case "edit_blog": {
      const before = readBlog(op.slug);
      let body = before.body;
      for (const e of op.bodyEdits) {
        const n = countOccurrences(body, e.find);
        if (n !== 1) throw new Error(`the post changed since this fix was drafted ("${snippet(e.find, 60)}" appears ${n} times)`);
        body = body.replace(e.find, () => e.replace);
      }
      const after: BlogFields = {
        ...before,
        title: op.title ?? before.title,
        excerpt: op.excerpt ?? before.excerpt,
        heroImageAlt: op.heroImageAlt ?? before.heroImageAlt,
        body,
      };
      writeBlog(op.slug, after);
      return { snap: { index, kind: "blog", slug: op.slug, before, after } };
    }
    case "edit_entity_copy": {
      const before = readEntityField(op.kind, op.slug, op.field);
      const after = op.field === "tagline" ? op.text! : JSON.stringify(op.paragraphs);
      writeEntityField(op.kind, op.slug, op.field, after);
      return { snap: { index, kind: "entity", entity: op.kind, slug: op.slug, field: op.field, before, after } };
    }
    case "add_redirect": {
      const beforeTo = consoleRedirectFor(op.from);
      addConsoleRedirect(op.from, op.to, `SEO fix #${proposal.id}: ${op.reason}`.slice(0, 300));
      return { snap: { index, kind: "redirect", from: op.from, beforeTo, after: op.to } };
    }
    case "unpublish_blog": {
      const before = readBlog(op.slug);
      const after = { ...before, status: "draft" };
      writeBlog(op.slug, { status: "draft" });
      return { snap: { index, kind: "blog", slug: op.slug, before, after } };
    }
    case "create_blog_draft": {
      if (storage.getBlogBySlug(op.slug)) throw new Error(`a post with slug "${op.slug}" already exists`);
      if (countConsoleDrafts() >= MAX_PENDING_CONSOLE_DRAFTS) {
        throw new Error(`${MAX_PENDING_CONSOLE_DRAFTS} console drafts are already waiting — publish or delete some first`);
      }
      const words = op.body.split(/\s+/).filter(Boolean).length;
      storage.upsertBlogPost({
        slug: op.slug,
        title: op.title,
        excerpt: op.excerpt,
        body: op.body,
        category: op.category,
        heroImage: "/img/og-default.jpg",
        status: "draft",
        readMinutes: Math.max(2, Math.round(words / 230)),
      } as any);
      return { snap: { index, kind: "draft", slug: op.slug }, message: "Saved as a draft — add a hero image and publish it from /admin/blog." };
    }
    case "set_cluster": {
      const before = getStoredCluster(op.clusterId);
      const after = upsertCluster({
        id: op.clusterId, label: op.label, pillar: op.pillar, headKeyword: op.headKeyword,
        intent: op.intent, prefixes: before?.prefixes ?? op.prefixes, vocabulary: op.vocabulary, members: op.members,
      });
      return {
        snap: { index, kind: "cluster", id: op.clusterId, before, after },
        message: before ? "Cluster updated — the report regroups on the next scan." : "Cluster created — the report regroups on the next scan.",
      };
    }
    case "code_change": {
      if (!githubConfigured()) {
        throw new Error("GitHub isn't configured on this server (GITHUB_TOKEN / GITHUB_REPO) — copy the prompt into Claude Code instead.");
      }
      const url = await openGithubIssue(op, ch.prompt ?? codeChangePrompt(op, {
        kind: "page", paths: [op.path], opportunity: null, label: op.path,
      }));
      return {
        snap: { index, kind: "issue", url },
        issueUrl: url,
        message: "Issue opened — Claude will open a pull request there for you to review and merge.",
      };
    }
  }
}

/** Apply the selected changes. Each succeeds or fails on its own. */
export async function applyFix(id: number, indexes: number[]): Promise<FixProposalRow> {
  const p = getFixProposal(id);
  if (!p) throw new Error("Fix not found");
  if (p.status !== "ready") throw new Error(`This fix is ${p.status.replace("_", " ")}, not ready to apply`);
  const wanted = new Set(indexes);
  const changes: FixChange[] = p.changes.map((c: FixChange) => ({ ...c }));
  // Alternatives are either/or: applying two titles for one page would just
  // overwrite the first with the second.
  const chosenGroups = new Set<string>();
  for (const ch of changes) {
    if (!wanted.has(ch.index) || !ch.variantGroup) continue;
    if (chosenGroups.has(ch.variantGroup)) throw new Error("Pick one of the alternatives, not several");
    chosenGroups.add(ch.variantGroup);
  }
  const snapshot: SnapshotEntry[] = [];
  let ok = 0;
  let failed = 0;

  for (const ch of changes) {
    if (!wanted.has(ch.index)) continue;
    try {
      const r = await applyOne(ch, p);
      snapshot.push(r.snap);
      ch.applied = true;
      ch.result = { ok: true, message: r.message, issueUrl: r.issueUrl };
      ok++;
    } catch (e: any) {
      ch.applied = false;
      ch.result = { ok: false, message: String(e?.message ?? e) };
      failed++;
    }
  }

  const status = ok === 0 ? "ready" : failed || ok < changes.length ? "partially_applied" : "applied";
  updateFixProposal(id, {
    status,
    changes,
    snapshot,
    ...(ok ? { appliedAt: new Date().toISOString() } : {}),
  });
  if (ok) afterWrite();
  return getFixProposal(id)!;
}

/**
 * Put back what a fix replaced. A field that has been edited again since the
 * fix was applied is left alone (and reported) unless `force` — silently
 * reverting someone's later edit would be worse than not undoing.
 */
export function undoFix(id: number, force = false): { proposal: FixProposalRow; skipped: string[] } {
  const p = getFixProposal(id);
  if (!p) throw new Error("Fix not found");
  if (p.status !== "applied" && p.status !== "partially_applied") throw new Error("Only an applied fix can be undone");
  const snapshot = (p.snapshot as SnapshotEntry[]).slice().reverse();
  const skipped: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  for (const s of snapshot) {
    try {
      switch (s.kind) {
        case "meta": {
          const cur = getMetaOverride(s.path);
          if (!force && !same({ title: cur?.title ?? null, description: cur?.description ?? null }, s.after)) {
            skipped.push(`${s.path} title/description changed since — left as is`);
            break;
          }
          setMetaOverride(s.path, s.before ?? { title: null, description: null });
          break;
        }
        case "home_meta": {
          const cur = getPageContent("home").seo;
          if (!force && !same({ title: cur.title, description: cur.description }, s.after)) {
            skipped.push("Homepage title/description changed since — left as is");
            break;
          }
          savePageContent("home", { seo: s.before, updatedBy: "SEO console (undo)", revisionLabel: `Before undo of SEO fix #${id}` });
          break;
        }
        case "focus": {
          const cur = storage.listSeoKeywordTargets().find((t) => t.path === s.path)?.focusKeyword ?? null;
          if (!force && cur !== s.after) {
            skipped.push(`${s.path} focus keyword changed since — left as is`);
            break;
          }
          if (s.before) storage.setSeoKeywordTarget(s.path, s.before, null);
          else storage.clearSeoKeywordTarget(s.path);
          break;
        }
        case "blog": {
          const cur = readBlog(s.slug);
          if (!force && !same(cur, s.after)) {
            skipped.push(`/blog/${s.slug} was edited since — left as is`);
            break;
          }
          writeBlog(s.slug, s.before);
          break;
        }
        case "entity": {
          const cur = readEntityField(s.entity, s.slug, s.field);
          if (!force && cur !== s.after) {
            skipped.push(`${s.entity} ${s.slug} ${s.field} was edited since — left as is`);
            break;
          }
          writeEntityField(s.entity, s.slug, s.field, s.before);
          break;
        }
        case "redirect": {
          if (!force && consoleRedirectFor(s.from) !== s.after) {
            skipped.push(`Redirect from ${s.from} changed since — left as is`);
            break;
          }
          removeConsoleRedirect(s.from);
          if (s.beforeTo) addConsoleRedirect(s.from, s.beforeTo);
          break;
        }
        case "draft": {
          const res = sqlite
            .prepare("DELETE FROM blog_posts WHERE slug = ? AND status = 'draft'")
            .run(s.slug);
          if (!res.changes) skipped.push(`/blog/${s.slug} was published since — left in place`);
          break;
        }
        case "cluster": {
          const cur = getStoredCluster(s.id);
          const shape = (c: StoredCluster | null) => c && {
            label: c.label, pillar: c.pillar, headKeyword: c.headKeyword, intent: c.intent,
            vocabulary: c.vocabulary, members: c.members,
          };
          if (!force && !same(shape(cur), shape(s.after))) {
            skipped.push(`Cluster ${s.id} was edited since — left as is`);
            break;
          }
          if (s.before) upsertCluster({ ...s.before });
          else deleteCluster(s.id);
          break;
        }
        case "issue":
          skipped.push(`GitHub issue ${s.url} can't be undone from here — close it (and any pull request) on GitHub`);
          break;
      }
    } catch (e: any) {
      skipped.push(`Could not undo one change: ${e?.message ?? e}`);
    }
  }

  updateFixProposal(id, { status: "undone" });
  afterWrite();
  return { proposal: getFixProposal(id)!, skipped };
}

/** Redraft a proposal with the owner's note. The old draft is dismissed. */
export function reviseFix(id: number, note: string): FixProposalRow {
  const p = getFixProposal(id);
  if (!p) throw new Error("Fix not found");
  if (p.status !== "ready" && p.status !== "dismissed" && p.status !== "undone" && p.status !== "failed") {
    throw new Error("Undo an applied fix before revising it");
  }
  const clean = note.trim().slice(0, 1500);
  if (!clean) throw new Error("Say what you'd like changed");
  const { label: _l, paths: _p, opportunityType: _o, ...subject } = p.subject ?? {};
  const next = proposeFix(subject as FixSubject, { note: clean, previous: describePrevious(p) });
  if (p.status === "ready") updateFixProposal(id, { status: "dismissed" });
  return next;
}

export function dismissFix(id: number): FixProposalRow {
  const p = getFixProposal(id);
  if (!p) throw new Error("Fix not found");
  if (p.status === "applied" || p.status === "partially_applied") {
    throw new Error("Undo an applied fix instead of dismissing it");
  }
  updateFixProposal(id, { status: "dismissed" });
  return getFixProposal(id)!;
}

/** Content changed: drop cached HTML everywhere (redirects and links touch
 *  more than one page) and mark the report stale so the next view rescans. */
function afterWrite(): void {
  invalidateSsrCache();
  invalidateSeoReport({ keepData: true });
}
