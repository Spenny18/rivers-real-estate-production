// Automations / action plans (server/automations.ts).
//
// /admin/automations        plans, messages waiting for approval, tasks the plans made
// /admin/automations/:id    the builder: drag steps from the left onto a "+" (or
//                           click "+"), click a step to edit it; and the people in it.

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  ChevronDown,
  CheckSquare,
  Clock,
  Facebook,
  GitBranch,
  Instagram,
  Linkedin,
  ListChecks,
  Mail,
  MessageSquare,
  Play,
  Plus,
  Tag,
  TagIcon,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { MergeFieldPicker, insertAtCursor, type MergeField } from "@/components/merge-field-picker";
import { timeAgo } from "@/lib/mock-data";

// ---- Types (mirror server/automations.ts) ------------------------------------------------

type Trigger = { type: "new_lead"; sources?: string[]; leadType?: "buyer" | "seller" } | { type: "tag_added"; tag: string } | { type: "manual" };
type Mode = "off" | "review" | "auto";
type Step =
  | { id: string; type: "wait"; amount: number; unit: "minutes" | "hours" | "days" }
  | { id: string; type: "send_text"; body: string }
  | { id: string; type: "send_email"; subject: string; body: string }
  | { id: string; type: "add_tag"; tag: string }
  | { id: string; type: "remove_tag"; tag: string }
  | { id: string; type: "create_task"; title: string; note?: string; dueInHours?: number }
  | { id: string; type: "social_task"; network: "facebook" | "instagram" | "linkedin"; message: string }
  | { id: string; type: "start_plan"; automationId: number }
  | { id: string; type: "condition"; check: "has_phone" | "has_email" | "has_tag" | "replied" | "source_is"; value?: string; yes: Step[]; no: Step[] };
type StepType = Step["type"];
type PaletteKey = StepType | "social_facebook" | "social_instagram" | "social_linkedin";

interface Automation {
  id: number;
  name: string;
  description: string | null;
  trigger: Trigger;
  steps: Step[];
  mode: Mode;
  stopOnReply: boolean;
  enabledAt: string | null;
  updatedAt: string;
  counts?: Record<string, number>;
}
interface Pending {
  stepRowId: number;
  runId: number;
  automationId: number;
  automationName: string;
  contactFubId: string;
  contactName: string | null;
  type: string;
  payload: { to: string; body: string; subject?: string };
  createdAt: string;
}
interface RunRow {
  id: number;
  contactFubId: string;
  contactName: string | null;
  status: string;
  stepId: string | null;
  nextAt: string | null;
  stoppedReason: string | null;
  startedAt: string;
}
/** A lead's time in a plan, as the overview lists it. */
interface RecentRun extends RunRow {
  automationId: number;
  automationName: string;
  contactSource: string | null;
  lastDetail: string | null;
  lastAt: string | null;
}
interface Meta {
  sources: string[];
  tags: string[];
  channels: { text: { ok: boolean; reason?: string }; email: { ok: boolean; reason?: string } };
  fields: MergeField[];
}

// ---- Step catalogue ----------------------------------------------------------------------

const PALETTE: Array<{ key: PaletteKey; label: string; icon: any; group: string }> = [
  { key: "send_text", label: "Send text", icon: MessageSquare, group: "Messages" },
  { key: "send_email", label: "Send email", icon: Mail, group: "Messages" },
  { key: "social_facebook", label: "Facebook message", icon: Facebook, group: "Messages" },
  { key: "social_instagram", label: "Instagram message", icon: Instagram, group: "Messages" },
  { key: "social_linkedin", label: "LinkedIn message", icon: Linkedin, group: "Messages" },
  { key: "add_tag", label: "Add tag", icon: Tag, group: "Contact" },
  { key: "remove_tag", label: "Remove tag", icon: TagIcon, group: "Contact" },
  { key: "create_task", label: "Create task", icon: CheckSquare, group: "Contact" },
  { key: "start_plan", label: "Start action plan", icon: Play, group: "Contact" },
  { key: "wait", label: "Wait", icon: Clock, group: "Flow" },
  { key: "condition", label: "If / else", icon: GitBranch, group: "Flow" },
];

function newId() {
  return `s_${Math.random().toString(16).slice(2, 12)}`;
}

function makeStep(key: PaletteKey): Step {
  const id = newId();
  switch (key) {
    case "send_text":
      return { id, type: "send_text", body: "Hi {first_name}, " };
    case "send_email":
      return { id, type: "send_email", subject: "", body: "Hi {first_name},\n\n\n\n{agent_name}" };
    case "social_facebook":
      return { id, type: "social_task", network: "facebook", message: "Hi {first_name}, " };
    case "social_instagram":
      return { id, type: "social_task", network: "instagram", message: "Hi {first_name}, " };
    case "social_linkedin":
      return { id, type: "social_task", network: "linkedin", message: "Hi {first_name}, " };
    case "add_tag":
      return { id, type: "add_tag", tag: "" };
    case "remove_tag":
      return { id, type: "remove_tag", tag: "" };
    case "create_task":
      return { id, type: "create_task", title: "Call {name}", dueInHours: 1 };
    case "start_plan":
      return { id, type: "start_plan", automationId: 0 };
    case "wait":
      return { id, type: "wait", amount: 1, unit: "days" };
    case "condition":
      return { id, type: "condition", check: "replied", yes: [], no: [] };
    case "social_task":
      return { id, type: "social_task", network: "facebook", message: "" };
  }
}

function stepIcon(s: Step) {
  if (s.type === "social_task") return s.network === "facebook" ? Facebook : s.network === "instagram" ? Instagram : Linkedin;
  return PALETTE.find((p) => p.key === s.type)?.icon ?? Zap;
}

