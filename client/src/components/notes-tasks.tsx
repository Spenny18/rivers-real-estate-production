// Notes and tasks (server/notes-tasks.ts), and the CRM export (server/crm-export.ts).
//
//   ContactNotesTasks  on a contact: write a note, add a task, tick off its open tasks
//   TaskBoard          the CRM's Tasks tab: every task, overdue first, with a new-task form
//   TasksDueCard       the dashboard: what's overdue and due today
//   ExportCard         "Download everything"

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, Circle, Download, Loader2, Plus, StickyNote, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { downloadAuthed } from "@/lib/authed-blob";
import { useToast } from "@/hooks/use-toast";

export interface TaskRow {
  uid: string;
  title: string | null;
  body: string | null;
  dueAt: string | null;
  completed: number | boolean;
  contactFubId: string | null;
  contactName: string | null;
  origin: "app" | "fub";
}

interface TasksResponse {
  tasks: TaskRow[];
  counts: { overdue: number; today: number; open: number };
}

const TASKS_KEY = "/api/admin/crm/tasks";

/** Refresh everything that shows notes or tasks. */
function useRefresh() {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({
      predicate: (q) => {
        const k = String(q.queryKey[0]);
        return (
          k.startsWith(TASKS_KEY) ||
          k.startsWith("/api/admin/crm/contacts/") ||
          k.startsWith("/api/admin/crm/smart-lists") || // task filters
          k === "/api/admin/crm/overview"
        );
      },
    });
}

// ---- Due dates -----------------------------------------------------------------------

function at(daysAhead: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** A value for <input type="datetime-local">, in local time. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function quickDues(): Array<{ label: string; date: Date }> {
  const now = new Date();
  const today5 = at(0, 17);
  const nextMonday = (() => {
    const d = at(1, 9);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return d;
  })();
  return [
    ...(today5 > now ? [{ label: "Today 5 pm", date: today5 }] : []),
    { label: "Tomorrow 9 am", date: at(1, 9) },
    { label: "In 3 days", date: at(3, 9) },
    { label: "Next Monday", date: nextMonday },
    { label: "In 2 weeks", date: at(14, 9) },
  ];
}

export function dueLabel(iso: string | null): { text: string; overdue: boolean } {
  if (!iso) return { text: "No due date", overdue: false };
  const d = new Date(iso);
  const now = new Date();
  const overdue = d.getTime() < now.getTime();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  let text: string;
  if (sameDay(d, now)) text = `Today ${time}`;
  else if (sameDay(d, tomorrow)) text = `Tomorrow ${time}`;
  else text = d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }) + ` ${time}`;
  return { text: overdue && !sameDay(d, now) ? `Overdue · ${text}` : text, overdue };
}

function DuePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const options = useMemo(quickDues, []);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const v = localInput(o.date);
          return (
            <button
              key={o.label}
              type="button"
              onClick={() => onChange(v)}
              className={`text-[11.5px] px-2 py-1 rounded-sm border ${value === v ? "border-foreground bg-foreground text-background" : "border-border hover:border-foreground/50"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <Input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} className="rounded-sm h-9 text-[13px] w-auto" aria-label="Due date and time" />
    </div>
  );
}

// ---- One task ------------------------------------------------------------------------

function TaskItem({ t, showContact, onOpenContact }: { t: TaskRow; showContact?: boolean; onOpenContact?: (id: string) => void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const done = !!t.completed;
  const toggle = useMutation({
    mutationFn: async () => apiRequest("PATCH", TASKS_KEY, { uid: t.uid, completed: !done }),
    onSuccess: refresh,
    onError: (e) => toast({ title: "Couldn't update the task", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `${TASKS_KEY}?uid=${encodeURIComponent(t.uid)}`),
    onSuccess: refresh,
    onError: (e) => toast({ title: "Couldn't delete the task", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const due = dueLabel(t.dueAt);
  return (
    <div className="flex items-start gap-2.5 py-1.5" data-testid={`task-${t.uid}`}>
      <button
        type="button"
        onClick={() => toggle.mutate()}
        disabled={toggle.isPending}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={done ? `Reopen ${t.title ?? "task"}` : `Complete ${t.title ?? "task"}`}
      >
        {toggle.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className={`text-[13.5px] ${done ? "line-through text-muted-foreground" : ""}`}>{t.title ?? "Untitled"}</div>
        {t.body && <div className="text-[12px] text-foreground/70">{t.body}</div>}
        <div className="text-[11.5px] text-muted-foreground flex flex-wrap gap-x-2">
          <span className={!done && due.overdue ? "text-destructive" : ""}>{due.text}</span>
          {showContact && t.contactFubId && (
            <button type="button" onClick={() => onOpenContact?.(t.contactFubId!)} className="underline underline-offset-2 hover:text-foreground">
              {t.contactName ?? "Contact"}
            </button>
          )}
          {t.origin === "fub" && <span>From Follow Up Boss</span>}
        </div>
      </div>
      {t.origin === "app" && (
        <button
          type="button"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          className="text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
          aria-label={`Delete ${t.title ?? "task"}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ---- New task --------------------------------------------------------------------------

function NewTaskForm({ contactId, onDone }: { contactId?: string | null; onDone?: () => void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(() => localInput(at(1, 9)));
  const [note, setNote] = useState("");
  const add = useMutation({
    mutationFn: async () =>
      apiRequest("POST", TASKS_KEY, { title, dueAt: new Date(due).toISOString(), contactId: contactId ?? null, note: note || null }),
    onSuccess: () => {
      setTitle("");
      setNote("");
      refresh();
      onDone?.();
    },
    onError: (e) => toast({ title: "Couldn't add the task", description: apiErrorMessage(e), variant: "destructive" }),
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && due) add.mutate();
      }}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing? e.g. Call about the Aspen Woods showing" className="rounded-sm h-9 text-[13px]" data-testid="input-task-title" />
      <DuePicker value={due} onChange={setDue} />
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="rounded-sm h-9 text-[13px]" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!title.trim() || !due || add.isPending} className="rounded-sm text-[11px]" data-testid="button-add-task">
          {add.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "ADD TASK"}
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="ghost" onClick={onDone} className="rounded-sm text-[11px]">
            CANCEL
          </Button>
        )}
      </div>
    </form>
  );
}

