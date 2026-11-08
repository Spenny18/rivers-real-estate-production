// Monthly community reports for one contact: which communities they get
// emailed every month, and adding or stopping one. Shown in the CRM contact
// drawer and on website leads. Backed by server/community-report-subs.ts.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Sub {
  id: number;
  email: string;
  neighbourhoodSlug: string;
  neighbourhoodName: string | null;
  cls: string;
  clsLabel: string;
  active: boolean;
  lastSentPeriod: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  unsubscribedAt: string | null;
}

interface Options {
  name: string;
  classOptions: Array<{ value: string; label: string }>;
  defaultCls: string;
}

function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-CA", { month: "long", year: "numeric" });
}

export function CommunityReportSubsPanel({
  email,
  name,
  crmContactId,
  leadId,
}: {
  email: string;
  name: string;
  crmContactId?: string | null;
  leadId?: number | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ["/api/admin/community-report-subs", email.toLowerCase()];
  const { data, isLoading } = useQuery<{ subs: Sub[] }>({
    queryKey: key,
    queryFn: async () => (await apiRequest("GET", `/api/admin/community-report-subs?email=${encodeURIComponent(email)}`)).json(),
  });
  const subs = data?.subs ?? [];

  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState("");
  const [cls, setCls] = useState("");

  const { data: neighbourhoods = [] } = useQuery<Array<{ slug: string; name: string }>>({
    queryKey: ["/api/admin/neighbourhoods"],
    enabled: adding,
  });
  const sorted = useMemo(() => [...neighbourhoods].sort((a, b) => a.name.localeCompare(b.name)), [neighbourhoods]);

  const options = useQuery<Options>({
    queryKey: ["/api/admin/community-report-subs/options", slug],
    queryFn: async () => (await apiRequest("GET", `/api/admin/community-report-subs/options?slug=${encodeURIComponent(slug)}`)).json(),
    enabled: !!slug,
    retry: false,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const onError = (e: unknown) => toast({ title: apiErrorMessage(e), variant: "destructive" });

  const add = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/admin/community-report-subs", {
        email,
        name,
        neighbourhoodSlug: slug,
        cls: cls || options.data?.defaultCls,
        crmContactId: crmContactId ?? null,
        leadId: leadId ?? null,
      })).json(),
    onSuccess: () => {
      refresh();
      setAdding(false);
      setSlug("");
      setCls("");
      toast({ title: "Added. They'll get it every month from the 2nd." });
    },
    onError,
  });

  const toggle = useMutation({
    mutationFn: async (s: Sub) => apiRequest("PATCH", `/api/admin/community-report-subs/${s.id}`, { active: !s.active }),
    onSuccess: refresh,
    onError,
  });

  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/community-report-subs/${id}`),
    onSuccess: refresh,
    onError,
  });

  const send = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/admin/community-report-subs/${id}/send`)).json(),
    onSuccess: (r: { period: string }) => {
      refresh();
      toast({ title: `Sent the ${monthLabel(r.period)} report.` });
    },
    onError,
  });

  const preview = async (id: number) => {
    // Opened first so the browser doesn't block it as a popup after the await.
    const win = window.open("", "_blank");
    try {
      const html = await (await apiRequest("GET", `/api/admin/community-report-subs/${id}/preview`)).text();
      if (win) {
        win.document.open();
        win.document.write(html);
        win.document.close();
      }
    } catch (e) {
      win?.close();
      onError(e);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground">MONTHLY COMMUNITY REPORTS</div>
        <Button
          size="sm"
          variant="outline"
          className="rounded-sm font-display tracking-[0.14em] text-[10px] h-7"
          onClick={() => setAdding((v) => !v)}
          data-testid="button-community-report-add"
        >
          {adding ? "CANCEL" : "+ ADD"}
        </Button>
      </div>

      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : subs.length === 0 && !adding ? (
        <p className="text-[13px] text-muted-foreground">
          Not getting any. Add a community to email them its market report every month.
        </p>
      ) : (
        <div className="space-y-1.5">
          {subs.map((s) => (
            <div key={s.id} className="flex items-start justify-between gap-3 px-3 py-2 rounded-sm bg-secondary/40">
              <div className="min-w-0">
                <div className="text-[13px]">
                  {s.neighbourhoodName ?? s.neighbourhoodSlug} · {s.clsLabel}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {s.unsubscribedAt && !s.active
                    ? "Unsubscribed themselves"
                    : !s.active
                      ? "Paused"
                      : s.lastSentPeriod
                        ? `Last sent: ${monthLabel(s.lastSentPeriod)} report`
                        : "First one goes out with the next monthly report"}
                  {s.lastError && <span className="text-destructive"> · Last try failed: {s.lastError}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="sm" className="rounded-sm h-7 px-2 text-[10px]" onClick={() => preview(s.id)}>
                  PREVIEW
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-sm h-7 px-2 text-[10px]"
                  disabled={send.isPending}
                  onClick={() => {
                    if (confirm(`Email this month's ${s.neighbourhoodName ?? ""} report to ${s.email} now?`)) send.mutate(s.id);
                  }}
                >
                  {send.isPending && send.variables === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "SEND NOW"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-sm h-7 px-2 text-[10px]"
                  onClick={() => {
                    if (!s.active && s.unsubscribedAt && !confirm(`${s.email} unsubscribed from this report. Only turn it back on if they've asked you to.`)) return;
                    toggle.mutate(s);
                  }}
                >
                  {s.active ? "PAUSE" : "RESUME"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-sm h-7 px-2 text-[10px] text-destructive"
                  onClick={() => {
                    if (confirm(`Stop sending the ${s.neighbourhoodName ?? ""} report to ${s.email}?`)) remove.mutate(s.id);
                  }}
                >
                  REMOVE
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="mt-2 space-y-2 border border-border rounded-sm p-3">
          <Select
            value={slug}
            onValueChange={(v) => {
              setSlug(v);
              setCls("");
            }}
          >
            <SelectTrigger className="h-9 rounded-sm text-sm" data-testid="select-community-report-neighbourhood">
              <SelectValue placeholder="Community" />
            </SelectTrigger>
            <SelectContent>
              {sorted.map((n) => (
                <SelectItem key={n.slug} value={n.slug}>
                  {n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {slug && options.isError && <p className="text-[12px] text-destructive">{apiErrorMessage(options.error)}</p>}
          {options.data && (
            <Select value={cls || options.data.defaultCls} onValueChange={setCls}>
              <SelectTrigger className="h-9 rounded-sm text-sm" data-testid="select-community-report-class">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.data.classOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            size="sm"
            className="rounded-sm font-display tracking-[0.14em] text-[10px] h-8 w-full"
            disabled={!options.data || add.isPending}
            onClick={() => add.mutate()}
            data-testid="button-community-report-save"
          >
            {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "EMAIL IT MONTHLY"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Sent to {email} every month from the 2nd, during the day, once last month's report is ready. Every email has an
            unsubscribe link. Only add people who've asked for it or are your clients.
          </p>
        </div>
      )}
    </div>
  );
}