function stepTitle(s: Step, plans: Automation[]): string {
  switch (s.type) {
    case "wait":
      return `Wait ${s.amount} ${s.amount === 1 ? s.unit.replace(/s$/, "") : s.unit}`;
    case "send_text":
      return "Send text";
    case "send_email":
      return `Send email${s.subject ? `: ${s.subject}` : ""}`;
    case "add_tag":
      return `Add tag${s.tag ? ` "${s.tag}"` : ""}`;
    case "remove_tag":
      return `Remove tag${s.tag ? ` "${s.tag}"` : ""}`;
    case "create_task":
      return `Task: ${s.title || "…"}`;
    case "social_task":
      return `${{ facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" }[s.network]} message (task)`;
    case "start_plan":
      return `Start "${plans.find((p) => p.id === s.automationId)?.name ?? "…"}"`;
    case "condition":
      return `If ${describeCheck(s)}`;
  }
}

function stepPreview(s: Step): string | null {
  if (s.type === "send_text") return s.body;
  if (s.type === "send_email") return s.body;
  if (s.type === "social_task") return s.message;
  if (s.type === "create_task") return s.note ?? null;
  return null;
}

function describeCheck(s: Extract<Step, { type: "condition" }>): string {
  switch (s.check) {
    case "has_phone":
      return "they have a phone number";
    case "has_email":
      return "they have an email address";
    case "has_tag":
      return `they have tag "${s.value ?? ""}"`;
    case "replied":
      return "they've replied";
    case "source_is":
      return `source is ${s.value ?? ""}`;
  }
}

function triggerText(t: Trigger): string {
  if (t.type === "new_lead") {
    const who = t.leadType === "buyer" ? "New buyer lead" : t.leadType === "seller" ? "New seller lead" : "Any new lead";
    return t.sources?.length ? `${who} from ${t.sources.join(", ")}` : who;
  }
  if (t.type === "tag_added") return `Tag "${t.tag}" added`;
  return "Added by hand";
}

const MODE_LABEL: Record<Mode, string> = { off: "Off", review: "On · review messages", auto: "On · automatic" };

// ---- Tree editing ------------------------------------------------------------------------

/** Where a step goes: a list (top level, or a branch of an if/else) and a position in it. */
interface Slot {
  parentId: string | null;
  branch: "yes" | "no" | null;
  index: number;
}

function mapLists(steps: Step[], fn: (list: Step[], parentId: string | null, branch: "yes" | "no" | null) => Step[], parentId: string | null = null, branch: "yes" | "no" | null = null): Step[] {
  const mapped = fn(steps, parentId, branch).map((s) =>
    s.type === "condition" ? { ...s, yes: mapLists(s.yes, fn, s.id, "yes"), no: mapLists(s.no, fn, s.id, "no") } : s,
  );
  return mapped;
}

function insertAt(steps: Step[], slot: Slot, step: Step): Step[] {
  return mapLists(steps, (list, parentId, branch) => {
    if (parentId !== slot.parentId || branch !== slot.branch) return list;
    const before = list.slice(0, slot.index);
    const after = list.slice(slot.index);
    // An if/else ends its branch: whatever came after it moves into "yes".
    if (step.type === "condition" && after.length) return [...before, { ...step, yes: [...step.yes, ...after] }];
    return [...before, step, ...after];
  });
}

function removeStep(steps: Step[], id: string): Step[] {
  return mapLists(steps, (list) => list.filter((s) => s.id !== id));
}

function updateStep(steps: Step[], id: string, patch: Partial<Step>): Step[] {
  return mapLists(steps, (list) => list.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s)));
}

function findStep(steps: Step[], id: string): Step | null {
  for (const s of steps) {
    if (s.id === id) return s;
    if (s.type === "condition") {
      const f = findStep(s.yes, id) ?? findStep(s.no, id);
      if (f) return f;
    }
  }
  return null;
}

function containsId(step: Step, id: string | null): boolean {
  if (!id) return false;
  if (step.id === id) return true;
  return step.type === "condition" && [...step.yes, ...step.no].some((s) => containsId(s, id));
}

/** Where a step currently sits, so a move into the same list can adjust its index. */
function slotOf(steps: Step[], id: string, parentId: string | null = null, branch: "yes" | "no" | null = null): Slot | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.id === id) return { parentId, branch, index: i };
    if (s.type === "condition") {
      const f = slotOf(s.yes, id, s.id, "yes") ?? slotOf(s.no, id, s.id, "no");
      if (f) return f;
    }
  }
  return null;
}

function moveStep(steps: Step[], id: string, to: Slot): Step[] {
  const step = findStep(steps, id);
  if (!step || containsId(step, to.parentId)) return steps;
  const from = slotOf(steps, id)!;
  let index = to.index;
  if (from.parentId === to.parentId && from.branch === to.branch && from.index < to.index) index -= 1;
  return insertAt(removeStep(steps, id), { ...to, index }, step);
}

// ---- Page ---------------------------------------------------------------------------------

export default function AdminAutomationsPage({ id }: { id?: number }) {
  return (
    <AppShell pageTitle="Automations">
      <div className="px-4 sm:px-8 py-7">{id ? <Builder id={id} /> : <Overview />}</div>
    </AppShell>
  );
}

