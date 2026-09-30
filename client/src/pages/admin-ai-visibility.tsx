// /admin/ai-visibility — how often ChatGPT and Perplexity name or cite
// Spencer when asked the questions buyers and sellers ask, and who they name
// instead. Data and scheduling live in server/ai-visibility.ts.
import { Fragment, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Play, Plus, Trash2, ChevronDown, ChevronRight, AlertTriangle, Check, X, Loader2, Sparkles, Lightbulb } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, apiErrorMessage } from "@/lib/queryClient";
import { FixDialog } from "@/components/seo/fix-dialog";

type Engine = "chatgpt" | "perplexity";
const ENGINE_LABEL: Record<Engine, string> = { chatgpt: "ChatGPT", perplexity: "Perplexity" };

interface EngineSummary {
  engine: Engine;
  checked: number;
  mentioned: number;
  cited: number;
  errors: number;
}
interface Result {
  promptId: number;
  prompt: string;
  engine: Engine;
  answer: string;
  citations: { url: string; title?: string }[];
  mentioned: boolean;
  cited: boolean;
  position: number | null;
  competitors: string[];
  error: string | null;
}
interface Report {
  engines: Record<Engine, boolean>;
  extractor: boolean;
  running: boolean;
  schedule: { intervalDays: number; nextRunAt: string | null };
  estimatedCostPerRun: number;
  prompts: { id: number; text: string; active: boolean }[];
  runs: {
    id: number;
    startedAt: string;
    finishedAt: string | null;
    status: "running" | "done" | "failed";
    trigger: string;
    promptCount: number;
    error: string | null;
    engines: EngineSummary[];
  }[];
  latestRunId: number | null;
  results: Result[];
  competitors: { name: string; mentions: number; engines: Engine[]; prompts: string[] }[];
  /** The crawled SEO report "Improve" plans against is ready. */
  seoReady: boolean;
  suggestions: {
    status: "generating" | "ready" | "failed";
    createdAt: string;
    error: string | null;
    items: Suggestion[];
  } | null;
}

type Level = "high" | "medium" | "low";
interface Suggestion {
  question: string;
  relatedQuery: string;
  demand: Level;
  demandEvidence: string;
  conversion: Level;
  conversionWhy: string;
  lowHanging: Level;
  lowHangingWhy: string;
  bestPage: string;
  score: number;
}

const LEVEL_STYLE: Record<Level, string> = {
  high: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  medium: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
};

