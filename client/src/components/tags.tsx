// Contact tags (server/tags.ts), the app's own:
//
//   ContactTagsEditor   one contact's tags as chips: add (with suggestions), remove
//   ManageTagsDialog    every tag with its count: rename or delete everywhere
//   BulkTagDialog       add or remove a tag on everyone in a smart list

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Tag, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const TAGS_KEY = "/api/admin/crm/tags";

interface TagCount {
  tag: string;
  count: number;
}

function useAllTags(enabled = true) {
  return useQuery<{ tags: TagCount[] }>({ queryKey: [TAGS_KEY], enabled });
}

/** Everything under /api/admin/crm: counts, lists and contact rows all show tags. */
function useRefreshCrm() {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/admin/crm"),
    });
}

/** A text box that suggests existing tags as you type; Enter picks. */
function TagInput({ onPick, exclude = [], placeholder = "Add a tag" }: { onPick: (t: string) => void; exclude?: string[]; placeholder?: string }) {
  const [typed, setTyped] = useState("");
  const { data } = useAllTags();
  const ex = new Set(exclude.map((t) => t.toLowerCase()));
  const q = typed.trim().toLowerCase();
  const suggestions = (data?.tags ?? []).filter((t) => !ex.has(t.tag.toLowerCase()) && (!q || t.tag.toLowerCase().includes(q))).slice(0, 8);
  const pick = (t: string) => {
    const v = t.trim();
    if (v) onPick(v);
    setTyped("");
  };
  return (
    <div className="relative">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          pick(typed);
        }}
      >
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={placeholder}
          maxLength={60}
          className="h-8 rounded-sm text-[12.5px]"
          data-testid="input-add-tag"
        />
      </form>
      {q && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-sm border border-border bg-background shadow-sm max-h-56 overflow-y-auto">
          {suggestions.map((s) => (
            <button
              key={s.tag}
              type="button"
              onClick={() => pick(s.tag)}
              className="w-full text-left px-2.5 py-1.5 text-[12.5px] hover:bg-secondary/60 flex justify-between gap-2"
            >
              <span>{s.tag}</span>
              <span className="text-muted-foreground tabular-nums">{s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ContactTagsEditor({ contactId }: { contactId: string }) {
  const { toast } = useToast();
  const refresh = useRefreshCrm();
  const key = [`/api/admin/crm/contacts/${contactId}/tags`];
  const qc = useQueryClient();
  const { data } = useQuery<{ tags: string[] }>({ queryKey: key });
  const tags = data?.tags ?? [];
  const [adding, setAdding] = useState(false);
  const change = useMutation({
    mutationFn: async (body: { add?: string[]; remove?: string[] }) =>
      (await apiRequest("POST", `/api/admin/crm/contacts/${encodeURIComponent(contactId)}/tags`, body)).json() as Promise<{ tags: string[] }>,
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      refresh();
    },
    onError: (e) => toast({ title: apiErrorMessage(e), variant: "destructive" }),
  });
  return (
    <div data-testid="contact-tags">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag className="h-3.5 w-3.5 text-muted-foreground" />
        {tags.length === 0 && !adding && <span className="text-[12px] text-muted-foreground">No tags</span>}
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-sm border border-border px-2 h-6 text-[12px]">
            {t}
            <button
              type="button"
              onClick={() => change.mutate({ remove: [t] })}
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Remove tag ${t}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-[12px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
            data-testid="button-add-tag"
          >
            + Tag
          </button>
        )}
        {change.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {adding && (
        <div className="flex items-start gap-2 mt-1.5 max-w-sm">
          <div className="flex-1">
            <TagInput exclude={tags} onPick={(t) => change.mutate({ add: [t] })} />
          </div>
          <Button size="sm" variant="ghost" className="h-8 rounded-sm text-[11px]" onClick={() => setAdding(false)}>
            DONE
          </Button>
        </div>
      )}
    </div>
  );
}

export function ManageTagsDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const refresh = useRefreshCrm();
  const { data, isLoading } = useAllTags();
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const tags = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.tags ?? []).filter((t) => !q || t.tag.toLowerCase().includes(q));
  }, [data, filter]);

  const rename = useMutation({
    mutationFn: async (v: { from: string; to: string }) => (await apiRequest("POST", "/api/admin/crm/tags/rename", v)).json(),
    onSuccess: (r: { contacts: number }, v) => {
      setRenaming(null);
      refresh();
      toast({ title: `Renamed "${v.from}" to "${v.to}" on ${r.contacts} contact${r.contacts === 1 ? "" : "s"}.` });
    },
    onError: (e) => toast({ title: apiErrorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (tag: string) => (await apiRequest("POST", "/api/admin/crm/tags/delete", { tag })).json(),
    onSuccess: (r: { contacts: number }, tag) => {
      refresh();
      toast({ title: `Removed "${tag}" from ${r.contacts} contact${r.contacts === 1 ? "" : "s"}.` });
    },
    onError: (e) => toast({ title: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">Tags</DialogTitle>
        </DialogHeader>
        <p className="text-[12.5px] text-muted-foreground -mt-2">
          Every tag on your contacts, including the ones from Follow Up Boss. Renaming or deleting changes every contact that has it.
        </p>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a tag" className="h-9 rounded-sm" />
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : tags.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No tags yet. Add one from a contact, or tag a whole smart list.</p>
        ) : (
          <div className="divide-y divide-border" data-testid="tag-manager-list">
            {tags.map((t) => (
              <div key={t.tag} className="flex items-center gap-2 py-2">
                {renaming?.from === t.tag ? (
                  <form
                    className="flex-1 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (renaming.to.trim() && renaming.to.trim() !== t.tag) rename.mutate({ from: t.tag, to: renaming.to.trim() });
                    }}
                  >
                    <Input
                      autoFocus
                      value={renaming.to}
                      maxLength={60}
                      onChange={(e) => setRenaming({ from: t.tag, to: e.target.value })}
                      className="h-8 rounded-sm text-[13px]"
                    />
                    <Button size="sm" type="submit" className="h-8 rounded-sm text-[11px]" disabled={rename.isPending}>
                      {rename.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "SAVE"}
                    </Button>
                    <Button size="sm" type="button" variant="ghost" className="h-8 rounded-sm text-[11px]" onClick={() => setRenaming(null)}>
                      CANCEL
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1 text-[13.5px]">{t.tag}</span>
                    <span className="text-[12px] text-muted-foreground tabular-nums">{t.count}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      aria-label={`Rename ${t.tag}`}
                      onClick={() => setRenaming({ from: t.tag, to: t.tag })}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive"
                      aria-label={`Delete ${t.tag}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        if (confirm(`Remove "${t.tag}" from all ${t.count} contact${t.count === 1 ? "" : "s"}? This can't be undone.`)) remove.mutate(t.tag);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function BulkTagDialog({ listId, listName, count, onClose }: { listId: number; listName: string; count: number; onClose: () => void }) {
  const { toast } = useToast();
  const refresh = useRefreshCrm();
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [tag, setTag] = useState("");
  const run = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/admin/crm/tags/bulk", { listId, [mode]: [tag.trim()] })).json() as Promise<{
        contacts: number;
        added: number;
        removed: number;
      }>,
    onSuccess: (r) => {
      refresh();
      toast({
        title:
          mode === "add"
            ? `Tagged ${r.added} contact${r.added === 1 ? "" : "s"} "${tag.trim()}"${r.contacts - r.added > 0 ? ` (${r.contacts - r.added} already had it)` : ""}.`
            : `Removed "${tag.trim()}" from ${r.removed} contact${r.removed === 1 ? "" : "s"}.`,
      });
      onClose();
    },
    onError: (e) => toast({ title: apiErrorMessage(e), variant: "destructive" }),
  });
  const chip = (on: boolean) =>
    `flex-1 px-3 py-2 rounded-sm border text-[11px] font-display tracking-[0.16em] ${on ? "bg-foreground text-background border-foreground" : "border-border hover:bg-secondary/40"}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">Tag everyone in “{listName}”</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <button type="button" className={chip(mode === "add")} onClick={() => setMode("add")}>
            ADD A TAG
          </button>
          <button type="button" className={chip(mode === "remove")} onClick={() => setMode("remove")}>
            REMOVE A TAG
          </button>
        </div>
        {tag ? (
          <div className="flex items-center gap-2 text-[13px]">
            <span className="inline-flex items-center gap-1 rounded-sm border border-border px-2 h-7">
              {tag}
              <button type="button" onClick={() => setTag("")} aria-label="Clear">
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        ) : (
          <TagInput onPick={setTag} placeholder={mode === "add" ? "Tag to add (new or existing)" : "Tag to remove"} />
        )}
        <p className="text-[12px] text-muted-foreground">
          Applies to all {count.toLocaleString("en-CA")} contact{count === 1 ? "" : "s"} in the list right now.
          {mode === "add" && " Automations that start when this tag is added will start for them."}
        </p>
        <Button
          className="rounded-sm font-display tracking-[0.14em] text-[11px]"
          disabled={!tag.trim() || run.isPending}
          onClick={() => run.mutate()}
          data-testid="button-bulk-tag"
        >
          {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === "add" ? `TAG ${count.toLocaleString("en-CA")}` : `UNTAG ${count.toLocaleString("en-CA")}`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
