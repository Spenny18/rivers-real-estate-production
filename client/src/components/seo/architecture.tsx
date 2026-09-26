// Site architecture — the cluster map as a whole.
//
// Each topic cluster should work as a hub: one pillar that owns the head term
// and links down to a page per sub-topic, each of which links back up. The
// audit behind this (server/seo-architecture.ts) measures that from the
// crawl's link graph and Search Console; this section shows it per cluster,
// lists clusters that are forming on their own, and lets the cluster map be
// edited or handed to Claude to plan.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Network, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import type { ClusterAudit, ClusterCandidate, FixSubject } from "./types";

interface ClusterSummary {
  id: string; label: string; pillar: string; headKeyword: string; intent: string;
  pages: number; avgScore: number; conflicts: number;
}

const FLAG_LABELS: Record<string, string> = {
  pillar_missing: "pillar page is broken",
  thin: "thin — under 3 pages",
  sprawl: "sprawling — needs sub-hubs",
  pillar_not_owner: "pillar doesn't own its head term",
  deep: "pages sit deep",
};

function Coverage({ label, n, of }: { label: string; n: number; of: number }) {
  const pct = of ? Math.round((n / of) * 100) : 100;
  const tone = pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div>
      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{label}</span>
        <span>{n}/{of}</span>
      </div>
      <div className="h-1 bg-secondary mt-1 overflow-hidden rounded-sm">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ArchitectureSection({
  clusters,
  audits,
  candidates,
  livePaths,
  clusterFilter,
  onFilter,
  pending,
  onPlan,
}: {
  clusters: ClusterSummary[];
  audits: ClusterAudit[];
  candidates: ClusterCandidate[];
  livePaths: string[];
  clusterFilter: string;
  onFilter: (id: string) => void;
  pending: string | null;
  onPlan: (subject: FixSubject, key: string) => void;
}) {
  const [editing, setEditing] = useState<EditorState | null>(null);
  const auditOf = (id: string) => audits.find((a) => a.id === id);

  return (
    <section data-testid="section-architecture">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-1">
        <h2 className="font-serif text-2xl flex items-center gap-2">
          <Network className="w-5 h-5" /> Site architecture
        </h2>
        <Button
          variant="outline"
          size="sm"
          className="rounded-sm gap-1.5 text-xs"
          onClick={() => setEditing({ mode: "new", value: blankCluster() })}
          data-testid="button-cluster-new"
        >
          <Plus className="w-3.5 h-3.5" /> New cluster
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-4 max-w-3xl">
        Each cluster should work as a hub: one pillar that owns the head term and links to a page per
        sub-topic, and each of those linking back up. Coverage counts links in the page body only — nav
        and footer links are on every page, so they don't say which page matters.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {clusters.map((c) => {
          const a = auditOf(c.id);
          const hub = a && c.id !== "journal" && c.id !== "trust";
          const owner = a?.headTerm;
          return (
            <div
              key={c.id}
              className={`border p-4 flex flex-col gap-3 ${clusterFilter === c.id ? "border-foreground bg-secondary/50" : "border-border bg-card"}`}
              data-testid={`cluster-${c.id}`}
            >
              <button className="text-left" onClick={() => onFilter(c.id)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="font-semibold text-sm">{c.label}</div>
                  {a && (
                    <span
                      className={`text-[10px] tabular-nums px-1.5 py-0.5 border ${
                        a.health >= 75 ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                          : a.health >= 50 ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
                            : "border-rose-500/40 text-rose-700 dark:text-rose-400"
                      }`}
                      title="Structural health"
                    >
                      {a.health}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1.5 font-mono">{c.pillar}</div>
                <div className="text-xs mt-1">owns <span className="font-semibold">{c.headKeyword}</span></div>
                <div className="flex items-center gap-4 mt-2 text-xs tabular-nums text-muted-foreground">
                  <span>{c.pages} pages</span>
                  <span>avg {c.avgScore}</span>
                  {a?.avgDepth != null && <span>depth {a.avgDepth}</span>}
                  {c.conflicts > 0 && (
                    <span className="text-rose-600 dark:text-rose-400">{c.conflicts} conflict{c.conflicts === 1 ? "" : "s"}</span>
                  )}
                </div>
              </button>

              {hub && a.children.length > 0 && (
                <div className="space-y-2">
                  <Coverage label="Pillar links to children" n={a.linkedFromPillar} of={a.children.length} />
                  <Coverage label="Children link back up" n={a.linkingUp} of={a.children.length} />
                </div>
              )}

              {hub && owner?.owner && (
                <div className="text-xs flex items-start gap-1.5">
                  {owner.owner === c.pillar ? (
                    <><Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> Pillar gets the most head-term demand</>
                  ) : (
                    <><AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                      <span>Outranked by <span className="font-mono">{owner.owner}</span> for its head term</span></>
                  )}
                </div>
              )}

              {a && (a.flags.length > 0 || a.gaps.length > 0) && (
                <div className="flex flex-wrap gap-1">
                  {a.flags.filter((f) => f !== "pillar_not_owner").map((f) => (
                    <span key={f} className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-amber-500/30 text-amber-700 dark:text-amber-400">
                      {FLAG_LABELS[f] ?? f}
                    </span>
                  ))}
                  {a.gaps.length > 0 && (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-border text-muted-foreground"
                      title={a.gaps.map((g) => g.query).join("\n")}>
                      {a.gaps.length} uncovered search{a.gaps.length === 1 ? "" : "es"}
                    </span>
                  )}
                </div>
              )}

              <div className="flex gap-2 mt-auto pt-1">
                <Button
                  size="sm"
                  onClick={() => onPlan({ kind: "cluster", clusterId: c.id }, `cluster:${c.id}`)}
                  disabled={pending !== null}
                  className="gap-1.5 rounded-sm font-display text-[10px] tracking-[0.14em] flex-1"
                  data-testid={`button-plan-${c.id}`}
                >
                  <Sparkles className={`w-3.5 h-3.5 ${pending === `cluster:${c.id}` ? "animate-pulse" : ""}`} />
                  PLAN WITH CLAUDE
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-sm"
                  aria-label={`Edit ${c.label}`}
                  onClick={() => setEditing({ mode: "edit", id: c.id, factory: auditOf(c.id)?.factory, value: null })}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {candidates.length > 0 && (
        <div className="mt-6" data-testid="section-candidates">
          <h3 className="font-display text-[11px] tracking-[0.16em] text-muted-foreground mb-2">
            CLUSTERS FORMING ON THEIR OWN
          </h3>
          <div className="border border-border divide-y divide-border">
            {candidates.map((cand) => (
              <div key={cand.id} className="p-4 bg-card flex flex-col lg:flex-row lg:items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{cand.label} · {cand.pages.length} posts</div>
                  <p className="text-xs text-muted-foreground mt-1">{cand.why}</p>
                  <div className="text-xs mt-1.5">
                    Suggested pillar <span className="font-mono">{cand.suggestedPillar ?? "a new page"}</span> ·
                    head term “{cand.headKeyword}”
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
                    {cand.pages.map((p) => <span key={p} className="font-mono text-[11px] text-muted-foreground">{p}</span>)}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-sm text-xs"
                    onClick={() => setEditing({
                      mode: "new",
                      value: {
                        label: cand.label,
                        pillar: cand.suggestedPillar ?? "",
                        headKeyword: cand.headKeyword,
                        intent: "informational",
                        prefixes: "",
                        vocabulary: cand.subject,
                        members: cand.pages.join("\n"),
                      },
                    })}
                    data-testid={`button-adopt-${cand.id}`}
                  >
                    Adopt
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => onPlan({ kind: "candidate", candidateId: cand.id }, `candidate:${cand.id}`)}
                    disabled={pending !== null}
                    className="gap-1.5 rounded-sm font-display text-[10px] tracking-[0.14em]"
                  >
                    <Sparkles className={`w-3.5 h-3.5 ${pending === `candidate:${cand.id}` ? "animate-pulse" : ""}`} />
                    PLAN WITH CLAUDE
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ClusterEditor state={editing} livePaths={livePaths} onClose={() => setEditing(null)} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cluster editor
// ---------------------------------------------------------------------------

interface FormValue {
  label: string; pillar: string; headKeyword: string; intent: string;
  prefixes: string; vocabulary: string; members: string;
}
type EditorState =
  | { mode: "new"; value: FormValue }
  | { mode: "edit"; id: string; factory?: boolean; value: FormValue | null };

const blankCluster = (): FormValue => ({
  label: "", pillar: "", headKeyword: "", intent: "informational", prefixes: "", vocabulary: "", members: "",
});

function ClusterEditor({
  state,
  livePaths,
  onClose,
}: {
  state: EditorState | null;
  livePaths: string[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormValue | null>(null);

  // Editing loads the stored definition (the report only carries a summary).
  useEffect(() => {
    if (!state) { setForm(null); return; }
    if (state.mode === "new") { setForm(state.value); return; }
    let cancelled = false;
    setForm(null);
    apiRequest("GET", "/api/admin/seo/clusters")
      .then((r) => r.json())
      .then((d) => {
        const c = (d.clusters ?? []).find((x: any) => x.id === state.id);
        if (c && !cancelled) {
          setForm({
            label: c.label, pillar: c.pillar, headKeyword: c.headKeyword, intent: c.intent,
            prefixes: (c.prefixes ?? []).join("\n"), vocabulary: (c.vocabulary ?? []).join(", "),
            members: (c.members ?? []).join("\n"),
          });
        }
      })
      .catch((e) => toast({ title: "Couldn't load the cluster", description: apiErrorMessage(e), variant: "destructive" }));
    return () => { cancelled = true; };
  }, [state, toast]);

  const done = (title: string) => {
    toast({ title, description: "The report rescans in the background to regroup pages." });
    qc.invalidateQueries({ queryKey: ["/api/admin/seo/keywords"] });
    onClose();
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...form,
        prefixes: form!.prefixes.split(/[\n,]/),
        vocabulary: form!.vocabulary.split(/[\n,]/),
        members: form!.members.split(/[\n,]/),
      };
      if (state?.mode === "edit") await apiRequest("PUT", `/api/admin/seo/clusters/${state.id}`, body);
      else await apiRequest("POST", "/api/admin/seo/clusters", body);
    },
    onSuccess: () => done(state?.mode === "edit" ? "Cluster saved" : "Cluster created"),
    onError: (e) => toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (state?.mode === "edit") await apiRequest("DELETE", `/api/admin/seo/clusters/${state.id}`);
    },
    onSuccess: () => done("Cluster deleted"),
    onError: (e) => toast({ title: "Couldn't delete", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const set = (k: keyof FormValue) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
  const pillarOk = form ? livePaths.includes(form.pillar.trim()) : true;

  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl rounded-sm" data-testid="dialog-cluster">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl font-normal">
            {state?.mode === "edit" ? "Edit cluster" : "New cluster"}
          </DialogTitle>
          <DialogDescription>
            Pages join a cluster by being its pillar, a listed member, under one of its URL prefixes, or (blog
            posts) by using its vocabulary.
          </DialogDescription>
        </DialogHeader>
        {!form ? (
          <div className="py-8 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="grid gap-3 text-sm">
            <Field label="Name">
              <Input value={form.label} onChange={set("label")} className="rounded-sm h-9" />
            </Field>
            <Field label="Pillar page" hint={!pillarOk && form.pillar ? "Not a live page in the last scan" : undefined}>
              <Input value={form.pillar} onChange={set("pillar")} list="seo-live-paths" placeholder="/neighbourhoods/aspen-woods"
                className="rounded-sm h-9 font-mono text-xs" />
              <datalist id="seo-live-paths">
                {livePaths.map((p) => <option key={p} value={p} />)}
              </datalist>
            </Field>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="Head keyword (only the pillar targets this)">
                <Input value={form.headKeyword} onChange={set("headKeyword")} className="rounded-sm h-9" />
              </Field>
              <Field label="Intent">
                <select value={form.intent} onChange={set("intent")}
                  className="h-9 rounded-sm border border-input bg-background px-2 text-sm">
                  <option value="transactional">Transactional</option>
                  <option value="commercial">Commercial</option>
                  <option value="informational">Informational</option>
                  <option value="navigational">Navigational</option>
                </select>
              </Field>
            </div>
            <Field label="Vocabulary (comma-separated — classifies blog posts)">
              <Input value={form.vocabulary} onChange={set("vocabulary")} className="rounded-sm h-9" />
            </Field>
            <Field label="URL prefixes (one per line)">
              <Textarea value={form.prefixes} onChange={set("prefixes")} rows={2} className="rounded-sm font-mono text-xs" />
            </Field>
            <Field label="Member pages (one per line)">
              <Textarea value={form.members} onChange={set("members")} rows={4} className="rounded-sm font-mono text-xs" />
            </Field>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          {state?.mode === "edit" && !state.factory && (
            <Button variant="ghost" className="rounded-sm text-rose-600 mr-auto" onClick={() => remove.mutate()} disabled={remove.isPending}>
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete
            </Button>
          )}
          <Button variant="ghost" className="rounded-sm" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!form || save.isPending}
            className="rounded-sm font-display text-[11px] tracking-[0.16em]" data-testid="button-cluster-save">
            {save.isPending ? "SAVING…" : "SAVE"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-semibold">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-amber-700 dark:text-amber-400">{hint}</span>}
    </label>
  );
}
