import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { LeadIntakePanel } from "@/components/lead-intake-panel";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Mail,
  Phone,
  MoreHorizontal,
  CalendarPlus,
  ChevronRight,
  Inbox,
  CheckCircle2,
  Send,
  Filter,
} from "lucide-react";
import { timeAgo } from "@/lib/mock-data";
import { apiRequest } from "@/lib/queryClient";
import type { PublicListing } from "@/lib/types";
import type { Lead, Message } from "@shared/schema";

const STATUS_BADGE: Record<string, string> = {
  new: "bg-foreground text-background border-transparent",
  contacted: "bg-secondary text-foreground border-border",
  qualified: "bg-secondary text-foreground border-border",
  "tour-booked": "bg-secondary text-foreground border-border",
  lost: "bg-muted text-muted-foreground border-border",
};

export default function LeadsPage() {
  const qc = useQueryClient();
  const { data: leads = [], isLoading } = useQuery<Lead[]>({ queryKey: ["/api/leads"] });
  const { data: listings = [] } = useQuery<PublicListing[]>({ queryKey: ["/api/listings"] });

  const sorted = useMemo(
    () => [...leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [leads],
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [reply, setReply] = useState("");

  // Default to first lead
  const effectiveSelectedId = selectedId ?? sorted[0]?.id ?? null;

  const filtered = sorted.filter((l) => {
    if (filter !== "all" && l.status !== filter) return false;
    if (
      query &&
      !`${l.name} ${l.email} ${l.message}`.toLowerCase().includes(query.toLowerCase())
    )
      return false;
    return true;
  });

  const selected = leads.find((l) => l.id === effectiveSelectedId);
  const selectedListing = selected
    ? listings.find((p) => p.id === selected.listingId)
    : null;

  const counts = {
    new: leads.filter((l) => l.status === "new").length,
    qualified: leads.filter((l) => l.status === "qualified").length,
    tour: leads.filter((l) => l.status === "tour-booked").length,
  };

  const messagesQuery = useQuery<Message[]>({
    queryKey: effectiveSelectedId ? ["/api/leads", effectiveSelectedId, "messages"] : ["__none__"],
    enabled: !!effectiveSelectedId,
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/leads/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
    },
  });

  const sendReply = useMutation({
    mutationFn: async ({ leadId, body }: { leadId: number; body: string }) => {
      const res = await apiRequest("POST", `/api/leads/${leadId}/messages`, { body });
      return res.json();
    },
    onSuccess: (_, { leadId }) => {
      setReply("");
      qc.invalidateQueries({ queryKey: ["/api/leads", leadId, "messages"] });
    },
  });

  return (
    <AppShell pageTitle="Enquiries" newLeadCount={counts.new}>
      <div className="px-8 py-7 space-y-5">
        {/* Header with new-lead action */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-serif text-3xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
              Enquiries
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Inbound leads from the public site and lead-source emails, plus any manually-added prospects.
            </p>
          </div>
          <NewLeadButton />
        </div>
        {/* Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { count: counts.new, label: "New enquiries", icon: Inbox },
            { count: counts.qualified, label: "Qualified", icon: CheckCircle2 },
            { count: counts.tour, label: "Tours booked", icon: CalendarPlus },
          ].map((s) => {
            const Icon = s.icon;
            return (
              <Card key={s.label}>
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-sm bg-secondary flex items-center justify-center text-foreground">
                    <Icon className="w-5 h-5" strokeWidth={1.6} />
                  </div>
                  <div>
                    <div className="font-serif text-2xl tabular-nums" style={{ letterSpacing: "-0.01em" }}>{s.count}</div>
                    <div className="eyebrow text-muted-foreground mt-0.5">{s.label}</div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <LeadIntakePanel />

        {/* Two-pane inbox */}
        <Card className="overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] h-[calc(100dvh-280px)] min-h-[520px]">
            {/* List */}
            <div className="border-r border-border flex flex-col overflow-hidden">
              <div className="p-3 border-b border-border space-y-2.5">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.6} />
                  <Input
                    placeholder="Search enquiries…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="pl-9 h-9 rounded-sm"
                    data-testid="input-search-leads"
                  />
                </div>
                <Select value={filter} onValueChange={setFilter}>
                  <SelectTrigger className="h-9 rounded-sm" data-testid="select-lead-filter">
                    <Filter className="w-3.5 h-3.5 mr-1.5" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All enquiries</SelectItem>
                    <SelectItem value="new">New</SelectItem>
                    <SelectItem value="contacted">Contacted</SelectItem>
                    <SelectItem value="qualified">Qualified</SelectItem>
                    <SelectItem value="tour-booked">Tour booked</SelectItem>
                    <SelectItem value="lost">Lost</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
                {isLoading
                  ? [0, 1, 2, 3].map((i) => (
                      <div key={i} className="p-4 border-b border-border">
                        <Skeleton className="h-12 w-full" />
                      </div>
                    ))
                  : filtered.map((lead) => {
                      const listing = listings.find((p) => p.id === lead.listingId);
                      const active = lead.id === effectiveSelectedId;
                      return (
                        <button
                          key={lead.id}
                          onClick={() => setSelectedId(lead.id)}
                          className={`w-full text-left px-4 py-3 border-b border-border hover:bg-secondary/40 transition-colors ${
                            active ? "bg-secondary/60" : ""
                          }`}
                          data-testid={`lead-list-${lead.id}`}
                        >
                          <div className="flex items-start gap-3">
                            <Avatar className="w-9 h-9 shrink-0">
                              <AvatarFallback className="bg-secondary text-secondary-foreground text-xs font-medium">
                                {lead.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium truncate text-foreground">{lead.name}</span>
                                <span className="text-[10px] text-muted-foreground/80 shrink-0 font-display tracking-[0.08em]">
                                  {timeAgo(lead.createdAt).toUpperCase()}
                                </span>
                              </div>
                              <div className="text-xs text-muted-foreground truncate mt-0.5">{listing?.title ?? "General enquiry"}</div>
                              <div className="text-xs text-foreground/80 truncate mt-1">{lead.message}</div>
                              <div className="flex items-center gap-2 mt-2">
                                <Badge className={`capitalize text-[10px] px-1.5 py-0 rounded-sm font-display tracking-[0.1em] ${STATUS_BADGE[lead.status] ?? STATUS_BADGE.new}`}>
                                  {lead.status.replace("-", " ").toUpperCase()}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground font-display tracking-[0.08em]">{lead.source.toUpperCase()}</span>
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
              </div>
            </div>

            {/* Detail */}
            {selected ? (
              <div className="flex flex-col overflow-hidden">
                <div className="p-5 border-b border-border flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar className="w-12 h-12">
                      <AvatarFallback className="bg-foreground text-background font-medium">
                        {selected.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="font-serif text-xl truncate text-foreground" style={{ letterSpacing: "-0.01em" }}>{selected.name}</div>
                      <div className="text-sm text-muted-foreground truncate flex items-center gap-2 flex-wrap">
                        <span className="flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" strokeWidth={1.6} /> {selected.email}</span>
                        {selected.phone && (
                          <>
                            <span>·</span>
                            <span className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" strokeWidth={1.6} />{selected.phone}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Select
                      value={selected.status}
                      onValueChange={(v) => updateStatus.mutate({ id: selected.id, status: v })}
                    >
                      <SelectTrigger className="w-[160px] h-9 rounded-sm" data-testid="select-lead-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new">New</SelectItem>
                        <SelectItem value="contacted">Contacted</SelectItem>
                        <SelectItem value="qualified">Qualified</SelectItem>
                        <SelectItem value="tour-booked">Tour booked</SelectItem>
                        <SelectItem value="lost">Lost</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon" className="rounded-sm" aria-label="More">
                      <MoreHorizontal className="w-4 h-4" strokeWidth={1.6} />
                    </Button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-5" style={{ overscrollBehavior: "contain" }}>
                  {/* Property reference */}
                  {selectedListing && (
                    <Card>
                      <CardContent className="p-3">
                        <div className="flex items-center gap-3">
                          <img src={selectedListing.heroImage} alt="" className="w-16 h-12 rounded-sm object-cover" />
                          <div className="flex-1 min-w-0">
                            <div className="eyebrow text-muted-foreground">Enquiry about</div>
                            <div className="font-serif text-[15px] truncate mt-0.5">{selectedListing.title}</div>
                            <div className="text-xs text-muted-foreground truncate">{selectedListing.address}</div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Email alerts + market snapshot */}
                  <LeadAlertsAndSnapshot leadId={selected.id} />

                  {/* Conversation */}
                  <div>
                    <div className="eyebrow text-muted-foreground mb-3">Conversation</div>
                    <div className="space-y-3">
                      <div className="flex gap-3">
                        <Avatar className="w-8 h-8 shrink-0">
                          <AvatarFallback className="bg-secondary text-xs">
                            {selected.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="bg-secondary/60 rounded-sm border border-border px-4 py-3 text-sm">
                            {selected.message}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-1.5 ml-1 font-display tracking-[0.1em]">
                            VIA {selected.source.toUpperCase()} · {timeAgo(selected.createdAt).toUpperCase()}
                          </div>
                        </div>
                      </div>

                      {(messagesQuery.data ?? []).map((m) => (
                        <div key={m.id} className={`flex gap-3 ${m.fromAgent ? "flex-row-reverse" : ""}`}>
                          <Avatar className="w-8 h-8 shrink-0">
                            <AvatarFallback className={m.fromAgent ? "bg-foreground text-background text-xs" : "bg-secondary text-xs"}>
                              {m.fromAgent ? "SR" : selected.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                            </AvatarFallback>
                          </Avatar>
                          <div className={`flex-1 min-w-0 flex flex-col ${m.fromAgent ? "items-end" : ""}`}>
                            <div className={`rounded-sm px-4 py-3 text-sm max-w-md ${
                              m.fromAgent ? "bg-foreground text-background" : "bg-secondary/60 border border-border"
                            }`}>
                              {m.body}
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-1.5 mx-1 font-display tracking-[0.1em]">
                              {m.fromAgent ? "SPENCER" : selected.name.toUpperCase()} · {timeAgo(m.createdAt).toUpperCase()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Reply composer */}
                <div className="p-4 border-t border-border bg-background">
                  <div className="flex items-end gap-2">
                    <div className="flex-1 relative">
                      <Input
                        placeholder="Write a reply…"
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && reply.trim() && selected) {
                            sendReply.mutate({ leadId: selected.id, body: reply });
                          }
                        }}
                        className="h-11 pr-3 rounded-sm"
                        data-testid="input-reply"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 rounded-sm font-display tracking-[0.14em] text-[11px]"
                      data-testid="button-book-tour"
                    >
                      <CalendarPlus className="w-3.5 h-3.5 mr-1.5" /> BOOK TOUR
                    </Button>
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="h-11 rounded-sm font-display tracking-[0.14em] text-[11px]"
                      title="Open in your email client"
                    >
                      <a
                        href={`mailto:${selected.email}?subject=${encodeURIComponent(
                          `Re: ${selectedListing?.title ?? "your enquiry"}`,
                        )}&body=${encodeURIComponent(
                          `Hi ${selected.name.split(" ")[0]},\n\n${reply || ""}\n\nContact Spencer 🤵\nSpencer Rivers\nREALTOR® | Rivers Real Estate\n(403) 966-9237`,
                        )}`}
                      >
                        <Mail className="w-3.5 h-3.5 mr-1.5" /> EMAIL
                      </a>
                    </Button>
                    <Button
                      size="sm"
                      className="h-11 rounded-sm font-display tracking-[0.14em] text-[11px]"
                      disabled={!reply.trim() || sendReply.isPending}
                      onClick={() => selected && sendReply.mutate({ leadId: selected.id, body: reply })}
                      data-testid="button-send-reply"
                    >
                      <Send className="w-3.5 h-3.5 mr-1.5" /> SEND
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center text-muted-foreground">
                {isLoading ? "Loading enquiries…" : "Select an enquiry to view details"}
              </div>
            )}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

// =============================================================================
// New-lead button (manual entry).
// =============================================================================

function NewLeadButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    email: "",
    phone: "",
    status: "new",
    source: "manual",
    listingId: "",
    message: "",
  });

  const create = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/leads", draft);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      setOpen(false);
      setDraft({
        name: "",
        email: "",
        phone: "",
        status: "new",
        source: "manual",
        listingId: "",
        message: "",
      });
    },
  });

  if (!open) {
    return (
      <Button
        onClick={() => setOpen(true)}
        className="rounded-sm font-display tracking-[0.14em] text-[11px] h-10"
      >
        + NEW LEAD
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-6 overflow-y-auto">
      <Card className="w-full max-w-lg my-12">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="font-serif text-xl" style={{ letterSpacing: "-0.005em" }}>
              New lead
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-sm h-8 w-8 p-0"
              onClick={() => setOpen(false)}
            >
              ×
            </Button>
          </div>
          <div className="space-y-3">
            <div>
              <div className="eyebrow text-muted-foreground mb-1.5">Name *</div>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Jane & Mark Anderson"
                className="rounded-sm h-10"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="eyebrow text-muted-foreground mb-1.5">Email *</div>
                <Input
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  placeholder="jane@example.com"
                  className="rounded-sm h-10"
                />
              </div>
              <div>
                <div className="eyebrow text-muted-foreground mb-1.5">Phone</div>
                <Input
                  value={draft.phone}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                  placeholder="(403) 555-1234"
                  className="rounded-sm h-10"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="eyebrow text-muted-foreground mb-1.5">Status</div>
                <Select
                  value={draft.status}
                  onValueChange={(v) => setDraft({ ...draft, status: v })}
                >
                  <SelectTrigger className="rounded-sm h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">New</SelectItem>
                    <SelectItem value="contacted">Contacted</SelectItem>
                    <SelectItem value="qualified">Qualified</SelectItem>
                    <SelectItem value="tour-booked">Tour booked</SelectItem>
                    <SelectItem value="lost">Lost</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="eyebrow text-muted-foreground mb-1.5">Source</div>
                <Select
                  value={draft.source}
                  onValueChange={(v) => setDraft({ ...draft, source: v })}
                >
                  <SelectTrigger className="rounded-sm h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="referral">Referral</SelectItem>
                    <SelectItem value="instagram">Instagram</SelectItem>
                    <SelectItem value="facebook">Facebook</SelectItem>
                    <SelectItem value="realtor.ca">Realtor.ca</SelectItem>
                    <SelectItem value="landing-page">Landing page</SelectItem>
                    <SelectItem value="open-house">Open house</SelectItem>
                    <SelectItem value="phone">Phone</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <div className="eyebrow text-muted-foreground mb-1.5">
                Listing reference (optional)
              </div>
              <Input
                value={draft.listingId}
                onChange={(e) => setDraft({ ...draft, listingId: e.target.value })}
                placeholder="l-001 or A2305467"
                className="rounded-sm h-10"
              />
            </div>
            <div>
              <div className="eyebrow text-muted-foreground mb-1.5">Notes / first message</div>
              <textarea
                value={draft.message}
                onChange={(e) => setDraft({ ...draft, message: e.target.value })}
                placeholder="Met at open house. Looking for 4-bed in Aspen Woods, $2.5-3M, 6mo timeline."
                rows={4}
                className="w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm h-9"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="rounded-sm font-display tracking-[0.14em] text-[11px] h-9 ml-auto"
              disabled={!draft.name.trim() || !draft.email.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              CREATE LEAD
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// =============================================================================
// Email-alerts + 30-day market-snapshot panel — shown inside each lead detail.
// =============================================================================

interface LeadAlertRow {
  id: number;
  leadId: number;
  label: string;
  filters: any;
  frequency: "instant" | "daily" | "weekly" | "monthly";
  alertType: "listings" | "snapshot";
  active: boolean;
  lastSentAt: string | null;
  lastMatchCount: number;
  createdAt: string;
}

interface MarketSnapshot {
  newListings: number;
  sold: number;
  terminated: number;
  priceReductions: number;
  averageListPrice: number;
  averageSoldPrice: number;
  samples: {
    newListings: any[];
    priceReductions: any[];
  };
}

function LeadAlertsAndSnapshot({ leadId }: { leadId: number }) {
  const qc = useQueryClient();
  const { data: alerts = [] } = useQuery<LeadAlertRow[]>({
    queryKey: ["/api/leads", leadId, "alerts"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/leads/${leadId}/alerts`);
      return r.json();
    },
  });

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    label: "",
    frequency: "daily" as LeadAlertRow["frequency"],
    alertType: "listings" as "listings" | "snapshot",
    minPrice: "",
    maxPrice: "",
    beds: "",
    baths: "",
    neighbourhood: "",
    propertyType: "",
  });

  const createAlert = useMutation({
    mutationFn: async () => {
      const filters: any = {};
      if (draft.minPrice) filters.minPrice = Number(draft.minPrice);
      if (draft.maxPrice) filters.maxPrice = Number(draft.maxPrice);
      if (draft.beds) filters.beds = Number(draft.beds);
      if (draft.baths) filters.baths = Number(draft.baths);
      if (draft.neighbourhood) filters.neighbourhood = draft.neighbourhood;
      if (draft.propertyType) filters.propertyType = draft.propertyType;
      const r = await apiRequest("POST", `/api/leads/${leadId}/alerts`, {
        label: draft.label,
        filters,
        frequency: draft.frequency,
        alertType: draft.alertType,
      });
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/leads", leadId, "alerts"] });
      setCreating(false);
      setDraft({
        label: "",
        frequency: "daily",
        alertType: "listings",
        minPrice: "",
        maxPrice: "",
        beds: "",
        baths: "",
        neighbourhood: "",
        propertyType: "",
      });
    },
  });

  const updateAlert = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Partial<LeadAlertRow> }) => {
      const r = await apiRequest("PATCH", `/api/leads/${leadId}/alerts/${id}`, patch);
      return r.json();
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["/api/leads", leadId, "alerts"] }),
  });

  const deleteAlert = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/leads/${leadId}/alerts/${id}`);
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["/api/leads", leadId, "alerts"] }),
  });

  const sendNow = useMutation({
    mutationFn: async (id: number) => {
      const r = await apiRequest("POST", `/api/leads/${leadId}/alerts/${id}/send`);
      return r.json();
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/leads", leadId, "alerts"] });
      const sent = data?.sent ?? 0;
      const errors = data?.errors ?? 0;
      if (errors > 0) {
        alert(`Send had ${errors} error(s). Check fly logs for details.`);
      } else if (sent > 0) {
        alert(`Sent ${sent} email${sent === 1 ? "" : "s"}.`);
      } else {
        alert("Nothing matched the filter — no email sent.");
      }
    },
  });

  return (
    <div className="space-y-5">
      {/* Email alerts list */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="eyebrow text-muted-foreground">Email alerts</div>
              <div className="font-serif text-base mt-0.5" style={{ letterSpacing: "-0.005em" }}>
                Saved searches that email this lead
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="rounded-sm font-display tracking-[0.14em] text-[10px] h-8"
              onClick={() => setCreating((v) => !v)}
            >
              {creating ? "CANCEL" : "+ NEW ALERT"}
            </Button>
          </div>

          {alerts.length === 0 && !creating && (
            <div className="text-xs text-muted-foreground italic">
              No alerts yet. Create one to email this lead when matching listings hit the MLS.
            </div>
          )}

          {alerts.length > 0 && (
            <ul className="divide-y divide-border -mx-4">
              {alerts.map((a) => (
                <li key={a.id} className="px-4 py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{a.label}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                      <span className="font-display tracking-[0.14em] uppercase">{a.frequency}</span>
                      <span className="font-display tracking-[0.14em] uppercase">
                        · {(a as any).alertType === "snapshot" ? "SNAPSHOT" : "PROPERTY"}
                      </span>
                      {a.lastSentAt ? (
                        <span>last sent {timeAgo(a.lastSentAt)}</span>
                      ) : (
                        <span>never sent</span>
                      )}
                      <span>· {a.lastMatchCount} matches</span>
                    </div>
                    {a.filters && Object.keys(a.filters).length > 0 && (
                      <div className="text-[10px] text-muted-foreground italic mt-1 truncate">
                        {Object.entries(a.filters)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Select
                      value={a.frequency}
                      onValueChange={(v) =>
                        updateAlert.mutate({ id: a.id, patch: { frequency: v as any } })
                      }
                    >
                      <SelectTrigger className="h-7 w-[100px] rounded-sm text-[10px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="instant">Instant</SelectItem>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-sm h-7 px-2 text-[10px]"
                      onClick={() =>
                        updateAlert.mutate({ id: a.id, patch: { active: !a.active } })
                      }
                    >
                      {a.active ? "ON" : "OFF"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-sm h-7 px-2 text-[10px]"
                      title="Preview email in new tab"
                      onClick={async () => {
                        try {
                          const r = await apiRequest("GET", `/api/saved-searches/${a.id}/preview`);
                          const html = await r.text();
                          const blob = new Blob([html], { type: "text/html" });
                          const url = URL.createObjectURL(blob);
                          window.open(url, "_blank", "noopener");
                          setTimeout(() => URL.revokeObjectURL(url), 60_000);
                        } catch (e: any) {
                          alert("Preview failed: " + (e?.message ?? "unknown"));
                        }
                      }}
                    >
                      PREVIEW
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-sm h-7 px-2 text-[10px]"
                      title="Send now"
                      disabled={sendNow.isPending}
                      onClick={() => sendNow.mutate(a.id)}
                    >
                      SEND
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-sm h-7 px-2 text-[10px] text-destructive"
                      onClick={() => {
                        if (confirm(`Delete alert "${a.label}"?`)) deleteAlert.mutate(a.id);
                      }}
                    >
                      DELETE
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {creating && (
            <div className="mt-3 pt-3 border-t border-border space-y-3">
              <Input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="Label (e.g. Aspen Woods 4+ bed under $2M)"
                className="rounded-sm h-9 text-sm"
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, alertType: "listings" })}
                  className={`px-3 py-2 rounded-sm border text-[11px] font-display tracking-[0.16em] transition-colors ${
                    draft.alertType === "listings"
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background border-border hover:bg-secondary/40"
                  }`}
                >
                  PROPERTY ALERTS
                  <div className="font-sans normal-case tracking-normal text-[10px] mt-0.5 opacity-80">
                    New matches + price reductions
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, alertType: "snapshot" })}
                  className={`px-3 py-2 rounded-sm border text-[11px] font-display tracking-[0.16em] transition-colors ${
                    draft.alertType === "snapshot"
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background border-border hover:bg-secondary/40"
                  }`}
                >
                  MARKET SNAPSHOT
                  <div className="font-sans normal-case tracking-normal text-[10px] mt-0.5 opacity-80">
                    Stats only · no listings
                  </div>
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={draft.minPrice}
                  onChange={(e) =>
                    setDraft({ ...draft, minPrice: e.target.value.replace(/\D/g, "") })
                  }
                  placeholder="Min $"
                  className="rounded-sm h-9 text-sm"
                />
                <Input
                  value={draft.maxPrice}
                  onChange={(e) =>
                    setDraft({ ...draft, maxPrice: e.target.value.replace(/\D/g, "") })
                  }
                  placeholder="Max $"
                  className="rounded-sm h-9 text-sm"
                />
                <Input
                  value={draft.beds}
                  onChange={(e) => setDraft({ ...draft, beds: e.target.value.replace(/\D/g, "") })}
                  placeholder="Min beds"
                  className="rounded-sm h-9 text-sm"
                />
                <Input
                  value={draft.baths}
                  onChange={(e) => setDraft({ ...draft, baths: e.target.value.replace(/\D/g, "") })}
                  placeholder="Min baths"
                  className="rounded-sm h-9 text-sm"
                />
                <Input
                  value={draft.neighbourhood}
                  onChange={(e) => setDraft({ ...draft, neighbourhood: e.target.value })}
                  placeholder="Neighbourhood"
                  className="rounded-sm h-9 text-sm col-span-2"
                />
              </div>
              <Select
                value={draft.frequency}
                onValueChange={(v) => setDraft({ ...draft, frequency: v as any })}
              >
                <SelectTrigger className="h-9 rounded-sm text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="instant">Instant — every match emails immediately</SelectItem>
                  <SelectItem value="daily">Daily — one digest per day</SelectItem>
                  <SelectItem value="weekly">Weekly — one digest per week</SelectItem>
                  <SelectItem value="monthly">Monthly — one digest per month</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="rounded-sm font-display tracking-[0.14em] text-[10px] h-8 w-full"
                disabled={!draft.label.trim() || createAlert.isPending}
                onClick={() => createAlert.mutate()}
              >
                CREATE ALERT
              </Button>
              <p className="text-[10px] text-muted-foreground italic">
                Note: email delivery requires SMTP credentials on Fly. Alerts will save and the
                cron will pick them up once those are configured. Until then this acts as the
                rules definition + market-snapshot driver.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Market snapshot — driven by the FIRST active alert's filters, falling
          back to the lead's listing-context if no alerts exist. */}
      <MarketSnapshotCard
        filters={
          alerts.find((a) => a.active)?.filters ?? null
        }
      />
    </div>
  );
}

function MarketSnapshotCard({ filters }: { filters: any | null }) {
  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v != null && v !== "") p.set(k, String(v));
      }
    }
    p.set("daysBack", "30");
    return p.toString();
  }, [filters]);

  const { data, isLoading } = useQuery<MarketSnapshot>({
    queryKey: ["/api/admin/market-snapshot", queryString],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/admin/market-snapshot?${queryString}`);
      return r.json();
    },
  });

  if (!filters) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground italic">
          Add an alert above to see a 30-day market snapshot for this lead's filter set.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="eyebrow text-muted-foreground mb-1">30-day market snapshot</div>
        <div className="font-serif text-base mb-3" style={{ letterSpacing: "-0.005em" }}>
          What's happened in this slice over the last 30 days
        </div>
        {isLoading || !data ? (
          <div className="text-xs text-muted-foreground italic">Loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              <SnapStat label="New" value={data.newListings} />
              <SnapStat label="Sold" value={data.sold} />
              <SnapStat label="Terminated" value={data.terminated} />
              <SnapStat label="Reduced" value={data.priceReductions} />
            </div>
            {data.averageListPrice > 0 && (
              <div className="mt-3 text-[11px] text-muted-foreground flex items-center gap-3 flex-wrap">
                <span>Avg list: ${(data.averageListPrice / 1000).toFixed(0)}K</span>
                {data.averageSoldPrice > 0 && (
                  <span>Avg sold: ${(data.averageSoldPrice / 1000).toFixed(0)}K</span>
                )}
              </div>
            )}
            {data.samples?.priceReductions?.length > 0 && (
              <div className="mt-4">
                <div className="eyebrow text-muted-foreground mb-1.5">Recent price reductions</div>
                <ul className="divide-y divide-border text-[12px]">
                  {data.samples.priceReductions.slice(0, 3).map((r: any, i: number) => (
                    <li key={i} className="py-2 flex items-center gap-2">
                      <div className="flex-1 min-w-0 truncate">{r.fullAddress}</div>
                      <span className="line-through text-muted-foreground">
                        ${(r.oldPrice / 1000).toFixed(0)}K
                      </span>
                      <span className="font-medium">${(r.newPrice / 1000).toFixed(0)}K</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SnapStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-sm bg-secondary/40 px-2 py-2 text-center">
      <div className="font-serif text-xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
        {value}
      </div>
      <div className="eyebrow text-muted-foreground mt-0.5 text-[9px]">{label}</div>
    </div>
  );
}
