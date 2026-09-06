// /admin/crm — the Follow Up Boss mirror.
//
// Reads the local copy synced hourly by server/fub-sync.ts rather than calling
// FUB per page view, so this stays fast and still renders when the API is
// down. The Sync now button forces a refresh.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Activity,
  Archive,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  FileText,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Copy,
  Search,
  Send,
  Stethoscope,
  TrendingUp,
  TriangleAlert,
  Users,
} from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ---- Types ------------------------------------------------------------------

interface SyncRun {
  id: number;
  resource: string;
  status: string;
  fetched: number;
  inserted: number;
  updated: number;
  httpStatus: number | null;
  error: string | null;
  truncated: boolean;
  nullRates: string;
  finishedAt: string | null;
  durationMs: number | null;
  trigger: string;
}

interface SyncResult {
  resource: string;
  status: string;
  fetched: number;
  inserted: number;
  updated: number;
  error?: string;
}

/** Progress of a background sync — see startSyncJob in server/fub-sync.ts. */
interface SyncJob {
  id: number;
  kind: "sync" | "text-backfill";
  trigger: string;
  full: boolean;
  startedAt: string;
  finishedAt: string | null;
  running: boolean;
  planned: string[];
  current: string | null;
  results: SyncResult[];
  progress: { done: number; total: number; label: string } | null;
  error: string | null;
}

interface RecordingInventory {
  calls: number;
  withRecording: number;
  totalSeconds: number;
  estimatedBytes: number;
  note: string;
}

interface ProbeResource {
  resource: string;
  path: string;
  ok: boolean;
  status: number;
  count?: number;
  envelopeKeys?: string[];
  metadata?: Record<string, unknown>;
  recordKeys?: string[];
  error?: string;
  note?: string;
}

interface Overview {
  configured: boolean;
  contacts: {
    total: number;
    newThisWeek: number;
    byStage: Array<{ stage: string; count: number }>;
  };
  deals: {
    total: number;
    open: number;
    openValue: number;
    wonValue: number;
    stages: Array<{ fubId: string; name: string | null; count: number; value: number }>;
  };
  activity: { calls: number; texts: number; events: number };
  openTasks: CrmActivity[];
  syncRuns: SyncRun[];
  mappingWarnings: Array<{ resource: string; fields: string[] }>;
  resources: Array<{ resource: string; optional: boolean; note: string | null }>;
}

interface CrmContact {
  fubId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  source: string | null;
  assignedTo: string | null;
  fubCreatedAt: string | null;
  lastActivityAt: string | null;
}

interface CrmActivity {
  id: number;
  kind: string;
  contactFubId: string | null;
  title: string | null;
  body: string | null;
  direction: string | null;
  outcome: string | null;
  durationSeconds: number | null;
  occurredAt: string | null;
  dueAt: string | null;
  completed: boolean;
}

interface CrmDeal {
  fubId: string;
  name: string | null;
  value: number | null;
  // The counts in the overview are computed on stageFubId, so the cards match
  // on it too. Matching on stageName instead put a deal in every column whose
  // stage happened to share a name, and showed none at all when a deal had an
  // id but no mapped name.
  stageFubId: string | null;
  stageName: string | null;
  status: string | null;
  contactFubId: string | null;
}

// ---- Helpers ----------------------------------------------------------------

