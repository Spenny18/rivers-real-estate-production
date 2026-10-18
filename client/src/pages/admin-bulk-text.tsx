// /admin/bulk-text: one text, with merge fields, to many contacts
// (server/bulk-texts.ts). Pick people by stage/tag/source, untick or add
// individuals, write or pick a template, preview it filled in, send. Texts go
// out one every few seconds, daytime only; past sends and their progress are
// listed below.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, Ban, Check, ChevronDown, ChevronRight, Loader2, MessageSquare, Search, Send, UserPlus, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { MergeFieldPicker, insertAtCursor } from "@/components/merge-field-picker";
import { TemplatePicker } from "@/components/template-picker";

interface Option {
  name: string;
  count: number;
}
interface Options {
  stages: Option[];
  tags: Option[];
  sources: Option[];
  configured: boolean;
  maxRecipients: number;
}
type Eligibility = "ok" | "no_phone" | "opted_out" | "duplicate";
interface Member {
  id: string;
  name: string;
  phone: string | null;
  stage: string | null;
  source: string | null;
  eligibility: Eligibility;
}
interface Preview {
  unknownFields: string[];
  samples: Array<{ id: string; name: string; text: string; blank: string[] }>;
  held: Array<{ id: string; name: string; blank: string[] }>;
  sendable: number;
  maxSegments: number;
}
interface BulkText {
  id: number;
  body: string;
  status: "sending" | "done" | "cancelled";
  createdAt: string;
  finishedAt: string | null;
  counts: Record<"queued" | "sent" | "failed" | "held" | "skipped", number>;
  total: number;
  resumesAt: string | null;
}

const WHY: Record<Exclude<Eligibility, "ok">, string> = {
  no_phone: "no mobile number",
  opted_out: "replied STOP",
  duplicate: "same number as someone above",
};

const ACTIVITY = [
  { label: "Any time", days: null },
  { label: "Last 6 months", days: 183 },
  { label: "Last 2 years", days: 730 },
] as const;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Edmonton" });

