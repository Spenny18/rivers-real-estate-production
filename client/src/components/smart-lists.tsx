// Smart lists on the CRM's Contacts tab (server/smart-lists.ts): saved views
// such as "Hot, no contact in 7 days", worked out live each time they open.
//
//   SmartListsBar       the lists as chips with their counts, plus "New list"
//   SmartListContacts   who's in the selected list, longest since contact first
//   SmartListEditor     name, filters and sort, with a live count as you go

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail, Pencil, Phone, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export interface Filters {
  stages?: string[];
  tagsAny?: string[];
  tagsNone?: string[];
  sources?: string[];
  lastContact?: { op: "older" | "within" | "never"; days?: number };
  created?: { op: "older" | "within"; days: number };
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasOpenTask?: boolean;
  hasOverdueTask?: boolean;
  q?: string;
}

export interface SmartList {
  id: number;
  name: string;
  filters: Filters;
  sort: string;
  count?: number;
}

interface Option {
  value: string;
  count: number;
}

interface ListsResponse {
  lists: SmartList[];
  options: { stages: Option[]; sources: Option[]; tags: Option[]; sorts: Record<string, string>; fubSmartLists: string[] };
}

interface ListContact {
  fubId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  source: string | null;
  tags: string | null;
  lastContactAt: string | null;
}

const LISTS_KEY = "/api/admin/crm/smart-lists";