function Overview() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"plans" | "approvals" | "tasks">("plans");
  const { data } = useQuery<{ automations: Automation[]; pending: Pending[]; recent: RecentRun[] }>({
    queryKey: ["/api/admin/automations"],
    refetchInterval: 30_000,
  });
  const recent = data?.recent ?? [];
  const { data: tasks = [] } = useQuery<any[]>({ queryKey: ["/api/admin/automation-tasks"], refetchInterval: 60_000 });
  const create = useMutation({
    mutationFn: async (template?: string) => (await apiRequest("POST", "/api/admin/automations", template ? { template } : { name: "New action plan" })).json(),
    onSuccess: (a: Automation) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/automations"] });
      navigate(`/admin/automations/${a.id}`);
    },
  });
  const pending = data?.pending ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-3xl" style={{ letterSpacing: "-0.01em" }}>
            Automations
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Action plans that text, email, tag and remind you, step by step. Plans in review hold every message here until you approve it.
          </p>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="rounded-sm" disabled={create.isPending}>
                Start from a template <ChevronDown className="w-4 h-4 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem onClick={() => create.mutate("buyer_new_lead")} className="flex-col items-start gap-0.5">
                <span className="font-medium">Buyer New Lead</span>
                <span className="text-xs text-muted-foreground">Welcome text and email, call task, follow-ups for buyers.</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => create.mutate("seller_new_lead")} className="flex-col items-start gap-0.5">
                <span className="font-medium">Seller New Lead</span>
                <span className="text-xs text-muted-foreground">Price-opinion offer, call task, follow-ups for sellers.</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button className="rounded-sm" onClick={() => create.mutate(undefined)} disabled={create.isPending}>
            <Plus className="w-4 h-4 mr-1" /> New plan
          </Button>
        </div>
      </div>

      <div className="flex gap-1.5">
        {(
          [
            ["plans", `Plans (${data?.automations.length ?? 0})`],
            ["approvals", `Waiting for approval (${pending.length})`],
            ["tasks", `Tasks (${tasks.length})`],
          ] as const
        ).map(([k, label]) => (
          <Button key={k} size="sm" variant={tab === k ? "default" : "outline"} className="rounded-sm h-8 text-xs" onClick={() => setTab(k)}>
            {label}
          </Button>
        ))}
      </div>

      {tab === "plans" && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(data?.automations ?? []).map((a) => (
            <Link key={a.id} href={`/admin/automations/${a.id}`}>
              <Card className="cursor-pointer hover:border-foreground/40 transition-colors h-full">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">{a.name}</div>
                    <Badge variant={a.mode === "off" ? "outline" : "default"} className="rounded-sm text-[10px] shrink-0">
                      {MODE_LABEL[a.mode]}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5" /> {triggerText(a.trigger)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {countSteps(a.steps)} steps · {(a.counts?.active ?? 0) + (a.counts?.approval ?? 0)} in progress · {a.counts?.completed ?? 0} finished
                  </div>
                  <PlanLatest runs={recent.filter((r) => r.automationId === a.id)} />
                </CardContent>
              </Card>
            </Link>
          ))}
          {data && data.automations.length === 0 && (
            <p className="text-sm text-muted-foreground">No plans yet. Start from a template (buyer or seller), or build one from scratch.</p>
          )}
        </div>
      )}
      {tab === "plans" && <RecentLeads runs={recent} />}

      {tab === "approvals" && <Approvals pending={pending} />}
      {tab === "tasks" && <Tasks tasks={tasks} />}
    </div>
  );
}

