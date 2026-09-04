// /admin/scheduling — the agent's console for the booking system.
//
// Three tabs:
//   Bookings       what's been booked, with status controls
//   Meeting types  the bookable links (/book/<slug>) and their rules
//   Availability   the weekly schedule plus one-off date exceptions
//
// Everything here writes through /api/admin/booking/*. The public /book pages
// read the same rows.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CalendarCheck,
  CalendarClock,
  CalendarX,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Plus,
  Trash2,
  TriangleAlert,
  Video,
  X,
} from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ---- Types (mirrors of the admin API payloads) ------------------------------

interface EventType {
  id: number;
  slug: string;
  name: string;
  description: string;
  durationMinutes: number;
  locationType: string;
  locationDetail: string | null;
  color: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  advanceDays: number;
  slotIntervalMinutes: number;
  maxPerDay: number | null;
  timezone: string;
  requirePhone: boolean;
  customQuestion: string | null;
  confirmationMessage: string | null;
  active: boolean;
  sortOrder: number;
  bookingCount: number;
  totalBookingCount: number;
  publicUrl: string;
  hasOwnSchedule: boolean;
}

interface AdminBooking {
  id: number;
  uid: string;
  eventTypeId: number;
  eventTypeName: string;
  eventTypeColor: string;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  answer: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  cancelReason: string | null;
  googleEventId: string | null;
  leadId: number | null;
  source: string;
  createdAt: string;
  manageUrl: string;
}