function LevelChip({ label, level, why }: { label: string; level: Level; why: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded-sm text-[10px] whitespace-nowrap ${LEVEL_STYLE[level]}`} title={why}>
      {label}: {level}
    </span>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const errMsg = (e: any) => String(e?.message ?? "Try again").replace(/^\d+:\s*/, "").replace(/^\{"message":"(.*)"\}$/, "$1");

export default function AdminAiVisibilityPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newPrompt, setNewPrompt] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const { data, isLoading } = useQuery<Report>({
    queryKey: ["/api/admin/ai-visibility"],
    // Poll while a check runs so the results appear when it finishes.
    // Poll while a check runs or suggestions are being written, and more
    // slowly while the site data "Improve" needs is still being prepared.
    refetchInterval: (q) => {
      const d = q.state.data as Report | undefined;
      if (d?.running || d?.suggestions?.status === "generating") return 5000;
      return d && !d.seoReady ? 15000 : false;
    },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["/api/admin/ai-visibility"] });

  const run = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/ai-visibility/run"),
    onSuccess: () => {
      toast({ title: "Check started", description: "Results appear here in a few minutes." });
      refresh();
    },
    onError: (e) => toast({ title: "Couldn't start", description: errMsg(e), variant: "destructive" }),
  });
  const add = useMutation({
    mutationFn: (text: string) => apiRequest("POST", "/api/admin/ai-visibility/prompts", { text }),
    onSuccess: () => {
      setNewPrompt("");
      refresh();
    },
    onError: (e) => toast({ title: "Couldn't add", description: errMsg(e), variant: "destructive" }),
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiRequest("PATCH", `/api/admin/ai-visibility/prompts/${id}`, { active }),
    onSuccess: refresh,
  });
  const [fixId, setFixId] = useState<number | null>(null);
  const [pendingFix, setPendingFix] = useState<number | null>(null);
  const improve = useMutation({
    mutationFn: async (promptId: number) => {
      setPendingFix(promptId);
      const r = await apiRequest("POST", "/api/admin/seo/fixes", { kind: "ai_question", promptId });
      return (await r.json()) as { id: number };
    },
    onSuccess: ({ id }) => setFixId(id),
    onError: (e) => toast({ title: "Couldn't start", description: apiErrorMessage(e), variant: "destructive" }),
    onSettled: () => setPendingFix(null),
  });
  const suggest = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/ai-visibility/suggestions"),
    onSuccess: refresh,
    onError: (e) => toast({ title: "Couldn't start", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/ai-visibility/prompts/${id}`),
    onSuccess: refresh,
  });

  if (isLoading || !data) {
    return (
      <AppShell pageTitle="AI Visibility">
        <div className="p-6 text-sm text-muted-foreground">Loading…</div>
      </AppShell>
    );
  }

  const engines = (Object.keys(data.engines) as Engine[]).filter((e) => data.engines[e]);
  const latest = data.runs.find((r) => r.id === data.latestRunId);
  const byPrompt = new Map<number, Partial<Record<Engine, Result>>>();
  for (const r of data.results) {
    const m = byPrompt.get(r.promptId) ?? {};
    m[r.engine] = r;
    byPrompt.set(r.promptId, m);
  }
  const positions = data.results.filter((r) => r.position).map((r) => r.position as number);
  const activeCount = data.prompts.filter((p) => p.active).length;

  return (
    <AppShell pageTitle="AI Visibility">
      <div className="p-6 max-w-[1400px] mx-auto">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="font-serif text-3xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
              AI Visibility
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-[760px]">
              Each check asks {engines.length ? engines.map((e) => ENGINE_LABEL[e]).join(" and ") : "the AI assistants"} the
              questions below, with web search on, and records whether you're named or cited and who's named instead.
              Answers vary between runs, so read the trend rather than any single result.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {data.schedule.nextRunAt
                ? `Runs every ${data.schedule.intervalDays} days · next ${fmtDate(data.schedule.nextRunAt)}`
                : "Automatic checks are off"}
              {" · "}about ${data.estimatedCostPerRun.toFixed(2)} per check ({activeCount} questions × {engines.length || 0}{" "}
              {engines.length === 1 ? "engine" : "engines"})
            </p>
          </div>
          <Button
            onClick={() => run.mutate()}
            disabled={data.running || run.isPending || !engines.length}
            data-testid="btn-run-ai-visibility"
          >
            {data.running ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.8} />
            )}
            {data.running ? "Checking…" : "Run check now"}
          </Button>
        </div>

        {(!data.engines.chatgpt || !data.engines.perplexity || !data.extractor) && (
          <Card className="mb-6 border-amber-500/40">
            <CardContent className="p-4 flex gap-2.5 text-sm text-foreground/80">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" strokeWidth={1.6} />
              <div className="space-y-1">
                {!data.engines.chatgpt && <div>ChatGPT isn't connected — set <code>OPENAI_API_KEY</code> on the server.</div>}
                {!data.engines.perplexity && (
                  <div>
                    Perplexity isn't connected — set <code>PERPLEXITY_API_KEY</code> (from perplexity.ai → API) on the server.
                  </div>
                )}
                {!data.extractor && (
                  <div>
                    Competitor names need <code>ANTHROPIC_API_KEY</code>; until then competitors are the sites the answers cite.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Latest check */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {(latest?.engines ?? []).map((e) => (
            <Card key={e.engine}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Bot className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.6} />
                  <div className="eyebrow text-muted-foreground">{ENGINE_LABEL[e.engine]} mentions you</div>
                </div>
                <div className="font-serif text-2xl" style={{ letterSpacing: "-0.02em" }}>
                  {pct(e.mentioned, e.checked)}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {e.mentioned} of {e.checked} answers · cited as a source in {e.cited}
                  {e.errors ? ` · ${e.errors} failed` : ""}
                </div>
              </CardContent>
            </Card>
          ))}
          {latest && (
            <Card>
              <CardContent className="p-4">
                <div className="eyebrow text-muted-foreground mb-2">Average rank when named</div>
                <div className="font-serif text-2xl" style={{ letterSpacing: "-0.02em" }}>
                  {positions.length ? (positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1) : "—"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  among the agents an answer recommends · checked {fmtDate(latest.startedAt)}
                </div>
              </CardContent>
            </Card>
          )}
          {!latest && (
            <Card className="md:col-span-3">
              <CardContent className="p-5 text-sm text-muted-foreground">
                {data.running ? "The first check is running — results appear here in a few minutes." : "No checks yet. Run one to get a baseline."}
              </CardContent>
            </Card>
          )}
        </div>

        <SuggestionsCard
          data={data.suggestions}
          starting={suggest.isPending}
          onSuggest={() => suggest.mutate()}
          onAdd={(q) => add.mutate(q)}
          adding={add.isPending}
        />

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 mb-6">
          {/* Questions */}
          <Card>
            <CardContent className="p-5">
              <div className="eyebrow text-muted-foreground mb-3">Questions checked</div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground text-[10px] tracking-[0.1em] uppercase">
                  <tr>
                    <th className="text-left py-1.5 font-medium">Question</th>
                    {engines.map((e) => (
                      <th key={e} className="text-center font-medium w-[96px]">
                        {ENGINE_LABEL[e]}
                      </th>
                    ))}
                    <th className="w-[150px]" />
                  </tr>
                </thead>
                <tbody>
                  {data.prompts.map((p) => {
                    const res = byPrompt.get(p.id) ?? {};
                    const isOpen = open === p.id;
                    return (
                      <Fragment key={p.id}>
                        <tr className={`border-t border-border/60 ${p.active ? "" : "opacity-50"}`}>
                          <td className="py-2 pr-2">
                            <button
                              type="button"
                              className="flex items-start gap-1 text-left hover:underline"
                              onClick={() => setOpen(isOpen ? null : p.id)}
                              disabled={!Object.keys(res).length}
                            >
                              {Object.keys(res).length ? (
                                isOpen ? <ChevronDown className="w-3 h-3 mt-0.5 shrink-0" /> : <ChevronRight className="w-3 h-3 mt-0.5 shrink-0" />
                              ) : (
                                <span className="w-3 shrink-0" />
                              )}
                              {p.text}
                            </button>
                          </td>
                          {engines.map((e) => {
                            const r = res[e];
                            return (
                              <td key={e} className="text-center">
                                {!r ? (
                                  <span className="text-muted-foreground">—</span>
                                ) : r.error ? (
                                  <span className="text-destructive/80" title={r.error}>error</span>
                                ) : r.mentioned ? (
                                  <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
                                    <Check className="w-3 h-3" />
                                    {r.position ? `#${r.position}` : "named"}
                                    {r.cited ? " · cited" : ""}
                                  </span>
                                ) : (
                                  <X className="w-3 h-3 inline text-muted-foreground" />
                                )}
                              </td>
                            );
                          })}
                          <td className="text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => improve.mutate(p.id)}
                              disabled={!Object.keys(res).length || !data.seoReady || pendingFix !== null}
                              className="mr-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-border text-[11px] hover:bg-muted disabled:opacity-40 align-middle"
                              title={
                                !Object.keys(res).length
                                  ? "Run a check first"
                                  : !data.seoReady
                                    ? "Preparing site data — ready in a minute or two"
                                    : "Draft changes to win this question in AI answers"
                              }
                              data-testid={`btn-improve-${p.id}`}
                            >
                              {pendingFix === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                              Improve
                            </button>
                            <Switch
                              checked={p.active}
                              onCheckedChange={(v) => toggle.mutate({ id: p.id, active: v })}
                              className="scale-75 align-middle"
                              aria-label="Include in checks"
                            />
                            <button
                              type="button"
                              onClick={() => remove.mutate(p.id)}
                              className="ml-1 text-muted-foreground hover:text-destructive align-middle"
                              aria-label="Delete question"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={engines.length + 2} className="pb-4">
                              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-1">
                                {engines.map((e) => {
                                  const r = res[e];
                                  if (!r) return null;
                                  return (
                                    <div key={e} className="rounded-sm border border-border p-3 bg-muted/30">
                                      <div className="eyebrow text-muted-foreground mb-1.5">{ENGINE_LABEL[e]}</div>
                                      {r.error ? (
                                        <div className="text-destructive/80">{r.error}</div>
                                      ) : (
                                        <>
                                          <div className="whitespace-pre-wrap leading-relaxed max-h-[320px] overflow-y-auto">{r.answer}</div>
                                          {r.competitors.length > 0 && (
                                            <div className="mt-2 text-muted-foreground">
                                              <span className="font-medium text-foreground">Named instead:</span> {r.competitors.join(", ")}
                                            </div>
                                          )}
                                          {r.citations.length > 0 && (
                                            <div className="mt-2 text-muted-foreground">
                                              <span className="font-medium text-foreground">Sources:</span>{" "}
                                              {r.citations.slice(0, 8).map((c, i) => (
                                                <a key={c.url} href={c.url} target="_blank" rel="noopener noreferrer" className="underline">
                                                  {c.title || hostOf(c.url)}
                                                  {i < Math.min(r.citations.length, 8) - 1 ? ", " : ""}
                                                </a>
                                              ))}
                                            </div>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <form
                className="flex gap-2 mt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newPrompt.trim()) add.mutate(newPrompt.trim());
                }}
              >
                <Input
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  placeholder="Add a question a buyer or seller would ask an AI assistant"
                  className="h-9"
                  data-testid="input-new-prompt"
                />
                <Button type="submit" variant="outline" className="h-9" disabled={add.isPending || !newPrompt.trim()}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="space-y-4">
            {/* Competitors */}
            <Card>
              <CardContent className="p-5">
                <div className="eyebrow text-muted-foreground mb-3">
                  {data.extractor ? "Named instead of you" : "Sites cited instead of you"}
                </div>
                {data.competitors.length ? (
                  <ul className="space-y-1.5 text-xs">
                    {data.competitors.map((c) => (
                      <li key={c.name} className="flex justify-between gap-2" title={c.prompts.join("\n")}>
                        <span className="truncate">{c.name}</span>
                        <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                          {c.mentions}× · {c.engines.map((e) => ENGINE_LABEL[e]).join(", ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-xs text-muted-foreground">Appears after the first check.</div>
                )}
              </CardContent>
            </Card>

            {/* History */}
            <Card>
              <CardContent className="p-5">
                <div className="eyebrow text-muted-foreground mb-3">Check history</div>
                {data.runs.length ? (
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground text-[10px] tracking-[0.1em] uppercase">
                      <tr>
                        <th className="text-left py-1 font-medium">Date</th>
                        {engines.map((e) => (
                          <th key={e} className="text-right font-medium">
                            {ENGINE_LABEL[e]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.runs.map((r) => (
                        <tr key={r.id} className="border-t border-border/60" title={r.error ?? ""}>
                          <td className="py-1.5">
                            {fmtDate(r.startedAt)}
                            {r.status === "running" && <span className="ml-1 text-muted-foreground">(running)</span>}
                            {r.status === "failed" && <span className="ml-1 text-destructive/80">(failed)</span>}
                          </td>
                          {engines.map((e) => {
                            const s = r.engines.find((x) => x.engine === e);
                            return (
                              <td key={e} className="text-right tabular-nums">
                                {s ? pct(s.mentioned, s.checked) : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="text-xs text-muted-foreground">No checks yet.</div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
      <FixDialog fixId={fixId} onClose={() => setFixId(null)} onRevised={setFixId} />
    </AppShell>
  );
}

function SuggestionsCard({
  data,
  starting,
  onSuggest,
  onAdd,
  adding,
}: {
  data: Report["suggestions"];
  starting: boolean;
  onSuggest: () => void;
  onAdd: (question: string) => void;
  adding: boolean;
}) {
  const generating = data?.status === "generating";
  return (
    <Card className="mb-6">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <div className="eyebrow text-muted-foreground">Suggested questions</div>
            <p className="text-xs text-muted-foreground mt-1 max-w-[760px]">
              Questions worth tracking, ranked by likelihood of turning into a client, how close you already are, and
              demand. Demand comes from your Search Console impressions for related searches; AI tools publish no
              search volume. Hover a rating for the reasoning.
            </p>
          </div>
          <Button variant="outline" onClick={onSuggest} disabled={starting || generating} data-testid="btn-suggest">
            {generating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Lightbulb className="w-3.5 h-3.5 mr-1.5" />}
            {generating ? "Thinking…" : data ? "Suggest again" : "Suggest questions"}
          </Button>
        </div>
        {!data && <div className="text-xs text-muted-foreground">No suggestions yet.</div>}
        {data?.status === "failed" && <div className="text-xs text-destructive/80">{data.error ?? "Failed — try again."}</div>}
        {generating && <div className="text-xs text-muted-foreground">Reviewing your search data and results — about a minute.</div>}
        {data?.status === "ready" && data.items.length === 0 && (
          <div className="text-xs text-muted-foreground">Every suggestion has been added. Suggest again for more.</div>
        )}
        {data?.status === "ready" && data.items.length > 0 && (
          <ul className="divide-y divide-border/60">
            {data.items.map((s) => (
              <li key={s.question} className="py-2.5 flex items-start gap-3">
                <div className="w-9 shrink-0 text-center font-serif text-lg tabular-nums" title="Priority score (0–100)">
                  {s.score}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{s.question}</div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    <LevelChip label="Conversion" level={s.conversion} why={s.conversionWhy} />
                    <LevelChip label="Low-hanging" level={s.lowHanging} why={s.lowHangingWhy} />
                    <LevelChip label="Demand" level={s.demand} why={s.demandEvidence} />
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {s.demandEvidence}
                    {s.bestPage ? ` · best page: ${s.bestPage}` : ""}
                  </div>
                </div>
                <Button size="sm" variant="outline" className="h-7" onClick={() => onAdd(s.question)} disabled={adding}>
                  <Plus className="w-3 h-3 mr-1" /> Add
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