export default function AdminBulkTextPage() {
  const qc = useQueryClient();
  const { data: options } = useQuery<Options>({ queryKey: ["/api/admin/bulk-texts/options"] });

  // Who
  const [stages, setStages] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [activeWithinDays, setActiveWithinDays] = useState<number | null>(null);
  const [include, setInclude] = useState<Member[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const filter = useMemo(
    () => ({ stages, tags, sources, activeWithinDays, include: include.map((m) => m.id) }),
    [stages, tags, sources, activeWithinDays, include],
  );
  const audience = useQuery<Member[]>({
    queryKey: ["/api/admin/bulk-texts/audience", filter],
    queryFn: async () => (await apiRequest("POST", "/api/admin/bulk-texts/audience", { filter })).json(),
  });
  const members = audience.data ?? [];
  const recipients = members.filter((m) => m.eligibility === "ok" && !excluded.has(m.id));
  const skipped = members.filter((m) => m.eligibility !== "ok");

  // What
  const [body, setBody] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const insertField = (token: string) => {
    const r = insertAtCursor(box.current, body, token, caret.current);
    setBody(r.value);
    caret.current = r.caret;
    setTimeout(() => {
      box.current?.focus();
      box.current?.setSelectionRange(r.caret, r.caret);
    }, 0);
  };

  const ids = recipients.map((m) => m.id);
  const previewKey = useDebounced({ body: body.trim(), contactIds: ids }, 500);
  const preview = useQuery<Preview>({
    queryKey: ["/api/admin/bulk-texts/preview", previewKey],
    queryFn: async () => (await apiRequest("POST", "/api/admin/bulk-texts/preview", previewKey)).json(),
    enabled: !!previewKey.body && previewKey.contactIds.length > 0,
  });
  const p = preview.data;

  const [confirming, setConfirming] = useState(false);
  const send = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/bulk-texts", { body, contactIds: ids })).json() as Promise<BulkText>,
    onSuccess: () => {
      setConfirming(false);
      setBody("");
      qc.invalidateQueries({ queryKey: ["/api/admin/bulk-texts"] });
    },
    onError: () => setConfirming(false),
  });

  const tooMany = options && ids.length > options.maxRecipients;
  const blocked = !body.trim() || ids.length === 0 || !!tooMany || (p?.unknownFields.length ?? 0) > 0 || options?.configured === false;
  const sendCount = p ? p.sendable : ids.length;

  return (
    <AppShell pageTitle="Bulk text">
      <div className="px-4 sm:px-8 py-7 space-y-5">
        <div>
          <h1 className="font-serif text-3xl" style={{ letterSpacing: "-0.01em" }}>
            Bulk text
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            One text to many people from your business line, filled in for each person. Texts go out one every few seconds, between 8 am and 9 pm; replies
            land in each person's Inbox thread.
          </p>
        </div>
        {options?.configured === false && <p className="text-sm text-destructive">Texting isn't set up, so nothing can be sent.</p>}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* 1. Who */}
          <Card className="h-fit">
            <CardContent className="p-5 space-y-4">
              <Step n={1} title="Who" />
              <ChipFilter label="Stage" options={options?.stages ?? []} value={stages} onChange={setStages} />
              <ChipFilter label="Tags" options={options?.tags ?? []} value={tags} onChange={setTags} searchable />
              <ChipFilter label="Source" options={options?.sources ?? []} value={sources} onChange={setSources} searchable />
              <div>
                <Label>Active</Label>
                <div className="flex flex-wrap gap-1.5">
                  {ACTIVITY.map((a) => (
                    <Chip key={a.label} on={activeWithinDays === a.days} onClick={() => setActiveWithinDays(a.days)}>
                      {a.label}
                    </Chip>
                  ))}
                </div>
              </div>
              <AddPerson onAdd={(m) => setInclude((xs) => (xs.some((x) => x.id === m.id) ? xs : [...xs, m]))} />

              <div className="border-t border-border pt-3">
                <div className="flex items-baseline justify-between gap-2 mb-2">
                  <span className="text-sm">
                    {audience.isFetching ? (
                      <span className="text-muted-foreground">Finding people…</span>
                    ) : (
                      <>
                        <span className="font-medium">{recipients.length}</span> {recipients.length === 1 ? "person" : "people"} selected
                        {skipped.length > 0 && <span className="text-muted-foreground"> · {skipped.length} can't be texted</span>}
                      </>
                    )}
                  </span>
                  {excluded.size > 0 && (
                    <button className="text-[12px] underline underline-offset-2 text-muted-foreground" onClick={() => setExcluded(new Set())}>
                      Re-tick all
                    </button>
                  )}
                </div>
                {tooMany && <p className="text-[12px] text-destructive mb-2">One bulk text can go to at most {options!.maxRecipients} people. Narrow the filters.</p>}
                {members.length === 0 && !audience.isFetching ? (
                  <p className="text-[13px] text-muted-foreground">Pick a stage, tag, source or activity above, or add people by name.</p>
                ) : (
                  <div className="max-h-[380px] overflow-y-auto divide-y divide-border border border-border rounded-sm" data-testid="bulk-recipients">
                    {members.map((m) => (
                      <label key={m.id} className={`flex items-center gap-2.5 px-3 py-1.5 text-[13px] ${m.eligibility === "ok" ? "cursor-pointer" : "opacity-55"}`}>
                        <Checkbox
                          checked={m.eligibility === "ok" && !excluded.has(m.id)}
                          disabled={m.eligibility !== "ok"}
                          onCheckedChange={(v) =>
                            setExcluded((s) => {
                              const n = new Set(s);
                              if (v) n.delete(m.id);
                              else n.add(m.id);
                              return n;
                            })
                          }
                        />
                        <span className="truncate flex-1">{m.name}</span>
                        <span className="text-[11.5px] text-muted-foreground shrink-0">
                          {m.eligibility === "ok" ? m.phone : WHY[m.eligibility]}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 2. Message */}
          <Card className="h-fit">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <Step n={2} title="Message" />
                <div className="flex items-center gap-1">
                  <TemplatePicker kind="text" onPick={(t) => setBody(t.body)} />
                  <MergeFieldPicker onPick={insertField} />
                </div>
              </div>
              <Textarea
                ref={box}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  caret.current = e.target.selectionStart;
                }}
                onSelect={() => (caret.current = box.current?.selectionStart ?? null)}
                rows={6}
                placeholder="Hi {contact_first_name|there}, …"
                data-testid="bulk-body"
              />
              <div className="text-[11.5px] text-muted-foreground">
                {body.length} characters
                {p && p.maxSegments > 1 && ` · up to ${p.maxSegments} texts each (longer ones are billed as several)`}
              </div>

              {p && p.unknownFields.length > 0 && (
                <p className="text-[12.5px] text-destructive">
                  {p.unknownFields.map((f) => `{${f}}`).join(", ")} isn't a merge field. Fix it with Insert field before sending.
                </p>
              )}
              {p && p.samples.length > 0 && (
                <div className="space-y-2">
                  <Label>Preview</Label>
                  {p.samples.map((s) => (
                    <div key={s.id}>
                      <div className="text-[11px] text-muted-foreground mb-0.5">To {s.name}</div>
                      <div className="rounded-lg bg-secondary px-3 py-2 text-[13px] whitespace-pre-wrap">{s.text}</div>
                    </div>
                  ))}
                </div>
              )}
              {p && p.held.length > 0 && (
                <div className="rounded-sm border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[12.5px]">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" /> {p.held.length} won't be sent: a field would be empty
                  </div>
                  <div className="text-muted-foreground mt-1">
                    {p.held
                      .slice(0, 8)
                      .map((h) => `${h.name} (${h.blank.map((f) => `{${f}}`).join(", ")})`)
                      .join(", ")}
                    {p.held.length > 8 && `, and ${p.held.length - 8} more`}. Add a fallback like {"{contact_first_name|there}"} to include them.
                  </div>
                </div>
              )}

              <p className="text-[11.5px] text-muted-foreground">
                Promotional texts need consent: send them to people who've asked to hear from you, or who you've worked with or heard from recently. Anyone
                who replies STOP is never bulk-texted again.
              </p>
              <div className="flex justify-end">
                <Button className="rounded-sm" disabled={blocked || preview.isFetching} onClick={() => setConfirming(true)} data-testid="bulk-send">
                  <Send className="w-4 h-4 mr-1.5" /> Send to {sendCount} {sendCount === 1 ? "person" : "people"}
                </Button>
              </div>
              {send.isError && <p className="text-sm text-destructive">{apiErrorMessage(send.error)}</p>}
            </CardContent>
          </Card>
        </div>

        <History />
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Text {sendCount} {sendCount === 1 ? "person" : "people"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Each gets their own copy from your business line, one every few seconds
              {sendCount > 1 ? ` (about ${Math.max(1, Math.round((sendCount * 4) / 60))} min)` : ""}. Outside 8 am–9 pm it waits for the morning. You can stop it
              part-way from the list below.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                send.mutate();
              }}
              disabled={send.isPending}
              data-testid="bulk-confirm"
            >
              {send.isPending ? "Starting…" : "Send"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

function Step({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-5 h-5 rounded-full bg-foreground text-background text-[11px] flex items-center justify-center">{n}</span>
      <span className="font-medium">{title}</span>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] tracking-[0.14em] uppercase text-muted-foreground mb-1.5">{children}</div>;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded-sm border text-[12px] ${on ? "bg-foreground text-background border-foreground" : "border-border hover:bg-secondary"}`}
    >
      {children}
    </button>
  );
}

function ChipFilter({
  label,
  options,
  value,
  onChange,
  searchable,
}: {
  label: string;
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  searchable?: boolean;
}) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const n = q.trim().toLowerCase();
  const matching = options.filter((o) => !n || o.name.toLowerCase().includes(n));
  const shown = all || n ? matching : matching.slice(0, 12);
  // Chosen ones stay visible even when they'd be cut off.
  const visible = [...shown, ...options.filter((o) => value.includes(o.name) && !shown.includes(o))];
  const toggle = (name: string) => onChange(value.includes(name) ? value.filter((x) => x !== name) : [...value, name]);
  if (options.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {value.length > 0 && (
          <button className="text-[11.5px] text-muted-foreground underline underline-offset-2 mb-1.5" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
      {searchable && options.length > 12 && (
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}`} className="h-8 text-[12.5px] mb-1.5" />
      )}
      <div className="flex flex-wrap gap-1.5">
        {visible.map((o) => (
          <Chip key={o.name} on={value.includes(o.name)} onClick={() => toggle(o.name)}>
            {o.name} <span className="opacity-60">{o.count}</span>
          </Chip>
        ))}
        {!all && !n && matching.length > 12 && (
          <button className="text-[12px] text-muted-foreground underline underline-offset-2" onClick={() => setAll(true)}>
            {matching.length - 12} more
          </button>
        )}
      </div>
    </div>
  );
}

function AddPerson({ onAdd }: { onAdd: (m: Member) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const { data = [] } = useQuery<Array<{ fubId: string; name: string | null; phone: string | null; stage: string | null; source: string | null }>>({
    queryKey: [`/api/admin/crm/contacts?q=${encodeURIComponent(dq)}&limit=8`],
    enabled: dq.length >= 2,
  });
  return (
    <div>
      <Label>Add people</Label>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or phone" className="pl-8 h-8 text-[12.5px]" />
      </div>
      {dq.length >= 2 && q && (
        <div className="mt-1 border border-border rounded-sm divide-y divide-border">
          {data.length === 0 && <div className="px-3 py-1.5 text-[12px] text-muted-foreground">No one found.</div>}
          {data.map((c) => (
            <button
              key={c.fubId}
              type="button"
              className="w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-secondary flex items-center gap-2"
              onClick={() => {
                onAdd({ id: c.fubId, name: c.name ?? "(no name)", phone: c.phone, stage: c.stage, source: c.source, eligibility: "ok" });
                setQ("");
              }}
            >
              <UserPlus className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">{c.name ?? "(no name)"}</span>
              <span className="text-muted-foreground">{c.phone ?? "no number"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Past sends -------------------------------------------------------------------------------

function History() {
  const qc = useQueryClient();
  const { data = [] } = useQuery<BulkText[]>({
    queryKey: ["/api/admin/bulk-texts"],
    refetchInterval: (q) => ((q.state.data as BulkText[] | undefined)?.some((b) => b.status === "sending") ? 4000 : false),
  });
  const [open, setOpen] = useState<number | null>(null);
  const cancel = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/admin/bulk-texts/${id}/cancel`)).json(),
    onSuccess: () => qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith("/api/admin/bulk-texts") }),
  });
  if (data.length === 0) return null;
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 py-3 border-b border-border font-medium">Sent</div>
        <div className="divide-y divide-border">
          {data.map((b) => {
            const done = b.counts.sent + b.counts.failed;
            const toSend = done + b.counts.queued;
            return (
              <div key={b.id}>
                <div className="px-5 py-3 flex items-start gap-3">
                  <button className="mt-0.5 text-muted-foreground" onClick={() => setOpen(open === b.id ? null : b.id)} aria-label="Show recipients">
                    {open === b.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] truncate">{b.body}</div>
                    <div className="text-[11.5px] text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                      <span>{when(b.createdAt)}</span>
                      <span>
                        {b.counts.sent} sent{toSend ? ` of ${toSend}` : ""}
                      </span>
                      {b.counts.failed > 0 && <span className="text-destructive">{b.counts.failed} failed</span>}
                      {b.counts.held > 0 && <span>{b.counts.held} held (empty field)</span>}
                      {b.counts.skipped > 0 && <span>{b.counts.skipped} skipped</span>}
                      {b.resumesAt && <span>paused overnight, resumes {when(b.resumesAt)}</span>}
                    </div>
                    {b.status === "sending" && toSend > 0 && (
                      <div className="h-1 bg-secondary rounded mt-2 overflow-hidden">
                        <div className="h-full bg-foreground transition-all" style={{ width: `${(done / toSend) * 100}%` }} />
                      </div>
                    )}
                  </div>
                  {b.status === "sending" ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="rounded-sm text-[10px]">
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Sending
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="rounded-sm h-7 text-xs"
                        onClick={() => window.confirm("Stop sending the rest?") && cancel.mutate(b.id)}
                      >
                        <Ban className="w-3.5 h-3.5 mr-1" /> Stop
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="outline" className="rounded-sm text-[10px] shrink-0">
                      {b.status === "done" ? "Done" : "Stopped"}
                    </Badge>
                  )}
                </div>
                {open === b.id && <Recipients id={b.id} live={b.status === "sending"} />}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function Recipients({ id, live }: { id: number; live: boolean }) {
  const { data } = useQuery<BulkText & { recipients: Array<{ id: number; contactId: string; name: string; phone: string; body: string; status: string; detail: string | null }> }>({
    queryKey: [`/api/admin/bulk-texts/${id}`],
    refetchInterval: live ? 4000 : false,
  });
  if (!data) return <div className="px-12 pb-3 text-[12px] text-muted-foreground">Loading…</div>;
  return (
    <div className="px-12 pb-3">
      <div className="max-h-[320px] overflow-y-auto border border-border rounded-sm divide-y divide-border">
        {data.recipients.map((r) => (
          <div key={r.id} className="px-3 py-1.5 text-[12.5px] flex items-center gap-2">
            <StatusIcon status={r.status} />
            <Link href={`/admin/inbox?contact=${encodeURIComponent(r.contactId)}`} className="truncate hover:underline">
              {r.name}
            </Link>
            <span className="text-muted-foreground truncate flex-1">{r.detail ?? (r.status === "queued" ? "waiting" : "")}</span>
            <span className="text-muted-foreground shrink-0">{r.phone}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "sent") return <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
  if (status === "failed") return <X className="w-3.5 h-3.5 text-destructive shrink-0" />;
  if (status === "held") return <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />;
  if (status === "skipped") return <Ban className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
  return <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
}
