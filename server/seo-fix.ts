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
import { storage, sqlite } from "./storage";
import { invalidateSsrCache } from "./ssr";
import { getPageContent, savePageContent } from "./page-content";
import {
  addConsoleRedirect,
  consoleRedirectFor,
  createFixProposal,
  getFixProposal,
  getMetaOverride,
  removeConsoleRedirect,
  setMetaOverride,
  updateFixProposal,
  type FixProposalRow,
  type MetaOverride,
} from "./seo-store";
import { cachedSeoReport, invalidateSeoReport } from "./seo-report-cache";
import { lastReportContext, type PageAnalysis, type SeoReport } from "./seo-keywords";
import type { Opportunity } from "./seo-opportunities";

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
  | { kind: "page"; path: string };

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
  | { type: "code_change"; path: string; files: string[]; instructions: string; reason: string };

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
  | { index: number; kind: "issue"; url: string };

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
function codeFilesFor(path: string): string[] {
  const meta = "server/seo-inject.ts (metaForPath — server-rendered title/description/schema)";
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
}

function resolveSubject(subject: FixSubject, report: SeoReport): ResolvedSubject {
  if (subject.kind === "opportunity") {
    const opp = report.opportunities.find((o) => o.id === subject.opportunityId);
    if (!opp) throw new Error("That opportunity is no longer in the report — rescan and try again.");
    return { kind: "opportunity", paths: opp.paths, opportunity: opp, label: opp.headline };
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
        : `the database (${home.type} "${home.slug}") — directly editable.`
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
  if (resolved.opportunity?.type === "content_gap") {
    parts.push(`No page targets this query yet. Propose one create_blog_draft that would genuinely answer it for a Calgary buyer or seller, plus edit_blog link insertions on 1–2 existing related posts pointing to the new slug (only if a natural sentence exists to link from).`);
  }

  for (const path of resolved.paths) {
    const page = report.pages.find((p) => p.path === path);
    if (page) parts.push(describePage(page));
  }

  const cluster = report.clusters
    .map((c) => `- ${c.label}: pillar ${c.pillar} owns "${c.headKeyword}"`)
    .join("\n");
  parts.push(`# Site structure\nClusters (child pages must not target their pillar's head term):\n${cluster}`);
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
- Canadian spelling (neighbourhood, centre). Confident, specific, no hype, no exclamation marks, no invented facts, statistics, prices or awards. Only use facts present in the supplied content.
- Titles 35–65 characters, lead with the target query in natural word order, end with " | Rivers Real Estate" only when it fits the limit. Blog post titles are also the H1, so they must read well as a headline.
- Meta descriptions 110–160 characters, include the query once, give a reason to click.
- Prefer queries the page already earns impressions for over invented keywords.
- Internal links go in blog bodies as [anchor text](/path) using descriptive anchors, only to paths from the live page list.

Change types and the fields each uses (set every unused field to null, or [] for arrays):
- set_meta: path, title and/or description. Works on any page. For blog posts prefer edit_blog (title/excerpt) instead, since those ARE the post's title and description.
- set_focus_keyword: path, keyword — the query the page should own from now on.
- edit_blog: slug, optional title / excerpt / heroImageAlt, and bodyEdits: [{find, replace}]. Each "find" must be copied EXACTLY from the supplied body and appear exactly once — use a whole sentence or paragraph. To add a new section, find the last sentence of the paragraph it should follow and replace it with that sentence + "\\n\\n## Heading\\n\\nNew paragraph". Keep edits surgical; do not rewrite whole posts.
- edit_entity_copy: kind ("neighbourhood" | "condo"), slug, field, and either text (for "tagline") or paragraphs (the COMPLETE new list for that array field). Plain text only.
- add_redirect: from, to — 301 a weaker page into a stronger one. Only for consolidation.
- unpublish_blog: slug — only alongside an add_redirect from that post.
- create_blog_draft: slug (lowercase-hyphenated, new), title, excerpt, body (lightweight markdown, 700–1200 words, answers the query directly in the first paragraph, ## sections, 2–4 internal links), category (one of Market, Buying, Selling, Neighbourhoods, Condos, Lifestyle).
- code_change: path, files, instructions — for page copy that lives in source code. Write instructions a developer (Claude Code) can execute without further context: exact current strings to find, exact replacements, and which strings must stay in sync between server and client.

If the right answer is to change nothing, return an empty changes list and explain why in the rationale.`;

/** Flat JSON schema — every field present, unused ones null — which is what
 *  structured outputs handles most reliably. */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "rationale", "changes"],
  properties: {
    summary: { type: "string", description: "One line: what this fix does." },
    rationale: { type: "string", description: "2–5 sentences: the diagnosis and why these changes fix it." },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type", "reason", "path", "slug", "kind", "field", "title", "description", "excerpt",
          "heroImageAlt", "keyword", "text", "paragraphs", "bodyEdits", "from", "to", "body",
          "category", "files", "instructions",
        ],
        properties: {
          type: {
            type: "string",
            enum: [
              "set_meta", "set_focus_keyword", "edit_blog", "edit_entity_copy", "add_redirect",
              "unpublish_blog", "create_blog_draft", "code_change",
            ],
          },
          reason: { type: "string" },
          path: { type: ["string", "null"] },
          slug: { type: ["string", "null"] },
          kind: { type: ["string", "null"], description: "neighbourhood | condo (edit_entity_copy only)" },
          field: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          excerpt: { type: ["string", "null"] },
          heroImageAlt: { type: ["string", "null"] },
          keyword: { type: ["string", "null"] },
          text: { type: ["string", "null"] },
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
          from: { type: ["string", "null"] },
          to: { type: ["string", "null"] },
          body: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          files: { type: "array", items: { type: "string" } },
          instructions: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

interface RawOutput {
  summary: string;
  rationale: string;
  changes: Array<Record<string, any>>;
}

async function askClaude(system: string, prompt: string): Promise<{ output: RawOutput; model: string }> {
  if (process.env.SEO_FIX_FAKE === "1") return { output: fakeOutput(prompt), model: "fake" };
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
    body: null, category: null, files: [], instructions: null,
  };
  const changes: Array<Record<string, any>> = [
    { ...blank, type: "set_meta", path, title: "Test Title for SEO Fix Flow | Rivers Real Estate", description: "A test meta description written by the fake fixer so the preview, apply and undo flow can be exercised end to end without an API key.", reason: "Fake: exercise set_meta." },
    { ...blank, type: "set_focus_keyword", path, keyword: "test focus keyword", reason: "Fake: exercise set_focus_keyword." },
  ];
  const slug = path.match(/^\/blog\/(.+)$/)?.[1];
  if (slug && firstPara) {
    changes.push({ ...blank, type: "edit_blog", slug, bodyEdits: [{ find: firstPara, replace: `${firstPara} See our [Calgary neighbourhood guides](/neighbourhoods).` }], reason: "Fake: exercise edit_blog." });
  }
  changes.push({ ...blank, type: "code_change", path, files: ["server/seo-inject.ts"], instructions: "Fake: no-op instructions.", reason: "Fake: exercise code_change." });
  return { summary: "Fake fix for testing", rationale: "SEO_FIX_FAKE=1 is set, so this proposal was generated without calling Claude.", changes };
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

  for (const c of raw) {
    const type = String(c.type ?? "");
    const reason = str(c.reason) ?? "";
    const index = changes.length;
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
        default:
          throw new Error("unknown change type");
      }
    } catch (e: any) {
      drop(type || "unknown", `${type || "change"} skipped: ${e?.message ?? e}`);
    }
  }

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
export function proposeFix(subject: FixSubject): FixProposalRow {
  const report = cachedSeoReport();
  if (!report) throw new Error("The SEO report hasn't been built yet — wait for the scan to finish.");
  const resolved = resolveSubject(subject, report);
  const row = createFixProposal(subject.kind, {
    ...subject,
    label: resolved.label,
    paths: resolved.paths,
    opportunityType: resolved.opportunity?.type ?? null,
  });

  (async () => {
    try {
      const prompt = buildPrompt(resolved, report);
      const { output, model } = await askClaude(SYSTEM_PROMPT, prompt);
      // Validate against the content as it is *now*, not as it was when the
      // report was built — the admin may have edited a post meanwhile.
      const { changes, dropped } = validateChanges(output.changes, cachedSeoReport() ?? report, resolved);
      updateFixProposal(row.id, {
        status: "ready",
        summary: String(output.summary ?? "").slice(0, 300),
        rationale: String(output.rationale ?? ""),
        changes,
        dropped,
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
