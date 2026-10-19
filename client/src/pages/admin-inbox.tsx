// /admin/inbox — every conversation with a contact in one place: emails (from
// Gmail), texts, calls and notes in a single thread, a reply box for email or
// text, and what they've been doing alongside. Server: server/inbox.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowLeft,
  Calendar,
  Eye,
  FileText,
  Heart,
  Home,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  MousePointerClick,
  Phone,
  PhoneOutgoing,
  Play,
  Image as ImageIcon,
  Search,
  Send,
  StickyNote,
  UserCheck,
  Briefcase,
  Plus,
  ExternalLink,
  Copy,
  Check,
  ListChecks,
  Pencil,
  FileStack,
  BookmarkPlus,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { showingStreetLine } from "@shared/showing-address";
import { formatEmailText } from "@/lib/email-text";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ListingSearch } from "@/components/listing-picker";
import { MergeFieldPicker, CustomFieldsDialog, insertAtCursor } from "@/components/merge-field-picker";
import type { MessageTemplate } from "@/pages/admin-templates";
import { TemplatePicker } from "@/components/template-picker";
import { AttachButton, AttachmentChips, useAttachments } from "@/components/email-attachments";

// ---- Types (mirror server/inbox.ts) ------------------------------------------------

interface Conversation {
  contactFubId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  lastAt: string;
  lastKind: string;
  lastDirection: string | null;
  lastPreview: string | null;
  unread: boolean;
}

interface ThreadItem {
  id: string;
  kind: "email" | "text" | "call" | "note" | "appointment" | "inquiry";
  direction: "inbound" | "outbound" | null;
  at: string;
  subject: string | null;
  body: string | null;
  meta: Record<string, any>;
}

interface ActivityEvent {
  id: number;
  kind: string;
  path: string | null;
  title: string | null;
  props: any;
  occurredAt: string;
}

interface Listing {
  mlsNumber: string | null;
  address: string;
  summary: string | null;
  url: string | null;
  photoUrl: string | null;
}

/**
 * A listing as it goes into a text or email: the address and its one-line
 * summary, then the link on its own line (clients and phones make it tappable;
 * in emails it's a tracked link).
 */
function listingSnippet(l: Listing): string {
  const line = [l.address, l.summary].filter(Boolean).join(" · ");
  return l.url ? `${line}\n${l.url}` : line;
}

interface ContactData {
  contact: {
    fubId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    stage: string | null;
    source: string | null;
    tags: string | null;
  };
  thread: ThreadItem[];
  replySubject: string | null;
  fubTexts: { ok: boolean; error?: string };
  panel: {
    engagement: {
      summary: {
        visits: number;
        listingViews: number;
        lastSeenAt: string | null;
        emailsSent: number;
        emailsOpened: number;
        emailsClicked: number;
        topNeighbourhoods: Array<{ name: string; count: number }>;
      };
      events: ActivityEvent[];
    } | null;
    favorites: Array<Listing & { savedAt: string }>;
    /** Every listing they're connected to: saved, viewed, shown, dealt on, enquired about. */
    properties?: Array<Listing & { reasons: string[]; lastAt: string }>;
    savedSearches: Array<{ id: number; name: string; frequency: string; active: boolean; createdAt: string }>;
    inquiries: Array<{ id: number; source: string; message: string; createdAt: string }>;
    showings: Array<{ id: number; scheduledFor: string; status: string; listing: Listing }>;
    transactions: {
      fub: Array<{ fubId: string; name: string | null; value: number | null; stageName: string | null; status: string | null }>;
      app: Array<{ id: number; title: string; address: string | null; kind: string; status: string }>;
    };
  };
}

interface InboxStatus {
  gmail: { ok: boolean; reason: string | null; lastSync: { ok: boolean; at: string; error?: string } | null };
  canEmail: { ok: boolean; reason?: string };
  canText: { ok: boolean; missing: string[] };
}

