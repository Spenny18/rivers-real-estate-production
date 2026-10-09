import * as React from "react";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, Clock, Plus } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  FubAppointmentRow,
  NewShowingDialog,
  SHOWING_STATUS_STYLES,
  ShowingRow,
  type FubAppointment,
  type ShowingView,
} from "@/components/showings";

// /admin/calendar — showings (server/showings.ts) plus, while scheduling moves
// off Follow Up Boss, FUB's own appointments as a read-only layer.

function startOfMonth(d: Date) {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addMonths(d: Date, n: number) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function buildCalendarGrid(monthAnchor: Date): Date[] {
  const start = startOfMonth(monthAnchor);
  const startDayOfWeek = start.getDay(); // 0 = Sunday
  const grid: Date[] = [];
  // Pad with previous month's days so the first row starts on Sunday.
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(start.getDate() - 1 - i);
    grid.push(d);
  }
  // Fill out 6 full weeks (42 cells) to keep grid stable.
  while (grid.length < 42) {
    const d = new Date(start);
    d.setDate(start.getDate() + (grid.length - startDayOfWeek));
    grid.push(d);
  }
  return grid;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}

function formatLongDate(d: Date) {
  return d.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/** One entry on the calendar, whichever source it came from. */
type Entry =
  | { kind: "showing"; at: string; showing: ShowingView }
  | { kind: "fub"; at: string; appt: FubAppointment };

function groupByDay(entries: Entry[]): Map<string, Entry[]> {
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = new Date(e.at).toDateString();
    const arr = map.get(key) ?? [];
    arr.push(e);
    map.set(key, arr);
  }
  map.forEach((arr) => arr.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
  return map;
}

export default function AdminCalendarPage() {
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<Date>(() => new Date());
  const [creating, setCreating] = useState(false);
  const [showFub, setShowFub] = useState(true);

  const { data: showings = [], isLoading } = useQuery<ShowingView[]>({ queryKey: ["/api/admin/showings"] });
  // The visible six weeks, padded, so a month change refetches only its window.
  const grid = useMemo(() => buildCalendarGrid(monthAnchor), [monthAnchor]);
  const from = grid[0].toISOString();
  const to = new Date(grid[grid.length - 1].getTime() + 86_400_000).toISOString();
  const { data: fubAppts = [] } = useQuery<FubAppointment[]>({
    queryKey: [`/api/admin/calendar/fub-appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`],
  });
  const today = new Date();

  const entries = useMemo<Entry[]>(
    () => [
      ...showings.map((s) => ({ kind: "showing" as const, at: s.scheduledFor, showing: s })),
      ...(showFub ? fubAppts.map((a) => ({ kind: "fub" as const, at: a.startsAt, appt: a })) : []),
    ],
    [showings, fubAppts, showFub],
  );
  const byDay = useMemo(() => groupByDay(entries), [entries]);
  const selectedEntries = byDay.get(selectedDay.toDateString()) ?? [];

  const upcoming = useMemo(() => {
    const now = Date.now();
    return showings
      .filter((s) => Date.parse(s.scheduledFor) >= now && s.status !== "cancelled")
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))
      .slice(0, 8);
  }, [showings]);

  const pendingRequests = showings.filter((s) => s.status === "requested" && Date.parse(s.scheduledFor) >= Date.now()).length;

  return (
    <AppShell pageTitle="Calendar">
      <div className="p-6 max-w-[1400px] mx-auto">
        <GoogleCalendarConnect />
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="font-serif text-3xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
              Calendar
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5">
              Showings, with calendar invites to your clients.
              {pendingRequests > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {" "}
                  {pendingRequests} tour request{pendingRequests === 1 ? "" : "s"} waiting for you to confirm.
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="rounded-sm h-9 font-display tracking-[0.14em] text-[11px] mr-2"
              onClick={() => setCreating(true)}
              data-testid="button-new-showing"
            >
              <Plus className="w-3.5 h-3.5 mr-1.5" /> NEW SHOWING
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm h-9"
              onClick={() => setMonthAnchor(addMonths(monthAnchor, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="font-display text-[12px] tracking-[0.18em] text-foreground min-w-[160px] text-center">
              {monthAnchor.toLocaleDateString("en-CA", { month: "long", year: "numeric" }).toUpperCase()}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm h-9"
              onClick={() => setMonthAnchor(addMonths(monthAnchor, 1))}
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-sm h-9 font-display tracking-[0.14em] text-[11px] ml-2"
              onClick={() => {
                const t = new Date();
                setMonthAnchor(startOfMonth(t));
                setSelectedDay(t);
              }}
            >
              TODAY
            </Button>
          </div>
        </div>

        <label className="inline-flex items-center gap-2 text-[12px] text-muted-foreground mb-3 cursor-pointer">
          <input type="checkbox" checked={showFub} onChange={(e) => setShowFub(e.target.checked)} />
          Show Follow Up Boss appointments ({fubAppts.length} this view, read-only)
        </label>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* Month grid */}
          <Card>
            <CardContent className="p-0">
              <div className="grid grid-cols-7 border-b border-border">
                {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d) => (
                  <div key={d} className="px-3 py-2 font-display text-[10px] tracking-[0.2em] text-muted-foreground">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 grid-rows-6 min-h-[640px]">
                {grid.map((day, i) => {
                  const dayEntries = byDay.get(day.toDateString()) ?? [];
                  const isCurrentMonth = day.getMonth() === monthAnchor.getMonth();
                  const isToday = isSameDay(day, today);
                  const isSelected = isSameDay(day, selectedDay);
                  return (
                    <button
                      key={i}
                      onClick={() => setSelectedDay(day)}
                      onDoubleClick={() => {
                        setSelectedDay(day);
                        setCreating(true);
                      }}
                      className={`text-left border-b border-r border-border last-of-row:border-r-0 px-2 py-1.5 flex flex-col gap-1 transition-colors ${
                        isCurrentMonth ? "bg-background" : "bg-secondary/30"
                      } ${isSelected ? "ring-2 ring-foreground ring-inset" : "hover:bg-secondary/50"}`}
                    >
                      <div
                        className={`font-display text-[11px] tracking-[0.1em] inline-flex items-center justify-center w-6 h-6 rounded-full ${
                          isToday ? "bg-foreground text-background" : isCurrentMonth ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {day.getDate()}
                      </div>
                      <div className="flex flex-col gap-1">
                        {dayEntries.slice(0, 3).map((e) =>
                          e.kind === "showing" ? (
                            <div
                              key={`s${e.showing.id}`}
                              className={`text-[10px] truncate px-1.5 py-0.5 rounded-sm border ${
                                SHOWING_STATUS_STYLES[e.showing.status] ?? SHOWING_STATUS_STYLES.requested
                              }`}
                            >
                              {formatTime(e.at)} · {e.showing.listing.address.split(",")[0]}
                            </div>
                          ) : (
                            <div
                              key={`f${e.appt.uid}`}
                              className="text-[10px] truncate px-1.5 py-0.5 rounded-sm border border-dashed border-border text-muted-foreground"
                              title="Follow Up Boss appointment"
                            >
                              {formatTime(e.at)} · {e.appt.title ?? "FUB appointment"}
                            </div>
                          ),
                        )}
                        {dayEntries.length > 3 && (
                          <div className="text-[10px] text-muted-foreground px-1.5">+{dayEntries.length - 3} more</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Right rail: selected day + upcoming */}
          <div className="space-y-6">
            <div>
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <div className="eyebrow text-muted-foreground">Selected day</div>
                <button
                  onClick={() => setCreating(true)}
                  className="text-[12px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
                >
                  Add a showing
                </button>
              </div>
              <div className="font-serif text-xl mb-3" style={{ letterSpacing: "-0.01em" }}>
                {formatLongDate(selectedDay)}
              </div>
              {selectedEntries.length === 0 ? (
                <Card>
                  <CardContent className="p-5 text-sm text-muted-foreground">Nothing scheduled for this day.</CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {selectedEntries.map((e) =>
                    e.kind === "showing" ? (
                      <ShowingRow key={`s${e.showing.id}`} showing={e.showing} />
                    ) : (
                      <FubAppointmentRow key={`f${e.appt.uid}`} appt={e.appt} />
                    ),
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="eyebrow text-muted-foreground mb-2">Upcoming showings · next 8</div>
              {isLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : upcoming.length === 0 ? (
                <Card>
                  <CardContent className="p-5 text-sm text-muted-foreground">Calendar is clear.</CardContent>
                </Card>
              ) : (
                <div className="space-y-1.5">
                  {upcoming.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        const d = new Date(s.scheduledFor);
                        setMonthAnchor(startOfMonth(d));
                        setSelectedDay(d);
                      }}
                      className="w-full text-left p-3 border border-border rounded-sm hover:bg-secondary/50 transition-colors"
                    >
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" strokeWidth={1.6} />
                        {new Date(s.scheduledFor).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" })} ·{" "}
                        {formatTime(s.scheduledFor)}
                        {s.status === "requested" && (
                          <Badge variant="outline" className={`rounded-sm text-[9px] uppercase border ${SHOWING_STATUS_STYLES.requested}`}>
                            requested
                          </Badge>
                        )}
                      </div>
                      <div className="text-sm font-medium truncate mt-1">{s.listing.address.split(",")[0]}</div>
                      {s.client && <div className="text-xs text-muted-foreground truncate mt-0.5">with {s.client.name}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <NewShowingDialog open={creating} onOpenChange={setCreating} day={selectedDay} />
    </AppShell>
  );
}

// =============================================================================
// Google Calendar connect / status row.
// =============================================================================

interface GoogleStatus {
  connected: boolean;
  configured: boolean;
  accountEmail: string | null;
  expiresAt: string | null;
}

function GoogleCalendarConnect() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: status } = useQuery<GoogleStatus>({
    queryKey: ["/api/admin/google/status"],
  });

  // Surface success/error from the OAuth callback redirect (URL search params).
  React.useEffect(() => {
    const search = window.location.search;
    if (!search) return;
    const qs = new URLSearchParams(search);
    const cleanUrl = window.location.pathname;
    if (qs.get("google_connected") === "1") {
      toast({ title: "Google Calendar connected", description: "Tours will now sync." });
      qc.invalidateQueries({ queryKey: ["/api/admin/google/status"] });
      window.history.replaceState(null, "", cleanUrl);
    }
    const err = qs.get("google_error");
    if (err) {
      toast({
        title: "Google connect failed",
        description: err,
        variant: "destructive",
      });
      window.history.replaceState(null, "", cleanUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("GET", "/api/admin/google/connect");
      return r.json();
    },
    onSuccess: (data: any) => {
      if (data?.url) {
        window.location.href = data.url;
      } else {
        toast({ title: "Couldn't start Google connect", description: data?.message ?? "" });
      }
    },
    onError: (e: any) => {
      toast({
        title: "Couldn't start Google connect",
        description: e?.message ?? "Server may be missing GOOGLE_OAUTH_CLIENT_ID secrets.",
        variant: "destructive",
      });
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/admin/google/disconnect");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/google/status"] });
      toast({ title: "Google Calendar disconnected" });
    },
  });

  if (!status) return null;

  return (
    <Card className="mb-5 bg-secondary/30">
      <CardContent className="p-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="eyebrow text-muted-foreground">Google Calendar sync</div>
          {status.connected ? (
            <div className="font-serif text-base mt-0.5 truncate" style={{ letterSpacing: "-0.005em" }}>
              Connected as {status.accountEmail ?? "Google account"}
            </div>
          ) : status.configured ? (
            <div className="font-serif text-base mt-0.5" style={{ letterSpacing: "-0.005em" }}>
              Not connected. Tours will only live in this app until you connect.
            </div>
          ) : (
            <div className="font-serif text-base mt-0.5 text-muted-foreground" style={{ letterSpacing: "-0.005em" }}>
              Server not configured. Set GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET on Fly.
            </div>
          )}
        </div>
        {status.configured && (
          <div className="flex items-center gap-2">
            {status.connected ? (
              <Button
                variant="outline"
                size="sm"
                className="rounded-sm font-display tracking-[0.14em] text-[11px] h-9"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                DISCONNECT
              </Button>
            ) : (
              <Button
                size="sm"
                className="rounded-sm font-display tracking-[0.14em] text-[11px] h-9"
                onClick={() => connect.mutate()}
                disabled={connect.isPending}
              >
                CONNECT GOOGLE CALENDAR
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
