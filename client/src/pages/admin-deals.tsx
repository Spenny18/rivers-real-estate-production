// /admin/deals — the transaction files.
//
// One row per deal, with how many documents are out for signature. New deals
// start here; everything else happens on /admin/deals/:id. The offsite
// backup's health sits at the top because signed contracts are the one
// thing on this server that must never be lost.

import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CloudUpload, FileSignature, FolderOpen, Loader2, Plus, ShieldAlert, ShieldCheck } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtDateTime, type BackupStatus, type DealView } from "@/lib/esign-types";

const KIND_LABELS: Record<DealView["kind"], string> = {
  purchase: "Purchase",
  listing: "Listing",
  lease: "Lease",
  other: "Other",
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-900",
  closed: "bg-secondary text-secondary-foreground border-border",
  archived: "bg-secondary/40 text-muted-foreground border-border",
};

const EMPTY = { title: "", address: "", kind: "purchase" as DealView["kind"], mlsNumber: "", notes: "" };

export default function AdminDealsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<"active" | "closed" | "archived" | "all">("active");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(EMPTY);

  const listKey = [`/api/admin/deals${filter === "all" ? "" : `?status=${filter}`}`];
  const { data: deals = [], isLoading } = useQuery<DealView[]>({ queryKey: listKey });
  const { data: backups } = useQuery<BackupStatus>({ queryKey: ["/api/admin/backups"] });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/deals", {
        title: draft.title,
        address: draft.address || undefined,
        kind: draft.kind,
        mlsNumber: draft.mlsNumber || null,
        notes: draft.notes || null,
      });
      return (await res.json()) as DealView;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/deals"] });
      qc.invalidateQueries({ queryKey: listKey });
      setCreating(false);
      setDraft(EMPTY);
      window.location.assign(`/admin/deals/${d.id}`);
    },
    onError: (e) => toast({ title: "Didn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const runBackup = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/backups/run", { kind: "full" });
      return res.json();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["/api/admin/backups"] }),
    onSuccess: () => toast({ title: "Backup complete", description: "Database snapshot and new documents are offsite." }),
    onError: (e) => toast({ title: "Backup failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <AppShell
      pageTitle="Deals"
      pageActions={
        <Button size="sm" onClick={() => setCreating(true)} data-testid="button-new-deal">
          <Plus className="h-4 w-4 mr-1" /> New deal
        </Button>
      }
    >
      <div className="p-6 space-y-6 max-w-6xl">
        {/* Backup health */}
        <Card>
          <CardContent className="p-4 flex flex-wrap items-center gap-4">
            {backups?.configured ? (
              backups.lastOk ? (
                <ShieldCheck className="h-5 w-5 text-emerald-600 shrink-0" />
              ) : (
                <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0" />
              )
            ) : (
              <ShieldAlert className="h-5 w-5 text-destructive shrink-0" />
            )}
            <div className="flex-1 min-w-[240px]">
              <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">OFFSITE BACKUP</div>
              {!backups ? (
                <div className="text-[13px] text-muted-foreground">Checking…</div>
              ) : !backups.configured ? (
                <div className="text-[13px]">
                  <span className="text-destructive font-medium">Not configured.</span> Signed contracts are only on this server. Set{" "}
                  <span className="font-mono text-[11px]">{backups.missing.join(", ")}</span> as Fly secrets (see README → Deals &amp; e-signature).
                </div>
              ) : (
                <div className="text-[13px]">
                  {backups.lastOk ? (
                    <>
                      Last full backup <span className="font-medium">{fmtDateTime(backups.lastOk.finishedAt)}</span> to{" "}
                      <span className="font-mono text-[11px]">{backups.target}</span>
                    </>
                  ) : (
                    <span className="text-amber-700">Configured, but no successful backup yet.</span>
                  )}
                  {backups.pendingFiles > 0 ? <span className="text-muted-foreground"> · {backups.pendingFiles} file(s) waiting</span> : null}
                  {backups.runs[0]?.status === "error" ? (
                    <div className="text-[12px] text-destructive mt-1">Last run failed: {backups.runs[0].error}</div>
                  ) : null}
                </div>
              )}
            </div>
            {backups?.configured ? (
              <Button size="sm" variant="outline" disabled={runBackup.isPending || backups.running} onClick={() => runBackup.mutate()}>
                {runBackup.isPending || backups.running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CloudUpload className="h-4 w-4 mr-1" />}
                Back up now
              </Button>
            ) : null}
          </CardContent>
        </Card>

        {/* Filter */}
        <div className="flex items-center gap-2">
          {(["active", "closed", "archived", "all"] as const).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} className="h-8 text-[11px] tracking-[0.12em]" onClick={() => setFilter(f)}>
              {f.toUpperCase()}
            </Button>
          ))}
        </div>

        {/* List */}
        {isLoading ? (
          <div className="text-[13px] text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading deals…
          </div>
        ) : deals.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center">
              <FolderOpen className="h-8 w-8 mx-auto text-muted-foreground mb-3" strokeWidth={1.4} />
              <div className="font-serif text-[20px] mb-1">No deals yet</div>
              <p className="text-[13px] text-muted-foreground max-w-md mx-auto">
                A deal is one transaction: the property, the parties, and every PDF you send for signature. Fill the contract in
                CREA WEBForms, export it as a PDF, and upload it here.
              </p>
              <Button className="mt-5" size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4 mr-1" /> New deal
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {deals.map((d) => (
              <Link key={d.id} href={`/admin/deals/${d.id}`} className="block" data-testid={`deal-row-${d.id}`}>
                <Card className="hover:border-foreground/30 transition-colors">
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-sm bg-secondary flex items-center justify-center shrink-0">
                      <FileSignature className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-medium text-[14px] truncate">{d.title}</div>
                        <Badge variant="outline" className={`text-[10px] ${STATUS_STYLES[d.status] ?? ""}`}>
                          {d.status}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">{KIND_LABELS[d.kind]}</span>
                      </div>
                      <div className="text-[12px] text-muted-foreground truncate">
                        {d.address || "No address"}
                        {d.mlsNumber ? ` · MLS® ${d.mlsNumber}` : ""}
                        {d.leadName ? ` · ${d.leadName}` : ""}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] tabular-nums">
                        {d.documentCount} {d.documentCount === 1 ? "document" : "documents"}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {d.awaitingSignature > 0 ? (
                          <span className="text-amber-700">{d.awaitingSignature} awaiting signature</span>
                        ) : d.completedDocuments > 0 ? (
                          <span className="text-emerald-700">{d.completedDocuments} completed</span>
                        ) : (
                          `Updated ${fmtDateTime(d.updatedAt)}`
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <Dialog open={creating} onOpenChange={(o) => !o && setCreating(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>One per transaction. You can add documents once it exists.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Deal name</Label>
              <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Smith purchase — 123 Elbow Dr SW" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as DealView["kind"] })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(KIND_LABELS) as DealView["kind"][]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {KIND_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>MLS® number</Label>
                <Input value={draft.mlsNumber} onChange={(e) => setDraft({ ...draft, mlsNumber: e.target.value })} placeholder="Optional" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Property address</Label>
              <Input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={3} placeholder="Private to you" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} disabled={!draft.title.trim() || create.isPending}>
              {create.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Create deal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
