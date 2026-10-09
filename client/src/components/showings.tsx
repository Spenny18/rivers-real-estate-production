// Showings on /admin/calendar: the "New showing" dialog (MLS number + client
// → calendar invite) and the row each showing renders as. Server side is
// server/showings.ts and server/showing-routes.ts.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Clock, Loader2, Mail, MapPin, RotateCw, Send, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { CrmContactLite } from "@/lib/esign-types";
import { showingStreetLine } from "@shared/showing-address";

export interface ShowingListing {
  source: "mls" | "managed" | "unknown";
  mlsNumber: string | null;
  address: string;
  summary: string | null;
  price: number | null;
  url: string | null;
  photoUrl: string | null;
  status?: string | null;
}

export interface ShowingView {
  id: number;
  listingId: string;
  leadId: number | null;
  scheduledFor: string;
  endsAt: string;
  status: string;
  notes: string | null;
  durationMinutes: number;
  notifyClient: boolean;
  contactFubId: string | null;
  googleEventId: string | null;
  inviteChannel: "google" | "email" | null;
  invitedAt: string | null;
  inviteError: string | null;
  listing: ShowingListing;
  client: { name: string; email: string | null; phone: string | null } | null;
}

export interface FubAppointment {
  uid: string;
  title: string | null;
  body: string | null;
  startsAt: string;
  endsAt: string;
  contactName: string | null;
}

interface Delivery {
  calendar: "synced" | "removed" | "not-connected" | "failed";
  client: "invited" | "updated" | "cancelled" | "not-sent" | "failed";
  channel: "google" | "email" | null;
  error?: string;
}

export const SHOWING_STATUS_STYLES: Record<string, string> = {
  requested: "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900",
  confirmed: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-900",
  completed: "bg-secondary text-secondary-foreground border-border",
  cancelled: "bg-secondary/40 text-muted-foreground border-border line-through",
};

/** What happened, in a sentence, for the toast after any change. */
export function describeDelivery(d: Delivery | null | undefined, clientName?: string | null): { title: string; description?: string; failed: boolean } {
  if (!d) return { title: "Saved", failed: false };
  const who = clientName?.split(" ")[0] || "The client";
  const via = d.channel === "google" ? "through Google Calendar" : "by email with a calendar file";
  const clientLine =
    d.client === "invited"
      ? `${who} has been sent an invite ${via}.`
      : d.client === "updated"
        ? `${who} has been sent the new time ${via}.`
        : d.client === "cancelled"
          ? `${who} has been told it's cancelled.`
          : d.client === "failed"
            ? `${who} couldn't be notified: ${d.error ?? "unknown error"}`
            : undefined;
  const calendarLine =
    d.calendar === "failed"
      ? `Your Google Calendar wasn't updated: ${d.error ?? "unknown error"}`
      : d.calendar === "not-connected"
        ? "Google Calendar isn't connected, so it's only on this calendar."
        : undefined;
  const failed = d.client === "failed" || d.calendar === "failed";
  return {
    title: failed ? "Saved, with a problem" : "Saved",
    description: [clientLine, calendarLine].filter(Boolean).join(" ") || undefined,
    failed,
  };
}

