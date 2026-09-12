// /admin/newsletter — the monthly Calgary Market Update.
//
// Two halves. Issues: one per month, drafted automatically on the 2nd with
// the market section already filled from the sold data; Spencer writes the
// note, drops in the news and events, previews, sends himself a test, and
// sends or schedules. Subscribers: the list, imported once from the Real
// Info Box export and topped up from the CRM, with every status change on
// record.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Plus, Trash2, Send, Eye, Save, CalendarClock, Upload, Download, Users, TriangleAlert, ExternalLink } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";

// ---- Types (mirror server/newsletter-template.ts) ----------------------------------

interface NewsLink {
  title: string;
  source: string;
  url: string;
}
interface EventItem {
  title: string;
  dates: string;
  blurb: string;
  url: string;
}
interface Feature {
  title: string;
  body: string;
  imageUrl: string;
  url: string;
}
interface IssueContent {
  intro: string;
  news: NewsLink[];
  events: EventItem[];
  article: Feature | null;
  neighbourhood: Feature | null;
  showMarket: boolean;
  showReports: boolean;
  showEvaluation: boolean;
}
interface Issue {
  id: number;
  period: string;
  subject: string;
  preheader: string | null;
  content: IssueContent;
  status: "draft" | "scheduled" | "sending" | "sent";
  scheduledFor: string | null;
  sentAt: string | null;
  recipients: number;
  delivered: number;
  failed: number;
  updatedAt: string;
}
interface Progress {
  running: boolean;
  issueId: number | null;
  total: number;
  done: number;
  failed: number;
  lastError: string | null;
}
interface Overview {
  counts: Record<string, number>;
  issues: Issue[];
  progress: Progress;
  configured: { ok: boolean; reason?: string };
  origin: string;
  defaultPeriod: string;
}
interface IssuePayload {
  issue: Issue;
  stats: { sent: number; failed: number; failures: Array<{ email: string; error: string | null }> };
  available: { report: boolean; commentary: boolean; reports: number };
  progress: Progress;
}
interface Subscriber {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: "subscribed" | "unsubscribed" | "bounced" | "complained";
  source: string;
  consentSource: string | null;
  consentAt: string | null;
  statusReason: string | null;
  statusChangedAt: string | null;
  createdAt: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function periodLabel(p: string): string {
  const [y, m] = p.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-CA", { timeZone: "America/Edmonton", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
const STATUS_TONE: Record<Issue["status"], string> = {
  draft: "bg-muted text-muted-foreground",
  scheduled: "bg-blue-50 text-blue-700 border-blue-200",
  sending: "bg-amber-50 text-amber-700 border-amber-200",
  sent: "bg-emerald-50 text-emerald-700 border-emerald-200",
};
const SUB_TONE: Record<Subscriber["status"], string> = {
  subscribed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  unsubscribed: "bg-muted text-muted-foreground",
  bounced: "bg-amber-50 text-amber-700 border-amber-200",
  complained: "bg-red-50 text-red-700 border-red-200",
};

const label = "text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-medium";

export default function AdminNewsletterPage() {
  const [tab, setTab] = useState<"issues" | "subscribers">("issues");
  const { data, isLoading } = useQuery<Overview>({ queryKey: ["/api/admin/newsletter"], refetchInterval: (q) => (q.state.data?.progress.running ? 2000 : false) });

  return (
    <AppShell pageTitle="Newsletter">
      {isLoading || !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-5">
          {!data.configured.ok && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <b>Sending is not configured.</b> {data.configured.reason}. Drafting and previewing still work.
              </div>
            </div>
          )}
          <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
            <TabsList>
              <TabsTrigger value="issues">Issues</TabsTrigger>
              <TabsTrigger value="subscribers">
                Subscribers <span className="ml-1.5 text-xs text-muted-foreground">{data.counts.subscribed.toLocaleString()}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="issues" className="mt-4">
              <IssuesTab data={data} />
            </TabsContent>
            <TabsContent value="subscribers" className="mt-4">
              <SubscribersTab counts={data.counts} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </AppShell>
  );
}

// ---- Issues ---------------------------------------------------------------------------

function IssuesTab({ data }: { data: Overview }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<number | null>(data.issues[0]?.id ?? null);
  const [newPeriod, setNewPeriod] = useState(data.defaultPeriod);

  useEffect(() => {
    if (selected == null && data.issues[0]) setSelected(data.issues[0].id);
  }, [data.issues, selected]);

  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/newsletter/issues", { period: newPeriod })).json() as Promise<{ issue: Issue }>,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/newsletter"] });
      setSelected(r.issue.id);
    },
    onError: (e) => toast({ title: "Couldn't create the issue", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <div className="grid gap-5 lg:grid-cols-12">
      <div className="lg:col-span-3 space-y-3">
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className={label}>New issue for</div>
            <div className="flex gap-2">
              <Input type="month" value={newPeriod} onChange={(e) => setNewPeriod(e.target.value)} className="h-9" />
              <Button size="sm" className="h-9" onClick={() => create.mutate()} disabled={create.isPending || !/^\d{4}-\d{2}$/.test(newPeriod)}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              The month the market section reports on. A draft for last month appears by itself on the 2nd.
            </p>
          </CardContent>
        </Card>
        <div className="space-y-1.5">
          {data.issues.length === 0 && <p className="text-sm text-muted-foreground px-1">No issues yet.</p>}
          {data.issues.map((i) => (
            <button
              key={i.id}
              onClick={() => setSelected(i.id)}
              className={`w-full text-left rounded-md border px-3 py-2.5 transition-colors ${selected === i.id ? "border-foreground bg-muted/40" : "border-border hover:border-foreground/40"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium truncate">{i.subject}</span>
                <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${STATUS_TONE[i.status]}`}>
                  {i.status}
                </Badge>
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {periodLabel(i.period)} figures
                {i.status === "sent" && ` · ${i.delivered.toLocaleString()} delivered${i.failed ? `, ${i.failed} failed` : ""}`}
                {i.status === "scheduled" && i.scheduledFor && ` · sends ${when(i.scheduledFor)}`}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="lg:col-span-9">
        {selected != null ? <IssueEditor id={selected} progress={data.progress} configured={data.configured.ok} subscribed={data.counts.subscribed} onDeleted={() => setSelected(null)} /> : (
          <Card>
            <CardContent className="p-8 text-sm text-muted-foreground">Create an issue to start.</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function IssueEditor({ id, progress, configured, subscribed, onDeleted }: { id: number; progress: Progress; configured: boolean; subscribed: number; onDeleted: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { data } = useQuery<IssuePayload>({ queryKey: [`/api/admin/newsletter/issues/${id}`] });

  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");
  const [content, setContent] = useState<IssueContent | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testTo, setTestTo] = useState(user?.email ?? "");
  const [scheduleAt, setScheduleAt] = useState("");
  const [confirm, setConfirm] = useState<"send" | "delete" | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  useEffect(() => {
    if (!data) return;
    setSubject(data.issue.subject);
    setPreheader(data.issue.preheader ?? "");
    setContent(data.issue.content);
    setDirty(false);
  }, [data?.issue.id, data?.issue.updatedAt]);

  const locked = !!data && (data.issue.status === "sending" || data.issue.status === "sent");
  const edit = (patch: Partial<IssueContent>) => {
    setContent((c) => (c ? { ...c, ...patch } : c));
    setDirty(true);
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/admin/newsletter"] });
    qc.invalidateQueries({ queryKey: [`/api/admin/newsletter/issues/${id}`] });
  };

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PUT", `/api/admin/newsletter/issues/${id}`, { subject, preheader, content })).json(),
    onSuccess: () => {
      invalidate();
      setDirty(false);
      setPreviewNonce((n) => n + 1);
      toast({ title: "Saved" });
    },
    onError: (e) => toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const test = useMutation({
    mutationFn: async () => {
      if (dirty) await apiRequest("PUT", `/api/admin/newsletter/issues/${id}`, { subject, preheader, content });
      return (await apiRequest("POST", `/api/admin/newsletter/issues/${id}/test`, { to: testTo })).json();
    },
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({ title: "Test sent", description: `Check ${testTo}. The subject starts with [TEST].` });
    },
    onError: (e) => toast({ title: "Test failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const send = useMutation({
    mutationFn: async () => {
      if (dirty) await apiRequest("PUT", `/api/admin/newsletter/issues/${id}`, { subject, preheader, content });
      return (await apiRequest("POST", `/api/admin/newsletter/issues/${id}/send`, {})).json();
    },
    onSuccess: () => {
      setConfirm(null);
      setDirty(false);
      invalidate();
      toast({ title: "Sending", description: `Going out to ${subscribed.toLocaleString()} people. Progress shows here.` });
    },
    onError: (e) => toast({ title: "Couldn't send", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const schedule = useMutation({
    mutationFn: async () => {
      if (dirty) await apiRequest("PUT", `/api/admin/newsletter/issues/${id}`, { subject, preheader, content });
      return (await apiRequest("POST", `/api/admin/newsletter/issues/${id}/schedule`, { at: new Date(scheduleAt).toISOString() })).json();
    },
    onSuccess: () => {
      setDirty(false);
      invalidate();
      toast({ title: "Scheduled", description: `Sends ${when(new Date(scheduleAt).toISOString())} Mountain time.` });
    },
    onError: (e) => toast({ title: "Couldn't schedule", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const unschedule = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/newsletter/issues/${id}/unschedule`, {})).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Back to draft" });
    },
    onError: (e) => toast({ title: "Couldn't unschedule", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/admin/newsletter/issues/${id}`)).json(),
    onSuccess: () => {
      setConfirm(null);
      onDeleted();
      qc.invalidateQueries({ queryKey: ["/api/admin/newsletter"] });
      toast({ title: "Issue deleted" });
    },
    onError: (e) => toast({ title: "Couldn't delete", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // Preview HTML is fetched with the bearer token and injected via srcDoc —
  // an iframe src cannot carry the token (see admin-market.tsx).
  const { data: preview, isFetching: previewLoading } = useQuery<{ html: string }>({
    queryKey: ["newsletter-preview", id, previewNonce, data?.issue.updatedAt],
    enabled: !!data,
    queryFn: async () => (await apiRequest("GET", `/api/admin/newsletter/issues/${id}/preview`)).json(),
  });
  function openPreview() {
    if (!preview?.html) return;
    const url = URL.createObjectURL(new Blob([preview.html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (!data || !content) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  const issue = data.issue;
  const sendingThis = progress.running && progress.issueId === id;

  return (
    <div className="space-y-4">
      {/* Status strip */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${STATUS_TONE[issue.status]}`}>
            {issue.status}
          </Badge>
          <span className="text-muted-foreground">{periodLabel(issue.period)} figures</span>
          <span className="text-muted-foreground">
            Market section: {data.available.report ? "figures ready" : "no figures yet"}
            {data.available.commentary ? ", commentary ready" : ""} · {data.available.reports} community report{data.available.reports === 1 ? "" : "s"} linked
          </span>
          {issue.status === "sent" && (
            <span className="text-muted-foreground">
              Sent {when(issue.sentAt)} · {issue.delivered.toLocaleString()} delivered{issue.failed ? `, ${issue.failed} failed` : ""}
            </span>
          )}
          {sendingThis && (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
              {progress.failed ? ` · ${progress.failed} failed` : ""}
            </span>
          )}
          {issue.status === "scheduled" && (
            <span className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4" /> Sends {when(issue.scheduledFor)}
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => unschedule.mutate()}>
                Cancel
              </Button>
            </span>
          )}
        </CardContent>
      </Card>
      {data.stats.failures.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <b>{data.stats.failed} address{data.stats.failed === 1 ? "" : "es"} failed.</b>{" "}
          {data.stats.failures.slice(0, 5).map((f) => `${f.email} (${f.error ?? "?"})`).join("; ")}
          {data.stats.failures.length > 5 ? " …" : ""}
          {issue.status === "sent" && !progress.running && (
            <Button size="sm" variant="outline" className="h-7 ml-3 text-xs" onClick={() => apiRequest("POST", `/api/admin/newsletter/issues/${id}/send`, { resend: true }).then(invalidate)}>
              Retry failed
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Editor */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-5 space-y-4">
              <Field label="Subject line">
                <Input value={subject} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} disabled={locked} />
              </Field>
              <Field label="Preview text (shown in the inbox under the subject)">
                <Input value={preheader} onChange={(e) => { setPreheader(e.target.value); setDirty(true); }} disabled={locked} />
              </Field>
              <Field label="Your note — the top of the email, after “Dear (first name),”">
                <Textarea rows={7} value={content.intro} onChange={(e) => edit({ intro: e.target.value })} disabled={locked} placeholder="Fall is here, and with Labour Day behind us…" />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Toggle label="Market at a glance" checked={content.showMarket} onChange={(v) => edit({ showMarket: v })} disabled={locked} />
                <Toggle label="Community reports" checked={content.showReports} onChange={(v) => edit({ showReports: v })} disabled={locked} />
                <Toggle label="Home evaluation" checked={content.showEvaluation} onChange={(v) => edit({ showEvaluation: v })} disabled={locked} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className={label}>In the news</div>
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={locked} onClick={() => edit({ news: [...content.news, { title: "", source: "", url: "" }] })}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Link
                </Button>
              </div>
              {content.news.map((n, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <Input className="col-span-6 h-9" placeholder="Headline" value={n.title} disabled={locked} onChange={(e) => edit({ news: content.news.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                  <Input className="col-span-2 h-9" placeholder="Source" value={n.source} disabled={locked} onChange={(e) => edit({ news: content.news.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)) })} />
                  <Input className="col-span-3 h-9" placeholder="https://" value={n.url} disabled={locked} onChange={(e) => edit({ news: content.news.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                  <Button size="icon" variant="ghost" className="h-9 w-9" disabled={locked} onClick={() => edit({ news: content.news.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className={label}>This month in Calgary</div>
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={locked} onClick={() => edit({ events: [...content.events, { title: "", dates: "", blurb: "", url: "" }] })}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Event
                </Button>
              </div>
              {content.events.map((ev, i) => (
                <div key={i} className="space-y-2 rounded-md border p-3">
                  <div className="grid grid-cols-12 gap-2">
                    <Input className="col-span-6 h-9" placeholder="Event" value={ev.title} disabled={locked} onChange={(e) => edit({ events: content.events.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                    <Input className="col-span-2 h-9" placeholder="Sep 9 – 13" value={ev.dates} disabled={locked} onChange={(e) => edit({ events: content.events.map((x, j) => (j === i ? { ...x, dates: e.target.value } : x)) })} />
                    <Input className="col-span-3 h-9" placeholder="https://" value={ev.url} disabled={locked} onChange={(e) => edit({ events: content.events.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                    <Button size="icon" variant="ghost" className="h-9 w-9" disabled={locked} onClick={() => edit({ events: content.events.filter((_, j) => j !== i) })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <Textarea rows={2} placeholder="One or two sentences." value={ev.blurb} disabled={locked} onChange={(e) => edit({ events: content.events.map((x, j) => (j === i ? { ...x, blurb: e.target.value } : x)) })} />
                </div>
              ))}
            </CardContent>
          </Card>

          <FeatureEditor label="Worth reading (the month's article)" value={content.article} disabled={locked} onChange={(article) => edit({ article })} titlePlaceholder="Getting around Calgary smarter" />
          <FeatureEditor label="Neighbourhood spotlight" value={content.neighbourhood} disabled={locked} onChange={(neighbourhood) => edit({ neighbourhood })} titlePlaceholder="Scenic Acres" />

          {/* Actions */}
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => save.mutate()} disabled={locked || !dirty || save.isPending}>
                  {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />} Save
                </Button>
                <Button variant="outline" onClick={openPreview} disabled={!preview?.html}>
                  <ExternalLink className="h-4 w-4 mr-2" /> Open full size
                </Button>
                {issue.status !== "sent" && (
                  <Button variant="outline" className="text-destructive" onClick={() => setConfirm("delete")} disabled={issue.status === "sending"}>
                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                  </Button>
                )}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <div className={label}>Send a test to</div>
                  <div className="flex gap-2">
                    <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} className="h-9" />
                    <Button variant="outline" className="h-9" onClick={() => test.mutate()} disabled={!configured || test.isPending || !testTo}>
                      {test.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
                {!locked && issue.status !== "scheduled" && (
                  <div className="space-y-1.5">
                    <div className={label}>Schedule (Mountain time)</div>
                    <div className="flex gap-2">
                      <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="h-9" />
                      <Button variant="outline" className="h-9" onClick={() => schedule.mutate()} disabled={!configured || !scheduleAt || schedule.isPending}>
                        <CalendarClock className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              {!locked && (
                <div className="flex items-center justify-between gap-3 border-t pt-4">
                  <p className="text-xs text-muted-foreground">
                    Goes to <b>{subscribed.toLocaleString()}</b> subscribed people, a hundred a second, each with their own unsubscribe link. Bounces and spam reports take people off the list automatically.
                  </p>
                  <Button onClick={() => setConfirm("send")} disabled={!configured || subscribed === 0 || progress.running}>
                    <Send className="h-4 w-4 mr-2" /> Send now
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Preview */}
        <Card className="xl:sticky xl:top-4 self-start">
          <CardContent className="p-3">
            <div className="flex items-center justify-between px-1 pb-2">
              <div className={label}>Preview</div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {previewLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                {dirty && "Save to refresh"}
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPreviewNonce((n) => n + 1)}>
                  <Eye className="h-3.5 w-3.5 mr-1" /> Refresh
                </Button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <iframe title="Newsletter preview" srcDoc={preview?.html ?? ""} className="bg-[#F4F4F4] border rounded" style={{ height: "78vh", width: "100%", minWidth: 640 }} sandbox="allow-same-origin allow-popups" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirm != null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "send" ? "Send this issue now?" : "Delete this issue?"}</DialogTitle>
            <DialogDescription>
              {confirm === "send"
                ? `“${subject}” goes to ${subscribed.toLocaleString()} people. This can't be recalled once it starts.`
                : "The draft and its content are removed. Nothing is sent."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            {confirm === "send" ? (
              <Button onClick={() => send.mutate()} disabled={send.isPending}>
                {send.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />} Send to {subscribed.toLocaleString()}
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => del.mutate()} disabled={del.isPending}>
                Delete
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label: l, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className={label}>{l}</div>
      {children}
    </div>
  );
}

function Toggle({ label: l, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
      {l}
    </label>
  );
}

function FeatureEditor({ label: l, value, onChange, disabled, titlePlaceholder }: { label: string; value: Feature | null; onChange: (f: Feature | null) => void; disabled: boolean; titlePlaceholder: string }) {
  const f = value ?? { title: "", body: "", imageUrl: "", url: "" };
  const set = (patch: Partial<Feature>) => onChange({ ...f, ...patch });
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className={label}>{l}</div>
          {value && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={disabled} onClick={() => onChange(null)}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
            </Button>
          )}
        </div>
        <Input className="h-9" placeholder={titlePlaceholder} value={f.title} disabled={disabled} onChange={(e) => set({ title: e.target.value })} />
        <Textarea rows={6} placeholder="Paragraphs separated by a blank line." value={f.body} disabled={disabled} onChange={(e) => set({ body: e.target.value })} />
        <div className="grid grid-cols-2 gap-2">
          <Input className="h-9" placeholder="Image URL (optional)" value={f.imageUrl} disabled={disabled} onChange={(e) => set({ imageUrl: e.target.value })} />
          <Input className="h-9" placeholder="Read-more link (optional)" value={f.url} disabled={disabled} onChange={(e) => set({ url: e.target.value })} />
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Subscribers ----------------------------------------------------------------------

function SubscribersTab({ counts }: { counts: Record<string, number> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (status) p.set("status", status);
    if (offset) p.set("offset", String(offset));
    const s = p.toString();
    return `/api/admin/newsletter/subscribers${s ? `?${s}` : ""}`;
  }, [q, status, offset]);
  const { data, isFetching } = useQuery<{ rows: Subscriber[]; counts: Record<string, number> }>({ queryKey: [url] });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["/api/admin/newsletter"] });
    qc.invalidateQueries({ predicate: (qq) => String(qq.queryKey[0]).startsWith("/api/admin/newsletter/subscribers") });
  };

  const setSub = useMutation({
    mutationFn: async (v: { id: number; status: Subscriber["status"] }) => (await apiRequest("PATCH", `/api/admin/newsletter/subscribers/${v.id}`, { status: v.status })).json(),
    onSuccess: refresh,
    onError: (e) => toast({ title: "Couldn't update", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/admin/newsletter/subscribers/${id}`)).json(),
    onSuccess: refresh,
    onError: (e) => toast({ title: "Couldn't remove", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const importCrm = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/newsletter/subscribers/import-crm", {})).json() as Promise<{ parsed: number; added: number; existing: number }>,
    onSuccess: (r) => {
      refresh();
      toast({ title: `Added ${r.added.toLocaleString()} from the CRM`, description: `${r.parsed.toLocaleString()} contacts have an email; ${r.existing.toLocaleString()} were already on the list.` });
    },
    onError: (e) => toast({ title: "Import failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  async function exportCsv() {
    const res = await apiRequest("GET", "/api/admin/newsletter/subscribers.csv");
    const blob = await res.blob();
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = "newsletter-subscribers.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 10_000);
  }

  const c = data?.counts ?? counts;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {(["subscribed", "unsubscribed", "bounced", "complained"] as const).map((s) => (
          <button key={s} onClick={() => { setStatus(status === s ? "" : s); setOffset(0); }} className={`rounded-md border p-4 text-left transition-colors ${status === s ? "border-foreground" : "hover:border-foreground/40"}`}>
            <div className={label}>{s}</div>
            <div className="text-2xl font-serif mt-1">{(c[s] ?? 0).toLocaleString()}</div>
          </button>
        ))}
      </div>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <Input placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="h-9 max-w-xs" />
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-9" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> Add one
            </Button>
            <Button variant="outline" size="sm" className="h-9" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-2" /> Import CSV
            </Button>
            <Button variant="outline" size="sm" className="h-9" onClick={() => importCrm.mutate()} disabled={importCrm.isPending}>
              {importCrm.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Users className="h-4 w-4 mr-2" />} Add CRM contacts
            </Button>
            <Button variant="outline" size="sm" className="h-9" onClick={exportCsv}>
              <Download className="h-4 w-4 mr-2" /> Export
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className={`${label} py-2 pr-3 font-medium`}>Email</th>
                  <th className={`${label} py-2 pr-3 font-medium`}>Name</th>
                  <th className={`${label} py-2 pr-3 font-medium`}>Status</th>
                  <th className={`${label} py-2 pr-3 font-medium`}>Consent</th>
                  <th className={`${label} py-2 pr-3 font-medium`}>Added</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((s) => (
                  <tr key={s.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 font-medium whitespace-nowrap">{s.email}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{[s.firstName, s.lastName].filter(Boolean).join(" ") || <span className="text-muted-foreground">—</span>}</td>
                    <td className="py-2 pr-3">
                      <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${SUB_TONE[s.status]}`}>{s.status}</Badge>
                      {s.status !== "subscribed" && s.statusReason && <div className="text-[11px] text-muted-foreground mt-1 max-w-[220px]">{s.statusReason}{s.statusChangedAt ? ` · ${when(s.statusChangedAt)}` : ""}</div>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground max-w-[240px]">
                      <span className="uppercase tracking-wider text-[10px]">{s.source}</span>
                      {s.consentSource && <div>{s.consentSource}</div>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">{when(s.createdAt)}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {s.status === "subscribed" ? (
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSub.mutate({ id: s.id, status: "unsubscribed" })}>Unsubscribe</Button>
                      ) : s.status === "unsubscribed" ? (
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { if (window.confirm(`Re-subscribe ${s.email}? Only do this if they asked.`)) setSub.mutate({ id: s.id, status: "subscribed" }); }}>Re-subscribe</Button>
                      ) : null}
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { if (window.confirm(`Remove ${s.email} entirely? An unsubscribe is kept as a record; removing forgets it.`)) remove.mutate(s.id); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
                {data && data.rows.length === 0 && (
                  <tr><td colSpan={6} className="py-8 text-center text-sm text-muted-foreground">{q || status ? "No one matches." : "Nobody on the list yet. Import the RealInfoBox export, or add your CRM contacts."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{isFetching ? "Loading…" : `Showing ${(data?.rows.length ?? 0).toLocaleString()} from ${offset + 1}`}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={(data?.rows.length ?? 0) < 100} onClick={() => setOffset(offset + 100)}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} />
      <AddDialog open={addOpen} onClose={() => setAddOpen(false)} onDone={refresh} />
    </div>
  );
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [source, setSource] = useState("realinfobox");
  const [consent, setConsent] = useState("Subscribed to the RealInfoBox Calgary Market Update; list exported before cancelling.");
  const [fileName, setFileName] = useState("");
  const run = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/newsletter/subscribers/import", { csv, source, consentSource: consent })).json() as Promise<{ parsed: number; added: number; existing: number; invalid: number }>,
    onSuccess: (r) => {
      onDone();
      onClose();
      setCsv("");
      setFileName("");
      toast({ title: `Imported ${r.added.toLocaleString()}`, description: `${r.parsed.toLocaleString()} addresses found; ${r.existing.toLocaleString()} already on the list. Unsubscribed people stay unsubscribed.` });
    },
    onError: (e) => toast({ title: "Import failed", description: apiErrorMessage(e), variant: "destructive" }),
  });
  async function onFile(f: File | undefined) {
    if (!f) return;
    setFileName(f.name);
    setCsv(await f.text());
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import subscribers</DialogTitle>
          <DialogDescription>A CSV with an email column. First and last name columns are picked up when present. Nobody who has unsubscribed is ever re-subscribed by an import.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2 items-center">
            <Input type="file" accept=".csv,.txt,.tsv" className="h-9" onChange={(e) => onFile(e.target.files?.[0])} />
            {fileName && <span className="text-xs text-muted-foreground whitespace-nowrap">{fileName}</span>}
          </div>
          <Textarea rows={6} placeholder="…or paste the CSV here" value={csv} onChange={(e) => setCsv(e.target.value)} className="font-mono text-xs" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Source">
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="realinfobox">RealInfoBox export</option>
                <option value="fub">Follow Up Boss export</option>
                <option value="mailchimp">Mailchimp export</option>
                <option value="import">Other</option>
              </select>
            </Field>
            <Field label="How consent was obtained (kept on each record)">
              <Input className="h-9" value={consent} onChange={(e) => setConsent(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => run.mutate()} disabled={!csv.trim() || run.isPending}>
            {run.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />} Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [consent, setConsent] = useState("Asked to be added");
  const run = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/newsletter/subscribers", { email, firstName: first, lastName: last, consentSource: consent })).json(),
    onSuccess: () => {
      onDone();
      onClose();
      setEmail(""); setFirst(""); setLast("");
      toast({ title: "Added" });
    },
    onError: (e) => toast({ title: "Couldn't add", description: apiErrorMessage(e), variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a subscriber</DialogTitle>
          <DialogDescription>Someone who asked you for the update. Note how, for the record.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
            <Input placeholder="Last name" value={last} onChange={(e) => setLast(e.target.value)} />
          </div>
          <Input placeholder="How they asked (e.g. at the Aspen Woods open house)" value={consent} onChange={(e) => setConsent(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => run.mutate()} disabled={!email.trim() || run.isPending}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
