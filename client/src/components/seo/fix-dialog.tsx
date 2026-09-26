// Review-and-apply dialog for a "Fix with Claude" proposal.
//
// Claude drafts in the background (server/seo-fix.ts); this polls until the
// draft lands, then shows every change as a before/after with a checkbox.
// Nothing touches the site until Apply, and only the ticked changes.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, Copy, ExternalLink, GitPullRequest, RefreshCw, Sparkles, Undo2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { STATUS_LABELS, type FixChange, type FixProposal, type PlannedTopic } from "./types";

async function getProposal(id: number): Promise<FixProposal> {
  const r = await apiRequest("GET", `/api/admin/seo/fixes/${id}`);
  return (await r.json()).proposal;
}

/** A code change that can't be delivered here can only be copied, not applied. */
const selectable = (c: FixChange) => !(c.op.type === "code_change" && c.delivery !== "github");

export function FixDialog({
  fixId,
  onClose,
  onDraftTopic,
}: {
  fixId: number | null;
  onClose: () => void;
  /** Start a new fix that drafts one roadmap topic as a post. */
  onDraftTopic?: (t: PlannedTopic) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [initialisedFor, setInitialisedFor] = useState<number | null>(null);

  const { data: p } = useQuery({
    queryKey: ["/api/admin/seo/fixes", fixId],
    queryFn: () => getProposal(fixId!),
    enabled: fixId !== null,
    refetchInterval: (q) => ((q.state.data as FixProposal | undefined)?.status === "generating" ? 2500 : false),
  });

  // Pre-tick everything except the destructive changes (redirects,
  // unpublishing) — those take a page out of the index, so they should be a
  // deliberate click.
  useEffect(() => {
    if (p && p.status === "ready" && initialisedFor !== p.id) {
      setSelected(new Set(p.changes.filter((c) => !c.destructive && selectable(c)).map((c) => c.index)));
      setInitialisedFor(p.id);
    }
  }, [p, initialisedFor]);

  const refresh = (next: FixProposal) => {
    qc.setQueryData(["/api/admin/seo/fixes", next.id], next);
    qc.invalidateQueries({ queryKey: ["/api/admin/seo/fixes"] });
    qc.invalidateQueries({ queryKey: ["/api/admin/seo/keywords"] });
  };

  const apply = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/admin/seo/fixes/${fixId}/apply`, { ops: Array.from(selected) });
      return (await r.json()).proposal as FixProposal;
    },
    onSuccess: (next) => {
      refresh(next);
      const failed = next.changes.filter((c) => c.result && !c.result.ok).length;
      toast(
        failed
          ? { title: `${failed} change${failed === 1 ? "" : "s"} could not be applied`, description: "The others are live. Details are in the dialog.", variant: "destructive" }
          : { title: "Fix applied", description: "It's live now. The report rescans in the background to re-score." },
      );
    },
    onError: (e) => toast({ title: "Apply failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const undo = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/admin/seo/fixes/${fixId}/undo`, {});
      return (await r.json()) as { proposal: FixProposal; skipped: string[] };
    },
    onSuccess: ({ proposal, skipped }) => {
      refresh(proposal);
      toast({
        title: "Fix undone",
        description: skipped.length ? skipped.join(" · ") : "Everything it changed is back to how it was.",
      });
    },
    onError: (e) => toast({ title: "Undo failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const dismiss = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/admin/seo/fixes/${fixId}/dismiss`, {});
      return (await r.json()).proposal as FixProposal;
    },
    onSuccess: (next) => {
      refresh(next);
      onClose();
    },
  });

  const toggle = (i: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  const applied = p && (p.status === "applied" || p.status === "partially_applied");

  return (
    <Dialog open={fixId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto rounded-sm" data-testid="dialog-fix">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl font-normal flex items-center gap-2">
            <Sparkles className="w-5 h-5" /> Fix with Claude
          </DialogTitle>
          <DialogDescription>{p?.subject?.label ?? "Loading…"}</DialogDescription>
        </DialogHeader>

        {!p || p.status === "generating" ? (
          <div className="py-12 flex flex-col items-center gap-3 text-sm text-muted-foreground text-center">
            <RefreshCw className="w-5 h-5 animate-spin" />
            <div>
              Claude is reading the page, its Search Console queries and the rest of the site,
              then drafting changes. This usually takes under a minute.
            </div>
            <div className="text-xs">You can close this — the draft will be waiting in Fix history.</div>
          </div>
        ) : p.status === "failed" ? (
          <div className="border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-700 dark:text-rose-400 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>{p.error ?? "The draft failed."}</div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="uppercase tracking-wider px-1.5 py-0.5 bg-secondary text-foreground">
                {STATUS_LABELS[p.status]}
              </span>
              {p.appliedAt && <span>applied {new Date(p.appliedAt).toLocaleString()}</span>}
            </div>

            {p.summary && <div className="text-sm font-medium">{p.summary}</div>}
            {p.rationale && <p className="text-sm text-muted-foreground leading-relaxed">{p.rationale}</p>}

            {p.changes.length === 0 ? (
              <div className="border border-border p-4 text-sm text-muted-foreground">
                Claude didn't propose any changes{p.dropped.length ? " that passed the safety checks" : ""}.
              </div>
            ) : (
              <div className="space-y-3">
                {p.changes.map((c) => (
                  <ChangeCard
                    key={c.index}
                    change={c}
                    checked={selected.has(c.index)}
                    onToggle={() => toggle(c.index)}
                    locked={p.status !== "ready" || !selectable(c)}
                  />
                ))}
              </div>
            )}

            {(p.planned?.length ?? 0) > 0 && (
              <div className="border border-border p-3" data-testid="fix-roadmap">
                <div className="text-[10px] uppercase tracking-[0.16em] font-semibold text-muted-foreground mb-2">
                  Content roadmap — pages worth writing next
                </div>
                <ol className="space-y-2">
                  {p.planned!.map((t, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm">
                      <span className="text-muted-foreground tabular-nums w-4 shrink-0">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{t.title}</div>
                        <div className="text-xs text-muted-foreground">
                          targets “{t.targetQuery}”{t.why ? ` — ${t.why}` : ""}
                        </div>
                      </div>
                      {onDraftTopic && t.clusterId && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-sm h-7 text-xs gap-1 shrink-0"
                          onClick={() => onDraftTopic(t)}
                        >
                          <Sparkles className="w-3 h-3" /> Draft this
                        </Button>
                      )}
                    </li>
                  ))}
                </ol>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Drafting opens a new fix; the post is saved as a draft for you to review and publish.
                </p>
              </div>
            )}

            {p.dropped.length > 0 && (
              <div className="text-xs text-muted-foreground border-l-2 border-amber-500 pl-3 space-y-1">
                <div className="uppercase tracking-wider text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                  Left out by the safety checks
                </div>
                {p.dropped.map((d, i) => <div key={i}>{d.reason}</div>)}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {p?.status === "ready" && (
            <>
              <Button variant="ghost" onClick={() => dismiss.mutate()} disabled={dismiss.isPending} className="rounded-sm">
                <X className="w-3.5 h-3.5 mr-1.5" /> Dismiss
              </Button>
              <Button
                onClick={() => apply.mutate()}
                disabled={apply.isPending || selected.size === 0}
                className="rounded-sm font-display text-[11px] tracking-[0.16em] gap-1.5"
                data-testid="button-fix-apply"
              >
                <Check className="w-3.5 h-3.5" />
                {apply.isPending ? "APPLYING…" : `APPLY ${selected.size} CHANGE${selected.size === 1 ? "" : "S"}`}
              </Button>
            </>
          )}
          {applied && (
            <Button
              variant="outline"
              onClick={() => undo.mutate()}
              disabled={undo.isPending}
              className="rounded-sm gap-1.5"
              data-testid="button-fix-undo"
            >
              <Undo2 className="w-3.5 h-3.5" /> {undo.isPending ? "Undoing…" : "Undo this fix"}
            </Button>
          )}
          {p && p.status !== "ready" && (
            <Button variant="ghost" onClick={onClose} className="rounded-sm">Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeCard({
  change: c,
  checked,
  onToggle,
  locked,
}: {
  change: FixChange;
  checked: boolean;
  onToggle: () => void;
  locked: boolean;
}) {
  const { toast } = useToast();
  const isCode = c.op.type === "code_change";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(c.prompt ?? "");
      toast({ title: "Prompt copied", description: "Paste it into a Claude Code session on this repository." });
    } catch {
      toast({ title: "Couldn't copy", description: "Select the text and copy it by hand.", variant: "destructive" });
    }
  };

  return (
    <div
      className={`border p-3 ${c.destructive ? "border-rose-500/40 bg-rose-500/[0.03]" : "border-border"}`}
      data-testid={`fix-change-${c.index}`}
    >
      <div className="flex items-start gap-3">
        {!isCode || c.delivery === "github" ? (
          <Checkbox
            checked={c.applied ?? checked}
            onCheckedChange={onToggle}
            disabled={locked}
            className="mt-0.5"
            aria-label={`Include: ${c.heading}`}
          />
        ) : (
          <div className="w-4" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{c.heading}</span>
            {c.destructive && (
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-rose-500/40 text-rose-700 dark:text-rose-400">
                removes a page from search
              </span>
            )}
            {isCode && (
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 bg-secondary flex items-center gap-1">
                <GitPullRequest className="w-2.5 h-2.5" />
                {c.delivery === "github" ? "opens a pull request" : "copy into Claude Code"}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{c.op.reason}</p>

          <div className="mt-2 space-y-2">
            {c.rows.map((r, i) => (
              <div key={i} className="text-xs">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{r.label}</div>
                {r.before && (
                  <div className="bg-rose-500/[0.07] border-l-2 border-rose-500/60 px-2 py-1 whitespace-pre-wrap text-muted-foreground line-through decoration-rose-500/40 max-h-40 overflow-y-auto">
                    {r.before}
                  </div>
                )}
                <div className="bg-emerald-500/[0.07] border-l-2 border-emerald-500/60 px-2 py-1 whitespace-pre-wrap mt-1 max-h-72 overflow-y-auto">
                  {r.after}
                </div>
              </div>
            ))}
          </div>

          {isCode && c.delivery !== "github" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={copy} className="rounded-sm gap-1.5 h-8">
                <Copy className="w-3.5 h-3.5" /> Copy prompt for Claude Code
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Set GITHUB_TOKEN and GITHUB_REPO on the server to open pull requests automatically.
              </span>
            </div>
          )}

          {c.result && (
            <div
              className={`mt-2 text-xs flex items-start gap-1.5 ${
                c.result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"
              }`}
            >
              {c.result.ok ? <Check className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
              <span>
                {c.result.ok ? c.result.message ?? "Applied" : c.result.message}
                {c.result.issueUrl && (
                  <>
                    {" "}
                    <a href={c.result.issueUrl} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">
                      View on GitHub <ExternalLink className="w-3 h-3" />
                    </a>
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
