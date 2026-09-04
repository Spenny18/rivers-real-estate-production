// The date + time picker shared by /book/:slug (new booking) and
// /book/manage/:uid (reschedule).
//
// The server hands back UTC ISO start times grouped by the agent's local day.
// Everything rendered here is re-projected into whatever zone the visitor
// picks, which defaults to their browser's. Nothing about a slot is decided
// client-side — this only chooses which ISO string gets posted back.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Globe, Loader2 } from "lucide-react";
import { apiUrl } from "@/lib/queryClient";

export interface SlotDay {
  date: string; // YYYY-MM-DD in the agent's timezone
  slots: string[]; // UTC ISO
}

interface SlotsResponse {
  timezone: string;
  from: string;
  to: string;
  durationMinutes: number;
  days: SlotDay[];
}

/** A short list of zones that covers where Calgary buyers actually call from. */
const COMMON_ZONES = [
  "America/Edmonton",
  "America/Vancouver",
  "America/Winnipeg",
  "America/Toronto",
  "America/Halifax",
  "America/St_Johns",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Phoenix",
  "Europe/London",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Australia/Sydney",
  "UTC",
];

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Edmonton";
  } catch {
    return "America/Edmonton";
  }
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function keyOf(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** Six stable weeks of cells so the grid never reflows between months. */
function monthGrid(anchor: Date): Date[] {
  const first = startOfMonth(anchor);
  const lead = first.getDay();
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(first.getFullYear(), first.getMonth(), 1 - lead + i));
  }
  return cells;
}

function formatTime(iso: string, tz: string, hour12: boolean) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12,
  }).format(new Date(iso));
}

export function formatLongDateTime(iso: string, tz: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
  return `${date} at ${time}`;
}

