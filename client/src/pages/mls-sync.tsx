import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMutation } from "@tanstack/react-query";
import { Database, RefreshCw, CheckCircle2, AlertTriangle, Clock, Stethoscope } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Shape of GET /api/admin/mls-sync/sold-probe — see server/rets-sold-probe.ts. */
interface SoldProbe {
  configured: boolean;
  loggedIn: boolean;
  statusLookups: Array<{ value: string; longValue?: string; shortValue?: string }>;
  saleFieldsInMetadata: string[];
  attempts: Array<{
    query: string;
    ok: boolean;
    rows: number;
    fields?: string[];
    saleFields?: Record<string, string | null>;
    error?: string;
  }>;
  verdict: string;
  error?: string;
}

type MlsSyncRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "error" | "skipped";
  source: "pillar9" | "seed";
  fetched: number;
  upserted: number;
  removed: number;
  errorMessage: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  success: "bg-foreground text-background",
  running: "bg-secondary text-foreground",
  error: "bg-destructive text-destructive-foreground",
  skipped: "bg-muted text-muted-foreground",
};

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function durationMs(start: string, end: string | null): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export default function MlsSyncPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<MlsSyncRun[]>({
    queryKey: ["/api/admin/mls-sync"],
    refetchInterval: 15_000,
  });

  const triggerMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/admin/mls-sync/run", {});
    },
    onSuccess: () => {
      toast({ title: "Sync started", description: "Fetching latest listings from Pillar 9." });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/admin/mls-sync"] });
      }, 1500);
    },
    onError: (err: any) => {
      toast({
        title: "Could not start sync",
        description: err?.message ?? "Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  // Asks the feed whether it will give us sold listings, and under what status
  // value and field names. The active sync only pulls StandardStatus=|A, so a
  // market report has no sale prices to work from until this is answered — and
  // the answer differs by board, so it has to be asked rather than assumed.
  const [probeOpen, setProbeOpen] = useState(false);
  const soldProbe = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/admin/mls-sync/sold-probe");
      return (await res.json()) as SoldProbe;
    },
    onSuccess: () => setProbeOpen(true),
    onError: (err: any) =>
      toast({
        title: "Probe failed",
        description: err?.message ?? "Try again in a moment.",
        variant: "destructive",
      }),
  });

  const runs = data ?? [];
  const lastSuccess = runs.find((r) => r.status === "success");
  const lastError = runs.find((r) => r.status === "error");
  const isRunning = runs.some((r) => r.status === "running");

  return (
    <AppShell
      pageTitle="MLS Sync"
      pageActions={
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => soldProbe.mutate()}
            disabled={soldProbe.isPending}
            className="rounded-sm font-display tracking-[0.16em] text-[11px]"
            data-testid="button-sold-probe"
          >
            <Stethoscope className="w-4 h-4 mr-1.5" />
            {soldProbe.isPending ? "CHECKING…" : "CHECK SOLD DATA"}
          </Button>
          <Button
            onClick={() => triggerMutation.mutate()}
            disabled={triggerMutation.isPending || isRunning}
            className="rounded-sm font-display tracking-[0.16em] text-[11px]"
            data-testid="button-run-sync"
          >
            <RefreshCw className={`w-4 h-4 mr-1.5 ${triggerMutation.isPending ? "animate-spin" : ""}`} />
            {isRunning ? "RUNNING…" : "RUN SYNC NOW"}
          </Button>
        </div>
      }
    >
      <div className="px-8 py-7 space-y-6 max-w-7xl">
        {/* Status cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-foreground" />
                <span className="eyebrow text-muted-foreground">Last successful sync</span>
              </div>
              <div className="font-serif text-xl" data-testid="text-last-success">
                {lastSuccess ? fmtTime(lastSuccess.finishedAt ?? lastSuccess.startedAt) : "Never"}
              </div>
              {lastSuccess && (
                <div className="text-xs text-muted-foreground mt-1">
                  {lastSuccess.upserted} upserted · {lastSuccess.removed} removed · {lastSuccess.source}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <Database className="w-4 h-4 text-foreground" />
                <span className="eyebrow text-muted-foreground">Cadence</span>
              </div>
              <div className="font-serif text-xl">Hourly</div>
              <div className="text-xs text-muted-foreground mt-1">
                Cron runs on the hour while server is up.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-foreground" />
                <span className="eyebrow text-muted-foreground">Last error</span>
              </div>
              <div className="font-serif text-xl" data-testid="text-last-error">
                {lastError ? fmtTime(lastError.startedAt) : "None"}
              </div>
              {lastError?.errorMessage && (
                <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {lastError.errorMessage}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Runs table */}
        <Card>
          <CardContent className="p-0">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h2 className="font-serif text-lg" style={{ letterSpacing: "-0.01em" }}>
                Recent runs
              </h2>
              <span className="eyebrow text-muted-foreground">
                <Clock className="w-3 h-3 inline mr-1" />
                Auto-refreshes every 15s
              </span>
            </div>

            {isLoading ? (
              <div className="p-5 space-y-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : runs.length === 0 ? (
              <div className="p-10 text-center text-muted-foreground">
                <Database className="w-8 h-8 mx-auto mb-3 opacity-40" />
                <p className="font-serif text-lg">No sync runs yet</p>
                <p className="text-sm mt-1">Click RUN SYNC NOW to trigger the first one.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-border">
                      <th className="px-5 py-3 eyebrow text-muted-foreground font-normal">Started</th>
                      <th className="px-5 py-3 eyebrow text-muted-foreground font-normal">Status</th>
                      <th className="px-5 py-3 eyebrow text-muted-foreground font-normal">Source</th>
                      <th className="px-5 py-3 eyebrow text-muted-foreground font-normal text-right">Fetched</th>
                      <th className="px-5 py-3 eyebrow text-muted-foreground font-normal text-right">Upserted</th>
                      <th className="px-5 py-3 eyebrow text-muted-foreground font-normal text-right">Removed</th>
                      <th className="px-5 py-3 eyebrow text-muted-foreground font-normal text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-border hover:bg-secondary/40 transition-colors"
                        data-testid={`row-sync-${r.id}`}
                      >
                        <td className="px-5 py-3 tabular-nums">{fmtTime(r.startedAt)}</td>
                        <td className="px-5 py-3">
                          <Badge className={`${STATUS_BADGE[r.status] ?? ""} rounded-sm font-display text-[10px] tracking-[0.14em] uppercase`}>
                            {r.status}
                          </Badge>
                          {r.errorMessage && (
                            <div className="text-xs text-muted-foreground mt-1 max-w-md truncate">
                              {r.errorMessage}
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-3 capitalize">{r.source}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{r.fetched}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{r.upserted}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{r.removed}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                          {durationMs(r.startedAt, r.finishedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Sold-data probe result ----
          The verdict is the answer; the raw JSON is what gets pasted back so
          the sync can be written against real field names rather than guesses. */}
      <Dialog open={probeOpen} onOpenChange={setProbeOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">Will this feed give us sold data?</DialogTitle>
          </DialogHeader>
          {soldProbe.data && (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed" data-testid="sold-verdict">
                {soldProbe.data.verdict}
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-sm bg-secondary/40 p-3.5">
                  <div className="eyebrow text-muted-foreground mb-1.5">Status values the feed accepts</div>
                  <p className="text-[13px] break-words">
                    {soldProbe.data.statusLookups.length > 0
                      ? soldProbe.data.statusLookups
                          .map((l) => l.longValue ? `${l.value} (${l.longValue})` : l.value)
                          .join(", ")
                      : "None reported — its metadata didn't answer."}
                  </p>
                </div>
                <div className="rounded-sm bg-secondary/40 p-3.5">
                  <div className="eyebrow text-muted-foreground mb-1.5">Sale fields it defines</div>
                  <p className="text-[13px] break-words">
                    {soldProbe.data.saleFieldsInMetadata.length > 0
                      ? soldProbe.data.saleFieldsInMetadata.join(", ")
                      : "None found — a market report needs ClosePrice and CloseDate."}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                {soldProbe.data.attempts.map((a, i) => (
                  <div key={i} className="rounded-sm bg-secondary/40 px-3.5 py-2.5" data-testid={`sold-attempt-${i}`}>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Badge
                        variant="outline"
                        className={`text-[10px] tracking-[0.1em] ${
                          a.ok && a.rows > 0 ? "border-emerald-500 text-emerald-700 dark:text-emerald-400" : ""
                        }`}
                      >
                        {a.ok ? `${a.rows} row${a.rows === 1 ? "" : "s"}` : "REJECTED"}
                      </Badge>
                      <code className="text-[12px]">{a.query}</code>
                    </div>
                    {a.saleFields && (
                      <p className="text-[12px] text-muted-foreground mt-1.5 break-words">
                        {Object.entries(a.saleFields)
                          .map(([k, v]) => `${k}: ${v ?? "—"}`)
                          .join(" · ")}
                      </p>
                    )}
                    {a.error && <p className="text-[12px] text-muted-foreground mt-1.5">{a.error}</p>}
                  </div>
                ))}
              </div>

              <div>
                <div className="eyebrow text-muted-foreground mb-2">Raw — paste this back</div>
                <textarea
                  readOnly
                  value={JSON.stringify(soldProbe.data, null, 2)}
                  data-testid="sold-probe-json"
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full h-52 text-[11.5px] font-mono leading-relaxed rounded-sm border border-border bg-secondary/30 p-3"
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