function sinceText(iso: string | null): string {
  if (!iso) return "Never contacted";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
  if (days <= 0) return "Contacted today";
  if (days === 1) return "Contacted yesterday";
  if (days < 60) return `Last contact ${days} days ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `Last contact ${months} months ago` : `Last contact ${Math.round(days / 365)} years ago`;
}

function tagList(tags: string | null): string[] {
  try {
    const t = JSON.parse(tags ?? "[]");
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

/** A plain-English line for a list's filters, for under its name. */
export function describeFilters(f: Filters): string {
  const parts: string[] = [];
  if (f.stages?.length) parts.push(f.stages.join(" or "));
  if (f.tagsAny?.length) parts.push(`tagged ${f.tagsAny.join(" or ")}`);
  if (f.tagsNone?.length) parts.push(`not tagged ${f.tagsNone.join(" or ")}`);
  if (f.sources?.length) parts.push(`from ${f.sources.join(" or ")}`);
  if (f.lastContact?.op === "never") parts.push("never contacted");
  if (f.lastContact?.op === "older") parts.push(`no contact in ${f.lastContact.days ?? 30} days`);
  if (f.lastContact?.op === "within") parts.push(`contacted in the last ${f.lastContact.days ?? 30} days`);
  if (f.created) parts.push(f.created.op === "within" ? `added in the last ${f.created.days} days` : `added over ${f.created.days} days ago`);
  if (f.hasEmail !== undefined) parts.push(f.hasEmail ? "has email" : "no email");
  if (f.hasPhone !== undefined) parts.push(f.hasPhone ? "has phone" : "no phone");
  if (f.hasOverdueTask) parts.push("overdue task");
  else if (f.hasOpenTask !== undefined) parts.push(f.hasOpenTask ? "open task" : "no open task");
  if (f.q) parts.push(`matching "${f.q}"`);
  return parts.length ? parts.join(" · ") : "Everyone";
}

// ---- The bar ---------------------------------------------------------------------------

export function SmartListsBar({ selected, onSelect }: { selected: number | null; onSelect: (id: number | null) => void }) {
  const { data } = useQuery<ListsResponse>({ queryKey: [LISTS_KEY] });
  const [editing, setEditing] = useState<SmartList | "new" | null>(null);
  const lists = data?.lists ?? [];
  const chip = (active: boolean) =>
    `shrink-0 inline-flex items-center gap-1.5 rounded-sm border px-2.5 h-8 text-[12.5px] transition-colors ${
      active ? "border-foreground bg-foreground text-background" : "border-border hover:border-foreground/40"
    }`;
  return (
    <div className="mb-3" data-testid="smart-lists-bar">
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <button type="button" className={chip(selected === null)} onClick={() => onSelect(null)}>
          All contacts
        </button>
        {lists.map((l) => (
          <button key={l.id} type="button" className={chip(selected === l.id)} onClick={() => onSelect(l.id)} data-testid={`smart-list-${l.id}`}>
            {l.name}
            <span className={`tabular-nums ${selected === l.id ? "text-background/70" : "text-muted-foreground"}`}>{l.count ?? ""}</span>
          </button>
        ))}
        <button type="button" className={`${chip(false)} text-muted-foreground`} onClick={() => setEditing("new")} data-testid="button-new-smart-list">
          <Plus className="h-3.5 w-3.5" /> New list
        </button>
      </div>
      {selected !== null && lists.find((l) => l.id === selected) && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground mt-1">
          <span>{describeFilters(lists.find((l) => l.id === selected)!.filters)}</span>
          <button
            type="button"
            onClick={() => setEditing(lists.find((l) => l.id === selected)!)}
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
            data-testid="button-edit-smart-list"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        </div>
      )}
      {editing && data && (
        <SmartListEditor
          list={editing === "new" ? null : editing}
          options={data.options}
          onClose={() => setEditing(null)}
          onSaved={(id) => onSelect(id)}
          onDeleted={() => onSelect(null)}
        />
      )}
    </div>
  );
}

// ---- Who's in it -----------------------------------------------------------------------

export function SmartListContacts({ listId, onOpenContact }: { listId: number; onOpenContact: (id: string) => void }) {
  const { data, isLoading, error } = useQuery<{ total: number; contacts: ListContact[] }>({
    queryKey: [`${LISTS_KEY}/${listId}/contacts?limit=500`],
  });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{apiErrorMessage(error)}</p>;
  const contacts = data?.contacts ?? [];
  if (contacts.length === 0) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">No one in this list right now.</CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-1.5" data-testid="smart-list-contacts">
      {contacts.map((c) => {
        const since = sinceText(c.lastContactAt);
        const stale = !c.lastContactAt || Date.now() - Date.parse(c.lastContactAt) > 30 * 86400_000;
        return (
          <button key={c.fubId} onClick={() => onOpenContact(c.fubId)} className="w-full text-left" data-testid={`smart-contact-${c.fubId}`}>
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
                    {tagList(c.tags)
                      .slice(0, 3)
                      .map((t) => (
                        <span key={t} className="text-[11px] text-muted-foreground">
                          #{t}
                        </span>
                      ))}
                  </div>
                  <div className="text-[12px] text-muted-foreground flex flex-wrap gap-x-3">
                    {c.phone && (
                      <span className="inline-flex items-center gap-1.5">
                        <Phone className="h-3 w-3" />
                        {c.phone}
                      </span>
                    )}
                    {c.email && (
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="h-3 w-3" />
                        {c.email}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-[12px] shrink-0 text-right">
                  <div className={stale ? "text-destructive/80" : "text-muted-foreground"}>{since}</div>
                  {c.source && <div className="text-muted-foreground">{c.source}</div>}
                </div>
              </CardContent>
            </Card>
          </button>
        );
      })}
      {data && data.total > contacts.length && (
        <p className="text-[12px] text-muted-foreground text-center pt-1">
          Showing {contacts.length.toLocaleString("en-CA")} of {data.total.toLocaleString("en-CA")}. Narrow the list to see the rest.
        </p>
      )}
    </div>
  );
}

// ---- The editor --------------------------------------------------------------------------

function Toggle({ on, label, count, onClick }: { on: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`text-[12px] px-2 py-1 rounded-sm border ${on ? "border-foreground bg-foreground text-background" : "border-border hover:border-foreground/40"}`}
    >
      {label}
      {count !== undefined && <span className={on ? "text-background/70" : "text-muted-foreground"}> {count}</span>}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function toggleIn(list: string[] | undefined, v: string): string[] | undefined {
  const cur = list ?? [];
  const next = cur.some((x) => x.toLowerCase() === v.toLowerCase()) ? cur.filter((x) => x.toLowerCase() !== v.toLowerCase()) : [...cur, v];
  return next.length ? next : undefined;
}

function TagPicker({ value, options, onChange }: { value?: string[]; options: Option[]; onChange: (v?: string[]) => void }) {
  const [typed, setTyped] = useState("");
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? options : options.slice(0, 16);
  const extra = (value ?? []).filter((v) => !options.some((o) => o.value.toLowerCase() === v.toLowerCase()));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {[...extra.map((v) => ({ value: v, count: undefined as number | undefined })), ...shown].map((o) => (
          <Toggle key={o.value} on={!!value?.some((v) => v.toLowerCase() === o.value.toLowerCase())} label={o.value} count={o.count} onClick={() => onChange(toggleIn(value, o.value))} />
        ))}
        {options.length > 16 && (
          <button type="button" onClick={() => setShowAll(!showAll)} className="text-[12px] underline underline-offset-2 text-muted-foreground">
            {showAll ? "Fewer" : `All ${options.length}`}
          </button>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) onChange(toggleIn(value, typed.trim()));
          setTyped("");
        }}
      >
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Another tag, then Enter" className="h-8 rounded-sm text-[12.5px] max-w-xs" />
      </form>
    </div>
  );
}

const selectClass = "h-8 rounded-sm border border-input bg-background px-2 text-[12.5px]";

export function SmartListEditor({
  list,
  options,
  onClose,
  onSaved,
  onDeleted,
}: {
  list: SmartList | null;
  options: ListsResponse["options"];
  onClose: () => void;
  onSaved: (id: number) => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(list?.name ?? "");
  const [sort, setSort] = useState(list?.sort ?? "last_contact_asc");
  const [f, setF] = useState<Filters>(list?.filters ?? {});
  const set = (patch: Partial<Filters>) => setF((cur) => {
    const next: Record<string, any> = { ...cur, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return next as Filters;
  });

  // Live count, a moment after the last change.
  const key = JSON.stringify([f, sort]);
  const [preview, setPreview] = useState<{ total: number; contacts: ListContact[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(() => {
      apiRequest("POST", `${LISTS_KEY}/preview`, { filters: f, sort })
        .then((r) => r.json())
        .then((d) => !cancelled && setPreview(d))
        .catch(() => !cancelled && setPreview(null))
        .finally(() => !cancelled && setPreviewing(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(LISTS_KEY) });
  const save = useMutation({
    mutationFn: async () =>
      (await apiRequest(list ? "PUT" : "POST", list ? `${LISTS_KEY}/${list.id}` : LISTS_KEY, { name, filters: f, sort })).json() as Promise<SmartList>,
    onSuccess: (l) => {
      refresh();
      onSaved(l.id);
      onClose();
    },
    onError: (e) => toast({ title: "Couldn't save the list", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `${LISTS_KEY}/${list!.id}`),
    onSuccess: () => {
      refresh();
      onDeleted();
      onClose();
    },
    onError: (e) => toast({ title: "Couldn't delete the list", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const lc = f.lastContact;
  const lcMode = lc ? lc.op : "any";
  const yesNo = (v: boolean | undefined) => (v === undefined ? "any" : v ? "yes" : "no");
  const fromYesNo = (v: string) => (v === "any" ? undefined : v === "yes");
  const fubNames = useMemo(() => options.fubSmartLists ?? [], [options]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="smart-list-editor">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">{list ? "Edit list" : "New smart list"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Hot buyers, no contact in 7 days" className="rounded-sm" data-testid="input-smart-list-name" />
          {!list && fubNames.length > 0 && (
            <p className="text-[12px] text-muted-foreground">Your Follow Up Boss smart lists, to recreate: {fubNames.join(", ")}.</p>
          )}

          <Section title="STAGE">
            <div className="flex flex-wrap gap-1.5">
              {options.stages.map((o) => (
                <Toggle key={o.value} on={!!f.stages?.some((s) => s.toLowerCase() === o.value.toLowerCase())} label={o.value} count={o.count} onClick={() => set({ stages: toggleIn(f.stages, o.value) })} />
              ))}
            </div>
          </Section>

          <Section title="LAST CONTACT (CALL, TEXT OR EMAIL)">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={lcMode}
                onChange={(e) => {
                  const op = e.target.value;
                  set({ lastContact: op === "any" ? undefined : { op: op as any, days: op === "never" ? undefined : lc?.days ?? 30 } });
                }}
                className={selectClass}
                aria-label="Last contact"
                data-testid="select-last-contact"
              >
                <option value="any">Any time</option>
                <option value="older">No contact in</option>
                <option value="within">Contacted in the last</option>
                <option value="never">Never contacted</option>
              </select>
              {(lcMode === "older" || lcMode === "within") && (
                <>
                  <Input
                    type="number"
                    min={0}
                    value={lc?.days ?? 30}
                    onChange={(e) => set({ lastContact: { op: lcMode as any, days: Math.max(0, parseInt(e.target.value, 10) || 0) } })}
                    className="h-8 w-20 rounded-sm text-[12.5px]"
                    aria-label="Days"
                    data-testid="input-last-contact-days"
                  />
                  <span className="text-[12.5px]">days</span>
                </>
              )}
            </div>
          </Section>

          <Section title="HAS ANY OF THESE TAGS">
            <TagPicker value={f.tagsAny} options={options.tags} onChange={(v) => set({ tagsAny: v })} />
          </Section>
          <Section title="HAS NONE OF THESE TAGS">
            <TagPicker value={f.tagsNone} options={options.tags} onChange={(v) => set({ tagsNone: v })} />
          </Section>

          {options.sources.length > 0 && (
            <Section title="SOURCE">
              <div className="flex flex-wrap gap-1.5">
                {options.sources.slice(0, 20).map((o) => (
                  <Toggle key={o.value} on={!!f.sources?.some((s) => s.toLowerCase() === o.value.toLowerCase())} label={o.value} count={o.count} onClick={() => set({ sources: toggleIn(f.sources, o.value) })} />
                ))}
              </div>
            </Section>
          )}

          <Section title="MORE">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12.5px]">
              <label className="flex items-center gap-2">
                <span className="w-24">Added</span>
                <select
                  value={f.created ? f.created.op : "any"}
                  onChange={(e) => set({ created: e.target.value === "any" ? undefined : { op: e.target.value as any, days: f.created?.days ?? 30 } })}
                  className={selectClass}
                >
                  <option value="any">Any time</option>
                  <option value="within">In the last</option>
                  <option value="older">Over</option>
                </select>
                {f.created && (
                  <>
                    <Input
                      type="number"
                      min={0}
                      value={f.created.days}
                      onChange={(e) => set({ created: { op: f.created!.op, days: Math.max(0, parseInt(e.target.value, 10) || 0) } })}
                      className="h-8 w-16 rounded-sm text-[12.5px]"
                      aria-label="Days since added"
                    />
                    <span>days{f.created.op === "older" ? " ago" : ""}</span>
                  </>
                )}
              </label>
              <label className="flex items-center gap-2">
                <span className="w-24">Tasks</span>
                <select
                  value={f.hasOverdueTask ? "overdue" : f.hasOpenTask === undefined ? "any" : f.hasOpenTask ? "open" : "none"}
                  onChange={(e) => {
                    const v = e.target.value;
                    set({ hasOverdueTask: v === "overdue" ? true : undefined, hasOpenTask: v === "open" ? true : v === "none" ? false : undefined });
                  }}
                  className={selectClass}
                >
                  <option value="any">Any</option>
                  <option value="open">Has an open task</option>
                  <option value="overdue">Has an overdue task</option>
                  <option value="none">No open tasks</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span className="w-24">Email</span>
                <select value={yesNo(f.hasEmail)} onChange={(e) => set({ hasEmail: fromYesNo(e.target.value) })} className={selectClass}>
                  <option value="any">Any</option>
                  <option value="yes">Has one</option>
                  <option value="no">Missing</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span className="w-24">Phone</span>
                <select value={yesNo(f.hasPhone)} onChange={(e) => set({ hasPhone: fromYesNo(e.target.value) })} className={selectClass}>
                  <option value="any">Any</option>
                  <option value="yes">Has one</option>
                  <option value="no">Missing</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span className="w-24">Sort</span>
                <select value={sort} onChange={(e) => setSort(e.target.value)} className={selectClass}>
                  {Object.entries(options.sorts).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Section>

          <div className="rounded-sm border border-border p-3 text-[12.5px]" data-testid="smart-list-preview">
            <div className="flex items-center gap-2">
              <span className="font-medium">{preview ? `${preview.total.toLocaleString("en-CA")} contact${preview.total === 1 ? "" : "s"}` : "…"}</span>
              <span className="text-muted-foreground">{describeFilters(f)}</span>
              {previewing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
            {preview && preview.contacts.length > 0 && (
              <div className="text-muted-foreground mt-1">
                {preview.contacts.map((c) => c.name ?? "Unnamed").join(", ")}
                {preview.total > preview.contacts.length ? "…" : ""}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="rounded-sm text-[11px]" data-testid="button-save-smart-list">
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "SAVE LIST"}
            </Button>
            <Button variant="ghost" onClick={onClose} className="rounded-sm text-[11px]">
              CANCEL
            </Button>
            {list && (
              <Button
                variant="ghost"
                onClick={() => window.confirm(`Delete "${list.name}"? Contacts aren't affected.`) && remove.mutate()}
                className="rounded-sm text-[11px] text-destructive ml-auto"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> DELETE LIST
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
