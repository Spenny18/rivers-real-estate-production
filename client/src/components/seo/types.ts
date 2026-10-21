// Client-side shapes for the SEO console's opportunities and Claude fixes.
// Mirrors server/seo-opportunities.ts and server/seo-fix.ts.

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

export interface OpportunityQuery {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  path?: string;
}

export type TaskCategory =
  | "delete_merge"
  | "orphans"
  | "internal_links"
  | "external_links"
  | "image_alt"
  | "titles_meta"
  | "content"
  | "structure";

export interface GainLine {
  label: string;
  path?: string;
  position: number | null;
  monthlyImpressions: number;
  ctrNow: number;
  ctrTarget: number;
  clicks: number;
}

/** How estClicksGain was reached: subtotal of the lines × factor. */
export interface GainEstimate {
  method: string;
  lines: GainLine[];
  otherLines: number;
  otherClicks: number;
  subtotal: number;
  factor: number;
  factorReason: string | null;
}

export interface Opportunity {
  id: string;
  type: OpportunityType;
  /** Absent on reports cached before categories existed. */
  category?: TaskCategory;
  template?: string;
  paths: string[];
  query: string | null;
  subtype?: "pillar_links" | "uplinks" | "pillar_not_owner" | "cluster_candidate" | "deep_page";
  clusterId?: string;
  candidateId?: string;
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
  estClicksGain: number;
  estimate?: GainEstimate;
  effort: "quick" | "medium" | "heavy";
  priority: number;
  quickWin: boolean;
  basis: "search-console" | "on-page";
}

export type FixSubject =
  | { opportunityId: string }
  | { kind: "cannibalization"; paths: string[] }
  | { kind: "page"; path: string }
  | { kind: "cluster"; clusterId: string }
  | { kind: "candidate"; candidateId: string }
  | { kind: "topic"; clusterId: string; query: string; title: string }
  | { kind: "ai_question"; promptId: number };

export interface PlannedTopic { title: string; targetQuery: string; why: string; clusterId: string | null }

export interface PreviewRow { label: string; before: string; after: string }

export interface FixChange {
  index: number;
  op: { type: string; reason: string; [k: string]: any };
  heading: string;
  rows: PreviewRow[];
  destructive: boolean;
  /** Changes sharing a group are alternatives — apply one of them. */
  variantGroup?: string;
  delivery?: "github" | "prompt";
  prompt?: string;
  applied?: boolean;
  result?: { ok: boolean; message?: string; issueUrl?: string };
}

export type FixStatus =
  | "generating" | "ready" | "failed" | "applied" | "partially_applied" | "undone" | "dismissed";

export interface FixProposal {
  id: number;
  kind: string;
  subject: { label?: string; paths?: string[]; opportunityType?: string | null; [k: string]: any };
  status: FixStatus;
  summary: string | null;
  rationale: string | null;
  changes: FixChange[];
  dropped: Array<{ type: string; reason: string }>;
  planned?: PlannedTopic[];
  error: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

export const OPPORTUNITY_LABELS: Record<OpportunityType, string> = {
  ctr_gap: "Low click-through",
  striking_distance: "Striking distance",
  keyword_mismatch: "Keyword mismatch",
  cannibalization: "Cannibalization",
  internal_links: "Internal links",
  orphan: "Orphan page",
  prune: "Dead weight",
  external_links: "External links",
  image_alt: "Image alt text",
  thin_content: "Thin content",
  content_gap: "Content gap",
  on_page: "On-page basics",
  architecture: "Site architecture",
};

/** The "what needs doing" filter, in the order the chips appear. */
export const TASK_CATEGORIES: Array<{ id: TaskCategory; label: string; hint: string }> = [
  { id: "delete_merge", label: "Delete or merge", hint: "Dead-weight posts to remove, and pages competing for the same search" },
  { id: "orphans", label: "Orphan pages", hint: "Pages nothing links to, or buried too deep to be found" },
  { id: "internal_links", label: "Internal links", hint: "Pages that need more links from the rest of the site" },
  { id: "external_links", label: "External links", hint: "Pages that cite no outside sources" },
  { id: "image_alt", label: "Image alt text", hint: "Featured and body images with missing or weak alt text" },
  { id: "titles_meta", label: "Titles & descriptions", hint: "Snippets that don't earn the click, or miss the keyword" },
  { id: "content", label: "Content", hint: "Thin pages, near-page-one rankings and topics with no page" },
  { id: "structure", label: "Site structure", hint: "Cluster ownership and new clusters forming" },
];

/** Category for an opportunity from a report cached before the server sent one. */
export function categoryOf(o: Pick<Opportunity, "type" | "subtype" | "category">): TaskCategory {
  if (o.category) return o.category;
  switch (o.type) {
    case "prune": case "cannibalization": return "delete_merge";
    case "orphan": return "orphans";
    case "internal_links": return "internal_links";
    case "external_links": return "external_links";
    case "image_alt": return "image_alt";
    case "ctr_gap": case "keyword_mismatch": case "on_page": return "titles_meta";
    case "striking_distance": case "thin_content": case "content_gap": return "content";
    default:
      if (o.subtype === "deep_page") return "orphans";
      if (o.subtype === "pillar_links" || o.subtype === "uplinks") return "internal_links";
      return "structure";
  }
}

export interface ClusterAudit {
  id: string;
  label: string;
  pillar: string;
  headKeyword: string;
  intent: string;
  factory: boolean;
  pillarStatus: number | null;
  children: string[];
  linkedFromPillar: number;
  linkingUp: number;
  missingDownLinks: string[];
  missingUpLinks: string[];
  offClusterLinkShare: number;
  avgDepth: number | null;
  deepPages: string[];
  headTerm: {
    owner: string | null; ownerImpressions: number; ownerPosition: number | null;
    pillarImpressions: number; pillarPosition: number | null; queries: number;
  } | null;
  gaps: Array<{ query: string; impressions: number; position: number; bestPage: string }>;
  flags: string[];
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

/** A cluster definition as stored (GET /api/admin/seo/clusters). */
export interface ClusterDef {
  id: string;
  label: string;
  pillar: string;
  headKeyword: string;
  intent: string;
  prefixes: string[];
  vocabulary: string[];
  members?: string[];
  factory?: boolean;
}

export const EFFORT_LABELS = { quick: "Quick", medium: "Medium", heavy: "Bigger job" } as const;

export const STATUS_LABELS: Record<FixStatus, string> = {
  generating: "Drafting",
  ready: "Ready to review",
  failed: "Failed",
  applied: "Applied",
  partially_applied: "Partly applied",
  undone: "Undone",
  dismissed: "Dismissed",
};