interface AvailabilityRow {
  id: number;
  eventTypeId: number | null;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

interface DateOverride {
  id: number;
  date: string;
  unavailable: boolean;
  startMinute: number | null;
  endMinute: number | null;
  note: string | null;
}

interface Stats {
  upcoming: number;
  next: AdminBooking | null;
  bookedLast7: number;
  upcomingNext7: number;
  cancelled: number;
  total: number;
  eventTypes: number;
  google: {
    connected: boolean;
    configured: boolean;
    accountEmail: string | null;
    freeBusyScope: boolean;
  };
  origin: string;
}

// ---- Helpers ----------------------------------------------------------------

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function fmtWhen(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDayHeading(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

function noticeLabel(minutes: number): string {
  if (minutes === 0) return "None";
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes < 1440) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${Math.round(minutes / 1440)} day${minutes === 1440 ? "" : "s"}`;
}

function LocationIcon({ type, className }: { type: string; className?: string }) {
  if (type === "video") return <Video className={className} />;
  if (type === "in_person") return <MapPin className={className} />;
  return <Phone className={className} />;
}

const STATUS_STYLES: Record<string, string> = {
  confirmed:
    "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-900",
  completed: "bg-secondary text-secondary-foreground border-border",
  cancelled: "bg-secondary/40 text-muted-foreground border-border",
  no_show:
    "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900",
};

const EMPTY_DRAFT = {
  name: "",
  slug: "",
  description: "",
  durationMinutes: 30,
  locationType: "phone",
  locationDetail: "",
  color: "#23412d",
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 15,
  minimumNoticeMinutes: 240,
  advanceDays: 60,
  slotIntervalMinutes: 30,
  maxPerDay: "" as number | "",
  requirePhone: true,
  customQuestion: "",
  confirmationMessage: "",
  active: true,
};

type Draft = typeof EMPTY_DRAFT;

// =============================================================================

export default function AdminSchedulingPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const viewerTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Edmonton";
    } catch {
      return "America/Edmonton";
    }
  }, []);

  const [statusFilter, setStatusFilter] = useState("upcoming");
  const [editing, setEditing] = useState<EventType | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [scheduleFor, setScheduleFor] = useState<string>("default");
  const [overrideDraft, setOverrideDraft] = useState({
    date: "",
    unavailable: true,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    note: "",
  });

  const { data: stats } = useQuery<Stats>({ queryKey: ["/api/admin/booking/stats"] });
  const { data: eventTypes = [], isLoading: typesLoading } = useQuery<EventType[]>({
    queryKey: ["/api/admin/booking/event-types"],
  });
  const { data: bookings = [], isLoading: bookingsLoading } = useQuery<AdminBooking[]>({
    queryKey: ["/api/admin/booking/bookings"],
  });
  const { data: availability = [] } = useQuery<AvailabilityRow[]>({
    queryKey: [`/api/admin/booking/availability?eventTypeId=${scheduleFor}`],
  });
  const { data: overrides = [] } = useQuery<DateOverride[]>({
    queryKey: ["/api/admin/booking/overrides"],
  });

  function refreshAll() {
    qc.invalidateQueries({ queryKey: ["/api/admin/booking/stats"] });
    qc.invalidateQueries({ queryKey: ["/api/admin/booking/event-types"] });
    qc.invalidateQueries({ queryKey: ["/api/admin/booking/bookings"] });
    qc.invalidateQueries({ queryKey: ["/api/admin/booking/overrides"] });
    qc.invalidateQueries({
      queryKey: [`/api/admin/booking/availability?eventTypeId=${scheduleFor}`],
    });
  }

  function fail(e: unknown) {
    toast({ title: "Didn't save", description: apiErrorMessage(e), variant: "destructive" });
  }

  // ---- Mutations ----------------------------------------------------------

  const saveEventType = useMutation({
    mutationFn: async ({ id, patch }: { id: number | null; patch: any }) => {
      const res = id
        ? await apiRequest("PATCH", `/api/admin/booking/event-types/${id}`, patch)
        : await apiRequest("POST", "/api/admin/booking/event-types", patch);
      return res.json();
    },
    onSuccess: () => {
      refreshAll();
      setEditing(null);
      setDraft(null);
      toast({ title: "Meeting type saved" });
    },
    onError: fail,
  });

  const deleteEventType = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/admin/booking/event-types/${id}`);
      return (await res.json()) as { removed: boolean; deactivated: boolean };
    },
    onSuccess: (r) => {
      refreshAll();
      setEditing(null);
      setDraft(null);
      toast(
        r.deactivated
          ? {
              title: "Meeting type retired",
              description:
                "It has bookings, so it was taken off the booking page rather than deleted — those invitees keep working reschedule links.",
            }
          : { title: "Meeting type deleted" },
      );
    },
    onError: fail,
  });

  const saveAvailability = useMutation({
    mutationFn: async (windows: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>) => {
      const res = await apiRequest("PUT", "/api/admin/booking/availability", {
        eventTypeId: scheduleFor === "default" ? null : Number(scheduleFor),
        windows,
      });
      return res.json();
    },
    onSuccess: () => {
      refreshAll();
      toast({ title: "Hours updated" });
    },
    onError: fail,
  });

  const addOverride = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/booking/overrides", overrideDraft);
      return res.json();
    },
    onSuccess: () => {
      refreshAll();
      setOverrideDraft({ date: "", unavailable: true, startMinute: 9 * 60, endMinute: 17 * 60, note: "" });
      toast({ title: "Date exception added" });
    },
    onError: fail,
  });

  const removeOverride = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/booking/overrides/${id}`);
    },
    onSuccess: () => refreshAll(),
    onError: fail,
  });

  const setBookingStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/booking/bookings/${id}`, { status });
      return res.json();
    },
    onSuccess: (_d, v) => {
      refreshAll();
      toast({
        title: v.status === "cancelled" ? "Booking cancelled" : "Booking updated",
        description:
          v.status === "cancelled"
            ? "The invitee was emailed and the calendar event removed."
            : undefined,
      });
    },
    onError: fail,
  });

  const connectGoogle = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/admin/google/connect");
      return res.json();
    },
    onSuccess: (d: any) => {
      if (d?.url) window.location.href = d.url;
    },
    onError: fail,
  });

  const disconnectGoogle = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/admin/google/disconnect");
    },
    onSuccess: () => {
      refreshAll();
      toast({ title: "Google Calendar disconnected" });
    },
    onError: fail,
  });

  function copy(text: string, label = "Link copied") {
    navigator.clipboard?.writeText(text).then(
      () => toast({ title: label, description: text }),
      () => toast({ title: "Couldn't copy", description: text, variant: "destructive" }),
    );
  }

  // ---- Derived ------------------------------------------------------------

  const visibleBookings = useMemo(() => {
    const now = Date.now();
    let rows = bookings;
    if (statusFilter === "upcoming") {
      rows = rows.filter((b) => b.status === "confirmed" && Date.parse(b.endsAt) >= now);
    } else if (statusFilter === "past") {
      rows = rows.filter((b) => Date.parse(b.endsAt) < now && b.status !== "cancelled");
    } else if (statusFilter !== "all") {
      rows = rows.filter((b) => b.status === statusFilter);
    }
    return statusFilter === "past"
      ? rows.slice().sort((a, b) => b.startsAt.localeCompare(a.startsAt))
      : rows;
  }, [bookings, statusFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, AdminBooking[]>();
    for (const b of visibleBookings) {
      const key = fmtDayHeading(b.startsAt, viewerTz);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return Array.from(map.entries());
  }, [visibleBookings, viewerTz]);

  // The weekly editor works on a local copy so a day can be toggled without a
  // round trip per keystroke; Save writes the whole schedule at once.
  const [weekDraft, setWeekDraft] = useState<Record<number, { start: string; end: string; on: boolean }> | null>(
    null,
  );
  const week = useMemo(() => {
    if (weekDraft) return weekDraft;
    const base: Record<number, { start: string; end: string; on: boolean }> = {};
    for (let d = 0; d < 7; d++) {
      const row = availability.find((a) => a.dayOfWeek === d);
      base[d] = row
        ? { start: minutesToTime(row.startMinute), end: minutesToTime(row.endMinute), on: true }
        : { start: "09:00", end: "17:00", on: false };
    }
    return base;
  }, [availability, weekDraft]);

  function setDay(day: number, patch: Partial<{ start: string; end: string; on: boolean }>) {
    setWeekDraft({ ...week, [day]: { ...week[day], ...patch } });
  }

  const inheritsDefault =
    scheduleFor !== "default" &&
    !eventTypes.find((et) => String(et.id) === scheduleFor)?.hasOwnSchedule;

  // =========================================================================

  return (
    <AppShell pageTitle="Scheduling">
      <div className="p-6 max-w-[1200px] mx-auto">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="font-serif text-3xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
              Scheduling
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
              Your booking links. Share a meeting type's URL and people pick from your real
              availability — checked against Google Calendar, written back to it, and logged as a lead.
            </p>
          </div>
          <a
            href="/book"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="link-public-booking"
            className="inline-flex items-center gap-2 border border-border rounded-sm px-4 py-2.5 text-[11px] font-display tracking-[0.16em] hover:bg-secondary/60 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" /> VIEW BOOKING PAGE
          </a>
        </div>

        {/* ---- KPI row ---- */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
          {[
            { label: "Upcoming", value: stats?.upcoming ?? 0, icon: CalendarClock },
            { label: "Next 7 days", value: stats?.upcomingNext7 ?? 0, icon: CalendarCheck },
            { label: "Booked this week", value: stats?.bookedLast7 ?? 0, icon: Check },
            { label: "Cancelled", value: stats?.cancelled ?? 0, icon: CalendarX },
          ].map((k) => (
            <Card key={k.label}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-[10px] font-display tracking-[0.16em] text-muted-foreground mb-2">
                  <k.icon className="h-3.5 w-3.5" />
                  {k.label.toUpperCase()}
                </div>
                <div className="font-serif text-3xl" data-testid={`stat-${k.label.toLowerCase().replace(/\s/g, "-")}`}>
                  {k.value}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ---- Google Calendar connection ---- */}
        <Card className="mb-6">
          <CardContent className="p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="font-display text-[11px] tracking-[0.16em] text-muted-foreground mb-1.5">
                GOOGLE CALENDAR
              </div>
              {!stats?.google.configured ? (
                <p className="text-sm text-muted-foreground max-w-xl leading-relaxed">
                  Not configured on the server. Set <code className="text-foreground">GOOGLE_OAUTH_CLIENT_ID</code>{" "}
                  and <code className="text-foreground">GOOGLE_OAUTH_CLIENT_SECRET</code> to let bookings
                  check and write your calendar. Bookings still work without it — they just won't see
                  events booked elsewhere.
                </p>
              ) : stats.google.connected ? (
                <p className="text-sm text-foreground">
                  Connected{stats.google.accountEmail ? ` as ${stats.google.accountEmail}` : ""}. Bookings
                  are written to your calendar and busy times are held back from the booking page.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground max-w-xl leading-relaxed">
                  Not connected. Connect to have bookings land on your calendar and to stop the booking
                  page offering times you're already busy.
                </p>
              )}
              {stats?.google.connected && !stats.google.freeBusyScope && (
                <p className="mt-2 text-[13px] text-amber-700 dark:text-amber-400 flex items-start gap-2 max-w-xl leading-relaxed">
                  <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
                  Your connection predates free/busy access, so events booked outside this site aren't
                  blocking slots yet. Reconnect once to fix that.
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              {stats?.google.connected && (
                <Button
                  variant="ghost"
                  onClick={() => disconnectGoogle.mutate()}
                  data-testid="button-google-disconnect"
                  className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                >
                  DISCONNECT
                </Button>
              )}
              <Button
                onClick={() => connectGoogle.mutate()}
                disabled={!stats?.google.configured || connectGoogle.isPending}
                data-testid="button-google-connect"
                className="rounded-sm text-[11px] font-display tracking-[0.14em]"
              >
                {stats?.google.connected ? "RECONNECT" : "CONNECT"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Tabs defaultValue="bookings">
          <TabsList className="mb-5">
            <TabsTrigger value="bookings" data-testid="tab-bookings">
              Bookings
            </TabsTrigger>
            <TabsTrigger value="types" data-testid="tab-types">
              Meeting types
            </TabsTrigger>
            <TabsTrigger value="availability" data-testid="tab-availability">
              Availability
            </TabsTrigger>
          </TabsList>

          {/* ================= BOOKINGS ================= */}
          <TabsContent value="bookings">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {[
                { v: "upcoming", l: "Upcoming" },
                { v: "past", l: "Past" },
                { v: "cancelled", l: "Cancelled" },
                { v: "all", l: "All" },
              ].map((f) => (
                <button
                  key={f.v}
                  onClick={() => setStatusFilter(f.v)}
                  data-testid={`filter-${f.v}`}
                  className={`px-3 py-1.5 rounded-sm text-[11px] font-display tracking-[0.14em] border transition-colors ${
                    statusFilter === f.v
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:bg-secondary/60"
                  }`}
                >
                  {f.l.toUpperCase()}
                </button>
              ))}
            </div>

            {bookingsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading bookings…
              </div>
            ) : grouped.length === 0 ? (
              <Card>
                <CardContent className="p-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    {statusFilter === "upcoming"
                      ? "Nothing booked yet. Share a meeting type's link and bookings land here."
                      : "Nothing to show for this filter."}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-6" data-testid="bookings-list">
                {grouped.map(([day, rows]) => (
                  <div key={day}>
                    <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-2">
                      {day.toUpperCase()}
                    </div>
                    <div className="space-y-2">
                      {rows.map((b) => (
                        <Card key={b.id} data-testid={`booking-${b.id}`}>
                          <CardContent className="p-4">
                            <div className="flex flex-wrap items-start gap-4">
                              <span
                                className="w-1 self-stretch rounded-full shrink-0"
                                style={{ background: b.eventTypeColor }}
                                aria-hidden
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2 mb-1">
                                  <span className="font-medium text-[15px]">{b.name}</span>
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] tracking-[0.1em] ${STATUS_STYLES[b.status] ?? ""}`}
                                  >
                                    {b.status.replace("_", " ").toUpperCase()}
                                  </Badge>
                                  {b.source === "admin" && (
                                    <Badge variant="outline" className="text-[10px] tracking-[0.1em]">
                                      ADDED BY YOU
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-[13px] text-muted-foreground">
                                  {b.eventTypeName} · {fmtWhen(b.startsAt, viewerTz)}
                                </div>
                                <div className="text-[13px] text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1">
                                  <a
                                    href={`mailto:${b.email}`}
                                    className="inline-flex items-center gap-1.5 hover:text-foreground"
                                  >
                                    <Mail className="h-3.5 w-3.5" />
                                    {b.email}
                                  </a>
                                  {b.phone && (
                                    <a
                                      href={`tel:${b.phone}`}
                                      className="inline-flex items-center gap-1.5 hover:text-foreground"
                                    >
                                      <Phone className="h-3.5 w-3.5" />
                                      {b.phone}
                                    </a>
                                  )}
                                </div>
                                {(b.notes || b.answer) && (
                                  <p className="mt-2 text-[13px] text-foreground/80 leading-relaxed border-l-2 border-border pl-3">
                                    {[b.answer, b.notes].filter(Boolean).join(" — ")}
                                  </p>
                                )}
                                {b.cancelReason && (
                                  <p className="mt-2 text-[13px] text-muted-foreground">
                                    Cancelled: {b.cancelReason}
                                  </p>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => copy(b.manageUrl, "Invitee link copied")}
                                  data-testid={`button-copy-manage-${b.id}`}
                                  className="rounded-sm text-[11px]"
                                  title="Copy the invitee's reschedule/cancel link"
                                >
                                  <Link2 className="h-3.5 w-3.5" />
                                </Button>
                                {b.status === "confirmed" && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setBookingStatus.mutate({ id: b.id, status: "completed" })}
                                      data-testid={`button-complete-${b.id}`}
                                      className="rounded-sm text-[11px] font-display tracking-[0.12em]"
                                    >
                                      DONE
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setBookingStatus.mutate({ id: b.id, status: "no_show" })}
                                      data-testid={`button-noshow-${b.id}`}
                                      className="rounded-sm text-[11px] font-display tracking-[0.12em]"
                                    >
                                      NO-SHOW
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setBookingStatus.mutate({ id: b.id, status: "cancelled" })}
                                      data-testid={`button-cancel-${b.id}`}
                                      className="rounded-sm text-[11px] text-muted-foreground hover:text-destructive"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ================= MEETING TYPES ================= */}
          <TabsContent value="types">
            <div className="flex justify-end mb-4">
              <Button
                onClick={() => {
                  setEditing(null);
                  setDraft({ ...EMPTY_DRAFT });
                }}
                data-testid="button-new-type"
                className="rounded-sm text-[11px] font-display tracking-[0.14em]"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" /> NEW MEETING TYPE
              </Button>
            </div>

            {typesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2" data-testid="event-types-list">
                {eventTypes.map((et) => (
                  <Card key={et.id} data-testid={`event-type-${et.slug}`}>
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="h-3 w-3 rounded-full shrink-0"
                            style={{ background: et.color }}
                            aria-hidden
                          />
                          <h3 className="font-serif text-[19px] truncate">{et.name}</h3>
                        </div>
                        <Switch
                          checked={et.active}
                          onCheckedChange={(active) =>
                            saveEventType.mutate({ id: et.id, patch: { active } })
                          }
                          data-testid={`switch-active-${et.slug}`}
                          aria-label={`${et.name} active`}
                        />
                      </div>

                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground mb-3">
                        <span>{et.durationMinutes} min</span>
                        <span className="inline-flex items-center gap-1.5">
                          <LocationIcon type={et.locationType} className="h-3.5 w-3.5" />
                          {et.locationType.replace("_", " ")}
                        </span>
                        <span>{noticeLabel(et.minimumNoticeMinutes)} notice</span>
                        <span>{et.bookingCount} booked</span>
                      </div>

                      <div className="flex items-center gap-2 mb-4">
                        <code className="text-[11px] text-muted-foreground truncate flex-1 bg-secondary/50 px-2 py-1.5 rounded-sm">
                          /book/{et.slug}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copy(et.publicUrl)}
                          data-testid={`button-copy-link-${et.slug}`}
                          className="rounded-sm shrink-0"
                          title="Copy public booking link"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <a
                          href={`/book/${et.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="h-8 w-8 grid place-items-center rounded-sm hover:bg-secondary/60 transition-colors shrink-0"
                          title="Open booking page"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditing(et);
                          setDraft({
                            name: et.name,
                            slug: et.slug,
                            description: et.description,
                            durationMinutes: et.durationMinutes,
                            locationType: et.locationType,
                            locationDetail: et.locationDetail ?? "",
                            color: et.color,
                            bufferBeforeMinutes: et.bufferBeforeMinutes,
                            bufferAfterMinutes: et.bufferAfterMinutes,
                            minimumNoticeMinutes: et.minimumNoticeMinutes,
                            advanceDays: et.advanceDays,
                            slotIntervalMinutes: et.slotIntervalMinutes,
                            maxPerDay: et.maxPerDay ?? "",
                            requirePhone: et.requirePhone,
                            customQuestion: et.customQuestion ?? "",
                            confirmationMessage: et.confirmationMessage ?? "",
                            active: et.active,
                          });
                        }}
                        data-testid={`button-edit-${et.slug}`}
                        className="rounded-sm w-full text-[11px] font-display tracking-[0.14em]"
                      >
                        EDIT SETTINGS
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ================= AVAILABILITY ================= */}
          <TabsContent value="availability">
            <Card className="mb-4">
              <CardContent className="p-5">
                <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
                  <div>
                    <h3 className="font-serif text-[20px] mb-1">Weekly hours</h3>
                    <p className="text-[13px] text-muted-foreground max-w-xl leading-relaxed">
                      The windows people can book inside. Times are in the meeting type's timezone
                      (America/Edmonton by default), so they hold through daylight saving.
                    </p>
                  </div>
                  <div className="min-w-[220px]">
                    <Label className="text-[11px] mb-1.5 block">Schedule for</Label>
                    <Select
                      value={scheduleFor}
                      onValueChange={(v) => {
                        setScheduleFor(v);
                        setWeekDraft(null);
                      }}
                    >
                      <SelectTrigger data-testid="select-schedule-for" className="rounded-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default (all meeting types)</SelectItem>
                        {eventTypes.map((et) => (
                          <SelectItem key={et.id} value={String(et.id)}>
                            {et.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {inheritsDefault && (
                  <p className="text-[13px] text-muted-foreground mb-4 border-l-2 border-border pl-3 leading-relaxed">
                    This meeting type currently follows the default schedule. Saving hours here gives it
                    its own, overriding the default for this type only.
                  </p>
                )}

                <div className="space-y-2">
                  {DAYS.map((label, day) => (
                    <div
                      key={day}
                      className="flex flex-wrap items-center gap-3 py-2 border-b border-border last:border-0"
                      data-testid={`day-row-${day}`}
                    >
                      <div className="flex items-center gap-3 w-40 shrink-0">
                        <Switch
                          checked={week[day].on}
                          onCheckedChange={(on) => setDay(day, { on })}
                          data-testid={`switch-day-${day}`}
                          aria-label={label}
                        />
                        <span
                          className={`text-[13px] ${week[day].on ? "text-foreground" : "text-muted-foreground"}`}
                        >
                          {label}
                        </span>
                      </div>
                      {week[day].on ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={week[day].start}
                            onChange={(e) => setDay(day, { start: e.target.value })}
                            data-testid={`input-start-${day}`}
                            className="w-32 rounded-sm"
                          />
                          <span className="text-muted-foreground text-[13px]">to</span>
                          <Input
                            type="time"
                            value={week[day].end}
                            onChange={(e) => setDay(day, { end: e.target.value })}
                            data-testid={`input-end-${day}`}
                            className="w-32 rounded-sm"
                          />
                        </div>
                      ) : (
                        <span className="text-[13px] text-muted-foreground">Unavailable</span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-5 flex items-center gap-3">
                  <Button
                    onClick={() =>
                      saveAvailability.mutate(
                        Object.entries(week)
                          .filter(([, v]) => v.on)
                          .map(([d, v]) => ({
                            dayOfWeek: Number(d),
                            startMinute: timeToMinutes(v.start),
                            endMinute: timeToMinutes(v.end),
                          }))
                          .filter((w) => w.endMinute > w.startMinute),
                      )
                    }
                    disabled={saveAvailability.isPending}
                    data-testid="button-save-hours"
                    className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                  >
                    {saveAvailability.isPending ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> SAVING…
                      </>
                    ) : (
                      "SAVE HOURS"
                    )}
                  </Button>
                  {weekDraft && (
                    <button
                      onClick={() => setWeekDraft(null)}
                      className="text-[12px] text-muted-foreground underline underline-offset-4"
                    >
                      Discard changes
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* ---- Date exceptions ---- */}
            <Card>
              <CardContent className="p-5">
                <h3 className="font-serif text-[20px] mb-1">Date exceptions</h3>
                <p className="text-[13px] text-muted-foreground mb-5 max-w-xl leading-relaxed">
                  Block a day off entirely, or give one date different hours — a holiday, a conference,
                  an open-house Saturday. Exceptions beat the weekly hours above.
                </p>

                <div className="flex flex-wrap items-end gap-3 mb-5 pb-5 border-b border-border">
                  <div>
                    <Label className="text-[11px] mb-1.5 block">Date</Label>
                    <Input
                      type="date"
                      value={overrideDraft.date}
                      onChange={(e) => setOverrideDraft({ ...overrideDraft, date: e.target.value })}
                      data-testid="input-override-date"
                      className="w-44 rounded-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2.5 pb-2.5">
                    <Switch
                      checked={!overrideDraft.unavailable}
                      onCheckedChange={(custom) =>
                        setOverrideDraft({ ...overrideDraft, unavailable: !custom })
                      }
                      data-testid="switch-override-custom"
                      aria-label="Use custom hours"
                    />
                    <span className="text-[13px] text-muted-foreground">Custom hours</span>
                  </div>
                  {!overrideDraft.unavailable && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        value={minutesToTime(overrideDraft.startMinute)}
                        onChange={(e) =>
                          setOverrideDraft({ ...overrideDraft, startMinute: timeToMinutes(e.target.value) })
                        }
                        className="w-32 rounded-sm"
                      />
                      <span className="text-muted-foreground text-[13px]">to</span>
                      <Input
                        type="time"
                        value={minutesToTime(overrideDraft.endMinute)}
                        onChange={(e) =>
                          setOverrideDraft({ ...overrideDraft, endMinute: timeToMinutes(e.target.value) })
                        }
                        className="w-32 rounded-sm"
                      />
                    </div>
                  )}
                  <div className="flex-1 min-w-[160px]">
                    <Label className="text-[11px] mb-1.5 block">Note</Label>
                    <Input
                      value={overrideDraft.note}
                      onChange={(e) => setOverrideDraft({ ...overrideDraft, note: e.target.value })}
                      placeholder="Conference, vacation…"
                      className="rounded-sm"
                    />
                  </div>
                  <Button
                    onClick={() => addOverride.mutate()}
                    disabled={!overrideDraft.date || addOverride.isPending}
                    data-testid="button-add-override"
                    className="rounded-sm text-[11px] font-display tracking-[0.14em]"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" /> ADD
                  </Button>
                </div>

                {overrides.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No upcoming exceptions.</p>
                ) : (
                  <div className="space-y-1.5" data-testid="overrides-list">
                    {overrides.map((o) => (
                      <div
                        key={o.id}
                        className="flex items-center justify-between gap-3 py-2 px-3 rounded-sm bg-secondary/40"
                        data-testid={`override-${o.date}`}
                      >
                        <div className="min-w-0">
                          <span className="text-[13px] font-medium">
                            {new Date(`${o.date}T12:00:00`).toLocaleDateString("en-CA", {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </span>
                          <span className="text-[13px] text-muted-foreground ml-3">
                            {o.unavailable
                              ? "Unavailable all day"
                              : `${minutesToTime(o.startMinute ?? 0)} – ${minutesToTime(o.endMinute ?? 0)}`}
                            {o.note ? ` · ${o.note}` : ""}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeOverride.mutate(o.id)}
                          data-testid={`button-remove-override-${o.date}`}
                          className="rounded-sm shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* ================= EVENT TYPE EDITOR ================= */}
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) {
            setDraft(null);
            setEditing(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">
              {editing ? editing.name : "New meeting type"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? `Bookable at /book/${editing.slug}`
                : "This becomes a public booking link people can be sent."}
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-5 py-2">
              <div className="grid sm:grid-cols-[1fr_120px] gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Name</Label>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    data-testid="input-type-name"
                    placeholder="Buyer Consultation"
                    className="rounded-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Colour</Label>
                  <Input
                    type="color"
                    value={draft.color}
                    onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                    data-testid="input-type-color"
                    className="rounded-sm h-10 p-1 cursor-pointer"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[12px]">
                  Link <span className="text-muted-foreground">— /book/…</span>
                </Label>
                <Input
                  value={draft.slug}
                  onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                  data-testid="input-type-slug"
                  placeholder="buyer-consultation"
                  className="rounded-sm font-mono text-[13px]"
                />
                {editing && draft.slug !== editing.slug && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400">
                    Changing this breaks links you've already shared.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-[12px]">What this meeting is</Label>
                <Textarea
                  rows={3}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  data-testid="input-type-description"
                  placeholder="Shown on the booking page — set expectations for what happens on the call."
                  className="rounded-sm"
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Length (minutes)</Label>
                  <Input
                    type="number"
                    min={5}
                    max={480}
                    value={draft.durationMinutes}
                    onChange={(e) => setDraft({ ...draft, durationMinutes: Number(e.target.value) })}
                    data-testid="input-type-duration"
                    className="rounded-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Slots every (minutes)</Label>
                  <Input
                    type="number"
                    min={5}
                    max={240}
                    value={draft.slotIntervalMinutes}
                    onChange={(e) => setDraft({ ...draft, slotIntervalMinutes: Number(e.target.value) })}
                    data-testid="input-type-interval"
                    className="rounded-sm"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Where</Label>
                  <Select
                    value={draft.locationType}
                    onValueChange={(v) => setDraft({ ...draft, locationType: v })}
                  >
                    <SelectTrigger data-testid="select-type-location" className="rounded-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="phone">Phone call</SelectItem>
                      <SelectItem value="video">Video call</SelectItem>
                      <SelectItem value="in_person">In person</SelectItem>
                      <SelectItem value="custom">Something else</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">
                    Location detail <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    value={draft.locationDetail}
                    onChange={(e) => setDraft({ ...draft, locationDetail: e.target.value })}
                    data-testid="input-type-location-detail"
                    placeholder={
                      draft.locationType === "video"
                        ? "https://meet.google.com/…"
                        : draft.locationType === "in_person"
                          ? "Your property — I'll come to you."
                          : "Left blank: I'll call the number given."
                    }
                    className="rounded-sm"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Buffer before (minutes)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={240}
                    value={draft.bufferBeforeMinutes}
                    onChange={(e) => setDraft({ ...draft, bufferBeforeMinutes: Number(e.target.value) })}
                    data-testid="input-type-buffer-before"
                    className="rounded-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Buffer after (minutes)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={240}
                    value={draft.bufferAfterMinutes}
                    onChange={(e) => setDraft({ ...draft, bufferAfterMinutes: Number(e.target.value) })}
                    data-testid="input-type-buffer-after"
                    className="rounded-sm"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Minimum notice (minutes)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={20160}
                    value={draft.minimumNoticeMinutes}
                    onChange={(e) => setDraft({ ...draft, minimumNoticeMinutes: Number(e.target.value) })}
                    data-testid="input-type-notice"
                    className="rounded-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {noticeLabel(draft.minimumNoticeMinutes)} ahead
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Book up to (days out)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    value={draft.advanceDays}
                    onChange={(e) => setDraft({ ...draft, advanceDays: Number(e.target.value) })}
                    data-testid="input-type-advance"
                    className="rounded-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">
                    Max per day <span className="text-muted-foreground">(blank = any)</span>
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={50}
                    value={draft.maxPerDay}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        maxPerDay: e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                    data-testid="input-type-max-per-day"
                    className="rounded-sm"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[12px]">
                  Extra question <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  value={draft.customQuestion}
                  onChange={(e) => setDraft({ ...draft, customQuestion: e.target.value })}
                  data-testid="input-type-question"
                  placeholder="Which property would you like to see?"
                  className="rounded-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-[12px]">
                  Confirmation message <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  rows={2}
                  value={draft.confirmationMessage}
                  onChange={(e) => setDraft({ ...draft, confirmationMessage: e.target.value })}
                  data-testid="input-type-confirmation"
                  placeholder="Shown right after someone books. Defaults to a standard confirmation."
                  className="rounded-sm"
                />
              </div>

              <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <Switch
                    checked={draft.requirePhone}
                    onCheckedChange={(requirePhone) => setDraft({ ...draft, requirePhone })}
                    data-testid="switch-type-require-phone"
                  />
                  <span className="text-[13px]">Require a phone number</span>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <Switch
                    checked={draft.active}
                    onCheckedChange={(active) => setDraft({ ...draft, active })}
                    data-testid="switch-type-active"
                  />
                  <span className="text-[13px]">Bookable</span>
                </label>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            {editing ? (
              <Button
                variant="ghost"
                onClick={() => {
                  const hasBookings = editing.totalBookingCount > 0;
                  if (
                    window.confirm(
                      hasBookings
                        ? `"${editing.name}" has bookings, so it will be retired rather than deleted: /book/${editing.slug} stops taking new bookings, and everyone already booked keeps a working reschedule link. Continue?`
                        : `Delete "${editing.name}"? /book/${editing.slug} will stop working.`,
                    )
                  ) {
                    deleteEventType.mutate(editing.id);
                  }
                }}
                data-testid="button-delete-type"
                className="rounded-sm text-muted-foreground hover:text-destructive text-[11px] font-display tracking-[0.14em]"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                {editing.totalBookingCount > 0 ? "RETIRE" : "DELETE"}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setDraft(null);
                  setEditing(null);
                }}
                className="rounded-sm text-[11px] font-display tracking-[0.14em]"
              >
                CANCEL
              </Button>
              <Button
                onClick={() =>
                  draft &&
                  saveEventType.mutate({
                    id: editing?.id ?? null,
                    patch: {
                      ...draft,
                      maxPerDay: draft.maxPerDay === "" ? null : draft.maxPerDay,
                      locationDetail: draft.locationDetail || null,
                      customQuestion: draft.customQuestion || null,
                      confirmationMessage: draft.confirmationMessage || null,
                    },
                  })
                }
                disabled={!draft?.name.trim() || saveEventType.isPending}
                data-testid="button-save-type"
                className="rounded-sm text-[11px] font-display tracking-[0.14em]"
              >
                {saveEventType.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> SAVING…
                  </>
                ) : (
                  "SAVE"
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
