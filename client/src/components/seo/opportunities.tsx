// Ranked SEO opportunities — the "what should I do first" list.
//
// Built server-side in server/seo-opportunities.ts from Search Console's
// page×query rows and GA4 page metrics. Each row shows how its click estimate
// was worked out, can be filtered by the kind of work it is, and can be
// handed to Claude.
import { useMemo, useState } from "react";
import { Sparkles, Zap, TrendingUp, ChevronDown, Calculator, LayoutTemplate } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EFFORT_LABELS,
  OPPORTUNITY_LABELS,
  TASK_CATEGORIES,
  categoryOf,
  type FixSubject,
  type GainEstimate,
  type Opportunity,
  type TaskCategory,
} from "./types";

const EFFORT_STYLES = {
  quick: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  heavy: "border-border text-muted-foreground",
} as const;

const fmtInt = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtClicks = (n: number) => (n === 0 ? "0" : n < 10 ? n.toFixed(1) : fmtInt(n));

type SortMode = "clicks" | "value";

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
  const [category, setCategory] = useState<TaskCategory | "all">("all");
  const [quickOnly, setQuickOnly] = useState(false);
  const [sort, setSort] = useState<SortMode>("clicks");
  const [showAll, setShowAll] = useState(false);

  const byCategory = useMemo(() => {
    const c: Partial<Record<TaskCategory, { count: number; clicks: number }>> = {};
    for (const o of opportunities) {
      const k = categoryOf(o);
      const cur = c[k] ?? { count: 0, clicks: 0 };
      c[k] = { count: cur.count + 1, clicks: cur.clicks + o.estClicksGain };
    }
    return c;
  }, [opportunities]);

  const list = useMemo(() => {
    let l = opportunities;
    if (category !== "all") l = l.filter((o) => categoryOf(o) === category);
    if (quickOnly) l = l.filter((o) => o.quickWin);
    return l.slice().sort((a, b) =>
      sort === "clicks"
        ? b.estClicksGain - a.estClicksGain || b.priority - a.priority
        : b.priority - a.priority);
  }, [opportunities, category, quickOnly, sort]);

  const shown = showAll ? list : list.slice(0, 12);
  const quickWins = opportunities.filter((o) => o.quickWin).length;
  const listClicks = list.reduce((s, o) => s + o.estClicksGain, 0);
  const activeHint = TASK_CATEGORIES.find((c) => c.id === category)?.hint;

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
          ? "Every estimate is worked out the same way: for each search the page appears in, monthly impressions × (the click-through rate the fix should reach − the rate it earns today), added up and scaled down for uncertainty. Open “How this is calculated” on any task to see its numbers. A typical click-through curve sets the targets, so treat the totals as a way to order the work rather than a forecast."
          : "Search Console isn't connected, so there are no impressions to estimate clicks from and every task shows 0. Connect it to rank by real impressions and positions."}
        {gscOk && !ga4Ok && " GA4 isn't connected, so “Best value” doesn't factor in engagement."}
      </p>

      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2">
        What needs doing
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Chip active={category === "all"} onClick={() => setCategory("all")}>
          All {opportunities.length}
        </Chip>
        {TASK_CATEGORIES.filter((c) => byCategory[c.id]).map((c) => (
          <Chip
            key={c.id}
            active={category === c.id}
            onClick={() => setCategory(category === c.id ? "all" : c.id)}
            title={c.hint}
            testId={`chip-category-${c.id}`}
          >
            {c.label} {byCategory[c.id]!.count}
            {gscOk && byCategory[c.id]!.clicks >= 1 && (
              <span className="opacity-70">· +{fmtInt(byCategory[c.id]!.clicks)}</span>
            )}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Chip active={quickOnly} onClick={() => setQuickOnly((v) => !v)}>
          <Zap className="w-3 h-3" /> Quick wins only
        </Chip>
        <span className="mx-1 h-5 w-px bg-border" />
        <span className="text-xs text-muted-foreground">Sort</span>
        <Chip active={sort === "clicks"} onClick={() => setSort("clicks")} testId="sort-clicks"
          title="Largest estimated monthly click gain first">
          Most clicks
        </Chip>
        <Chip active={sort === "value"} onClick={() => setSort("value")} testId="sort-value"
          title="Clicks weighted by search intent and visitor engagement, divided by effort">
          Best value for effort
        </Chip>
      </div>
      {(activeHint || category !== "all" || quickOnly) && (
        <p className="text-xs text-muted-foreground mb-3 tabular-nums">
          {activeHint && <>{activeHint}. </>}
          {list.length} task{list.length === 1 ? "" : "s"}
          {gscOk && <> · ≈ +{fmtInt(listClicks)} clicks / month between them</>}
        </p>
      )}

      {shown.length === 0 ? (
        <div className="border border-border p-8 text-sm text-muted-foreground">
          {opportunities.length === 0
            ? "Nothing stands out right now. Opportunities appear as Search Console gathers impressions."
            : "No opportunities match these filters."}
        </div>
      ) : (
        <ol className="border border-border divide-y divide-border">
          {shown.map((o, i) => (
            <OpportunityRow
              key={o.id}
              o={o}
              rank={i + 1}
              gscOk={gscOk}
              pending={pending}
              onFix={onFix}
              onOpenPage={onOpenPage}
            />
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

const MAX_PATHS = 4;

function OpportunityRow({
  o, rank, gscOk, pending, onFix, onOpenPage,
}: {
  o: Opportunity;
  rank: number;
  gscOk: boolean;
  pending: string | null;
  onFix: (subject: FixSubject) => void;
  onOpenPage: (path: string) => void;
}) {
  const [showMath, setShowMath] = useState(false);
  const [allPaths, setAllPaths] = useState(false);
  const paths = allPaths ? o.paths : o.paths.slice(0, MAX_PATHS);

  return (
    <li className="p-4 bg-card" data-testid={`opportunity-${o.id}`}>
      <div className="flex flex-col lg:flex-row lg:items-start gap-4">
        <div className="font-serif text-xl text-muted-foreground w-7 shrink-0 tabular-nums">{rank}</div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 bg-secondary">
              {OPPORTUNITY_LABELS[o.type] ?? o.type}
            </span>
            <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 border ${EFFORT_STYLES[o.effort]}`}>
              {EFFORT_LABELS[o.effort]}
            </span>
            {o.quickWin && (
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-emerald-500/40 text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                <Zap className="w-2.5 h-2.5" /> Quick win
              </span>
            )}
            {o.template && (
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-border text-muted-foreground flex items-center gap-1">
                <LayoutTemplate className="w-2.5 h-2.5" /> One template change · {o.paths.length} pages
              </span>
            )}
          </div>
          <div className="text-sm font-medium">{o.headline}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
            {paths.map((p) => (
              <button
                key={p}
                onClick={() => onOpenPage(p)}
                className="font-mono text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground break-all text-left"
              >
                {p}
              </button>
            ))}
            {o.paths.length > MAX_PATHS && (
              <button onClick={() => setAllPaths((v) => !v)} className="text-xs text-muted-foreground hover:text-foreground">
                {allPaths ? "show fewer" : `+${o.paths.length - MAX_PATHS} more`}
              </button>
            )}
            {o.paths.length === 0 && <span className="font-mono text-xs text-muted-foreground">new page</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{o.why}</p>
          <p className="text-xs mt-1.5 leading-relaxed">
            <span className="text-muted-foreground">Fix: </span>
            {o.action}
          </p>
          {o.estimate && (
            <button
              onClick={() => setShowMath((v) => !v)}
              className="mt-2 text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground"
              aria-expanded={showMath}
              data-testid={`button-math-${o.id}`}
            >
              <Calculator className="w-3 h-3" /> How this is calculated
              <ChevronDown className={`w-3 h-3 transition-transform ${showMath ? "rotate-180" : ""}`} />
            </button>
          )}
          {showMath && o.estimate && <EstimateBreakdown e={o.estimate} total={o.estClicksGain} />}
        </div>
        <div className="flex lg:flex-col items-center lg:items-end justify-between gap-3 shrink-0 lg:w-56">
          <div className="text-xs tabular-nums text-muted-foreground lg:text-right space-y-0.5">
            <div
              className={`font-serif text-2xl leading-none ${o.estClicksGain > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}
              data-testid={`gain-${o.id}`}
            >
              +{fmtClicks(o.estClicksGain)}
            </div>
            <div className="mb-1">clicks / month{o.estClicksGain === 0 && gscOk ? " (no direct gain)" : ""}</div>
            {o.basis === "search-console" && o.metrics.impressions > 0 && (
              <div>
                {fmtInt(o.metrics.impressions)} impr · {fmtPct(o.metrics.ctr)} CTR
                {o.metrics.position != null && <> · pos {o.metrics.position}</>}
              </div>
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
  );
}

/** The working behind one estimate: each search's monthly impressions times
 *  the click-through gap, summed, then scaled. */
function EstimateBreakdown({ e, total }: { e: GainEstimate; total: number }) {
  const showPath = e.lines.some((l) => l.path);
  return (
    <div className="mt-2 border border-border bg-background p-3 text-xs space-y-2" data-testid="estimate-breakdown">
      <p className="leading-relaxed">
        <span className="font-semibold">Assumption: </span>
        {e.method}
      </p>
      {e.lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full tabular-nums min-w-[480px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="text-left font-semibold py-1 pr-2">Search</th>
                <th className="text-right font-semibold py-1 px-2">Pos</th>
                <th className="text-right font-semibold py-1 px-2">Impr / mo</th>
                <th className="text-right font-semibold py-1 px-2">CTR now → target</th>
                <th className="text-right font-semibold py-1 pl-2">Clicks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {e.lines.map((l, i) => (
                <tr key={`${l.label}-${l.path ?? ""}-${i}`}>
                  <td className="py-1 pr-2">
                    {l.label}
                    {showPath && l.path && <span className="block font-mono text-[10px] text-muted-foreground">{l.path}</span>}
                  </td>
                  <td className="text-right py-1 px-2">{l.position ?? "—"}</td>
                  <td className="text-right py-1 px-2">{fmtInt(l.monthlyImpressions)}</td>
                  <td className="text-right py-1 px-2 whitespace-nowrap">
                    {fmtPct(l.ctrNow)} → {fmtPct(l.ctrTarget)}
                  </td>
                  <td className="text-right py-1 pl-2 text-emerald-700 dark:text-emerald-400">+{fmtClicks(l.clicks)}</td>
                </tr>
              ))}
              {e.otherLines > 0 && (
                <tr className="text-muted-foreground">
                  <td className="py-1 pr-2" colSpan={4}>
                    {e.otherLines} more search{e.otherLines === 1 ? "" : "es"}
                  </td>
                  <td className="text-right py-1 pl-2">+{fmtClicks(e.otherClicks)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {e.lines.length > 0 && (
        <div className="border-t border-border pt-2 space-y-0.5 tabular-nums">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Subtotal (impressions × CTR gap, all searches)</span>
            <span>+{fmtClicks(e.subtotal)}</span>
          </div>
          {e.factor !== 1 && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{e.factorReason ?? `× ${e.factor}`}</span>
              <span>× {e.factor}</span>
            </div>
          )}
          <div className="flex justify-between gap-3 font-semibold">
            <span>Estimated gain</span>
            <span>+{fmtClicks(total)} clicks / month</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({
  active, onClick, children, title, testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      data-testid={testId}
      className={`h-8 px-3 text-xs border rounded-sm flex items-center gap-1.5 tabular-nums transition-colors ${
        active ? "border-foreground bg-foreground text-background" : "border-border hover:border-foreground/40"
      }`}
    >
      {children}
    </button>
  );
}
