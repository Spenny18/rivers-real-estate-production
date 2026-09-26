// Ranked SEO opportunities — the "what should I do first" list.
//
// Built server-side in server/seo-opportunities.ts from Search Console's
// page×query rows and GA4 page metrics. Each row can be handed to Claude.
import { useMemo, useState } from "react";
import { Sparkles, Zap, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EFFORT_LABELS,
  OPPORTUNITY_LABELS,
  type FixSubject,
  type Opportunity,
  type OpportunityType,
} from "./types";

const EFFORT_STYLES = {
  quick: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  heavy: "border-border text-muted-foreground",
} as const;

const fmtInt = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function OpportunitiesSection({
  opportunities,
  estClicksAvailable,
  gscOk,
  ga4Ok,
  pending,
  onFix,
  onOpenPage,
}: {
  opportunities: Opportunity[];
  estClicksAvailable: number;
  gscOk: boolean;
  ga4Ok: boolean;
  /** Opportunity id whose fix request is in flight. */
  pending: string | null;
  onFix: (subject: FixSubject) => void;
  onOpenPage: (path: string) => void;
}) {
  const [type, setType] = useState<OpportunityType | "all">("all");
  const [quickOnly, setQuickOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const counts = useMemo(() => {
    const c: Partial<Record<OpportunityType, number>> = {};
    for (const o of opportunities) c[o.type] = (c[o.type] ?? 0) + 1;
    return c;
  }, [opportunities]);

  const list = useMemo(() => {
    let l = opportunities;
    if (type !== "all") l = l.filter((o) => o.type === type);
    if (quickOnly) l = l.filter((o) => o.quickWin);
    return l;
  }, [opportunities, type, quickOnly]);

  const shown = showAll ? list : list.slice(0, 12);
  const quickWins = opportunities.filter((o) => o.quickWin).length;

  return (
    <section data-testid="section-opportunities">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-1">
        <h2 className="font-serif text-2xl flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-emerald-600 dark:text-emerald-400" /> Opportunities
        </h2>
        {gscOk && (
          <div className="text-sm text-muted-foreground tabular-nums">
            ≈ <span className="font-serif text-2xl text-foreground">{fmtInt(estClicksAvailable)}</span>{" "}
            extra clicks / month on the table · {quickWins} quick win{quickWins === 1 ? "" : "s"}
          </div>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4 max-w-3xl">
        {gscOk
          ? `Ranked by estimated extra organic clicks, weighted by search intent${ga4Ok ? " and by how well each page's visitors engage and convert in GA4" : ""}, divided by effort. Estimates use a typical click-through curve, so treat them as a way to order the work rather than a forecast.`
          : "Search Console isn't connected, so this list is ranked on on-page signals only. Connect it to rank by real impressions and positions."}
        {gscOk && !ga4Ok && " GA4 isn't connected, so engagement isn't factored in."}
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Chip active={type === "all"} onClick={() => setType("all")}>
          All {opportunities.length}
        </Chip>
        {(Object.keys(OPPORTUNITY_LABELS) as OpportunityType[])
          .filter((t) => counts[t])
          .map((t) => (
            <Chip key={t} active={type === t} onClick={() => setType(type === t ? "all" : t)}>
              {OPPORTUNITY_LABELS[t]} {counts[t]}
            </Chip>
          ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <Chip active={quickOnly} onClick={() => setQuickOnly((v) => !v)}>
          <Zap className="w-3 h-3" /> Quick wins only
        </Chip>
      </div>

      {shown.length === 0 ? (
        <div className="border border-border p-8 text-sm text-muted-foreground">
          {opportunities.length === 0
            ? "Nothing stands out right now. Opportunities appear as Search Console gathers impressions."
            : "No opportunities match these filters."}
        </div>
      ) : (
        <ol className="border border-border divide-y divide-border">
          {shown.map((o, i) => (
            <li key={o.id} className="p-4 bg-card" data-testid={`opportunity-${o.id}`}>
              <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                <div className="font-serif text-xl text-muted-foreground w-7 shrink-0 tabular-nums">{i + 1}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 bg-secondary">
                      {OPPORTUNITY_LABELS[o.type]}
                    </span>
                    <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 border ${EFFORT_STYLES[o.effort]}`}>
                      {EFFORT_LABELS[o.effort]}
                    </span>
                    {o.quickWin && (
                      <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-emerald-500/40 text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                        <Zap className="w-2.5 h-2.5" /> Quick win
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-medium">{o.headline}</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                    {o.paths.map((p) => (
                      <button
                        key={p}
                        onClick={() => onOpenPage(p)}
                        className="font-mono text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground"
                      >
                        {p}
                      </button>
                    ))}
                    {o.paths.length === 0 && <span className="font-mono text-xs text-muted-foreground">new page</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{o.why}</p>
                  <p className="text-xs mt-1.5 leading-relaxed">
                    <span className="text-muted-foreground">Fix: </span>
                    {o.action}
                  </p>
                </div>
                <div className="flex lg:flex-col items-center lg:items-end justify-between gap-3 shrink-0 lg:w-56">
                  <div className="text-xs tabular-nums text-muted-foreground lg:text-right space-y-0.5">
                    {o.basis === "search-console" && o.metrics.impressions > 0 ? (
                      <>
                        <div>
                          {fmtInt(o.metrics.impressions)} impr · {fmtPct(o.metrics.ctr)} CTR
                          {o.metrics.position != null && <> · pos {o.metrics.position}</>}
                        </div>
                        {o.estClicksGain > 0 && (
                          <div className="text-emerald-700 dark:text-emerald-400 font-medium">
                            +{o.estClicksGain < 10 ? o.estClicksGain.toFixed(1) : fmtInt(o.estClicksGain)} clicks / mo
                          </div>
                        )}
                      </>
                    ) : (
                      <div>no search data</div>
                    )}
                    {o.metrics.pageviews != null && (
                      <div>
                        {fmtInt(o.metrics.pageviews)} views
                        {o.metrics.keyEvents ? ` · ${fmtInt(o.metrics.keyEvents)} key events` : ""}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => onFix({ opportunityId: o.id })}
                    disabled={pending !== null}
                    className="gap-1.5 rounded-sm font-display text-[10px] tracking-[0.16em] shrink-0"
                    data-testid={`button-fix-${o.id}`}
                  >
                    <Sparkles className={`w-3.5 h-3.5 ${pending === o.id ? "animate-pulse" : ""}`} />
                    FIX WITH CLAUDE
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {list.length > 12 && (
        <Button variant="ghost" className="mt-2 text-xs" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show the top 12" : `Show all ${list.length}`}
        </Button>
      )}
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-8 px-3 text-xs border rounded-sm flex items-center gap-1.5 tabular-nums transition-colors ${
        active ? "border-foreground bg-foreground text-background" : "border-border hover:border-foreground/40"
      }`}
    >
      {children}
    </button>
  );
}
