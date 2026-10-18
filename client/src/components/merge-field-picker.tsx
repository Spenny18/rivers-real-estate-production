// "Insert field": pick a merge field ({contact_first_name}, {inquiry_address} …)
// to drop into a message, and add or remove custom fields
// (server/merge-fields.ts). Used by the Inbox composer and the automation builder.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Loader2, Settings2, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";

export interface MergeField {
  token: string;
  label: string;
  group: string;
}
interface CustomField {
  key: string;
  label: string;
  type: string;
  source: "fub" | "app";
}
interface Catalog {
  fields: MergeField[];
  custom: CustomField[];
}

const KEY = ["/api/admin/merge-fields"];

export function useMergeFields() {
  return useQuery<Catalog>({ queryKey: KEY, staleTime: 5 * 60_000 });
}

export function MergeFieldPicker({
  onPick,
  disabled,
  className,
  label = "Insert field",
}: {
  onPick: (token: string) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [managing, setManaging] = useState(false);
  const { data, isLoading } = useMergeFields();

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.fields ?? []).filter((f) => !needle || f.label.toLowerCase().includes(needle) || f.token.includes(needle));
    const out = new Map<string, MergeField[]>();
    for (const f of list) out.set(f.group, [...(out.get(f.group) ?? []), f]);
    return Array.from(out.entries());
  }, [data, q]);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={
              className ??
              "px-2.5 py-1 rounded-sm text-[11.5px] flex items-center gap-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-50"
            }
            data-testid="insert-merge-field"
          >
            <Braces className="h-3 w-3" /> {label}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[320px] p-0">
          <div className="p-2 border-b border-border">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields" autoFocus className="h-8 text-[13px]" />
          </div>
          <div className="max-h-[340px] overflow-y-auto py-1">
            {isLoading && (
              <div className="px-3 py-2 text-[12px] text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading fields…
              </div>
            )}
            {groups.map(([group, fields]) => (
              <div key={group}>
                <div className="px-3 pt-2 pb-1 text-[10px] tracking-[0.14em] uppercase text-muted-foreground">{group}</div>
                {fields.map((f) => (
                  <button
                    key={f.token}
                    type="button"
                    onClick={() => {
                      onPick(`{${f.token}}`);
                      setOpen(false);
                      setQ("");
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-baseline justify-between gap-2"
                    data-testid={`merge-field-${f.token}`}
                  >
                    <span className="text-[13px] truncate">{f.label}</span>
                    <span className="text-[10.5px] text-muted-foreground font-mono truncate">{`{${f.token}}`}</span>
                  </button>
                ))}
              </div>
            ))}
            {!isLoading && groups.length === 0 && <div className="px-3 py-2 text-[12px] text-muted-foreground">No fields match.</div>}
          </div>
          <div className="border-t border-border p-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              Add a fallback: <span className="font-mono">{"{contact_first_name|there}"}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setManaging(true);
              }}
              className="text-[11.5px] flex items-center gap-1 underline underline-offset-2 shrink-0"
            >
              <Settings2 className="h-3 w-3" /> Custom fields
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {managing && <CustomFieldsDialog onClose={() => setManaging(false)} />}
    </>
  );
}

/** Add and remove custom fields. Follow Up Boss's are listed but managed in Follow Up Boss. */
export function CustomFieldsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useMergeFields();
  const [label, setLabel] = useState("");
  const [type, setType] = useState("text");
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const add = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/custom-fields", { label, type })).json(),
    onSuccess: () => {
      setLabel("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async (key: string) => (await apiRequest("DELETE", `/api/admin/custom-fields/${encodeURIComponent(key)}`)).json(),
    onSuccess: refresh,
  });
  const custom = data?.custom ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Custom fields</DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-muted-foreground">
          Add a field, then fill it in for each contact in the Inbox (Details, in the right-hand column). Use it in any message as its{" "}
          <span className="font-mono">{"{custom_…}"}</span> field.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) add.mutate();
          }}
        >
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Preferred neighbourhood" data-testid="custom-field-label" />
          <select value={type} onChange={(e) => setType(e.target.value)} className="h-9 rounded-sm border border-border bg-transparent px-2 text-[13px]">
            <option value="text">Text</option>
            <option value="date">Date</option>
            <option value="number">Number</option>
          </select>
          <Button type="submit" className="rounded-sm" disabled={!label.trim() || add.isPending} data-testid="custom-field-add">
            Add
          </Button>
        </form>
        {add.isError && <p className="text-[12px] text-destructive">{apiErrorMessage(add.error)}</p>}
        <div className="max-h-[320px] overflow-y-auto divide-y divide-border border border-border rounded-sm">
          {custom.length === 0 && <div className="px-3 py-2 text-[13px] text-muted-foreground">None yet.</div>}
          {custom.map((f) => (
            <div key={f.key} className="px-3 py-2 flex items-center gap-2 text-[13px]">
              <div className="min-w-0 flex-1">
                <div className="truncate">{f.label}</div>
                <div className="text-[11px] text-muted-foreground font-mono truncate">{`{${f.key}}`}</div>
              </div>
              <span className="text-[11px] text-muted-foreground shrink-0">{f.source === "fub" ? "Follow Up Boss" : f.type}</span>
              {f.source === "app" && (
                <button type="button" onClick={() => remove.mutate(f.key)} aria-label={`Remove ${f.label}`} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Insert text into an input or textarea at its cursor (or the end), returning
 * the new value. Used where a field is picked for a box that has lost focus.
 */
export function insertAtCursor(el: HTMLInputElement | HTMLTextAreaElement | null, value: string, text: string, lastCaret?: number | null): { value: string; caret: number } {
  const pos = Math.min(lastCaret ?? el?.selectionStart ?? value.length, value.length);
  const next = value.slice(0, pos) + text + value.slice(pos);
  return { value: next, caret: pos + text.length };
}
