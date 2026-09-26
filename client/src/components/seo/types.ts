// Client-side shapes for the SEO console's opportunities and Claude fixes.
// Mirrors server/seo-opportunities.ts and server/seo-fix.ts.

export type OpportunityType =
  | "ctr_gap"
  | "striking_distance"
  | "keyword_mismatch"
  | "cannibalization"
  | "internal_links"
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

export interface Opportunity {
  id: string;
  type: OpportunityType;
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
  | { kind: "topic"; clusterId: string; query: string; title: string };

export interface PlannedTopic { title: string; targetQuery: string; why: string; clusterId: string | null }

export interface PreviewRow { label: string; before: string; after: string }

export interface FixChange {
  index: number;
  op: { type: string; reason: string; [k: string]: any };
  heading: string;
  rows: PreviewRow[];
  destructive: boolean;
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
  content_gap: "Content gap",
  on_page: "On-page basics",
  architecture: "Site architecture",
};

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