// ---- Formatting ------------------------------------------------------------------------

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function initials(name: string | null, email: string | null): string {
  const src = (name || email || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function money(n: number | null | undefined): string {
  if (!n) return "";
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;
}

const KIND_ICON: Record<string, typeof Mail> = { email: Mail, text: MessageSquare, call: Phone, note: StickyNote, appointment: Calendar, inquiry: FileText };

// ---- Page ------------------------------------------------------------------------------

type Filter = "all" | "unread" | "text" | "email" | "call";

export default function AdminInboxPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("contact"),
  );

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: conversations = [], isLoading } = useQuery<Conversation[]>({
    queryKey: [`/api/admin/inbox/conversations?filter=${filter}${q ? `&q=${encodeURIComponent(q)}` : ""}`],
    refetchInterval: 60_000,
  });
  const { data: status } = useQuery<InboxStatus>({ queryKey: ["/api/admin/inbox/status"] });
  // Everyone else who matches the search — contacts with no messages yet —
  // so a conversation can be started with anyone in the CRM.
  const { data: contactMatches = [] } = useQuery<Array<{ fubId: string; name: string | null; email: string | null; phone: string | null }>>({
    queryKey: [`/api/admin/crm/contacts?q=${encodeURIComponent(q)}&limit=25`],
    enabled: q.length >= 2,
  });
  const inList = new Set(conversations.map((c) => c.contactFubId));
  const others = q.length >= 2 ? contactMatches.filter((c) => !inList.has(c.fubId)).slice(0, 15) : [];
  const searchBox = useRef<HTMLInputElement>(null);
  const open = (fubId: string) => {
    setSelected(fubId);
    window.history.replaceState(null, "", `/admin/inbox?contact=${encodeURIComponent(fubId)}`);
  };

  return (
    <AppShell pageTitle="Inbox">
      <div className="h-[calc(100vh-64px)] flex flex-col">
        {status && !status.gmail.ok && (
          <div className="px-5 py-2 text-[12.5px] bg-amber-50 text-amber-900 border-b border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900">
            Emails aren't syncing: {status.gmail.reason}
          </div>
        )}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[320px_1fr] xl:grid-cols-[320px_1fr_340px]">
          {/* Conversation list */}
          <aside className={`border-r border-border min-h-0 flex flex-col ${selected ? "hidden md:flex" : "flex"}`}>
            <div className="p-3 border-b border-border space-y-2">
              <div className="flex gap-1.5">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    ref={searchBox}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search any contact"
                    className="pl-8 h-9 rounded-sm text-[13px]"
                    data-testid="input-inbox-search"
                  />
                </div>
                <Button
                  variant="outline"
                  className="h-9 rounded-sm px-2.5 text-[12px]"
                  onClick={() => {
                    setFilter("all");
                    searchBox.current?.focus();
                  }}
                  title="Start a text or email with any contact: search for them"
                  data-testid="inbox-new-message"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> New
                </Button>
              </div>
              <div className="flex gap-1">
                {(["all", "unread", "text", "email", "call"] as Filter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-2.5 py-1 rounded-sm text-[11.5px] capitalize ${
                      filter === f ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary"
                    }`}
                  >
                    {f === "text" ? "Texts" : f === "email" ? "Emails" : f === "call" ? "Calls" : f}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto" data-testid="inbox-conversations">
              {isLoading ? (
                <div className="p-4 text-[13px] text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              ) : conversations.length === 0 && others.length === 0 ? (
                <div className="p-4 text-[13px] text-muted-foreground">
                  {filter === "unread" ? "You're all caught up." : q ? "No contacts match." : "No conversations yet."}
                </div>
              ) : (
                conversations.map((c) => {
                  const Icon = KIND_ICON[c.lastKind] ?? Mail;
                  return (
                    <button
                      key={c.contactFubId}
                      onClick={() => open(c.contactFubId)}
                      className={`w-full text-left px-3 py-2.5 border-b border-border flex gap-2.5 ${
                        selected === c.contactFubId ? "bg-secondary" : "hover:bg-secondary/50"
                      }`}
                      data-testid={`conversation-${c.contactFubId}`}
                    >
                      <div className="h-9 w-9 shrink-0 rounded-full bg-secondary flex items-center justify-center text-[11px] font-medium">
                        {initials(c.name, c.email)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={`text-[13.5px] truncate ${c.unread ? "font-semibold" : ""}`}>{c.name || c.email || c.phone}</span>
                          <span className="text-[11px] text-muted-foreground shrink-0">{ago(c.lastAt)}</span>
                        </div>
                        <div className={`text-[12px] flex items-center gap-1.5 min-w-0 ${c.unread ? "text-foreground" : "text-muted-foreground"}`}>
                          <Icon className="h-3 w-3 shrink-0" strokeWidth={1.6} />
                          <span className="truncate">
                            {c.lastDirection === "outbound" ? "You: " : ""}
                            {c.lastPreview}
                          </span>
                          {c.unread && <span className="h-2 w-2 rounded-full bg-emerald-600 shrink-0 ml-auto" aria-label="Unread" />}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
              {others.length > 0 && (
                <div data-testid="inbox-other-contacts">
                  <div className="px-3 pt-3 pb-1 text-[10px] tracking-[0.14em] uppercase text-muted-foreground">
                    No messages yet: start one
                  </div>
                  {others.map((c) => (
                    <button
                      key={c.fubId}
                      onClick={() => open(c.fubId)}
                      className={`w-full text-left px-3 py-2 border-b border-border flex gap-2.5 items-center ${
                        selected === c.fubId ? "bg-secondary" : "hover:bg-secondary/50"
                      }`}
                      data-testid={`contact-${c.fubId}`}
                    >
                      <div className="h-8 w-8 shrink-0 rounded-full border border-dashed border-border flex items-center justify-center text-[11px]">
                        {initials(c.name, c.email)}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] truncate">{c.name || c.email || c.phone}</div>
                        <div className="text-[11.5px] text-muted-foreground truncate">{[c.phone, c.email].filter(Boolean).join(" · ")}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>

          {/* Thread + panel */}
          {selected ? (
            <Conversation key={selected} fubId={selected} status={status} onBack={() => setSelected(null)} />
          ) : (
            <div className="hidden md:flex items-center justify-center text-[13px] text-muted-foreground xl:col-span-2">
              Pick a conversation.
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ---- One conversation ---------------------------------------------------------------------

function Conversation({ fubId, status, onBack }: { fubId: string; status?: InboxStatus; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showActivity, setShowActivity] = useState(true);
  const { data, isLoading } = useQuery<ContactData>({
    queryKey: [`/api/admin/inbox/contact/${fubId}`],
    refetchInterval: 60_000,
  });

  // Opening marks it read; refresh the list and the nav badge.
  useEffect(() => {
    if (data) {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/inbox/conversations") });
      qc.invalidateQueries({ queryKey: ["/api/admin/inbox/unread"] });
    }
  }, [data?.contact.fubId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Activity interleaved with the messages, as small system lines.
  const items = useMemo(() => {
    if (!data) return [];
    const msgs = data.thread.map((t) => ({ type: "msg" as const, at: t.at, item: t }));
    const acts =
      showActivity && data.panel.engagement
        ? data.panel.engagement.events
            .filter((e) => ["listing_view", "email_open", "email_click", "identify"].includes(e.kind))
            .map((e) => ({ type: "act" as const, at: e.occurredAt, event: e }))
        : [];
    return [...msgs, ...acts].sort((a, b) => a.at.localeCompare(b.at));
  }, [data, showActivity]);

  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items.length]);

  // The panel's "Insert" buttons write into the composer.
  const insertListing = useRef<((l: Listing) => void) | null>(null);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center text-[13px] text-muted-foreground xl:col-span-2">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading conversation…
      </div>
    );
  }
  const c = data.contact;

  return (
    <>
      <section className="min-h-0 flex flex-col">
        <header className="px-4 py-3 border-b border-border flex items-center gap-3">
          <button onClick={onBack} className="md:hidden text-muted-foreground" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="font-serif text-lg truncate">{c.name || c.email}</div>
            <div className="text-[12px] text-muted-foreground truncate">
              {[c.email, c.phone, c.stage].filter(Boolean).join(" · ")}
            </div>
          </div>
          <label className="hidden sm:flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={showActivity} onChange={(e) => setShowActivity(e.target.checked)} />
            Show activity
          </label>
          {c.phone && <CallButton contactFubId={c.fubId} name={c.name || c.phone} ready={!!status?.canText.ok} />}
          <Link href={`/admin/crm?contact=${encodeURIComponent(c.fubId)}`} className="text-[12px] underline underline-offset-2 text-muted-foreground hover:text-foreground">
            CRM
          </Link>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-secondary/20" data-testid="inbox-thread">
          {!data.fubTexts.ok && (
            <div className="text-[12px] text-muted-foreground border-l-2 border-border pl-3">
              Couldn't fetch this contact's Follow Up Boss texts just now. {data.fubTexts.error}
            </div>
          )}
          {items.length === 0 && <div className="text-[13px] text-muted-foreground">No messages yet. Start the conversation below.</div>}
          {items.map((x) => (x.type === "msg" ? <Message key={x.item.id} item={x.item} /> : <ActivityLine key={`a${x.event.id}`} event={x.event} />))}
          <div ref={bottom} />
        </div>

        <Composer
          contact={c}
          status={status}
          defaultSubject={data.replySubject}
          insertRef={insertListing}
          onSent={() => {
            qc.invalidateQueries({ queryKey: [`/api/admin/inbox/contact/${fubId}`] });
            qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/inbox/conversations") });
          }}
          onError={(m) => toast({ title: "Not sent", description: m, variant: "destructive" })}
        />
      </section>

      <ContactPanel data={data} onInsert={(l) => insertListing.current?.(l)} />
    </>
  );
}

function Message({ item }: { item: ThreadItem }) {
  const out = item.direction === "outbound";
  if (item.kind === "call" || item.kind === "appointment") {
    const Icon = KIND_ICON[item.kind];
    const mins = item.meta.durationSeconds ? Math.round(item.meta.durationSeconds / 60) : null;
    return (
      <div className="flex justify-center">
        <div className="text-[12px] text-muted-foreground flex items-center gap-1.5 bg-background border border-border rounded-full px-3 py-1">
          <Icon className="h-3 w-3" strokeWidth={1.6} />
          {item.kind === "call"
            ? `${item.direction === "inbound" ? "Incoming" : item.direction === "outbound" ? "Outgoing" : ""} call${mins ? ` · ${mins} min` : ""}${item.meta.outcome ? ` · ${item.meta.outcome}` : ""}`
            : item.subject ?? "Appointment"}
          <span>· {stamp(item.at)}</span>
          {item.kind === "call" && item.meta.hasRecording && typeof item.meta.callLogId === "number" && (
            <RecordingButton callLogId={item.meta.callLogId} />
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "inquiry") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg px-3.5 py-2.5 bg-background border border-dashed border-border">
          <div className="text-[11px] flex items-center gap-1.5 mb-1 text-muted-foreground">
            <FileText className="h-3 w-3" strokeWidth={1.6} />
            {item.subject} · {stamp(item.at)}
          </div>
          <div className="text-[13.5px] whitespace-pre-wrap break-words leading-relaxed">{item.body}</div>
        </div>
      </div>
    );
  }
  if (item.kind === "note") {
    return (
      <div className="mx-auto max-w-[85%] bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-sm px-3 py-2">
        <div className="text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-1.5 mb-1">
          <StickyNote className="h-3 w-3" /> Note · {stamp(item.at)}
        </div>
        <div className="text-[13px] whitespace-pre-wrap">{item.body}</div>
      </div>
    );
  }
  const Icon = KIND_ICON[item.kind] ?? Mail;
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`${
          // Emails shown as sent need room: a fixed width the email can fill.
          item.kind === "email" && typeof item.meta.gmailId === "string" ? "w-[80%] max-w-[760px]" : "max-w-[80%]"
        } rounded-lg px-3.5 py-2.5 ${out ? "bg-foreground text-background" : "bg-background border border-border"}`}
      >
        <div className={`text-[11px] flex items-center gap-1.5 mb-1 ${out ? "text-background/70" : "text-muted-foreground"}`}>
          <Icon className="h-3 w-3" strokeWidth={1.6} />
          {item.kind === "email" ? "Email" : item.meta.via === "business line" ? "Text · business line" : "Text"} · {stamp(item.at)}
          {item.meta.hasAttachments && " · attachment"}
        </div>
        {item.kind === "email" && item.subject && <div className="text-[13px] font-medium mb-1">{item.subject}</div>}
        <FormattedBody item={item} out={out} />
      </div>
    </div>
  );
}

/**
 * The plain-text body made readable: links clickable, Gmail's "[Image]"
 * placeholders dropped (and counted), and for emails a way to see the
 * formatted original. See client/src/lib/email-text.ts.
 */
function FormattedBody({ item, out }: { item: ThreadItem; out: boolean }) {
  const gmailId = item.kind === "email" && typeof item.meta.gmailId === "string" ? item.meta.gmailId : null;
  // Emails show as sent, images and all; texts (and emails Gmail can't
  // supply) as formatted text.
  if (gmailId) return <EmailAsSent item={item} out={out} gmailId={gmailId} />;
  return <TextBody item={item} out={out} gmailId={null} />;
}

function TextBody({ item, out, gmailId }: { item: ThreadItem; out: boolean; gmailId: string | null }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const { segments, hiddenImages } = useMemo(() => formatEmailText(item.body), [item.body]);
  const linkClass = out ? "underline underline-offset-2 text-background" : "underline underline-offset-2 text-foreground";
  return (
    <>
      <div className="text-[13.5px] whitespace-pre-wrap break-words leading-relaxed">
        {segments.map((sg, i) =>
          sg.type === "link" ? (
            <a key={i} href={sg.href} target={sg.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className={linkClass}>
              {sg.text}
            </a>
          ) : (
            <span key={i}>{sg.text}</span>
          ),
        )}
      </div>
      {(gmailId || hiddenImages > 0) && (
        <div className={`mt-1.5 text-[11px] flex items-center gap-2 ${out ? "text-background/70" : "text-muted-foreground"}`}>
          {hiddenImages > 0 && (
            <span className="inline-flex items-center gap-1">
              <ImageIcon className="h-3 w-3" strokeWidth={1.6} />
              {hiddenImages} image{hiddenImages === 1 ? "" : "s"}
            </span>
          )}
          {gmailId && (
            <button type="button" className="underline underline-offset-2 hover:opacity-80" onClick={() => setShowOriginal(true)} data-testid={`show-original-${gmailId}`}>
              Show original
            </button>
          )}
        </div>
      )}
      {gmailId && showOriginal && <OriginalEmailDialog gmailId={gmailId} subject={item.subject} onClose={() => setShowOriginal(false)} />}
    </>
  );
}

/**
 * One email in the thread as it was sent, with its pictures, fetched from
 * Gmail when it scrolls into view. Earlier replies quoted underneath are
 * hidden (the thread already shows them); "Open full size" shows everything.
 * Until it arrives, or if Gmail can't be reached, the text version shows.
 */
function EmailAsSent({ item, out, gmailId }: { item: ThreadItem; out: boolean; gmailId: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(120);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const el = holder.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") return setVisible(true);
    // A working observer reports once straight away. If it never does (some
    // embedded or background views), load the email anyway rather than leave
    // it as text.
    let reported = false;
    const io = new IntersectionObserver(
      (entries) => {
        reported = true;
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    const fallback = setTimeout(() => !reported && setVisible(true), 1500);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
    };
  }, [visible]);
  const { data, isError } = useQuery<OriginalEmail>({
    queryKey: [`/api/admin/inbox/email/${gmailId}/original`, "inline"],
    queryFn: async () => (await apiRequest("GET", `/api/admin/inbox/email/${encodeURIComponent(gmailId)}/original?images=1&quoted=0`)).json(),
    enabled: visible,
    staleTime: 30 * 60_000,
    retry: 1,
  });
  const fit = () => {
    const doc = frame.current?.contentDocument;
    if (doc?.body) setHeight(Math.min(Math.max(doc.documentElement.scrollHeight, 60), 2400));
  };
  const showFrame = data && !data.plainOnly && !isError;
  return (
    <div ref={holder}>
      {showFrame ? (
        <>
          <iframe
            ref={frame}
            title={item.subject || "Email"}
            // Same sandbox as the full-size view: nothing in the email can run.
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            srcDoc={data.html}
            onLoad={() => {
              fit();
              // Pictures arrive after the document; measure again once they have.
              setTimeout(fit, 600);
              setTimeout(fit, 2000);
            }}
            className="rounded-sm"
            style={{ width: "100%", minWidth: 280, height, border: 0, display: "block", background: "#fff" }}
            data-testid={`email-as-sent-${gmailId}`}
          />
          <div className={`mt-1.5 text-[11px] ${out ? "text-background/70" : "text-muted-foreground"}`}>
            <button type="button" className="underline underline-offset-2 hover:opacity-80" onClick={() => setFull(true)} data-testid={`show-original-${gmailId}`}>
              Open full size
            </button>
          </div>
          {full && <OriginalEmailDialog gmailId={gmailId} subject={item.subject} onClose={() => setFull(false)} />}
        </>
      ) : (
        <TextBody item={item} out={out} gmailId={gmailId} />
      )}
    </div>
  );
}

interface OriginalEmail {
  html: string;
  remoteImages: number;
  inlineImages: number;
  plainOnly: boolean;
}

/**
 * The email as sent, fetched from Gmail on demand and shown in a sandboxed
 * frame: no scripts can run, and its Content-Security-Policy blocks every
 * outside request except pictures, which load by default (Spencer's choice,
 * 2026-10-17 — they can be open-tracking pixels). Server: server/email-original.ts.
 */
function OriginalEmailDialog({ gmailId, subject, onClose }: { gmailId: string; subject: string | null; onClose: () => void }) {
  const [images, setImages] = useState(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(400);
  const { data, isLoading, error } = useQuery<OriginalEmail>({
    queryKey: [`/api/admin/inbox/email/${gmailId}/original`, images],
    queryFn: async () => (await apiRequest("GET", `/api/admin/inbox/email/${encodeURIComponent(gmailId)}/original${images ? "?images=1" : ""}`)).json(),
    staleTime: 5 * 60_000,
  });
  const fit = () => {
    const doc = frame.current?.contentDocument;
    if (doc?.body) setHeight(Math.min(Math.max(doc.documentElement.scrollHeight, 200), 4000));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[90vh] overflow-y-auto p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="text-[15px] font-medium pr-6">{subject || "Email"}</DialogTitle>
          {data && (data.remoteImages > 0 || data.plainOnly) && (
            <div className="text-[12px] text-muted-foreground flex items-center gap-2 flex-wrap">
              {data.plainOnly && <span>This email was sent as plain text.</span>}
              {data.remoteImages > 0 && !images && (
                <>
                  <span>
                    {data.remoteImages} image{data.remoteImages === 1 ? " is" : "s are"} hidden — loading them can tell the sender you opened it.
                  </span>
                  <button type="button" className="underline underline-offset-2 text-foreground" onClick={() => setImages(true)} data-testid="load-remote-images">
                    Load images
                  </button>
                </>
              )}
            </div>
          )}
        </DialogHeader>
        {isLoading && (
          <div className="flex items-center justify-center py-16 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Fetching from Gmail…
          </div>
        )}
        {error && <div className="px-4 py-6 text-[13px] text-destructive">{String((error as Error).message).replace(/^\d+:\s*/, "")}</div>}
        {data && (
          <iframe
            ref={frame}
            title="Original email"
            // No allow-scripts: nothing in the email can run. allow-same-origin
            // only lets this page measure the content's height.
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            srcDoc={data.html}
            onLoad={fit}
            style={{ width: "100%", height, border: 0, display: "block", background: "#fff" }}
            data-testid="original-email-frame"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ActivityLine({ event }: { event: ActivityEvent }) {
  const l = event.props?.listing;
  const text =
    event.kind === "listing_view"
      ? `Viewed ${l?.address ? showingStreetLine(l.address) : "a listing"}${l?.price ? ` · ${money(l.price)}` : ""}`
      : event.kind === "email_open"
        ? `Opened “${event.title}”${event.props?.likelyAutomated ? " (likely automated)" : ""}`
        : event.kind === "email_click"
          ? `Clicked a link in “${event.title}”`
          : `Identified on the site via ${event.props?.via ?? "a form"}`;
  const Icon = event.kind === "listing_view" ? Home : event.kind === "email_open" ? MailOpen : event.kind === "email_click" ? MousePointerClick : UserCheck;
  return (
    <div className="flex justify-center">
      <div className="text-[11.5px] text-muted-foreground flex items-center gap-1.5">
        <Icon className="h-3 w-3" strokeWidth={1.6} />
        {event.kind === "listing_view" && event.path ? (
          <a href={event.path} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            {text}
          </a>
        ) : (
          text
        )}
        <span>· {stamp(event.occurredAt)}</span>
      </div>
    </div>
  );
}

function Composer({
  contact,
  status,
  defaultSubject,
  insertRef,
  onSent,
  onError,
}: {
  contact: ContactData["contact"];
  status?: InboxStatus;
  defaultSubject: string | null;
  insertRef: React.MutableRefObject<((l: Listing) => void) | null>;
  onSent: () => void;
  onError: (m: string) => void;
}) {
  const textReady = !!status?.canText.ok && !!contact.phone;
  const emailReady = !!status?.canEmail.ok && !!contact.email;
  const [channel, setChannel] = useState<"email" | "text">(textReady && !emailReady ? "text" : "email");
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [body, setBody] = useState("");
  const [picking, setPicking] = useState(false);
  // Emails carry the Gmail signature unless this is unticked (server/gmail-signature.ts).
  const [signature, setSignature] = useState(true);
  const attachments = useAttachments();
  const area = useRef<HTMLTextAreaElement>(null);
  // Where the cursor was, so a listing picked from the panel (which takes the
  // focus away) lands there rather than at the end.
  const caret = useRef<number | null>(null);
  const remember = () => {
    caret.current = area.current?.selectionStart ?? null;
  };

  /** Put a listing into the message at the cursor, on its own lines. */
  const insert = (l: Listing) => {
    const snippet = listingSnippet(l);
    let at = 0;
    setBody((prev) => {
      const pos = Math.min(caret.current ?? prev.length, prev.length);
      const before = prev.slice(0, pos);
      const after = prev.slice(pos);
      // A blank line either side, so listings and sentences don't run together.
      const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
      const trail = !after ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
      at = before.length + lead.length + snippet.length;
      return before + lead + snippet + trail + after;
    });
    setTimeout(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
      caret.current = at;
    }, 0);
  };
  useEffect(() => {
    insertRef.current = insert;
    return () => {
      insertRef.current = null;
    };
  });

  // Merge fields go into whichever box was used last, at its cursor.
  const subjectBox = useRef<HTMLInputElement>(null);
  const subjectCaret = useRef<number | null>(null);
  const lastBox = useRef<"subject" | "body">("body");
  const insertField = (token: string) => {
    if (channel === "email" && lastBox.current === "subject") {
      const r = insertAtCursor(subjectBox.current, subject, token, subjectCaret.current);
      setSubject(r.value);
      subjectCaret.current = r.caret;
      setTimeout(() => {
        subjectBox.current?.focus();
        subjectBox.current?.setSelectionRange(r.caret, r.caret);
      }, 0);
      return;
    }
    let at = 0;
    setBody((prev) => {
      const r = insertAtCursor(null, prev, token, caret.current);
      at = r.caret;
      return r.value;
    });
    setTimeout(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
      caret.current = at;
    }, 0);
  };

  /**
   * Use a template: an email's subject replaces the current one; the message
   * fills an empty box, or goes in at the cursor if something's written.
   * Merge fields stay as {fields} and are filled in when sent.
   */
  const applyTemplate = (t: MessageTemplate) => {
    if (t.kind === "email" && t.subject) setSubject(t.subject);
    if (!body.trim()) {
      setBody(t.body);
      caret.current = t.body.length;
    } else {
      let at = 0;
      setBody((prev) => {
        const pos = Math.min(caret.current ?? prev.length, prev.length);
        const before = prev.slice(0, pos);
        const after = prev.slice(pos);
        const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        at = before.length + lead.length + t.body.length;
        return before + lead + t.body + (after && !after.startsWith("\n") ? "\n\n" : "") + after;
      });
      caret.current = null;
      void at;
    }
    setTimeout(() => area.current?.focus(), 0);
  };

  const send = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/admin/inbox/contact/${contact.fubId}/reply`, {
          channel,
          body,
          subject: channel === "email" ? subject : undefined,
          signature: channel === "email" ? signature : undefined,
          attachmentIds: channel === "email" ? attachments.ids : undefined,
        })
      ).json(),
    onSuccess: () => {
      setBody("");
      attachments.clear();
      onSent();
    },
    onError: (e: any) => onError(e?.message ?? "Try again."),
  });

  const why =
    channel === "text"
      ? !contact.phone
        ? "This contact has no phone number."
        : !status?.canText.ok
          ? "Texting isn't set up yet — it goes live with the business line (Twilio)."
          : null
      : !contact.email
        ? "This contact has no email address."
        : !status?.canEmail.ok
          ? status?.canEmail.reason ?? "Email sending isn't connected."
          : null;

  const attachBlocked = channel === "email" && (attachments.uploading || attachments.hasErrors);

  return (
    <div
      className="border-t border-border p-3 space-y-2 bg-background"
      onDragOver={(e) => {
        if (channel === "email" && !why && e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (channel !== "email" || why || !e.dataTransfer.files.length) return;
        e.preventDefault();
        attachments.add(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-1">
        {(["email", "text"] as const).map((ch) => (
          <button
            key={ch}
            onClick={() => setChannel(ch)}
            className={`px-2.5 py-1 rounded-sm text-[11.5px] flex items-center gap-1.5 ${
              channel === ch ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary"
            }`}
          >
            {ch === "email" ? <Mail className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
            {ch === "email" ? "Email" : "Text"}
          </button>
        ))}
        {why && <span className="text-[11.5px] text-muted-foreground ml-2">{why}</span>}
        <div className="flex-1" />
        <TemplatePicker kind={channel} onPick={applyTemplate} disabled={!!why} />
        <MergeFieldPicker onPick={insertField} disabled={!!why} />
        {channel === "email" && <AttachButton onFiles={attachments.add} disabled={!!why} />}
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!!why}
              className="px-2.5 py-1 rounded-sm text-[11.5px] flex items-center gap-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-50"
              data-testid="inbox-insert-listing"
            >
              <Home className="h-3 w-3" /> Insert listing
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[380px] p-3">
            <div className="text-[12px] text-muted-foreground mb-2">Find a listing by address or MLS® number. It goes in with its link.</div>
            <ListingSearch
              autoFocus
              onPick={(l) => {
                setPicking(false);
                insert(l);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      {channel === "email" && (
        <Input
          ref={subjectBox}
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            subjectCaret.current = e.target.selectionStart;
          }}
          onFocus={() => (lastBox.current = "subject")}
          onSelect={() => (subjectCaret.current = subjectBox.current?.selectionStart ?? null)}
          placeholder="Subject"
          className="h-8 rounded-sm text-[13px]"
          disabled={!!why}
        />
      )}
      <div className="flex gap-2 items-end">
        <textarea
          ref={area}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            caret.current = e.target.selectionStart;
          }}
          onSelect={remember}
          onBlur={remember}
          onFocus={() => (lastBox.current = "body")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim() && !why && !attachBlocked) send.mutate();
          }}
          rows={channel === "text" ? 2 : 4}
          placeholder={channel === "text" ? "Text message…" : "Write your email…"}
          disabled={!!why}
          className="flex-1 text-[13.5px] leading-relaxed rounded-sm border border-border bg-transparent p-2.5 resize-y disabled:opacity-50"
          data-testid="inbox-reply-body"
        />
        <Button
          onClick={() => send.mutate()}
          disabled={!!why || !body.trim() || send.isPending || (channel === "email" && !subject.trim()) || attachBlocked}
          className="rounded-sm h-9"
          data-testid="inbox-send"
        >
          {send.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {channel === "email" && <AttachmentChips files={attachments.files} onRemove={attachments.remove} />}
      <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
        {channel === "email" && (
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={signature} onChange={(e) => setSignature(e.target.checked)} data-testid="inbox-signature" />
            Add my Gmail signature
          </label>
        )}
        {channel === "email" ? "Sends from your Gmail; replies thread normally. ⌘+Enter to send." : "Sends from your business line. ⌘+Enter to send."}
        <SaveAsTemplate kind={channel} subject={subject} body={body} />
        {channel === "text" && body.length > 160 && ` ${Math.ceil(body.length / 153)} texts.`}
      </div>
    </div>
  );
}