export function zoneLabel(tz: string) {
  try {
    const abbr = new Intl.DateTimeFormat("en-CA", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return abbr ? `${tz.replace(/_/g, " ")} (${abbr})` : tz.replace(/_/g, " ");
  } catch {
    return tz;
  }
}

export function BookingPicker({
  slug,
  timezone,
  onTimezoneChange,
  selected,
  onSelect,
  disabledNote,
}: {
  slug: string;
  timezone: string;
  onTimezoneChange: (tz: string) => void;
  selected: string | null;
  onSelect: (iso: string | null) => void;
  /** Shown above the slot column, e.g. the current time on a reschedule. */
  disabledNote?: string;
}) {
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()));
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [hour12, setHour12] = useState(true);

  // Pull the whole visible month in one request, plus a week either side so
  // the leading/trailing cells of the grid are accurate too.
  const from = useMemo(() => {
    const gridStart = monthGrid(monthAnchor)[0];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return keyOf(gridStart < today ? today : gridStart);
  }, [monthAnchor]);

  const { data, isLoading, isError } = useQuery<SlotsResponse>({
    queryKey: ["booking-slots", slug, from],
    queryFn: async () => {
      const r = await fetch(
        apiUrl(`/api/booking/event-types/${encodeURIComponent(slug)}/slots?from=${from}&days=45`),
      );
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 60_000,
  });

  // Slots come back keyed by the agent's local day. Re-bucket them by the
  // visitor's day so an evening Calgary slot shows on the right date for
  // someone booking from Sydney.
  const byVisitorDay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const day of data?.days ?? []) {
      for (const iso of day.slots) {
        const key = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(iso));
        const list = map.get(key) ?? [];
        list.push(iso);
        map.set(key, list);
      }
    }
    for (const list of Array.from(map.values())) list.sort();
    return map;
  }, [data, timezone]);

  // Land on the first day that actually has openings.
  useEffect(() => {
    if (activeDay && byVisitorDay.has(activeDay)) return;
    const firstOpen = Array.from(byVisitorDay.keys()).sort()[0];
    setActiveDay(firstOpen ?? null);
  }, [byVisitorDay, activeDay]);

  const grid = useMemo(() => monthGrid(monthAnchor), [monthAnchor]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const canGoBack = startOfMonth(today) < monthAnchor;
  const daySlots = activeDay ? (byVisitorDay.get(activeDay) ?? []) : [];

  return (
    <div className="grid md:grid-cols-[1fr_260px] gap-8">
      {/* ---- Month calendar ---- */}
      <div>
        <div className="flex items-center justify-between mb-5">
          <div className="font-display text-[15px] tracking-[0.06em]">
            {monthAnchor.toLocaleDateString("en-CA", { month: "long", year: "numeric" })}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => canGoBack && setMonthAnchor(addMonths(monthAnchor, -1))}
              disabled={!canGoBack}
              aria-label="Previous month"
              data-testid="button-prev-month"
              className="h-8 w-8 grid place-items-center rounded-sm border border-border disabled:opacity-30 hover:bg-secondary/60 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMonthAnchor(addMonths(monthAnchor, 1))}
              aria-label="Next month"
              data-testid="button-next-month"
              className="h-8 w-8 grid place-items-center rounded-sm border border-border hover:bg-secondary/60 transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 mb-2">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div
              key={i}
              className="text-center font-display text-[10px] tracking-[0.18em] text-muted-foreground py-1"
            >
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1" data-testid="booking-calendar">
          {grid.map((d, i) => {
            const key = keyOf(d);
            const inMonth = d.getMonth() === monthAnchor.getMonth();
            const open = byVisitorDay.has(key);
            const isToday = keyOf(today) === key;
            const isActive = activeDay === key;
            return (
              <button
                key={i}
                type="button"
                disabled={!open}
                onClick={() => {
                  setActiveDay(key);
                  onSelect(null);
                }}
                data-testid={`day-${key}`}
                aria-label={d.toLocaleDateString("en-CA", { dateStyle: "full" })}
                aria-pressed={isActive}
                className={[
                  "aspect-square rounded-sm text-[13px] font-medium transition-colors relative",
                  !inMonth ? "opacity-30" : "",
                  isActive
                    ? "bg-foreground text-background"
                    : open
                      ? "bg-secondary/70 text-foreground hover:bg-secondary"
                      : "text-muted-foreground/50 cursor-default",
                ].join(" ")}
              >
                {d.getDate()}
                {open && !isActive && (
                  <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-foreground/60" />
                )}
                {isToday && (
                  <span className="absolute inset-0 rounded-sm ring-1 ring-inset ring-foreground/30 pointer-events-none" />
                )}
              </button>
            );
          })}
        </div>

        {/* ---- Timezone ---- */}
        <div className="mt-6 flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <select
            value={timezone}
            onChange={(e) => onTimezoneChange(e.target.value)}
            data-testid="select-timezone"
            aria-label="Time zone"
            className="bg-transparent text-[13px] text-muted-foreground border-0 border-b border-border focus:outline-none focus:border-foreground py-1 max-w-full"
          >
            {Array.from(new Set([timezone, browserTimeZone(), ...COMMON_ZONES])).map((tz) => (
              <option key={tz} value={tz}>
                {zoneLabel(tz)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- Slot column ---- */}
      <div className="md:border-l md:border-border md:pl-8">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div className="font-display text-[11px] tracking-[0.18em] text-muted-foreground">
            {activeDay
              ? new Date(`${activeDay}T12:00:00`).toLocaleDateString("en-CA", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })
              : "SELECT A DAY"}
          </div>
          <div className="flex rounded-sm border border-border overflow-hidden shrink-0">
            {[true, false].map((mode) => (
              <button
                key={String(mode)}
                type="button"
                onClick={() => setHour12(mode)}
                data-testid={`button-hour-${mode ? "12" : "24"}`}
                className={`px-2 py-1 text-[10px] font-display tracking-[0.12em] transition-colors ${
                  hour12 === mode ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary/60"
                }`}
              >
                {mode ? "12H" : "24H"}
              </button>
            ))}
          </div>
        </div>

        {disabledNote && (
          <p className="text-[12px] text-muted-foreground mb-3 leading-relaxed">{disabledNote}</p>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground py-6">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading times…
          </div>
        ) : isError ? (
          <p className="text-[13px] text-muted-foreground py-6">
            Couldn't load available times. Please refresh, or call (403) 966-9237.
          </p>
        ) : daySlots.length === 0 ? (
          <p className="text-[13px] text-muted-foreground py-6 leading-relaxed">
            No openings on this day. Try another date — dotted days have availability.
          </p>
        ) : (
          <div
            className="space-y-2 md:max-h-[420px] md:overflow-y-auto md:pr-1"
            // Not "slot-…" — that prefix belongs to the individual buttons.
            data-testid="booking-slots"
          >
            {daySlots.map((iso) => {
              const isSelected = selected === iso;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => onSelect(isSelected ? null : iso)}
                  data-testid={`slot-${iso}`}
                  aria-pressed={isSelected}
                  className={`w-full py-2.5 px-3 rounded-sm border text-[13px] font-medium tracking-wide transition-colors ${
                    isSelected
                      ? "bg-foreground text-background border-foreground"
                      : "border-border hover:border-foreground/60 hover:bg-secondary/40"
                  }`}
                >
                  {formatTime(iso, timezone, hour12)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