/** "2026-10-09T14:30" in the browser's zone, for <input type="datetime-local">. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultStart(day?: Date): string {
  const d = day ? new Date(day) : new Date();
  if (!day || d.toDateString() === new Date().toDateString()) {
    // Next whole hour from now.
    const now = new Date();
    d.setHours(now.getHours() + 1, 0, 0, 0);
  } else d.setHours(10, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const DURATIONS = [30, 45, 60, 90];

function invalidateShowings(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["/api/admin/showings"] });
  qc.invalidateQueries({ queryKey: ["/api/tours"] });
}

// ---- New showing ---------------------------------------------------------------

export function NewShowingDialog({
  open,
  onOpenChange,
  day,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  day?: Date;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [propertyQuery, setPropertyQuery] = useState("");
  const [picked, setPicked] = useState<ShowingListing | null>(null);
  const [startsAt, setStartsAt] = useState(() => defaultStart(day));
  const [duration, setDuration] = useState(60);
  const [contactQuery, setContactQuery] = useState("");
  const [contact, setContact] = useState<CrmContactLite | null>(null);
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [notify, setNotify] = useState(true);

  useEffect(() => {
    if (open) setStartsAt(defaultStart(day));
  }, [open, day]);

  const reset = () => {
    setPropertyQuery("");
    setPicked(null);
    setDuration(60);
    setContactQuery("");
    setContact(null);
    setManual(false);
    setName("");
    setEmail("");
    setPhone("");
    setNotes("");
    setNotify(true);
  };

  // One field for both: something shaped like an MLS number is looked up
  // exactly; anything else searches addresses.
  const typed = useDebounced(propertyQuery.trim(), 300);
  const looksLikeMls = /^[a-z]\d{5,}$/i.test(typed);
  const mlsLookup = useQuery<ShowingListing>({
    queryKey: [`/api/admin/showings/listing?mls=${encodeURIComponent(typed.toUpperCase())}`],
    enabled: !picked && looksLikeMls,
    retry: false,
  });
  const addressSearch = useQuery<ShowingListing[]>({
    queryKey: [`/api/admin/showings/listing-search?q=${encodeURIComponent(typed)}`],
    enabled: !picked && !looksLikeMls && typed.length >= 3,
  });
  const propertyMatches: ShowingListing[] = looksLikeMls ? (mlsLookup.data ? [mlsLookup.data] : []) : addressSearch.data ?? [];
  const searchingProperty = looksLikeMls ? mlsLookup.isFetching : addressSearch.isFetching;
  const listing = picked;

  const q = useDebounced(contactQuery.trim(), 250);
  const { data: matches = [], isFetching: searching } = useQuery<CrmContactLite[]>({
    queryKey: [`/api/admin/crm/contacts?q=${encodeURIComponent(q)}&limit=8`],
    enabled: !contact && !manual && q.length >= 2,
  });

  const { data: status } = useQuery<{ google: boolean; email: boolean; canInvite: boolean }>({
    queryKey: ["/api/admin/showings/status"],
    enabled: open,
  });

  const clientEmail = manual ? email.trim() : contact?.email ?? "";
  const hasClient = manual ? !!name.trim() : !!contact;

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/showings", {
        mlsNumber: picked?.mlsNumber ?? "",
        startsAt: new Date(startsAt).toISOString(),
        durationMinutes: duration,
        contactFubId: manual ? null : contact?.fubId ?? null,
        clientName: manual ? name.trim() : null,
        clientEmail: manual ? email.trim() || null : null,
        clientPhone: manual ? phone.trim() || null : null,
        notes: notes.trim() || null,
        notifyClient: notify,
      });
      return (await res.json()) as { showing: ShowingView; delivery: Delivery };
    },
    onSuccess: ({ showing, delivery }) => {
      invalidateShowings(qc);
      const m = describeDelivery(delivery, showing.client?.name);
      toast({ title: m.failed ? m.title : "Showing booked", description: m.description, variant: m.failed ? "destructive" : undefined });
      reset();
      onOpenChange(false);
    },
    onError: (e: any) => toast({ title: "Couldn't book the showing", description: e?.message ?? "Try again.", variant: "destructive" }),
  });

  const canSubmit =
    !!listing && hasClient && !!startsAt && !create.isPending && (!notify || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">New showing</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          {/* Property */}
          <div>
            <label className="eyebrow text-muted-foreground block mb-1.5">Property</label>
            {listing ? (
              <div className="flex gap-3 rounded-sm border border-border p-2.5" data-testid="showing-listing-preview">
                {listing.photoUrl && (
                  <img src={listing.photoUrl} alt="" className="w-24 h-16 object-cover rounded-sm shrink-0 bg-secondary" />
                )}
                <div className="min-w-0 flex-1 text-[13px]">
                  <div className="font-medium truncate">{listing.address}</div>
                  <div className="text-muted-foreground">
                    {[listing.summary, listing.mlsNumber && `MLS® ${listing.mlsNumber}`].filter(Boolean).join(" · ")}
                  </div>
                  {listing.status && listing.status !== "Active" && (
                    <div className="text-amber-700 dark:text-amber-400 text-[12px]">Listing status: {listing.status}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  aria-label="Change property"
                  className="self-start text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div>
                <Input
                  value={propertyQuery}
                  onChange={(e) => setPropertyQuery(e.target.value)}
                  placeholder="Address or MLS® number, e.g. 38 Lissington Dr SW"
                  autoFocus
                  className="rounded-sm"
                  data-testid="input-showing-property"
                />
                {typed.length >= 3 && (
                  <div className="mt-1.5 rounded-sm border border-border divide-y divide-border max-h-72 overflow-y-auto">
                    {searchingProperty && propertyMatches.length === 0 ? (
                      <div className="px-3 py-2 text-[12px] text-muted-foreground flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" /> Searching listings…
                      </div>
                    ) : propertyMatches.length === 0 ? (
                      <div className="px-3 py-2 text-[12px] text-muted-foreground">
                        {looksLikeMls ? `No listing found for MLS® ${typed.toUpperCase()}.` : "No listings match that address."}
                      </div>
                    ) : (
                      propertyMatches.map((m) => (
                        <button
                          key={m.mlsNumber ?? m.address}
                          type="button"
                          onClick={() => setPicked(m)}
                          className="w-full text-left px-3 py-2 hover:bg-secondary/50 flex items-center gap-3"
                          data-testid={`showing-property-${m.mlsNumber}`}
                        >
                          {m.photoUrl ? (
                            <img src={m.photoUrl} alt="" className="w-14 h-10 object-cover rounded-sm shrink-0 bg-secondary" loading="lazy" />
                          ) : (
                            <div className="w-14 h-10 rounded-sm bg-secondary shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="text-[13px] truncate">{m.address}</div>
                            <div className="text-[12px] text-muted-foreground truncate">
                              {[m.summary, m.mlsNumber && `MLS® ${m.mlsNumber}`].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* When */}
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div>
              <label className="eyebrow text-muted-foreground block mb-1.5">Date &amp; time</label>
              <Input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="rounded-sm"
                data-testid="input-showing-start"
              />
            </div>
            <div>
              <label className="eyebrow text-muted-foreground block mb-1.5">Length</label>
              <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                <SelectTrigger className="rounded-sm w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Client */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="eyebrow text-muted-foreground">Client</label>
              <button
                type="button"
                onClick={() => {
                  setManual(!manual);
                  setContact(null);
                }}
                className="text-[12px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
              >
                {manual ? "Pick from CRM instead" : "Not in the CRM? Enter details"}
              </button>
            </div>
            {manual ? (
              <div className="grid gap-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="rounded-sm" />
                <div className="grid grid-cols-2 gap-2">
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" className="rounded-sm" />
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" className="rounded-sm" />
                </div>
              </div>
            ) : contact ? (
              <div className="flex items-center justify-between gap-3 rounded-sm border border-border px-3 py-2">
                <div className="min-w-0 text-[13px]">
                  <div className="font-medium truncate">{contact.name ?? contact.email}</div>
                  <div className="text-muted-foreground truncate">
                    {[contact.email, contact.phone].filter(Boolean).join(" · ") || "No contact details"}
                  </div>
                </div>
                <button type="button" onClick={() => setContact(null)} aria-label="Change client" className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div>
                <Input
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                  placeholder="Search name, email or phone…"
                  className="rounded-sm"
                  data-testid="input-showing-client"
                />
                {q.length >= 2 && (
                  <div className="mt-1.5 rounded-sm border border-border divide-y divide-border max-h-56 overflow-y-auto">
                    {searching && matches.length === 0 ? (
                      <div className="px-3 py-2 text-[12px] text-muted-foreground">Searching…</div>
                    ) : matches.length === 0 ? (
                      <div className="px-3 py-2 text-[12px] text-muted-foreground">No matches. Enter their details instead.</div>
                    ) : (
                      matches.map((c) => (
                        <button
                          key={c.fubId}
                          type="button"
                          onClick={() => setContact(c)}
                          className="w-full text-left px-3 py-2 hover:bg-secondary/50"
                        >
                          <div className="text-[13px]">{c.name ?? c.email}</div>
                          <div className="text-[12px] text-muted-foreground truncate">
                            {[c.email, c.phone].filter(Boolean).join(" · ")}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Note */}
          <div>
            <label className="eyebrow text-muted-foreground block mb-1.5">Note (included in the invite)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="e.g. Meet out front — I'll have the lockbox code."
              className="w-full text-[14px] leading-relaxed rounded-sm border border-border bg-transparent p-3 resize-y"
            />
          </div>

          {/* Invite */}
          <label className="flex items-start gap-2.5 cursor-pointer">
            <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} className="mt-0.5" />
            <span className="text-[13px] leading-relaxed">
              Send the client a calendar invite
              <span className="block text-[12px] text-muted-foreground">
                {status?.google
                  ? "Sent from your Google Calendar. They can accept it, and changes here update their calendar."
                  : status?.email
                    ? "Google Calendar isn't connected, so it goes by email with a calendar file attached."
                    : "Neither Google Calendar nor email sending is set up, so no invite can be sent."}
                {notify && !hasClient ? "" : notify && !clientEmail ? " This client has no email address." : ""}
              </span>
            </span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={() => create.mutate()}
              disabled={!canSubmit}
              className="rounded-sm font-display text-[11px] tracking-[0.16em]"
              data-testid="button-create-showing"
            >
              {create.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> BOOKING…
                </>
              ) : (
                <>
                  <CalendarCheck className="h-3.5 w-3.5 mr-2" /> {notify ? "BOOK & SEND INVITE" : "BOOK SHOWING"}
                </>
              )}
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)} className="rounded-sm text-[11px]">
              CANCEL
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- One showing -----------------------------------------------------------------

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}

function inviteLabel(s: ShowingView): { text: string; tone: "ok" | "warn" | "mute" } | null {
  if (s.inviteError) return { text: "Invite problem", tone: "warn" };
  if (s.inviteChannel) return { text: s.inviteChannel === "google" ? "Invited · Google" : "Invited · email", tone: "ok" };
  if (s.status === "confirmed" && s.notifyClient && s.client?.email) return { text: "Not invited", tone: "warn" };
  if (s.status === "requested") return { text: "Awaiting your confirmation", tone: "mute" };
  return null;
}

export function ShowingRow({ showing }: { showing: ShowingView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [startsAt, setStartsAt] = useState(() => toLocalInput(showing.scheduledFor));
  const [duration, setDuration] = useState(showing.durationMinutes || 60);

  const onDone = (r: { showing: ShowingView; delivery: Delivery }) => {
    invalidateShowings(qc);
    const m = describeDelivery(r.delivery, r.showing.client?.name);
    toast({ title: m.title, description: m.description, variant: m.failed ? "destructive" : undefined });
  };
  const onFail = (e: any) => toast({ title: "Couldn't update the showing", description: e?.message ?? "Try again.", variant: "destructive" });

  const update = useMutation({
    mutationFn: async (body: Record<string, unknown>) => (await apiRequest("PATCH", `/api/admin/showings/${showing.id}`, body)).json(),
    onSuccess: (r) => {
      setEditing(false);
      onDone(r);
    },
    onError: onFail,
  });
  const resend = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/showings/${showing.id}/resend`)).json(),
    onSuccess: onDone,
    onError: onFail,
  });

  const label = inviteLabel(showing);
  const busy = update.isPending || resend.isPending;

  return (
    <Card data-testid={`showing-${showing.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground mb-1">
              <Clock className="w-3 h-3" strokeWidth={1.6} />
              {formatTime(showing.scheduledFor)}–{formatTime(showing.endsAt)}
              <Badge
                variant="outline"
                className={`rounded-sm font-display tracking-[0.1em] text-[9px] uppercase border ${
                  SHOWING_STATUS_STYLES[showing.status] ?? SHOWING_STATUS_STYLES.requested
                }`}
              >
                {showing.status}
              </Badge>
            </div>
            <div className="font-serif text-base truncate" style={{ letterSpacing: "-0.01em" }}>
              {showing.listing.url ? (
                <a href={showing.listing.url} target="_blank" rel="noreferrer" className="hover:underline underline-offset-2">
                  {showingStreetLine(showing.listing.address)}
                </a>
              ) : (
                showingStreetLine(showing.listing.address)
              )}
            </div>
            <div className="text-xs text-muted-foreground flex items-center gap-1 truncate mt-0.5">
              <MapPin className="w-3 h-3 shrink-0" strokeWidth={1.6} />
              {[showing.listing.summary, showing.listing.mlsNumber && `MLS® ${showing.listing.mlsNumber}`].filter(Boolean).join(" · ") ||
                showing.listing.address}
            </div>
            {showing.client && (
              <div className="text-xs text-muted-foreground flex items-center gap-1 truncate mt-0.5">
                <User className="w-3 h-3 shrink-0" strokeWidth={1.6} />
                {showing.client.name}
                {showing.client.phone && ` · ${showing.client.phone}`}
              </div>
            )}
            {label && (
              <div
                className={`text-[11.5px] flex items-center gap-1 mt-1 ${
                  label.tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : label.tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
                }`}
                title={showing.inviteError ?? undefined}
              >
                <Mail className="w-3 h-3" strokeWidth={1.6} />
                {label.text}
              </div>
            )}
            {showing.notes && (
              <div className="text-xs text-foreground/80 mt-2 bg-secondary/40 rounded-sm px-2 py-1.5 italic">"{showing.notes}"</div>
            )}
          </div>
          <Select value={showing.status} onValueChange={(status) => update.mutate({ status })} disabled={busy}>
            <SelectTrigger className="h-8 w-[120px] rounded-sm text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="requested">Requested</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {showing.status !== "cancelled" && showing.status !== "completed" && (
          <div className="mt-3 pt-3 border-t border-border">
            {editing ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="h-8 rounded-sm w-auto text-xs" />
                <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                  <SelectTrigger className="h-8 w-[92px] rounded-sm text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d} min
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-8 rounded-sm text-[11px]"
                  disabled={busy}
                  onClick={() => update.mutate({ startsAt: new Date(startsAt).toISOString(), durationMinutes: duration })}
                >
                  {update.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                </Button>
                <Button size="sm" variant="ghost" className="h-8 rounded-sm text-[11px]" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" className="h-7 rounded-sm text-[11px]" onClick={() => setEditing(true)} disabled={busy}>
                  <RotateCw className="h-3 w-3 mr-1.5" /> Reschedule
                </Button>
                {showing.status === "confirmed" && showing.client?.email && showing.notifyClient && (
                  <Button size="sm" variant="outline" className="h-7 rounded-sm text-[11px]" onClick={() => resend.mutate()} disabled={busy}>
                    {resend.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : <Send className="h-3 w-3 mr-1.5" />}
                    {showing.inviteChannel ? "Resend invite" : "Send invite"}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** A Follow Up Boss appointment on the calendar: read-only, clearly marked. */
export function FubAppointmentRow({ appt }: { appt: FubAppointment }) {
  return (
    <Card className="border-dashed">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <Clock className="w-3 h-3" strokeWidth={1.6} />
          {formatTime(appt.startsAt)}–{formatTime(appt.endsAt)}
          <Badge variant="outline" className="rounded-sm font-display tracking-[0.1em] text-[9px] uppercase">
            Follow Up Boss
          </Badge>
        </div>
        <div className="font-serif text-base truncate">{appt.title ?? "Appointment"}</div>
        {appt.contactName && (
          <div className="text-xs text-muted-foreground flex items-center gap-1 truncate mt-0.5">
            <User className="w-3 h-3" strokeWidth={1.6} />
            {appt.contactName}
          </div>
        )}
        {appt.body && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{appt.body}</div>}
        <div className="text-[11px] text-muted-foreground mt-2">Read-only — edit in Follow Up Boss.</div>
      </CardContent>
    </Card>
  );
}