// ---- On a contact --------------------------------------------------------------------

export function ContactNotesTasks({ contactId }: { contactId: string }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [note, setNote] = useState("");
  const [taskOpen, setTaskOpen] = useState(false);
  const { data } = useQuery<TasksResponse>({ queryKey: [`${TASKS_KEY}?contact=${encodeURIComponent(contactId)}`] });
  const save = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/admin/crm/contacts/${encodeURIComponent(contactId)}/notes`, { body: note }),
    onSuccess: () => {
      setNote("");
      refresh();
    },
    onError: (e) => toast({ title: "Couldn't save the note", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const open = data?.tasks ?? [];
  return (
    <div className="rounded-sm border border-border p-3.5 space-y-3" data-testid="contact-notes-tasks">
      <div className="space-y-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note…"
          rows={2}
          className="w-full rounded-sm border border-input bg-background px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
          data-testid="input-note"
          aria-label="Note"
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={!note.trim() || save.isPending} className="rounded-sm text-[11px]" data-testid="button-save-note">
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StickyNote className="h-3.5 w-3.5 mr-1" />} SAVE NOTE
          </Button>
          {!taskOpen && (
            <Button size="sm" variant="outline" onClick={() => setTaskOpen(true)} className="rounded-sm text-[11px]" data-testid="button-new-task">
              <Plus className="h-3.5 w-3.5 mr-1" /> TASK
            </Button>
          )}
        </div>
      </div>
      {taskOpen && <NewTaskForm contactId={contactId} onDone={() => setTaskOpen(false)} />}
      {open.length > 0 && (
        <div>
          <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1">OPEN TASKS</div>
          {open.map((t) => (
            <TaskItem key={t.uid} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Edit or delete a note written in the app, from the contact's history. */
export function NoteActions({ uid, body }: { uid: string; body: string | null }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body ?? "");
  const save = useMutation({
    mutationFn: async () => apiRequest("PATCH", "/api/admin/crm/notes", { uid, body: text }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
    onError: (e) => toast({ title: "Couldn't save the note", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/admin/crm/notes?uid=${encodeURIComponent(uid)}`),
    onSuccess: refresh,
    onError: (e) => toast({ title: "Couldn't delete the note", description: apiErrorMessage(e), variant: "destructive" }),
  });
  if (!uid.startsWith("note:app:")) return null;
  if (editing) {
    return (
      <div className="space-y-1.5 mt-1">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-sm border border-input bg-background px-2.5 py-1.5 text-[12.5px]" aria-label="Edit note" />
        <div className="flex gap-2 text-[11.5px]">
          <button type="button" onClick={() => save.mutate()} disabled={!text.trim() || save.isPending} className="underline underline-offset-2">
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className="underline underline-offset-2 text-muted-foreground">
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <span className="ml-2 inline-flex gap-2">
      <button type="button" onClick={() => setEditing(true)} className="underline underline-offset-2 hover:text-foreground">
        Edit
      </button>
      <button
        type="button"
        onClick={() => window.confirm("Delete this note?") && remove.mutate()}
        className="underline underline-offset-2 hover:text-destructive"
      >
        Delete
      </button>
    </span>
  );
}

// ---- The Tasks tab -----------------------------------------------------------------------