/** The last few people a plan picked up, on its card. */
function PlanLatest({ runs }: { runs: RecentRun[] }) {
  if (runs.length === 0) return <div className="text-xs text-muted-foreground pt-1 border-t border-border">No leads yet</div>;
  return (
    <div className="pt-2 border-t border-border space-y-1">
      <div className="eyebrow text-muted-foreground">Latest leads</div>
      {runs.slice(0, 3).map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">{r.contactName ?? "Unknown"}</span>
          <span className="text-muted-foreground whitespace-nowrap">
            {RUN_STATUS[r.status] ?? r.status} · {timeAgo(r.startedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Everyone recently put into a plan, newest first, with what the plan last did for them. */
function RecentLeads({ runs }: { runs: RecentRun[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="font-serif text-xl" style={{ letterSpacing: "-0.01em" }}>
            Recent leads in plans
          </h3>
          <p className="text-xs text-muted-foreground mt-1">Who each plan picked up, and the last thing it did for them.</p>
        </div>
        {runs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No one has been added to a plan yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="font-medium px-5 py-2.5">Lead</th>
                  <th className="font-medium px-3 py-2.5">Plan</th>
                  <th className="font-medium px-3 py-2.5 whitespace-nowrap">Added</th>
                  <th className="font-medium px-3 py-2.5">Status</th>
                  <th className="font-medium px-5 py-2.5 hidden md:table-cell">Last step</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => {
                  const live = r.status === "active" || r.status === "approval";
                  const next = r.status === "active" && r.nextAt && new Date(r.nextAt) > new Date() ? `next step ${new Date(r.nextAt).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                      : null;
                  return (
                    <tr key={r.id} className="hover:bg-secondary/40">
                      <td className="px-5 py-2.5">
                        <Link href={`/admin/crm?contact=${encodeURIComponent(r.contactFubId)}`} className="hover:underline underline-offset-2">
                          {r.contactName ?? "Unknown"}
                        </Link>
                        {r.contactSource && <div className="text-xs text-muted-foreground">{r.contactSource}</div>}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.automationName === "Deleted plan" ? (
                          <span className="text-muted-foreground">Deleted plan</span>
                        ) : (
                          <Link href={`/admin/automations/${r.automationId}`} className="hover:underline underline-offset-2">
                            {r.automationName}
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{timeAgo(r.startedAt)}</td>
                      <td className="px-3 py-2.5">
                        <Badge variant={live ? "default" : "outline"} className="rounded-sm text-[10px]">
                          {RUN_STATUS[r.status] ?? r.status}
                        </Badge>
                        {(r.stoppedReason || next) && <div className="text-xs text-muted-foreground mt-0.5">{r.stoppedReason ?? next}</div>}
                      </td>
                      <td className="px-5 py-2.5 hidden md:table-cell text-muted-foreground max-w-[320px]">
                        <div className="truncate" title={r.lastDetail ?? ""}>
                          {r.lastDetail ?? "—"}
                        </div>
                        {r.lastAt && <div className="text-xs">{timeAgo(r.lastAt)}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function countSteps(steps: Step[]): number {
  return steps.reduce((n, s) => n + 1 + (s.type === "condition" ? countSteps(s.yes) + countSteps(s.no) : 0), 0);
}

function Approvals({ pending }: { pending: Pending[] }) {
  if (pending.length === 0) return <p className="text-sm text-muted-foreground">Nothing waiting.</p>;
  return (
    <div className="space-y-3">
      {pending.map((p) => (
        <ApprovalCard key={p.stepRowId} p={p} />
      ))}
    </div>
  );
}

function ApprovalCard({ p }: { p: Pending }) {
  const qc = useQueryClient();
  const [body, setBody] = useState(p.payload.body);
  const [subject, setSubject] = useState(p.payload.subject ?? "");
  const decide = useMutation({
    mutationFn: async (decision: "send" | "skip" | "stop") =>
      (await apiRequest("POST", `/api/admin/automation-approvals/${p.stepRowId}`, { decision, body, subject })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/automations"] }),
    onError: () => qc.invalidateQueries({ queryKey: ["/api/admin/automations"] }),
  });
  const isText = p.type === "send_text";
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {isText ? <MessageSquare className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
          <span className="font-medium">{isText ? "Text" : "Email"} to {p.contactName ?? p.payload.to}</span>
          <span className="text-muted-foreground">({p.payload.to})</span>
          <Badge variant="outline" className="rounded-sm text-[10px]">{p.automationName}</Badge>
          <span className="text-xs text-muted-foreground">{timeAgo(p.createdAt)}</span>
        </div>
        {!isText && <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />}
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={isText ? 3 : 7} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="rounded-sm" disabled={decide.isPending} onClick={() => decide.mutate("send")}>
            Approve and send
          </Button>
          <Button size="sm" variant="outline" className="rounded-sm" disabled={decide.isPending} onClick={() => decide.mutate("skip")}>
            Skip this message
          </Button>
          <Button size="sm" variant="ghost" className="rounded-sm" disabled={decide.isPending} onClick={() => decide.mutate("stop")}>
            Stop plan for this person
          </Button>
        </div>
        {decide.isError && <p className="text-sm text-destructive">{apiErrorMessage(decide.error)}</p>}
      </CardContent>
    </Card>
  );
}

function Tasks({ tasks }: { tasks: any[] }) {
  const qc = useQueryClient();
  const done = useMutation({
    mutationFn: async (uid: string) => (await apiRequest("POST", "/api/admin/automation-tasks/complete", { uid, done: true })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/automation-tasks"] }),
  });
  if (tasks.length === 0) return <p className="text-sm text-muted-foreground">No open tasks.</p>;
  return (
    <Card>
      <CardContent className="p-0 divide-y divide-border">
        {tasks.map((t) => (
          <div key={t.uid} className="p-4 flex items-start gap-3">
            <Button size="sm" variant="outline" className="rounded-sm h-7 px-2 shrink-0" disabled={done.isPending} onClick={() => done.mutate(t.uid)}>
              Done
            </Button>
            <div className="min-w-0">
              <div className="text-sm font-medium">{t.title}</div>
              <div className="text-xs text-muted-foreground">
                {t.contactName ?? "Unknown contact"}
                {t.phone ? ` · ${t.phone}` : ""} · due {timeAgo(t.dueAt)}
              </div>
              {t.body && <div className="text-xs whitespace-pre-wrap mt-1 break-words">{linkify(t.body)}</div>}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function linkify(text: string): ReactNode {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
        open
      </a>
    ) : (
      part
    ),
  );
}

// ---- Builder ------------------------------------------------------------------------------

function Builder({ id }: { id: number }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data } = useQuery<{ automation: Automation; runs: RunRow[]; problems: string[] }>({ queryKey: [`/api/admin/automations/${id}`] });
  const { data: list } = useQuery<{ automations: Automation[]; pending: Pending[] }>({ queryKey: ["/api/admin/automations"] });
  const { data: meta } = useQuery<Meta>({ queryKey: ["/api/admin/automation-meta"] });

  const [draft, setDraft] = useState<Automation | null>(null);
  const [selected, setSelected] = useState<string | "trigger" | null>(null);
  const [view, setView] = useState<"build" | "people">("build");
  const [error, setError] = useState<string | null>(null);
  // Switching to automatic while messages wait for approval: ask what to do with them.
  const [releaseAsk, setReleaseAsk] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (data?.automation && (!draft || draft.id !== data.automation.id)) setDraft(data.automation);
  }, [data?.automation]);

  const dirty = useMemo(() => {
    if (!draft || !data) return false;
    const a = data.automation;
    return (
      draft.name !== a.name ||
      JSON.stringify(draft.trigger) !== JSON.stringify(a.trigger) ||
      JSON.stringify(draft.steps) !== JSON.stringify(a.steps) ||
      draft.stopOnReply !== a.stopOnReply
    );
  }, [draft, data]);

  const save = useMutation({
    mutationFn: async (patch: Partial<Automation>) => (await apiRequest("PATCH", `/api/admin/automations/${id}`, patch)).json(),
    onSuccess: (a: Automation) => {
      setError(null);
      setDraft(a);
      qc.invalidateQueries({ queryKey: [`/api/admin/automations/${id}`] });
      qc.invalidateQueries({ queryKey: ["/api/admin/automations"] });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  const sendPending = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/automations/${id}/send-pending`)).json(),
    onSuccess: (r: { sent: number; failed: number }) => {
      setNotice(
        r.failed
          ? `Sent ${r.sent}; ${r.failed} couldn't be sent (see People for details).`
          : `Sent ${r.sent} waiting message${r.sent === 1 ? "" : "s"}.`,
      );
      qc.invalidateQueries({ queryKey: [`/api/admin/automations/${id}`] });
      qc.invalidateQueries({ queryKey: ["/api/admin/automations"] });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/admin/automations/${id}`)).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/automations"] });
      navigate("/admin/automations");
    },
  });

  if (!draft) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const plans = (list?.automations ?? []).filter((p) => p.id !== id);
  const setSteps = (steps: Step[]) => setDraft({ ...draft, steps });
  const selectedStep = selected && selected !== "trigger" ? findStep(draft.steps, selected) : null;
  const saveAll = () => save.mutate({ name: draft.name, trigger: draft.trigger, steps: draft.steps, stopOnReply: draft.stopOnReply });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin/automations">
          <Button variant="ghost" size="sm" className="rounded-sm">
            <ArrowLeft className="w-4 h-4 mr-1" /> Plans
          </Button>
        </Link>
        <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="max-w-sm font-serif text-lg h-10" />
        <Select
          value={draft.mode}
          onValueChange={async (mode) => {
            if (dirty) return setError("Save your changes before switching the plan on or off.");
            setNotice(null);
            save.mutate({ mode: mode as Mode });
            if (mode !== "auto") return;
            // Fresh, not the cached list: someone may have been added since the page loaded.
            const fresh = await qc.fetchQuery<{ pending: Pending[] }>({ queryKey: ["/api/admin/automations"], staleTime: 0 });
            const waiting = fresh.pending.filter((p) => p.automationId === id).length;
            if (waiting > 0) setReleaseAsk(waiting);
          }}
        >
          <SelectTrigger className="w-[220px] rounded-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="review">On · review messages first</SelectItem>
            <SelectItem value="auto">On · send automatically</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={draft.stopOnReply} onCheckedChange={(v) => setDraft({ ...draft, stopOnReply: v })} />
          Stop when they reply
        </label>
        <div className="flex-1" />
        <Button className="rounded-sm" disabled={!dirty || save.isPending} onClick={saveAll}>
          {save.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-sm"
          onClick={() => {
            if (window.confirm(`Delete "${draft.name}"? Everyone in it stops.`)) remove.mutate();
          }}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      <AlertDialog open={releaseAsk !== null} onOpenChange={(o) => !o && setReleaseAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send the {releaseAsk} waiting message{releaseAsk === 1 ? "" : "s"} now?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This plan is now automatic, so new messages send on their own. {releaseAsk === 1 ? "One message was" : `${releaseAsk} messages were`} queued
              while it was in review. Send {releaseAsk === 1 ? "it" : "them"} now, or leave {releaseAsk === 1 ? "it" : "them"} under Waiting for approval to look over first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Leave for approval</AlertDialogCancel>
            <AlertDialogAction onClick={() => sendPending.mutate()}>Send now</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {draft.mode !== "off" && meta && (!meta.channels.text.ok || !meta.channels.email.ok) && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {!meta.channels.text.ok && `${meta.channels.text.reason}: text steps will fail. `}
          {!meta.channels.email.ok && `${meta.channels.email.reason}`}
        </p>
      )}

      <div className="flex gap-1.5">
        <Button size="sm" variant={view === "build" ? "default" : "outline"} className="rounded-sm h-8 text-xs" onClick={() => setView("build")}>
          <Workflow className="w-3.5 h-3.5 mr-1" /> Builder
        </Button>
        <Button size="sm" variant={view === "people" ? "default" : "outline"} className="rounded-sm h-8 text-xs" onClick={() => setView("people")}>
          <ListChecks className="w-3.5 h-3.5 mr-1" /> People ({data?.runs.length ?? 0})
        </Button>
      </div>

      {view === "people" ? (
        <People automation={draft} runs={data?.runs ?? []} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[200px_1fr_340px]">
          <Palette />
          <Card className="overflow-auto">
            <CardContent className="p-6 min-h-[560px] bg-secondary/30">
              <div className="flex flex-col items-center">
                <NodeCard active={selected === "trigger"} icon={Zap} title="Trigger" subtitle={triggerText(draft.trigger)} onClick={() => setSelected("trigger")} accent />
                <StepList
                  steps={draft.steps}
                  parentId={null}
                  branch={null}
                  plans={plans}
                  selected={selected}
                  onSelect={setSelected}
                  onChange={setSteps}
                  all={draft.steps}
                />
              </div>
            </CardContent>
          </Card>
          <Inspector
            draft={draft}
            selected={selected}
            step={selectedStep}
            meta={meta}
            plans={plans}
            onTrigger={(t) => setDraft({ ...draft, trigger: t })}
            onStep={(patch) => selectedStep && setSteps(updateStep(draft.steps, selectedStep.id, patch))}
            onDelete={() => {
              if (!selectedStep) return;
              setSteps(removeStep(draft.steps, selectedStep.id));
              setSelected(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function Palette() {
  const groups = Array.from(new Set(PALETTE.map((p) => p.group)));
  return (
    <Card className="h-fit lg:sticky lg:top-4">
      <CardContent className="p-3 space-y-3">
        <div className="text-xs text-muted-foreground">Drag a step onto a + in the plan, or click a + to pick one.</div>
        {groups.map((g) => (
          <div key={g} className="space-y-1">
            <div className="eyebrow text-muted-foreground">{g}</div>
            {PALETTE.filter((p) => p.group === g).map((p) => {
              const Icon = p.icon;
              return (
                <div
                  key={p.key}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("application/x-step", JSON.stringify({ add: p.key }))}
                  className="flex items-center gap-2 rounded-sm border border-border bg-background px-2 py-1.5 text-sm cursor-grab active:cursor-grabbing hover:border-foreground/40"
                >
                  <Icon className="w-4 h-4 shrink-0" strokeWidth={1.6} /> {p.label}
                </div>
              );
            })}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function StepList(props: {
  steps: Step[];
  all: Step[];
  parentId: string | null;
  branch: "yes" | "no" | null;
  plans: Automation[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: (steps: Step[]) => void;
}) {
  const { steps, all, parentId, branch, plans, selected, onSelect, onChange } = props;
  const endsWithCondition = steps[steps.length - 1]?.type === "condition";
  const add = (index: number, key: PaletteKey) => {
    const step = makeStep(key);
    onChange(insertAt(all, { parentId, branch, index }, step));
    onSelect(step.id);
  };
  const drop = (index: number, raw: string) => {
    try {
      const d = JSON.parse(raw);
      if (d.add) add(index, d.add);
      else if (d.move) onChange(moveStep(all, d.move, { parentId, branch, index }));
    } catch {
      /* not ours */
    }
  };
  return (
    <>
      {steps.map((s, i) => (
        <div key={s.id} className="flex flex-col items-center">
          <DropZone onDrop={(raw) => drop(i, raw)} onPick={(k) => add(i, k)} />
          <NodeCard
            icon={stepIcon(s)}
            title={stepTitle(s, plans)}
            subtitle={stepPreview(s)}
            active={selected === s.id}
            onClick={() => onSelect(s.id)}
            dragId={s.id}
          />
          {s.type === "condition" && (
            <div className="mt-2 grid grid-cols-2 gap-6 pt-2 border-t-2 border-border">
              {(["yes", "no"] as const).map((b) => (
                <div key={b} className="flex flex-col items-center min-w-[260px]">
                  <Badge variant={b === "yes" ? "default" : "outline"} className="rounded-sm text-[10px]">
                    {b === "yes" ? "YES" : "NO"}
                  </Badge>
                  <StepList {...props} steps={s[b]} parentId={s.id} branch={b} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {!endsWithCondition && <DropZone onDrop={(raw) => drop(steps.length, raw)} onPick={(k) => add(steps.length, k)} last />}
    </>
  );
}

function NodeCard(props: {
  icon: any;
  title: string;
  subtitle?: string | null;
  active: boolean;
  onClick: () => void;
  accent?: boolean;
  dragId?: string;
}) {
  const Icon = props.icon;
  return (
    <button
      draggable={!!props.dragId}
      onDragStart={(e: DragEvent) => props.dragId && e.dataTransfer.setData("application/x-step", JSON.stringify({ move: props.dragId }))}
      onClick={props.onClick}
      className={`w-[260px] text-left rounded-sm border bg-background px-3 py-2.5 shadow-sm transition-colors ${
        props.active ? "border-foreground ring-1 ring-foreground" : "border-border hover:border-foreground/40"
      } ${props.accent ? "border-l-4 border-l-foreground" : ""} ${props.dragId ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="w-4 h-4 shrink-0" strokeWidth={1.6} />
        <span className="truncate">{props.title}</span>
      </div>
      {props.subtitle && <div className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">{props.subtitle}</div>}
    </button>
  );
}

function DropZone({ onDrop, onPick, last }: { onDrop: (raw: string) => void; onPick: (k: PaletteKey) => void; last?: boolean }) {
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-center relative">
      <div className="w-px h-4 bg-border" />
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-step")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onDrop(e.dataTransfer.getData("application/x-step"));
        }}
        className={`flex items-center justify-center rounded-full border transition-all ${
          over ? "w-[260px] h-10 border-dashed border-foreground bg-background" : "w-7 h-7 border-border bg-background hover:border-foreground"
        }`}
      >
        <button aria-label="Add a step here" onClick={() => setOpen(!open)} className="w-full h-full flex items-center justify-center">
          {open ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
        </button>
      </div>
      {open && (
        <div className="absolute top-12 z-20 w-56 rounded-sm border border-border bg-background shadow-lg p-1">
          {PALETTE.map((p) => {
            const Icon = p.icon;
            return (
              <button
                key={p.key}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-secondary text-left"
                onClick={() => {
                  setOpen(false);
                  onPick(p.key);
                }}
              >
                <Icon className="w-4 h-4" strokeWidth={1.6} /> {p.label}
              </button>
            );
          })}
        </div>
      )}
      {!last && <div className="w-px h-4 bg-border" />}
    </div>
  );
}

// ---- Inspector (the right-hand panel) --------------------------------------------------------

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="eyebrow text-muted-foreground">{label}</div>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** A text box with "Insert field" above it: the picked merge field goes in at the cursor. */
function FieldBox({ value, onChange, rows, multiline }: { value: string; onChange: (v: string) => void; rows?: number; multiline?: boolean }) {
  const ref = useRef<any>(null);
  const caret = useRef<number | null>(null);
  const props = {
    ref,
    value,
    onChange: (e: any) => {
      onChange(e.target.value);
      caret.current = e.target.selectionStart;
    },
    onSelect: () => {
      caret.current = ref.current?.selectionStart ?? null;
    },
  };
  return (
    <div className="space-y-1">
      <div className="flex justify-end -mt-6">
        <MergeFieldPicker
          onPick={(token) => {
            const r = insertAtCursor(ref.current, value, token, caret.current);
            onChange(r.value);
            caret.current = r.caret;
            setTimeout(() => {
              ref.current?.focus();
              ref.current?.setSelectionRange(r.caret, r.caret);
            }, 0);
          }}
        />
      </div>
      {multiline ? <Textarea rows={rows} {...props} /> : <Input {...props} />}
    </div>
  );
}

function TagInput({ value, onChange, meta }: { value: string; onChange: (v: string) => void; meta?: Meta }) {
  return (
    <>
      <Input value={value} onChange={(e) => onChange(e.target.value)} list="automation-tags" placeholder="Tag name" />
      <datalist id="automation-tags">
        {(meta?.tags ?? []).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </>
  );
}

function Inspector(props: {
  draft: Automation;
  selected: string | null;
  step: Step | null;
  meta?: Meta;
  plans: Automation[];
  onTrigger: (t: Trigger) => void;
  onStep: (patch: Partial<Step>) => void;
  onDelete: () => void;
}) {
  const { draft, selected, step, meta, plans, onTrigger, onStep, onDelete } = props;

  if (selected === "trigger") {
    const t = draft.trigger;
    return (
      <Card className="h-fit lg:sticky lg:top-4">
        <CardContent className="p-4 space-y-4">
          <div className="font-medium">Trigger</div>
          <Field label="Start this plan when">
            <Select
              value={t.type}
              onValueChange={(v) => onTrigger(v === "new_lead" ? { type: "new_lead", leadType: "buyer" } : v === "tag_added" ? { type: "tag_added", tag: "" } : { type: "manual" })}
            >
              <SelectTrigger className="rounded-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new_lead">A new lead comes in</SelectItem>
                <SelectItem value="tag_added">A tag is added</SelectItem>
                <SelectItem value="manual">I add someone by hand</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {t.type === "new_lead" && (
            <Field
              label="Lead type"
              hint="Sellers: selling or valuation enquiries, the home-value tools, community reports, and lead emails that say they're selling. Everyone else counts as a buyer; renters match only “Any”."
            >
              <Select
                value={t.leadType ?? "any"}
                onValueChange={(v) => onTrigger({ ...t, leadType: v === "any" ? undefined : (v as "buyer" | "seller") })}
              >
                <SelectTrigger className="rounded-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="buyer">Buyers</SelectItem>
                  <SelectItem value="seller">Sellers</SelectItem>
                  <SelectItem value="any">Any lead</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {t.type === "new_lead" && (
            <Field label="Only from these sources" hint="None ticked means every source.">
              <div className="max-h-64 overflow-auto space-y-1 border border-border rounded-sm p-2">
                {(meta?.sources ?? []).map((s) => {
                  const on = t.sources?.includes(s) ?? false;
                  return (
                    <label key={s} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => onTrigger({ ...t, sources: on ? (t.sources ?? []).filter((x) => x !== s) : [...(t.sources ?? []), s] })}
                      />
                      {s}
                    </label>
                  );
                })}
              </div>
            </Field>
          )}
          {t.type === "tag_added" && (
            <Field label="Tag">
              <TagInput value={t.tag} onChange={(tag) => onTrigger({ type: "tag_added", tag })} meta={meta} />
            </Field>
          )}
          <p className="text-xs text-muted-foreground">
            New-lead plans count leads that arrive after the plan is switched on, including ones that only reach Follow Up Boss, which arrive on its hourly sync.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!step) {
    return (
      <Card className="h-fit">
        <CardContent className="p-4 text-sm text-muted-foreground">Click the trigger or a step to edit it. Drag a step onto a + to move it.</CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-fit lg:sticky lg:top-4">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="font-medium">{stepTitle(step, plans)}</div>
          <Button variant="ghost" size="sm" className="rounded-sm h-8 px-2" onClick={onDelete} aria-label="Delete step">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
        <StepFields step={step} meta={meta} plans={plans} onStep={onStep} />
      </CardContent>
    </Card>
  );
}

function StepFields({ step, meta, plans, onStep }: { step: Step; meta?: Meta; plans: Automation[]; onStep: (patch: Partial<Step>) => void }) {
  switch (step.type) {
    case "wait":
      return (
        <Field label="Wait for">
          <div className="flex gap-2">
            <Input type="number" min={1} value={step.amount} onChange={(e) => onStep({ amount: Number(e.target.value) })} className="w-24" />
            <Select value={step.unit} onValueChange={(unit) => onStep({ unit: unit as any })}>
              <SelectTrigger className="rounded-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">minutes</SelectItem>
                <SelectItem value="hours">hours</SelectItem>
                <SelectItem value="days">days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Field>
      );
    case "send_text":
      return (
        <Field label="Message" hint={undefined}>
          <FieldBox multiline rows={6} value={step.body} onChange={(body) => onStep({ body })} />
          <div className="text-xs text-muted-foreground space-y-1">
            <div>{step.body.length} characters.</div>
            <div>Automatic texts wait until 8 am if they'd go out between 9 pm and 8 am.</div>
          </div>
        </Field>
      );
    case "send_email":
      return (
        <>
          <Field label="Subject">
            <FieldBox value={step.subject} onChange={(subject) => onStep({ subject })} />
          </Field>
          <Field label="Message">
            <FieldBox multiline rows={10} value={step.body} onChange={(body) => onStep({ body })} />
            <div className="text-xs text-muted-foreground">
              Sent from your Gmail, with your Gmail signature.
            </div>
          </Field>
        </>
      );
    case "add_tag":
    case "remove_tag":
      return (
        <Field label="Tag">
          <TagInput value={step.tag} onChange={(tag) => onStep({ tag })} meta={meta} />
        </Field>
      );
    case "create_task":
      return (
        <>
          <Field label="Task">
            <FieldBox value={step.title} onChange={(title) => onStep({ title })} />
          </Field>
          <Field label="Note">
            <FieldBox multiline rows={3} value={step.note ?? ""} onChange={(note) => onStep({ note })} />
          </Field>
          <Field label="Due in (hours)">
            <Input type="number" min={0} value={step.dueInHours ?? 0} onChange={(e) => onStep({ dueInHours: Number(e.target.value) })} className="w-24" />
          </Field>
        </>
      );
    case "social_task":
      return (
        <>
          <Field label="Network">
            <Select value={step.network} onValueChange={(network) => onStep({ network: network as any })}>
              <SelectTrigger className="rounded-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="facebook">Facebook</SelectItem>
                <SelectItem value="instagram">Instagram</SelectItem>
                <SelectItem value="linkedin">LinkedIn</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Message">
            <FieldBox multiline rows={5} value={step.message} onChange={(message) => onStep({ message })} />
          </Field>
          <p className="text-xs text-muted-foreground">
            Facebook, Instagram and LinkedIn don't let apps start conversations, so this makes you a task with the message written and a link to find them.
          </p>
        </>
      );
    case "start_plan":
      return (
        <Field label="Plan to start" hint="Only runs if that plan is switched on.">
          <Select value={step.automationId ? String(step.automationId) : ""} onValueChange={(v) => onStep({ automationId: Number(v) })}>
            <SelectTrigger className="rounded-sm">
              <SelectValue placeholder="Pick a plan" />
            </SelectTrigger>
            <SelectContent>
              {plans.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      );
    case "condition":
      return (
        <>
          <Field label="Check whether">
            <Select value={step.check} onValueChange={(check) => onStep({ check: check as any, value: "" })}>
              <SelectTrigger className="rounded-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="replied">They've replied (since the plan started)</SelectItem>
                <SelectItem value="has_phone">They have a phone number</SelectItem>
                <SelectItem value="has_email">They have an email address</SelectItem>
                <SelectItem value="has_tag">They have a tag</SelectItem>
                <SelectItem value="source_is">Their source is</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {step.check === "has_tag" && (
            <Field label="Tag">
              <TagInput value={step.value ?? ""} onChange={(value) => onStep({ value })} meta={meta} />
            </Field>
          )}
          {step.check === "source_is" && (
            <Field label="Source">
              <Select value={step.value ?? ""} onValueChange={(value) => onStep({ value })}>
                <SelectTrigger className="rounded-sm">
                  <SelectValue placeholder="Pick a source" />
                </SelectTrigger>
                <SelectContent>
                  {(meta?.sources ?? []).map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <p className="text-xs text-muted-foreground">Each branch carries on with its own steps; an if/else is always the last step of its branch.</p>
        </>
      );
  }
}

// ---- People in a plan -----------------------------------------------------------------------

const RUN_STATUS: Record<string, string> = {
  active: "In progress",
  approval: "Waiting for approval",
  completed: "Finished",
  stopped: "Stopped",
};

function People({ automation, runs }: { automation: Automation; runs: RunRow[] }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const { data: found = [] } = useQuery<any[]>({
    queryKey: [`/api/admin/crm/contacts?q=${encodeURIComponent(q)}&limit=8`],
    enabled: q.trim().length >= 2,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: [`/api/admin/automations/${automation.id}`] });
  const enroll = useMutation({
    mutationFn: async (contactFubId: string) => (await apiRequest("POST", `/api/admin/automations/${automation.id}/enroll`, { contactFubId })).json(),
    onSuccess: () => {
      setQ("");
      refresh();
    },
  });
  const stop = useMutation({
    mutationFn: async (runId: number) => (await apiRequest("POST", `/api/admin/automation-runs/${runId}/stop`)).json(),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="text-sm font-medium">Add someone to this plan</div>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={automation.mode === "off" ? "Switch the plan on first" : "Search contacts by name, email or phone"}
            disabled={automation.mode === "off"}
            className="max-w-md"
          />
          {q.trim().length >= 2 && (
            <div className="max-w-md border border-border rounded-sm divide-y divide-border">
              {found.map((c) => (
                <button key={c.fubId} className="w-full text-left px-3 py-2 text-sm hover:bg-secondary" onClick={() => enroll.mutate(c.fubId)}>
                  {c.name} <span className="text-muted-foreground">{c.email ?? c.phone ?? ""}</span>
                </button>
              ))}
              {found.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No matches</div>}
            </div>
          )}
          {enroll.isError && <p className="text-sm text-destructive">{apiErrorMessage(enroll.error)}</p>}
        </CardContent>
      </Card>

      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody has been through this plan yet.</p>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-border">
            {runs.map((r) => (
              <div key={r.id} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button className="text-sm font-medium underline-offset-2 hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    {r.contactName ?? r.contactFubId}
                  </button>
                  <Badge variant={r.status === "active" || r.status === "approval" ? "default" : "outline"} className="rounded-sm text-[10px]">
                    {RUN_STATUS[r.status] ?? r.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    started {timeAgo(r.startedAt)}
                    {r.stoppedReason ? ` · ${r.stoppedReason}` : ""}
                    {r.status === "active" && r.nextAt && new Date(r.nextAt) > new Date() ? ` · next step ${new Date(r.nextAt).toLocaleString()}` : ""}
                  </span>
                  <div className="flex-1" />
                  {(r.status === "active" || r.status === "approval") && (
                    <Button size="sm" variant="ghost" className="rounded-sm h-7" onClick={() => stop.mutate(r.id)}>
                      Stop
                    </Button>
                  )}
                </div>
                {open === r.id && <RunSteps runId={r.id} />}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function RunSteps({ runId }: { runId: number }) {
  const { data = [] } = useQuery<any[]>({ queryKey: [`/api/admin/automation-runs/${runId}/steps`] });
  return (
    <ol className="mt-2 ml-1 space-y-1 border-l border-border pl-3">
      {data.map((s) => (
        <li key={s.id} className="text-xs">
          <span className={s.status === "failed" ? "text-destructive" : s.status === "skipped" ? "text-muted-foreground" : ""}>{s.detail ?? s.type}</span>
          <span className="text-muted-foreground"> · {new Date(s.createdAt).toLocaleString()}</span>
        </li>
      ))}
    </ol>
  );
}