function money(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n).toLocaleString("en-CA")}`;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** Rough "running for" text, refreshed by the sync poll rather than a timer. */
function elapsed(startedAt: string): string {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "a moment";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Time left, extrapolated from the rate so far. Honest about being an
 * estimate — a half-hour job with no finish line reads as a hang.
 */
function remaining(startedAt: string, p: { done: number; total: number }): string {
  const elapsedMs = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || p.done <= 0) return "a while";
  const perItem = elapsedMs / p.done;
  const mins = Math.round(((p.total - p.done) * perItem) / 60000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

function duration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const KIND_ICON: Record<string, typeof Phone> = {
  call: Phone,
  text: MessageSquare,
  event: Activity,
  note: FileText,
  email: Mail,
  task: CheckCircle2,
  appointment: CalendarClock,
};

const STATUS_STYLE: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-900",
  partial:
    "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900",
  error: "bg-red-100 text-red-900 border-red-200 dark:bg-red-950 dark:text-red-100 dark:border-red-900",
  skipped: "bg-secondary text-muted-foreground border-border",
};

/** Debounce so typing in the search box isn't one request per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// =============================================================================

export default function AdminCrmPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [openContact, setOpenContact] = useState<string | null>(null);
  const [activityKind, setActivityKind] = useState<string>("all");

  const { data: overview, isLoading } = useQuery<Overview>({
    queryKey: ["/api/admin/crm/overview"],
  });
  // The search term and the activity kind go to the server. Filtering the
  // loaded array instead would silently search only the page in hand, so a
  // contact outside the newest 200 could never be found.
  const debouncedSearch = useDebounced(search, 250);
  const { data: contacts = [], isFetching: contactsFetching } = useQuery<CrmContact[]>({
    queryKey: [`/api/admin/crm/contacts?q=${encodeURIComponent(debouncedSearch)}&limit=200`],
  });
  const { data: activities = [] } = useQuery<CrmActivity[]>({
    queryKey: [
      `/api/admin/crm/activities?limit=200${activityKind === "all" ? "" : `&kind=${activityKind}`}`,
    ],
  });
  const { data: deals = [] } = useQuery<CrmDeal[]>({
    queryKey: ["/api/admin/crm/deals?limit=500"],
  });
  // Opening a contact also pulls their texts live — Follow Up Boss has no
  // account-wide text listing, so this is the only place they can be fetched.
  // That makes this request slower than the rest of the page and worth its own
  // loading state.
  const { data: detail, isFetching: detailFetching } = useQuery<{
    contact: CrmContact;
    activities: CrmActivity[];
    deals: CrmDeal[];
    texts?: { ok: boolean; fetched: number; error?: string };
  }>({
    queryKey: [`/api/admin/crm/contacts/${openContact}`],
    enabled: !!openContact,
  });

  // Query keys carry their filters, so match on the path prefix rather than
  // an exact key.
  function refresh() {
    qc.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey[0] === "string" &&
        (q.queryKey[0] as string).startsWith("/api/admin/crm/"),
    });
  }

  // The sync runs in the background on the server and this polls it, rather
  // than the button holding a request open for the whole run. A full pass takes
  // minutes and Fly's proxy closes an idle connection at about a minute, so a
  // waiting request would report a failure for a sync that finished fine.
  // Polling starts on its own if a cron cycle is already under way when the
  // page loads.
  const { data: syncState } = useQuery<{ job: SyncJob | null }>({
    queryKey: ["/api/admin/crm/sync-job"],
    refetchInterval: (q) => (q.state.data?.job?.running ? 2000 : false),
    // The page-wide default is staleTime: Infinity, which is right for mirrored
    // CRM rows and wrong here — coming back to this page would then show a
    // cached "idle" while an hourly cycle was actually under way.
    staleTime: 0,
  });
  const job = syncState?.job ?? null;
  const syncing = !!job?.running;

  // Report the outcome of a run we actually watched finish.
  //
  // Keyed on having seen it running, not just on it being finished: the server
  // keeps the last job around, so a page load an hour after the cron ran would
  // otherwise pop a toast about a sync the user never started and already knows
  // the result of.
  const watchedJob = useRef<number | null>(null);
  useEffect(() => {
    if (!job) return;
    if (job.running) {
      watchedJob.current = job.id;
      return;
    }
    if (watchedJob.current !== job.id) return;
    watchedJob.current = null;
    refresh();
    const failed = job.results.filter((r) => r.status === "error");
    const added = job.results.reduce((s, r) => s + r.inserted, 0);
    const changed = job.results.reduce((s, r) => s + r.updated, 0);
    toast({
      title: job.error ? "Sync stopped early" : `Synced — ${added} new, ${changed} updated`,
      description:
        job.error ??
        (failed.length ? `Couldn't reach: ${failed.map((f) => f.resource).join(", ")}` : undefined),
      variant: job.error || failed.length ? "destructive" : undefined,
    });
    // refresh/toast are stable for this page's lifetime; the job is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.running]);

  const sync = useMutation({
    mutationFn: async (full: boolean) => {
      const res = await apiRequest("POST", "/api/admin/crm/sync", { full });
      return (await res.json()) as { started: boolean; job: SyncJob };
    },
    onSuccess: (d) => {
      // Seed the polled state so the button flips to "syncing" immediately
      // instead of on the next poll.
      qc.setQueryData(["/api/admin/crm/sync-job"], { job: d.job });
      qc.invalidateQueries({ queryKey: ["/api/admin/crm/sync-job"] });
      if (!d.started) {
        toast({
          title: "A sync is already running",
          description: `Started ${d.job.trigger === "cron" ? "by the hourly cycle" : "a moment ago"} — watching that one.`,
        });
      }
    },
    onError: (e) =>
      toast({ title: "Sync failed to start", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // Email goes out through Spencer's own Google mailbox, so it threads with
  // replies and comes back through Follow Up Boss's mailbox sync. A connection
  // made before this existed lacks the send scope, which is worth saying up
  // front rather than at the moment someone presses Send.
  const { data: emailStatus } = useQuery<{ ok: boolean; reason?: string }>({
    queryKey: ["/api/admin/crm/email-status"],
  });
  const [composeOpen, setComposeOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");

  const sendEmail = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/crm/contacts/${openContact}/email`, {
        subject,
        body: emailBody,
      });
      return (await res.json()) as { messageId: string };
    },
    onSuccess: () => {
      setComposeOpen(false);
      setSubject("");
      setEmailBody("");
      qc.invalidateQueries({ queryKey: [`/api/admin/crm/contacts/${openContact}`] });
      toast({ title: "Sent", description: "It's in your Gmail Sent folder and this contact's history." });
    },
    onError: (e) =>
      toast({ title: "Couldn't send", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // Reads the live API and reports the field names it actually returns, so the
  // mapping in fub-sync.ts can be corrected from evidence. Never returns record
  // values — names only.
  const [probeOpen, setProbeOpen] = useState(false);
  const probe = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/admin/crm/probe");
      return (await res.json()) as { configured: boolean; resources: ProbeResource[] };
    },
    onSuccess: () => setProbeOpen(true),
    onError: (e) =>
      toast({ title: "Probe failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  async function copyProbe() {
    const text = JSON.stringify(probe.data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: "Paste it back into the chat." });
    } catch {
      // Clipboard access is denied outside a secure context, and in some
      // embedded browsers. The textarea below is selectable either way.
      toast({
        title: "Couldn't copy automatically",
        description: "Select the text below and copy it by hand.",
        variant: "destructive",
      });
    }
  }

  const backfill = useMutation({
    mutationFn: async (restart: boolean) => {
      const res = await apiRequest("POST", "/api/admin/crm/backfill-texts", { restart });
      return (await res.json()) as { started: boolean; job: SyncJob };
    },
    onSuccess: (d) => {
      qc.setQueryData(["/api/admin/crm/sync-job"], { job: d.job });
      qc.invalidateQueries({ queryKey: ["/api/admin/crm/sync-job"] });
      if (!d.started) {
        toast({
          title: "Something else is already running",
          description: "Wait for the job in progress to finish, then try again.",
        });
      }
    },
    onError: (e) =>
      toast({ title: "Couldn't start", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const { data: recordings } = useQuery<RecordingInventory>({
    queryKey: ["/api/admin/crm/recordings"],
  });

  const test = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/admin/crm/test");
      return (await res.json()) as { ok: boolean; configured: boolean; error?: string; accountHint?: string };
    },
    onSuccess: (d) =>
      toast({
        title: d.ok ? "Follow Up Boss connected" : "Couldn't connect",
        description: d.ok ? d.accountHint : d.error,
        variant: d.ok ? undefined : "destructive",
      }),
    onError: (e) =>
      toast({ title: "Test failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // Both lists arrive already filtered by the query above.
  const filteredContacts = contacts;
  const visibleActivities = activities;

  const contactName = (fubId: string | null) =>
    contacts.find((c) => c.fubId === fubId)?.name ?? null;

  return (
    <AppShell pageTitle="CRM">
      <div className="p-6 max-w-[1200px] mx-auto">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="font-serif text-3xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
              CRM
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
              Your Follow Up Boss account, mirrored here hourly — people, deals, calls, texts and
              tasks. Read-only: edits still happen in Follow Up Boss, and land here on the next sync.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => test.mutate()}
              disabled={test.isPending}
              data-testid="button-crm-test"
              className="rounded-sm text-[11px] font-display tracking-[0.14em]"
            >
              {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "TEST CONNECTION"}
            </Button>
            <Button
              onClick={() => sync.mutate(false)}
              disabled={sync.isPending || syncing || !overview?.configured}
              data-testid="button-crm-sync"
              className="rounded-sm text-[11px] font-display tracking-[0.14em]"
            >
              {sync.isPending || syncing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> SYNCING…
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5 mr-2" /> SYNC NOW
                </>
              )}
            </Button>
          </div>
        </div>

        {/* ---- Live sync progress ----
            Answers "how long should this take?" while it's happening, instead
            of a spinner that gives no sign of whether anything is moving. */}
        {job?.running && (
          <Card className="mb-6" data-testid="crm-sync-progress">
            <CardContent className="p-5">
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-[15px]">
                    {job.kind === "text-backfill"
                      ? "Backfilling text messages"
                      : `${job.trigger === "cron" ? "Hourly sync running" : "Syncing"}${
                          job.current ? ` — ${job.current}` : "…"
                        }`}
                  </div>
                  <div className="text-[12px] text-muted-foreground">
                    {job.progress
                      ? `${job.progress.done.toLocaleString("en-CA")} of ${job.progress.total.toLocaleString("en-CA")} contacts`
                      : `${job.results.length} of ${job.planned.length} done`}{" "}
                    · {job.results.reduce((s, r) => s + r.inserted, 0)} new ·{" "}
                    {job.results.reduce((s, r) => s + r.updated, 0)} updated · running for{" "}
                    {elapsed(job.startedAt)}
                    {job.progress && job.progress.done > 0 && (
                      <> · about {remaining(job.startedAt, job.progress)} left</>
                    )}
                  </div>
                </div>
              </div>
              <div className="h-1 rounded-full bg-secondary overflow-hidden mb-3">
                <div
                  className="h-full bg-foreground transition-all duration-500"
                  style={{
                    width: `${Math.round(
                      job.progress
                        ? (job.progress.done / Math.max(job.progress.total, 1)) * 100
                        : (job.results.length / Math.max(job.planned.length, 1)) * 100,
                    )}%`,
                  }}
                />
              </div>
              {job.kind === "sync" && (
                <div className="flex flex-wrap gap-1.5">
                  {job.planned.map((r) => {
                    const done = job.results.find((x) => x.resource === r);
                    return (
                      <Badge
                        key={r}
                        variant="outline"
                        className={`text-[10px] tracking-[0.1em] ${
                          done
                            ? (STATUS_STYLE[done.status] ?? "")
                            : r === job.current
                              ? "border-foreground"
                              : "text-muted-foreground"
                        }`}
                      >
                        {r}
                      </Badge>
                    );
                  })}
                </div>
              )}
              <p className="text-[12px] text-muted-foreground mt-3 leading-relaxed">
                {job.kind === "text-backfill"
                  ? "It keeps running on the server even if you close this page, and it resumes where it stopped — so an interrupted run doesn't start over."
                  : "It keeps running on the server even if you close this page — the first full pull can take several minutes, and later ones are quicker because people syncs incrementally."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* ---- Not configured ---- */}
        {overview && !overview.configured && (
          <Card className="mb-6">
            <CardContent className="p-5 flex items-start gap-3">
              <CircleAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-[15px] mb-1">Follow Up Boss isn't connected</div>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
                  Set <code className="text-foreground">FUB_API_KEY</code> as a Fly secret (Follow Up
                  Boss → Admin → API), then hit Sync now. Nothing else on the site depends on it —
                  lead push-out already degrades gracefully without it.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ---- Mapping warnings ---- */}
        {overview && overview.mappingWarnings.length > 0 && (
          <Card className="mb-6 border-amber-300 dark:border-amber-900">
            <CardContent className="p-5 flex items-start gap-3">
              <TriangleAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-[15px] mb-1">Some fields came back empty</div>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl mb-2">
                  These columns were null for every record in the last sync, which usually means the
                  field name we read doesn't match what Follow Up Boss returns — not that your CRM is
                  empty. The raw payloads are stored, so nothing is lost and the mapping can be
                  corrected without re-pulling.
                </p>
                <ul className="text-[13px] text-foreground/80 space-y-0.5">
                  {overview.mappingWarnings.map((w) => (
                    <li key={w.resource} data-testid={`mapping-warning-${w.resource}`}>
                      <span className="font-medium">{w.resource}</span>: {w.fields.join(", ")}
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ---- KPIs ---- */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-6">
          {[
            { label: "Contacts", value: String(overview?.contacts.total ?? 0), icon: Users },
            { label: "New this week", value: String(overview?.contacts.newThisWeek ?? 0), icon: TrendingUp },
            { label: "Open deals", value: String(overview?.deals.open ?? 0), icon: Activity },
            { label: "Pipeline value", value: money(overview?.deals.openValue ?? 0), icon: TrendingUp },
          ].map((k) => (
            <Card key={k.label}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-[10px] font-display tracking-[0.16em] text-muted-foreground mb-2">
                  <k.icon className="h-3.5 w-3.5" />
                  {k.label.toUpperCase()}
                </div>
                <div
                  className="font-serif text-3xl"
                  data-testid={`crm-stat-${k.label.toLowerCase().replace(/\s/g, "-")}`}
                >
                  {k.value}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading CRM…
          </div>
        ) : (
          <Tabs defaultValue="pipeline">
            <TabsList className="mb-5">
              <TabsTrigger value="pipeline" data-testid="tab-crm-pipeline">Pipeline</TabsTrigger>
              <TabsTrigger value="contacts" data-testid="tab-crm-contacts">Contacts</TabsTrigger>
              <TabsTrigger value="activity" data-testid="tab-crm-activity">Activity</TabsTrigger>
              <TabsTrigger value="tasks" data-testid="tab-crm-tasks">Tasks</TabsTrigger>
              <TabsTrigger value="sync" data-testid="tab-crm-sync">Sync</TabsTrigger>
            </TabsList>

            {/* ================= PIPELINE ================= */}
            <TabsContent value="pipeline">
              {(overview?.deals.stages.length ?? 0) === 0 ? (
                <Card>
                  <CardContent className="p-10 text-center">
                    <p className="text-sm text-muted-foreground max-w-lg mx-auto leading-relaxed">
                      No pipeline stages synced. Deals are a Follow Up Boss add-on — if your plan
                      doesn't include them, the Sync tab will show a 403 against{" "}
                      <code className="text-foreground">deals</code>, and everything else still works.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="pipeline-board">
                  {overview!.deals.stages.map((s) => (
                    <Card key={s.fubId} data-testid={`stage-${s.fubId}`}>
                      <CardContent className="p-4">
                        <div className="flex items-baseline justify-between gap-2 mb-3">
                          <h3 className="font-serif text-[18px]">{s.name ?? "Unnamed stage"}</h3>
                          <span className="text-[12px] text-muted-foreground shrink-0">
                            {s.count} · {money(s.value)}
                          </span>
                        </div>
                        <div className="space-y-1.5">
                          {deals
                            .filter((d) => d.stageFubId === s.fubId)
                            .slice(0, 6)
                            .map((d) => (
                              <button
                                key={d.fubId}
                                onClick={() => d.contactFubId && setOpenContact(d.contactFubId)}
                                className="w-full text-left px-3 py-2 rounded-sm bg-secondary/40 hover:bg-secondary/70 transition-colors"
                              >
                                <div className="text-[13px] truncate">
                                  {d.name ?? contactName(d.contactFubId) ?? "Untitled deal"}
                                </div>
                                <div className="text-[12px] text-muted-foreground">
                                  {money(d.value ?? 0)}
                                </div>
                              </button>
                            ))}
                          {s.count === 0 && (
                            <p className="text-[12px] text-muted-foreground py-1">Nothing here yet.</p>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* ================= CONTACTS ================= */}
            <TabsContent value="contacts">
              <div className="relative mb-4 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, phone, stage…"
                  data-testid="input-crm-search"
                  className="pl-9 rounded-sm"
                />
                {contactsFetching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>
              {filteredContacts.length === 0 ? (
                <Card>
                  <CardContent className="p-10 text-center">
                    <p className="text-sm text-muted-foreground">
                      {contacts.length === 0 ? "No contacts synced yet." : "Nothing matches that search."}
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-1.5" data-testid="crm-contact-list">
                  {filteredContacts.map((c) => (
                    <button
                      key={c.fubId}
                      onClick={() => setOpenContact(c.fubId)}
                      data-testid={`crm-contact-${c.fubId}`}
                      className="w-full text-left"
                    >
                      <Card className="hover:border-foreground/30 transition-colors">
                        <CardContent className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-[14px]">{c.name ?? "Unnamed"}</span>
                              {c.stage && (
                                <Badge variant="outline" className="text-[10px] tracking-[0.1em]">
                                  {c.stage.toUpperCase()}
                                </Badge>
                              )}
                            </div>
                            <div className="text-[12px] text-muted-foreground flex flex-wrap gap-x-3">
                              {c.email && (
                                <span className="inline-flex items-center gap-1.5">
                                  <Mail className="h-3 w-3" />
                                  {c.email}
                                </span>
                              )}
                              {c.phone && (
                                <span className="inline-flex items-center gap-1.5">
                                  <Phone className="h-3 w-3" />
                                  {c.phone}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-[12px] text-muted-foreground shrink-0 text-right">
                            {c.source && <div>{c.source}</div>}
                            <div>{when(c.lastActivityAt)}</div>
                          </div>
                        </CardContent>
                      </Card>
                    </button>
                  ))}
                  {filteredContacts.length >= 200 && (
                    <p className="text-[12px] text-muted-foreground pt-2">
                      Showing the 200 most recently updated matches — narrow the search to see more.
                    </p>
                  )}
                </div>
              )}
            </TabsContent>

            {/* ================= ACTIVITY ================= */}
            <TabsContent value="activity">
              <div className="flex flex-wrap gap-2 mb-4">
                {["all", "call", "text", "event", "task", "appointment"].map((k) => (
                  <button
                    key={k}
                    onClick={() => setActivityKind(k)}
                    data-testid={`filter-activity-${k}`}
                    className={`px-3 py-1.5 rounded-sm text-[11px] font-display tracking-[0.14em] border transition-colors ${
                      activityKind === k
                        ? "bg-foreground text-background border-foreground"
                        : "border-border text-muted-foreground hover:bg-secondary/60"
                    }`}
                  >
                    {k.toUpperCase()}
                  </button>
                ))}
              </div>
              {visibleActivities.length === 0 ? (
                <Card>
                  <CardContent className="p-10 text-center">
                    <p className="text-sm text-muted-foreground">Nothing to show for this filter.</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-1.5" data-testid="crm-activity-list">
                  {visibleActivities.map((a) => {
                    const Icon = KIND_ICON[a.kind] ?? Activity;
                    const dur = duration(a.durationSeconds);
                    return (
                      <Card key={a.id}>
                        <CardContent className="p-3.5 flex items-start gap-3">
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[14px] font-medium">{a.title ?? a.kind}</span>
                              {a.direction && (
                                <Badge variant="outline" className="text-[10px] tracking-[0.1em]">
                                  {a.direction.toUpperCase()}
                                </Badge>
                              )}
                              {a.outcome && (
                                <span className="text-[12px] text-muted-foreground">{a.outcome}</span>
                              )}
                              {dur && <span className="text-[12px] text-muted-foreground">{dur}</span>}
                            </div>
                            {a.body && (
                              <p className="text-[13px] text-foreground/80 mt-1 leading-relaxed line-clamp-3">
                                {a.body}
                              </p>
                            )}
                            <div className="text-[12px] text-muted-foreground mt-1">
                              {contactName(a.contactFubId) ?? "Unlinked"} · {when(a.occurredAt)}
                            </div>
                          </div>
                          {a.contactFubId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setOpenContact(a.contactFubId)}
                              className="rounded-sm text-[11px] shrink-0"
                            >
                              OPEN
                            </Button>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </TabsContent>

            {/* ================= TASKS ================= */}
            <TabsContent value="tasks">
              {(overview?.openTasks.length ?? 0) === 0 ? (
                <Card>
                  <CardContent className="p-10 text-center">
                    <p className="text-sm text-muted-foreground">No open tasks or appointments.</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-1.5" data-testid="crm-task-list">
                  {overview!.openTasks.map((t) => {
                    const overdue = t.dueAt ? Date.parse(t.dueAt) < Date.now() : false;
                    return (
                      <Card key={t.id}>
                        <CardContent className="p-3.5 flex items-center gap-3">
                          {t.kind === "appointment" ? (
                            <CalendarClock className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-[14px]">{t.title ?? "Untitled"}</div>
                            <div className="text-[12px] text-muted-foreground">
                              {contactName(t.contactFubId) ?? "Unlinked"}
                            </div>
                          </div>
                          <span
                            className={`text-[12px] shrink-0 ${overdue ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {when(t.dueAt)}
                          </span>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </TabsContent>

            {/* ================= SYNC ================= */}
            <TabsContent value="sync">
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <Button
                  variant="outline"
                  onClick={() => sync.mutate(true)}
                  disabled={sync.isPending || syncing || !overview?.configured}
                  data-testid="button-crm-full-sync"
                  className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                >
                  FULL RE-SYNC
                </Button>
                <span className="text-[12px] text-muted-foreground">
                  Ignores the incremental cursor and re-pulls everything. Slower; use after fixing a
                  mapping.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 mb-5">
                <Button
                  variant="outline"
                  onClick={() => probe.mutate()}
                  disabled={probe.isPending || !overview?.configured}
                  data-testid="button-crm-probe"
                  className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                >
                  {probe.isPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> PROBING…
                    </>
                  ) : (
                    <>
                      <Stethoscope className="h-3.5 w-3.5 mr-2" /> RUN PROBE
                    </>
                  )}
                </Button>
                <span className="text-[12px] text-muted-foreground max-w-xl leading-relaxed">
                  Asks Follow Up Boss what its endpoints actually return — response shape and{" "}
                  <em>field names only</em>, never contact data. This is what proves whether a column
                  showing empty is a mapping mistake or a genuinely empty CRM.
                </span>
              </div>
              {/* ---- Getting your data out ----
                  Separated from the sync controls above because it answers a
                  different question: not "is the dashboard current" but "could
                  I leave Follow Up Boss tomorrow without losing anything". */}
              <Card className="mb-5 border-amber-300 dark:border-amber-900">
                <CardContent className="p-5">
                  <div className="flex items-start gap-3 mb-4">
                    <Archive className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium text-[15px] mb-1">Getting your data out</div>
                      <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
                        The hourly sync keeps this dashboard current. It is not the same as having a
                        complete copy — two things live only in Follow Up Boss, and both stop being
                        reachable the day the subscription ends.
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-sm bg-secondary/40 p-4">
                      <div className="font-display text-[10px] tracking-[0.16em] text-muted-foreground mb-2">
                        TEXT MESSAGES
                      </div>
                      <p className="text-[13px] text-foreground/80 leading-relaxed mb-3">
                        Follow Up Boss won't list texts account-wide — the endpoint needs a specific
                        contact — so the sync can't mirror them and they're fetched when you open
                        someone. Every contact you've never clicked has no texts stored here.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => backfill.mutate(false)}
                        disabled={backfill.isPending || syncing || !overview?.configured}
                        data-testid="button-crm-backfill-texts"
                        className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                      >
                        {backfill.isPending ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> STARTING…
                          </>
                        ) : (
                          <>
                            <MessageSquare className="h-3.5 w-3.5 mr-2" /> BACKFILL ALL TEXTS
                          </>
                        )}
                      </Button>
                      <p className="text-[11.5px] text-muted-foreground mt-2 leading-relaxed">
                        One request per contact, so it runs for a while. It resumes if interrupted.
                      </p>
                    </div>

                    <div className="rounded-sm bg-secondary/40 p-4">
                      <div className="font-display text-[10px] tracking-[0.16em] text-muted-foreground mb-2">
                        CALL RECORDINGS
                      </div>
                      {recordings ? (
                        <>
                          <p className="text-[13px] text-foreground/80 leading-relaxed mb-2">
                            <span className="font-medium" data-testid="recording-count">
                              {recordings.withRecording.toLocaleString("en-CA")}
                            </span>{" "}
                            of {recordings.calls.toLocaleString("en-CA")} mirrored calls have audio,
                            roughly{" "}
                            <span className="font-medium">{bytes(recordings.estimatedBytes)}</span>{" "}
                            in total.
                          </p>
                          <p className="text-[13px] text-foreground/80 leading-relaxed">
                            The audio itself is hosted by Follow Up Boss. Only the link is stored
                            here, and those links stop working when the account closes.
                          </p>
                        </>
                      ) : (
                        <p className="text-[13px] text-muted-foreground">Counting…</p>
                      )}
                      <p className="text-[11.5px] text-muted-foreground mt-2 leading-relaxed">
                        Downloading them is the next piece of work — it needs somewhere to put them
                        first.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <div className="space-y-1.5" data-testid="crm-sync-runs">
                {(overview?.syncRuns.length ?? 0) === 0 ? (
                  <Card>
                    <CardContent className="p-10 text-center">
                      <p className="text-sm text-muted-foreground">
                        Nothing has synced yet. The cron runs hourly, or hit Sync now.
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  overview!.syncRuns.map((r) => {
                    const optional = overview!.resources.find((x) => x.resource === r.resource)?.optional;
                    return (
                      <Card key={r.id} data-testid={`sync-run-${r.resource}`}>
                        <CardContent className="p-3.5">
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="font-medium text-[14px] w-36 shrink-0">{r.resource}</span>
                            <Badge
                              variant="outline"
                              className={`text-[10px] tracking-[0.1em] ${STATUS_STYLE[r.status] ?? ""}`}
                            >
                              {r.status.toUpperCase()}
                            </Badge>
                            <span className="text-[12px] text-muted-foreground">
                              {r.fetched} fetched · {r.inserted} new · {r.updated} updated
                            </span>
                            <span className="text-[12px] text-muted-foreground ml-auto">
                              {when(r.finishedAt)}
                              {r.durationMs != null ? ` · ${Math.round(r.durationMs / 100) / 10}s` : ""}
                            </span>
                          </div>
                          {r.error && (
                            <p className="text-[12px] text-muted-foreground mt-2 border-l-2 border-border pl-3 leading-relaxed">
                              {r.httpStatus === 403 && optional
                                ? `403 — this resource isn't enabled on your Follow Up Boss plan. Everything else still syncs.`
                                : r.error.slice(0, 300)}
                            </p>
                          )}
                          {r.truncated && (
                            <p
                              className="text-[12px] text-amber-700 dark:text-amber-400 mt-2 border-l-2 border-amber-400 pl-3 leading-relaxed"
                              data-testid={`sync-truncated-${r.resource}`}
                            >
                              Not everything was pulled — this stopped at a safety cutoff with more
                              still available, so treat the numbers above as a floor.
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* ---- Probe result ----
          Rendered as a summary plus the raw JSON: the summary is readable, and
          the JSON is the thing worth pasting back so the mapping can be fixed
          against real field names. */}
      <Dialog open={probeOpen} onOpenChange={setProbeOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">What Follow Up Boss returns</DialogTitle>
          </DialogHeader>
          {probe.data && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyProbe}
                  data-testid="button-copy-probe"
                  className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                >
                  <Copy className="h-3.5 w-3.5 mr-2" /> COPY JSON
                </Button>
                <span className="text-[12px] text-muted-foreground">
                  Field names and response shapes only — no contact details.
                </span>
              </div>

              <div className="space-y-1.5">
                {probe.data.resources.map((r) => (
                  <div
                    key={r.resource}
                    className="px-3.5 py-3 rounded-sm bg-secondary/40"
                    data-testid={`probe-${r.resource}`}
                  >
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="font-medium text-[14px] w-32 shrink-0">{r.resource}</span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] tracking-[0.1em] ${
                          r.ok ? STATUS_STYLE.ok : STATUS_STYLE.error
                        }`}
                      >
                        {r.ok ? `HTTP ${r.status}` : `HTTP ${r.status || "ERR"}`}
                      </Badge>
                      {r.ok && (
                        <span className="text-[12px] text-muted-foreground">
                          envelope: {(r.envelopeKeys ?? []).join(", ") || "—"}
                        </span>
                      )}
                    </div>
                    {r.ok && (r.recordKeys?.length ?? 0) > 0 && (
                      <p className="text-[12px] text-foreground/75 mt-1.5 leading-relaxed break-words">
                        <span className="text-muted-foreground">fields:</span>{" "}
                        {r.recordKeys!.join(", ")}
                      </p>
                    )}
                    {r.ok && (r.recordKeys?.length ?? 0) === 0 && (
                      <p className="text-[12px] text-muted-foreground mt-1.5">
                        Reachable, but no records came back — nothing to read field names from.
                      </p>
                    )}
                    {!r.ok && (
                      <p className="text-[12px] text-muted-foreground mt-1.5 leading-relaxed">
                        {r.status === 403 && r.note ? r.note : (r.error ?? "Unreachable")}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <div>
                <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-2">
                  RAW
                </div>
                <textarea
                  readOnly
                  value={JSON.stringify(probe.data, null, 2)}
                  data-testid="probe-json"
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full h-56 text-[11.5px] font-mono leading-relaxed rounded-sm border border-border bg-secondary/30 p-3"
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Contact detail ---- */}
      <Dialog open={!!openContact} onOpenChange={(o) => !o && setOpenContact(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl flex items-center gap-2.5">
              {detail?.contact.name ?? "Contact"}
              {detailFetching && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
              )}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-5">
              {/* ---- Compose ----
                  Sends from Spencer's own mailbox, so a reply threads against
                  it and Follow Up Boss mirrors it straight back. */}
              {detail.contact.email && (
                <div className="rounded-sm border border-border p-3.5">
                  {composeOpen ? (
                    <div className="space-y-2.5">
                      <div className="text-[12px] text-muted-foreground">
                        To <span className="text-foreground">{detail.contact.email}</span>
                      </div>
                      <Input
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        placeholder="Subject"
                        data-testid="input-email-subject"
                        className="rounded-sm"
                      />
                      <textarea
                        value={emailBody}
                        onChange={(e) => setEmailBody(e.target.value)}
                        placeholder="Write your message…"
                        rows={7}
                        data-testid="input-email-body"
                        className="w-full text-[14px] leading-relaxed rounded-sm border border-border bg-transparent p-3 resize-y"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => sendEmail.mutate()}
                          disabled={sendEmail.isPending || !subject.trim() || !emailBody.trim()}
                          data-testid="button-send-email"
                          className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                        >
                          {sendEmail.isPending ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> SENDING…
                            </>
                          ) : (
                            <>
                              <Send className="h-3.5 w-3.5 mr-2" /> SEND
                            </>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setComposeOpen(false)}
                          className="rounded-sm text-[11px]"
                        >
                          CANCEL
                        </Button>
                        <span className="text-[11.5px] text-muted-foreground">
                          Sends from your Gmail, so replies come back to you normally.
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setComposeOpen(true)}
                        disabled={!emailStatus?.ok}
                        data-testid="button-compose-email"
                        className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                      >
                        <Send className="h-3.5 w-3.5 mr-2" /> EMAIL
                      </Button>
                      {emailStatus && !emailStatus.ok && (
                        <span className="text-[12px] text-muted-foreground leading-relaxed">
                          {emailStatus.reason}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted-foreground">
                {detail.contact.email && (
                  <a href={`mailto:${detail.contact.email}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                    <Mail className="h-3.5 w-3.5" />
                    {detail.contact.email}
                  </a>
                )}
                {detail.contact.phone && (
                  <a href={`tel:${detail.contact.phone}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                    <Phone className="h-3.5 w-3.5" />
                    {detail.contact.phone}
                  </a>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {detail.contact.stage && <Badge variant="outline">{detail.contact.stage}</Badge>}
                {detail.contact.source && <Badge variant="outline">{detail.contact.source}</Badge>}
                {detail.contact.assignedTo && (
                  <Badge variant="outline">{detail.contact.assignedTo}</Badge>
                )}
              </div>

              {detail.deals.length > 0 && (
                <div>
                  <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-2">
                    DEALS
                  </div>
                  <div className="space-y-1.5">
                    {detail.deals.map((d) => (
                      <div key={d.fubId} className="flex items-center justify-between gap-3 px-3 py-2 rounded-sm bg-secondary/40">
                        <span className="text-[13px]">{d.name ?? "Untitled"}</span>
                        <span className="text-[13px] text-muted-foreground">
                          {d.stageName} · {money(d.value ?? 0)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-2">
                  HISTORY
                </div>
                {detail.texts && !detail.texts.ok && (
                  <p className="text-[12px] text-muted-foreground mb-2 border-l-2 border-border pl-3 leading-relaxed">
                    Couldn't load this contact's texts just now — calls, events and tasks below are
                    from the hourly mirror and are unaffected. {detail.texts.error}
                  </p>
                )}
                {detail.activities.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  <div className="space-y-2">
                    {detail.activities.map((a) => {
                      const Icon = KIND_ICON[a.kind] ?? Activity;
                      return (
                        <div key={a.id} className="flex items-start gap-2.5">
                          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1" />
                          <div className="min-w-0">
                            <div className="text-[13px]">
                              {a.title ?? a.kind}
                              {a.direction ? ` · ${a.direction}` : ""}
                              {duration(a.durationSeconds) ? ` · ${duration(a.durationSeconds)}` : ""}
                            </div>
                            {a.body && (
                              <p className="text-[12.5px] text-foreground/75 leading-relaxed">{a.body}</p>
                            )}
                            <div className="text-[11.5px] text-muted-foreground">{when(a.occurredAt)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