/** "Templates": pick a saved text or email template for this channel (pages/admin-templates.tsx). */

/** "Save as template": keep what's written (merge fields and all) for next time. */
function SaveAsTemplate({ kind, subject, body }: { kind: "email" | "text"; subject: string; body: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/templates", { kind, name, subject: kind === "email" ? subject.replace(/^re:\s*/i, "") : undefined, body })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith("/api/admin/templates") });
      setOpen(false);
      setName("");
    },
  });
  if (!body.trim()) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground" data-testid="inbox-save-template">
          <BookmarkPlus className="h-3 w-3" /> Save as template
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-3 space-y-2">
        <div className="text-[12px] text-muted-foreground">Save this {kind} as a template. Merge fields stay as fields.</div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" autoFocus className="h-8 text-[13px]" />
          <Button type="submit" size="sm" className="rounded-sm h-8" disabled={!name.trim() || save.isPending}>
            Save
          </Button>
        </form>
        {save.isError && <p className="text-[12px] text-destructive">{apiErrorMessage(save.error)}</p>}
      </PopoverContent>
    </Popover>
  );
}

// ---- The side panel ------------------------------------------------------------------------

function Section({ title, icon: Icon, count, children }: { title: string; icon: typeof Mail; count?: number; children: React.ReactNode }) {
  return (
    <div className="py-3 border-b border-border">
      <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-2 flex items-center gap-1.5">
        <Icon className="h-3 w-3" strokeWidth={1.6} />
        {title}
        {count ? <span className="tabular-nums">({count})</span> : null}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[12.5px] text-muted-foreground">{children}</div>;
}

function ContactPanel({ data, onInsert }: { data: ContactData; onInsert: (l: Listing) => void }) {
  const p = data.panel;
  // Older responses (before properties existed) still show their saved homes.
  const properties = p.properties ?? p.favorites.map((f) => ({ ...f, reasons: ["Saved"], lastAt: f.savedAt }));
  const e = p.engagement?.summary;
  const tags = (() => {
    try {
      return (JSON.parse(data.contact.tags ?? "[]") as string[]).slice(0, 8);
    } catch {
      return [];
    }
  })();
  return (
    <aside className="hidden xl:block border-l border-border min-h-0 overflow-y-auto px-4" data-testid="inbox-panel">
      <div className="py-3 border-b border-border space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          {data.contact.stage && <Badge variant="outline">{data.contact.stage}</Badge>}
          {data.contact.source && <Badge variant="outline">{data.contact.source}</Badge>}
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="font-normal">
              {t}
            </Badge>
          ))}
        </div>
      </div>

      <Section title="ACTIVITY" icon={Eye}>
        {e ? (
          <div className="grid grid-cols-2 gap-1.5 text-[12px]">
            <Stat label="Last on site" value={e.lastSeenAt ? ago(e.lastSeenAt) + " ago" : "—"} />
            <Stat label="Visits" value={e.visits} />
            <Stat label="Listings viewed" value={e.listingViews} />
            <Stat label="Emails opened" value={`${e.emailsOpened}/${e.emailsSent}`} />
            {e.topNeighbourhoods.length > 0 && (
              <div className="col-span-2 text-muted-foreground">
                Looking at: <span className="text-foreground">{e.topNeighbourhoods.map((n) => n.name).join(", ")}</span>
              </div>
            )}
          </div>
        ) : (
          <Empty>No email address, so no tracked activity.</Empty>
        )}
      </Section>

      <ContactDetails fubId={data.contact.fubId} />

      <Section title="PROPERTIES" icon={Home} count={properties.length}>
        {properties.length === 0 ? (
          <Empty>No saved, viewed or shown listings yet.</Empty>
        ) : (
          <div className="space-y-2" data-testid="inbox-properties">
            {properties.slice(0, 12).map((l) => (
              <div key={l.mlsNumber ?? l.url ?? l.address} className="flex gap-2 items-start group">
                {l.photoUrl ? (
                  <img src={l.photoUrl} alt="" className="w-12 h-9 object-cover rounded-sm bg-secondary shrink-0" loading="lazy" />
                ) : (
                  <div className="w-12 h-9 rounded-sm bg-secondary shrink-0" />
                )}
                <div className="min-w-0 flex-1 text-[12px]">
                  <div className="truncate" title={l.address}>
                    {showingStreetLine(l.address)}
                  </div>
                  <div className="text-muted-foreground truncate">{l.summary}</div>
                  {l.mlsNumber && <MlsNumber value={l.mlsNumber} />}
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {l.reasons.map((r) => (
                      <span key={r} className="text-[10px] px-1 rounded-sm bg-secondary text-muted-foreground">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => onInsert(l)}
                    className="text-[11px] flex items-center gap-0.5 underline underline-offset-2 text-foreground hover:opacity-70"
                    title="Insert this listing and its link into your message"
                    data-testid={`insert-property-${l.mlsNumber ?? l.address}`}
                  >
                    <Plus className="h-3 w-3" /> Insert
                  </button>
                  {l.url && (
                    <a href={l.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label="Open listing">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="SAVED SEARCHES" icon={Search} count={p.savedSearches.length}>
        {p.savedSearches.length === 0 ? (
          <Empty>No saved searches.</Empty>
        ) : (
          p.savedSearches.map((s) => (
            <div key={s.id} className="text-[12.5px] flex justify-between gap-2">
              <span className="truncate">{s.name}</span>
              <span className="text-muted-foreground shrink-0">{s.active ? s.frequency : "paused"}</span>
            </div>
          ))
        )}
      </Section>

      <Section title="SHOWINGS" icon={Calendar} count={p.showings.length}>
        {p.showings.length === 0 ? (
          <Empty>No showings.</Empty>
        ) : (
          p.showings.slice(0, 6).map((s) => (
            <div key={s.id} className="text-[12.5px] flex justify-between gap-2">
              <span className="truncate">{showingStreetLine(s.listing.address)}</span>
              <span className="text-muted-foreground shrink-0">
                {new Date(s.scheduledFor).toLocaleDateString("en-CA", { month: "short", day: "numeric" })} · {s.status}
              </span>
            </div>
          ))
        )}
      </Section>

      <Section title="TRANSACTIONS" icon={Briefcase} count={p.transactions.fub.length + p.transactions.app.length}>
        {p.transactions.fub.length + p.transactions.app.length === 0 ? (
          <Empty>No transactions.</Empty>
        ) : (
          <div className="space-y-1">
            {p.transactions.app.map((d) => (
              <Link key={`a${d.id}`} href={`/admin/deals/${d.id}`} className="block text-[12.5px] hover:underline underline-offset-2">
                {d.title} <span className="text-muted-foreground">· {d.kind} · {d.status}</span>
              </Link>
            ))}
            {p.transactions.fub.map((d) => (
              <div key={`f${d.fubId}`} className="text-[12.5px]">
                {d.name ?? "Deal"}{" "}
                <span className="text-muted-foreground">
                  · {[d.stageName, money(d.value)].filter(Boolean).join(" · ")} (FUB)
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="WEBSITE INQUIRIES" icon={FileText} count={p.inquiries.length}>
        {p.inquiries.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          p.inquiries.slice(0, 5).map((i) => (
            <div key={i.id} className="text-[12.5px] mb-1.5">
              <div className="text-muted-foreground">
                {i.source} · {ago(i.createdAt)} ago
              </div>
              <div className="line-clamp-2">{i.message}</div>
            </div>
          ))
        )}
      </Section>
    </aside>
  );
}

interface ContactField {
  key: string;
  label: string;
  type: string;
  source: "fub" | "app";
  value: string | null;
  fubValue: string | null;
  appValue: string | null;
}

/**
 * The contact's custom fields (Birthday, Spouse name, ones added in the app),
 * the values behind {custom_…} merge fields. Filled-in ones show; Edit shows
 * them all. A value typed here wins over Follow Up Boss's.
 */
function ContactDetails({ fubId }: { fubId: string }) {
  const qc = useQueryClient();
  const key = [`/api/admin/contacts/${fubId}/fields`];
  const { data = [] } = useQuery<ContactField[]>({ queryKey: key });
  const [editing, setEditing] = useState(false);
  const [managing, setManaging] = useState(false);
  const save = useMutation({
    mutationFn: async ({ field, value }: { field: string; value: string }) =>
      (await apiRequest("PUT", `/api/admin/contacts/${fubId}/fields/${encodeURIComponent(field)}`, { value })).json(),
    onSuccess: (rows: ContactField[]) => qc.setQueryData(key, rows),
  });
  const filled = data.filter((f) => f.value);
  const shown = editing ? data : filled;
  return (
    <Section title="DETAILS" icon={ListChecks} count={filled.length}>
      {shown.length === 0 && !editing ? (
        <Empty>No details yet.</Empty>
      ) : (
        <div className="space-y-1.5">
          {shown.map((f) => (
            <div key={f.key} className="text-[12px]">
              <div className="text-muted-foreground flex items-center justify-between gap-2">
                <span className="truncate">{f.label}</span>
                {f.appValue && f.fubValue && <span className="text-[10px] shrink-0">edited here</span>}
              </div>
              {editing ? (
                <input
                  type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                  defaultValue={f.value ?? ""}
                  onBlur={(e) => {
                    if (e.target.value !== (f.value ?? "")) save.mutate({ field: f.key, value: e.target.value });
                  }}
                  className="w-full h-7 rounded-sm border border-border bg-transparent px-2 text-[12px]"
                  data-testid={`contact-field-${f.key}`}
                />
              ) : (
                <div className="break-words">{f.type === "date" && f.value ? new Date(`${f.value.slice(0, 10)}T12:00:00`).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" }) : f.value}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-3 text-[11.5px]">
        <button type="button" onClick={() => setEditing(!editing)} className="flex items-center gap-1 underline underline-offset-2">
          <Pencil className="h-3 w-3" /> {editing ? "Done" : "Edit"}
        </button>
        <button type="button" onClick={() => setManaging(true)} className="underline underline-offset-2 text-muted-foreground">
          Custom fields
        </button>
      </div>
      {managing && (
        <CustomFieldsDialog
          onClose={() => {
            setManaging(false);
            qc.invalidateQueries({ queryKey: key });
          }}
        />
      )}
    </Section>
  );
}

/** The MLS® number, selectable, with a one-click copy. */
function MlsNumber({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the number is selectable text, so it can still be copied by hand.
    }
  };
  return (
    <div className="flex items-center gap-1 text-muted-foreground">
      <span>
        MLS® <span className="select-all tabular-nums">{value}</span>
      </span>
      <button
        type="button"
        onClick={copy}
        className="hover:text-foreground"
        aria-label={copied ? "Copied" : `Copy MLS number ${value}`}
        title={copied ? "Copied" : "Copy MLS® number"}
        data-testid={`copy-mls-${value}`}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
      {copied && <span className="text-[10px]">Copied</span>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-sm bg-secondary/50 px-2 py-1.5">
      <div className="text-[13px]">{value}</div>
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
    </div>
  );
}

/**
 * Click-to-call from the business line: Twilio rings Spencer's cell first;
 * he presses 1 and it dials the client, who sees the business number.
 */
function CallButton({ contactFubId, name, ready }: { contactFubId: string; name: string; ready: boolean }) {
  const { toast } = useToast();
  const call = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/calls", { contactFubId })).json(),
    onSuccess: () =>
      toast({ title: "Calling your cell…", description: `Answer, then press 1 to be connected to ${name}. They'll see your business line.` }),
    onError: (e: Error) => toast({ title: "Couldn't start the call", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 gap-1.5"
      disabled={!ready || call.isPending}
      title={ready ? "Ring your cell, then connect to them from the business line" : "Set up the business line first (Admin → Calendar)"}
      onClick={() => call.mutate()}
      data-testid="inbox-call"
    >
      {call.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PhoneOutgoing className="h-3.5 w-3.5" strokeWidth={1.8} />}
      Call
    </Button>
  );
}

/**
 * Plays a business-line call's recording. Fetched with the admin's auth and
 * played from a blob — an <audio src> can't send the Authorization header.
 */
function RecordingButton({ callLogId }: { callLogId: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  if (url) return <audio src={url} controls autoPlay className="h-7 max-w-[220px]" />;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        setError(null);
        try {
          const r = await apiRequest("GET", `/api/admin/calls/${callLogId}/recording`);
          setUrl(URL.createObjectURL(await r.blob()));
        } catch (e: any) {
          setError(String(e?.message ?? "Couldn't load").replace(/^\d+:\s*/, ""));
        } finally {
          setLoading(false);
        }
      }}
      data-testid={`play-recording-${callLogId}`}
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
      {error ?? "Recording"}
    </button>
  );
}
