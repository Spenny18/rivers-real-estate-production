// Creating and editing contacts the app owns (server/contacts.ts), used on
// /admin/crm. Follow Up Boss contacts stay read-only here — the hourly sync
// would undo any change.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiUrl, getAuthToken } from "@/lib/queryClient";

export const CONTACT_STAGES = ["Lead", "Hot", "Nurture", "Active client", "Under contract", "Closed", "Past client", "Sphere", "Trash"];

export interface ContactFormValues {
  name: string;
  email: string;
  phone: string;
  stage: string;
  source: string;
  tags: string;
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** fetch rather than apiRequest: a 409 carries the duplicate's id, which is the useful part. */
async function send(method: "POST" | "PATCH", url: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const token = getAuthToken();
  const r = await fetch(apiUrl(url), {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

function Fields({ v, set, withNote, note, setNote }: { v: ContactFormValues; set: (p: Partial<ContactFormValues>) => void; withNote?: boolean; note?: string; setNote?: (s: string) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <label className="eyebrow text-muted-foreground block mb-1">Name</label>
        <Input value={v.name} onChange={(e) => set({ name: e.target.value })} className="rounded-sm" autoFocus data-testid="input-contact-name" />
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="eyebrow text-muted-foreground block mb-1">Email</label>
          <Input value={v.email} onChange={(e) => set({ email: e.target.value })} type="email" className="rounded-sm" data-testid="input-contact-email" />
        </div>
        <div>
          <label className="eyebrow text-muted-foreground block mb-1">Phone</label>
          <Input value={v.phone} onChange={(e) => set({ phone: e.target.value })} className="rounded-sm" data-testid="input-contact-phone" />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="eyebrow text-muted-foreground block mb-1">Stage</label>
          <select
            value={v.stage}
            onChange={(e) => set({ stage: e.target.value })}
            className="w-full h-9 rounded-sm border border-border bg-transparent px-2 text-[14px]"
          >
            {Array.from(new Set([...CONTACT_STAGES, v.stage].filter(Boolean))).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="eyebrow text-muted-foreground block mb-1">Source</label>
          <Input value={v.source} onChange={(e) => set({ source: e.target.value })} placeholder="e.g. Referral — Jane Smith" className="rounded-sm" />
        </div>
      </div>
      <div>
        <label className="eyebrow text-muted-foreground block mb-1">Tags (comma separated)</label>
        <Input value={v.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="Buyer, Aspen Woods" className="rounded-sm" />
      </div>
      {withNote && (
        <div>
          <label className="eyebrow text-muted-foreground block mb-1">Note (optional)</label>
          <textarea
            value={note}
            onChange={(e) => setNote?.(e.target.value)}
            rows={3}
            className="w-full text-[14px] rounded-sm border border-border bg-transparent p-2.5 resize-y"
          />
        </div>
      )}
    </div>
  );
}

const EMPTY: ContactFormValues = { name: "", email: "", phone: "", stage: "Lead", source: "", tags: "" };

export function NewContactDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Called with the new contact's id — or an existing one's, when it was a duplicate. */
  onCreated: (fubId: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [v, setV] = useState<ContactFormValues>(EMPTY);
  const [note, setNote] = useState("");
  const [duplicate, setDuplicate] = useState<{ fubId: string; message: string } | null>(null);
  useEffect(() => {
    if (open) {
      setV(EMPTY);
      setNote("");
      setDuplicate(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      send("POST", "/api/admin/crm/contacts", {
        name: v.name,
        email: v.email || null,
        phone: v.phone || null,
        stage: v.stage,
        source: v.source || null,
        tags: parseTags(v.tags),
        note: note || null,
      }),
    onSuccess: (r) => {
      if (r.status === 409) return setDuplicate({ fubId: r.data.fubId, message: r.data.message });
      if (!r.ok) return toast({ title: "Couldn't add the contact", description: r.data?.message ?? "Try again.", variant: "destructive" });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/crm") });
      toast({ title: "Contact added" });
      onOpenChange(false);
      onCreated(r.data.fubId);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">New contact</DialogTitle>
        </DialogHeader>
        <Fields v={v} set={(p) => setV({ ...v, ...p })} withNote note={note} setNote={setNote} />
        {duplicate && (
          <div className="text-[13px] rounded-sm border border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-900 px-3 py-2 flex items-center justify-between gap-3">
            <span>{duplicate.message}</span>
            <Button
              size="sm"
              variant="outline"
              className="rounded-sm h-7 text-[11px] shrink-0"
              onClick={() => {
                onOpenChange(false);
                onCreated(duplicate.fubId);
              }}
            >
              Open it
            </Button>
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => create.mutate()}
            disabled={!v.name.trim() || (!v.email.trim() && !v.phone.trim()) || create.isPending}
            className="rounded-sm font-display text-[11px] tracking-[0.16em]"
            data-testid="button-create-contact"
          >
            {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "ADD CONTACT"}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="rounded-sm text-[11px]">
            CANCEL
          </Button>
          {!v.email.trim() && !v.phone.trim() && <span className="text-[12px] text-muted-foreground self-center">Needs an email or a phone number.</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function EditContactForm({
  contact,
  onDone,
}: {
  contact: { fubId: string; name: string | null; email: string | null; phone: string | null; stage: string | null; source: string | null; tags?: string | string[] | null };
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const tags = Array.isArray(contact.tags)
    ? contact.tags
    : (() => {
        try {
          return JSON.parse(contact.tags ?? "[]") as string[];
        } catch {
          return [];
        }
      })();
  const [v, setV] = useState<ContactFormValues>({
    name: contact.name ?? "",
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    stage: contact.stage ?? "Lead",
    source: contact.source ?? "",
    tags: tags.join(", "),
  });
  const save = useMutation({
    mutationFn: () =>
      send("PATCH", `/api/admin/crm/contacts/${encodeURIComponent(contact.fubId)}`, {
        name: v.name,
        email: v.email || null,
        phone: v.phone || null,
        stage: v.stage,
        source: v.source || null,
        tags: parseTags(v.tags),
      }),
    onSuccess: (r) => {
      if (!r.ok) return toast({ title: "Couldn't save", description: r.data?.message ?? "Try again.", variant: "destructive" });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/crm") || String(q.queryKey[0]).startsWith("/api/admin/inbox") });
      onDone();
    },
  });
  return (
    <div className="rounded-sm border border-border p-3.5 space-y-3">
      <Fields v={v} set={(p) => setV({ ...v, ...p })} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={!v.name.trim() || save.isPending} className="rounded-sm text-[11px]">
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "SAVE"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} className="rounded-sm text-[11px]">
          CANCEL
        </Button>
      </div>
    </div>
  );
}