export function TaskBoard({ onOpenContact }: { onOpenContact: (id: string) => void }) {
  const [status, setStatus] = useState<"open" | "done">("open");
  const [adding, setAdding] = useState(false);
  const { data, isLoading } = useQuery<TasksResponse>({ queryKey: [`${TASKS_KEY}?status=${status}`] });
  const tasks = data?.tasks ?? [];
  const groups = useMemo(() => {
    if (status === "done") return [{ label: "Completed", rows: tasks }];
    const now = Date.now();
    const endToday = at(0, 23).getTime() + 59 * 60_000;
    const g = [
      { label: "Overdue", rows: [] as TaskRow[] },
      { label: "Today", rows: [] as TaskRow[] },
      { label: "Upcoming", rows: [] as TaskRow[] },
    ];
    for (const t of tasks) {
      const d = t.dueAt ? Date.parse(t.dueAt) : Infinity;
      if (d < now && new Date(d).toDateString() !== new Date().toDateString()) g[0].rows.push(t);
      else if (d <= endToday) g[1].rows.push(t);
      else g[2].rows.push(t);
    }
    return g.filter((x) => x.rows.length);
  }, [tasks, status]);

  return (
    <div className="space-y-3" data-testid="crm-task-board">
      <div className="flex flex-wrap items-center gap-2">
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)} className="rounded-sm text-[11px]" data-testid="button-task-board-new">
            <Plus className="h-3.5 w-3.5 mr-1" /> NEW TASK
          </Button>
        )}
        <div className="flex gap-1 ml-auto">
          {(["open", "done"] as const).map((s) => (
            <Button key={s} size="sm" variant={status === s ? "default" : "outline"} onClick={() => setStatus(s)} className="rounded-sm text-[11px] h-8">
              {s === "open" ? "Open" : "Done"}
            </Button>
          ))}
        </div>
      </div>
      {adding && (
        <Card>
          <CardContent className="p-4">
            <div className="text-[12px] text-muted-foreground mb-2">A task for yourself. For one about a contact, add it from the contact.</div>
            <NewTaskForm onDone={() => setAdding(false)} />
          </CardContent>
        </Card>
      )}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tasks.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">{status === "open" ? "Nothing to do. Add a task above." : "No completed tasks yet."}</CardContent>
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.label}>
            <CardContent className="p-4">
              <div className={`font-display text-[10px] tracking-[0.18em] mb-1 ${g.label === "Overdue" ? "text-destructive" : "text-muted-foreground"}`}>
                {g.label.toUpperCase()} · {g.rows.length}
              </div>
              {g.rows.map((t) => (
                <TaskItem key={t.uid} t={t} showContact onOpenContact={onOpenContact} />
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ---- Dashboard ----------------------------------------------------------------------------

export function TasksDueCard() {
  const { data } = useQuery<TasksResponse>({ queryKey: [`${TASKS_KEY}?status=open`], refetchInterval: 120_000 });
  if (!data) return null;
  const due = data.tasks.filter((t) => t.dueAt && Date.parse(t.dueAt) <= at(0, 23).getTime() + 59 * 60_000).slice(0, 6);
  return (
    <Card data-testid="dashboard-tasks">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-2">
          <div className="eyebrow text-muted-foreground flex items-center gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" /> TASKS
          </div>
          <Link href="/admin/crm?tab=tasks" className="text-[12px] underline underline-offset-2 text-muted-foreground hover:text-foreground">
            All tasks
          </Link>
        </div>
        <div className="text-sm mb-2">
          {data.counts.overdue > 0 && <span className="text-destructive">{data.counts.overdue} overdue · </span>}
          {data.counts.today} due today · {data.counts.open} open
        </div>
        {due.length === 0 ? <p className="text-[13px] text-muted-foreground">Nothing due today.</p> : due.map((t) => <TaskItem key={t.uid} t={t} showContact />)}
      </CardContent>
    </Card>
  );
}

// ---- Export ---------------------------------------------------------------------------------

export function ExportCard() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery<{ tables: Array<{ table: string; rows: number; about: string }> }>({ queryKey: ["/api/admin/crm/export/summary"] });
  const total = data?.tables.reduce((n, t) => n + t.rows, 0) ?? 0;
  const pick = (name: string) => data?.tables.find((t) => t.table === name)?.rows ?? 0;
  const download = async () => {
    setBusy(true);
    try {
      await downloadAuthed("/api/admin/crm/export", `rivers-crm-export-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) {
      toast({ title: "Export failed", description: apiErrorMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="crm-export">
      <CardContent className="p-5 flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1">EXPORT</div>
          <p className="text-[13px] text-foreground/80 leading-relaxed">
            Everything in the CRM as spreadsheets (CSV) in one zip: contacts, notes, tasks, calls, texts, emails, deals, showings, automations and more.
            Passwords and other credentials are left out.
          </p>
          {data && (
            <p className="text-[12px] text-muted-foreground mt-1">
              {pick("crm_contacts").toLocaleString("en-CA")} contacts · {pick("crm_activities").toLocaleString("en-CA")} history items ·{" "}
              {data.tables.length} files · {total.toLocaleString("en-CA")} rows in all
            </p>
          )}
        </div>
        <Button onClick={download} disabled={busy} className="rounded-sm font-display tracking-[0.14em] text-[11px] shrink-0" data-testid="button-crm-export">
          {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />} DOWNLOAD EVERYTHING
        </Button>
      </CardContent>
    </Card>
  );
}
