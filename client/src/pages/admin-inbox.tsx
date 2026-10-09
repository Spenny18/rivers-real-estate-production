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
  Search,
  Send,
  StickyNote,
  UserCheck,
  Briefcase,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { showingStreetLine } from "@shared/showing-address";

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

type Filter = "all" | "unread" | "text" | "email";

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
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, phone"
                  className="pl-8 h-9 rounded-sm text-[13px]"
                  data-testid="input-inbox-search"
                />
              </div>
              <div className="flex gap-1">
                {(["all", "unread", "text", "email"] as Filter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-2.5 py-1 rounded-sm text-[11.5px] capitalize ${
                      filter === f ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary"
                    }`}
                  >
                    {f === "text" ? "Texts" : f === "email" ? "Emails" : f}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto" data-testid="inbox-conversations">
              {isLoading ? (
                <div className="p-4 text-[13px] text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              ) : conversations.length === 0 ? (
                <div className="p-4 text-[13px] text-muted-foreground">
                  {filter === "unread" ? "You're all caught up." : q ? "No conversations match." : "No conversations yet."}
                </div>
              ) : (
                conversations.map((c) => {
                  const Icon = KIND_ICON[c.lastKind] ?? Mail;
                  return (
                    <button
                      key={c.contactFubId}
                      onClick={() => setSelected(c.contactFubId)}
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
          onSent={() => {
            qc.invalidateQueries({ queryKey: [`/api/admin/inbox/contact/${fubId}`] });
            qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/inbox/conversations") });
          }}
          onError={(m) => toast({ title: "Not sent", description: m, variant: "destructive" })}
        />
      </section>

      <ContactPanel data={data} />
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
        className={`max-w-[80%] rounded-lg px-3.5 py-2.5 ${
          out ? "bg-foreground text-background" : "bg-background border border-border"
        }`}
      >
        <div className={`text-[11px] flex items-center gap-1.5 mb-1 ${out ? "text-background/70" : "text-muted-foreground"}`}>
          <Icon className="h-3 w-3" strokeWidth={1.6} />
          {item.kind === "email" ? "Email" : item.meta.via === "business line" ? "Text · business line" : "Text"} · {stamp(item.at)}
          {item.meta.hasAttachments && " · attachment"}
        </div>
        {item.kind === "email" && item.subject && <div className="text-[13px] font-medium mb-1">{item.subject}</div>}
        <div className="text-[13.5px] whitespace-pre-wrap break-words leading-relaxed">{item.body}</div>
      </div>
    </div>
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
  onSent,
  onError,
}: {
  contact: ContactData["contact"];
  status?: InboxStatus;
  defaultSubject: string | null;
  onSent: () => void;
  onError: (m: string) => void;
}) {
  const textReady = !!status?.canText.ok && !!contact.phone;
  const emailReady = !!status?.canEmail.ok && !!contact.email;
  const [channel, setChannel] = useState<"email" | "text">(textReady && !emailReady ? "text" : "email");
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [body, setBody] = useState("");

  const send = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/admin/inbox/contact/${contact.fubId}/reply`, { channel, body, subject: channel === "email" ? subject : undefined })).json(),
    onSuccess: () => {
      setBody("");
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

  return (
    <div className="border-t border-border p-3 space-y-2 bg-background">
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
      </div>
      {channel === "email" && (
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="h-8 rounded-sm text-[13px]" disabled={!!why} />
      )}
      <div className="flex gap-2 items-end">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim() && !why) send.mutate();
          }}
          rows={channel === "text" ? 2 : 4}
          placeholder={channel === "text" ? "Text message…" : "Write your email…"}
          disabled={!!why}
          className="flex-1 text-[13.5px] leading-relaxed rounded-sm border border-border bg-transparent p-2.5 resize-y disabled:opacity-50"
          data-testid="inbox-reply-body"
        />
        <Button
          onClick={() => send.mutate()}
          disabled={!!why || !body.trim() || send.isPending || (channel === "email" && !subject.trim())}
          className="rounded-sm h-9"
          data-testid="inbox-send"
        >
          {send.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {channel === "email" ? "Sends from your Gmail; replies thread normally. ⌘+Enter to send." : "Sends from your business line. ⌘+Enter to send."}
        {channel === "text" && body.length > 160 && ` ${Math.ceil(body.length / 153)} texts.`}
      </div>
    </div>
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

function ContactPanel({ data }: { data: ContactData }) {
  const p = data.panel;
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

      <Section title="SAVED HOMES" icon={Heart} count={p.favorites.length}>
        {p.favorites.length === 0 ? (
          <Empty>None saved in their portal.</Empty>
        ) : (
          <div className="space-y-1.5">
            {p.favorites.slice(0, 8).map((f) => (
              <a key={f.mlsNumber ?? f.address} href={f.url ?? "#"} target="_blank" rel="noreferrer" className="flex gap-2 items-center hover:bg-secondary/50 rounded-sm">
                {f.photoUrl ? <img src={f.photoUrl} alt="" className="w-12 h-9 object-cover rounded-sm bg-secondary" loading="lazy" /> : <div className="w-12 h-9 rounded-sm bg-secondary" />}
                <div className="min-w-0 text-[12px]">
                  <div className="truncate">{showingStreetLine(f.address)}</div>
                  <div className="text-muted-foreground truncate">{f.summary}</div>
                </div>
              </a>
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

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-sm bg-secondary/50 px-2 py-1.5">
      <div className="text-[13px]">{value}</div>
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
    </div>
  );
}
