// Leads read from lead-source emails (REW.ca, Zillow, …) — server/lead-intake.ts.
// Shown on the Enquiries page: what's waiting for a look, and what came in.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Mail, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { timeAgo } from "@/lib/mock-data";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";

interface Extracted {
  isLead: boolean;
  confident: boolean;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  property: string | null;
  intent: string;
  link: string | null;
  note: string;
}

interface IntakeRow {
  id: number;
  source: string;
  fromAddr: string | null;
  subject: string | null;
  bodyText: string | null;
  receivedAt: string;
  status: string;
  reason: string | null;
  extracted: Extracted | null;
  leadId: number | null;
}

interface IntakeResponse {
  ready: boolean;
  reason?: string;
  lastCheck: string | null;
  sources: string[];
  rows: IntakeRow[];
}

const STATUS_LABEL: Record<string, string> = {
  imported: "Added as lead",
  duplicate: "Same lead again",
  needs_review: "Needs review",
  not_a_lead: "Not a lead",
  dismissed: "Dismissed",
  sample: "Sample (older mail)",
};

type View = "review" | "imported" | "all";

export function LeadIntakePanel() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("review");
  const { data } = useQuery<IntakeResponse>({ queryKey: ["/api/admin/lead-intake"], refetchInterval: 60_000 });

  const lookback = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/lead-intake/lookback", { days: 30, limit: 40 })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/lead-intake"] }),
  });

  if (!data) return null;
  const rows = data.rows;
  const review = rows.filter((r) => r.status === "needs_review");
  const imported = rows.filter((r) => r.status === "imported" || r.status === "duplicate");
  const shown = view === "review" ? review : view === "imported" ? imported : rows;

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-serif text-xl" style={{ letterSpacing: "-0.005em" }}>
              <Mail className="w-5 h-5" strokeWidth={1.6} /> Leads from email
            </div>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Lead emails from {data.sources.join(", ")} in your Gmail become leads here automatically.
              {data.lastCheck ? ` Last checked ${timeAgo(data.lastCheck)}.` : ""}
            </p>
            {!data.ready && data.reason && <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">{data.reason}</p>}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="rounded-sm"
            disabled={lookback.isPending || !data.ready}
            onClick={() => lookback.mutate()}
            title="Reads the last 30 days of lead-source email to show how each source is read. Creates no leads."
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${lookback.isPending ? "animate-spin" : ""}`} />
            {lookback.isPending ? "Reading…" : "Test on last 30 days"}
          </Button>
        </div>
        {lookback.isError && <p className="text-sm text-destructive">{apiErrorMessage(lookback.error)}</p>}
        {lookback.data && <p className="text-sm text-muted-foreground">Read {lookback.data.read} older emails. They're under "All", marked as samples.</p>}

        <div className="flex gap-1.5">
          {(
            [
              ["review", `Needs review (${review.length})`],
              ["imported", `Added (${imported.length})`],
              ["all", `All (${rows.length})`],
            ] as Array<[View, string]>
          ).map(([v, label]) => (
            <Button
              key={v}
              size="sm"
              variant={view === v ? "default" : "outline"}
              className="rounded-sm h-8 text-xs"
              onClick={() => setView(v)}
            >
              {label}
            </Button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {view === "review" ? "Nothing waiting." : "No lead emails yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {shown.map((r) => (
              <IntakeItem key={r.id} row={r} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function IntakeItem({ row }: { row: IntakeRow }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(row.status === "needs_review");
  const [showOriginal, setShowOriginal] = useState(false);
  const x = row.extracted;
  const [draft, setDraft] = useState({ name: x?.name ?? "", email: x?.email ?? "", phone: x?.phone ?? "" });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["/api/admin/lead-intake"] });
    qc.invalidateQueries({ queryKey: ["/api/leads"] });
  };
  const act = useMutation({
    mutationFn: async (action: "import" | "dismiss" | "retry") =>
      (await apiRequest("POST", `/api/admin/lead-intake/${row.id}/${action}`, action === "import" ? draft : {})).json(),
    onSuccess: refresh,
  });

  const canAct = !row.leadId && row.status !== "dismissed";
  return (
    <li className="py-3">
      <button className="w-full flex items-start gap-2 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="w-4 h-4 mt-0.5 shrink-0" /> : <ChevronRight className="w-4 h-4 mt-0.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{x?.name || row.subject || "(no subject)"}</span>
            <Badge variant="outline" className="rounded-sm text-[10px]">{row.source}</Badge>
            <Badge variant={row.status === "needs_review" ? "default" : "secondary"} className="rounded-sm text-[10px]">
              {STATUS_LABEL[row.status] ?? row.status}
            </Badge>
            <span className="text-xs text-muted-foreground">{timeAgo(row.receivedAt)}</span>
          </div>
          {row.reason && <div className="text-xs text-muted-foreground mt-0.5 truncate">{row.reason}</div>}
        </div>
      </button>

      {open && (
        <div className="pl-6 pt-3 space-y-3">
          <div className="text-xs text-muted-foreground">
            {row.subject} · {row.fromAddr}
          </div>
          {x && (
            <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-sm">
              {x.property && (
                <>
                  <dt className="text-muted-foreground">About</dt>
                  <dd>{x.property}</dd>
                </>
              )}
              {x.message && (
                <>
                  <dt className="text-muted-foreground">Message</dt>
                  <dd className="whitespace-pre-wrap">{x.message}</dd>
                </>
              )}
              {x.intent !== "unknown" && (
                <>
                  <dt className="text-muted-foreground">Type</dt>
                  <dd className="capitalize">{x.intent}</dd>
                </>
              )}
              {x.link && (
                <>
                  <dt className="text-muted-foreground">Link</dt>
                  <dd className="truncate">
                    <a href={x.link} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                      Open on {row.source}
                    </a>
                  </dd>
                </>
              )}
              {!canAct && (
                <>
                  <dt className="text-muted-foreground">Contact</dt>
                  <dd>{[x.email, x.phone].filter(Boolean).join(" · ") || "—"}</dd>
                </>
              )}
            </dl>
          )}

          {canAct && (
            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <Input placeholder="Email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
                <Input placeholder="Phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="rounded-sm" disabled={act.isPending} onClick={() => act.mutate("import")}>
                  Add as lead
                </Button>
                <Button size="sm" variant="outline" className="rounded-sm" disabled={act.isPending} onClick={() => act.mutate("retry")}>
                  Read again
                </Button>
                <Button size="sm" variant="ghost" className="rounded-sm" disabled={act.isPending} onClick={() => act.mutate("dismiss")}>
                  Not a lead
                </Button>
              </div>
              {act.isError && <p className="text-sm text-destructive">{apiErrorMessage(act.error)}</p>}
            </div>
          )}

          <button className="text-xs underline underline-offset-2 text-muted-foreground" onClick={() => setShowOriginal(!showOriginal)}>
            {showOriginal ? "Hide original email" : "Show original email"}
          </button>
          {showOriginal && (
            <pre className="text-xs whitespace-pre-wrap break-words bg-secondary/50 rounded-sm p-3 max-h-80 overflow-auto font-sans">
              {row.bodyText}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
