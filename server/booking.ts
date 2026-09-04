// The scheduling engine behind /book (public) and /admin/scheduling (admin).
//
// What it does, in order, when someone opens a booking page:
//
//   1. Read the event type's weekly windows (its own, or the default
//      schedule) and apply any one-off date overrides.
//   2. Walk each local day in slot-interval steps, keeping only candidate
//      slots whose full duration fits inside a window.
//   3. Drop anything that is too soon (minimum notice), too far out
//      (advance days), collides with an existing booking, an existing tour,
//      or a Google Calendar busy block — each collision widened by the event
//      type's before/after buffers.
//   4. Drop the rest of a day once it has hit its per-day cap.
//
// Everything is stored in UTC. Availability is stored as minutes from local
// midnight in the event type's IANA zone, so "9:00 AM" stays 9:00 AM across
// a DST change rather than sliding an hour twice a year. There is no tz
// library in this project on purpose — `Intl.DateTimeFormat` already knows
// every zone the runtime does, and the two helpers below are all we need.

import { randomBytes } from "node:crypto";
import { storage } from "./storage";
import type { BookingEventType, Booking } from "@shared/schema";

export interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms
}

export interface DaySlots {
  date: string; // YYYY-MM-DD in the event type's timezone
  slots: string[]; // UTC ISO start times
}

// ---- Timezone primitives ---------------------------------------------------

/**
 * How far the given zone is ahead of UTC at that instant, in milliseconds.
 * Positive east of Greenwich; Calgary returns -6h (MDT) or -7h (MST).
 */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl renders midnight as "24" in some ICU versions.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

/**
 * Turn a local wall-clock time into the UTC instant it names.
 *
 * The offset depends on the instant we're solving for, so we guess with the
 * offset at the naive timestamp and then correct once — enough to land on the
 * right side of any DST transition.
 *
 * A wall time inside a spring-forward gap names no instant at all (in
 * America/Edmonton, 2026-03-08 02:30 never happens). This returns a Date
 * anyway — the nearest the correction converges on, which lands *before* the
 * gap, not after it. Callers that must not silently shift a time by an hour
 * should use `zonedTimeToUtcStrict` instead; this one is for range bounds
 * like local midnight, where being an hour out is harmless.
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  minuteOfDay: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minuteOfDay * 60_000;
  let ts = naive - tzOffsetMs(new Date(naive), timeZone);
  ts = naive - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/**
 * As `zonedTimeToUtc`, but null when the wall time doesn't exist in that zone
 * — i.e. it falls in a spring-forward gap. Verified by projecting the result
 * back: a real wall time round-trips to the same date and minute, a
 * nonexistent one doesn't.
 */
export function zonedTimeToUtcStrict(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
): Date | null {
  const d = zonedTimeToUtc(year, month, day, minuteOfDay, timeZone);
  const back = zonedParts(d, timeZone);
  const wanted = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (back.date !== wanted || back.minuteOfDay !== minuteOfDay) return null;
  return d;
}

/** The local calendar date + minute-of-day an instant falls on in a zone. */
export function zonedParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  minuteOfDay: number;
  dayOfWeek: number; // 0 = Sunday
  date: string; // YYYY-MM-DD
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const WEEKDAYS: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    minuteOfDay: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dayOfWeek: WEEKDAYS[parts.weekday] ?? 0,
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** "YYYY-MM-DD" -> {year, month, day}. Returns null when malformed. */
export function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** The date key `n` days after `key`, on the civil calendar. */
export function addDaysToKey(key: string, n: number): string {
  const p = parseDateKey(key);
  if (!p) return key;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** Today's date key in a zone. */
export function todayKey(timeZone: string): string {
  return zonedParts(new Date(), timeZone).date;
}

export function isValidTimeZone(tz: string | undefined | null): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---- Availability ----------------------------------------------------------

interface Window {
  startMinute: number;
  endMinute: number;
}

/**
 * The weekly windows in force for an event type: its own rows if it has any,
 * otherwise the shared default schedule.
 */
export function weeklyWindowsFor(eventTypeId: number): Map<number, Window[]> {
  let rows = storage.listBookingAvailability(eventTypeId);
  if (rows.length === 0) rows = storage.listBookingAvailability(null);
  const byDay = new Map<number, Window[]>();
  for (const r of rows) {
    if (r.endMinute <= r.startMinute) continue;
    const list = byDay.get(r.dayOfWeek) ?? [];
    list.push({ startMinute: r.startMinute, endMinute: r.endMinute });
    byDay.set(r.dayOfWeek, list);
  }
  for (const list of Array.from(byDay.values())) {
    list.sort((a, b) => a.startMinute - b.startMinute);
  }
  return byDay;
}

/** Merge overlapping intervals so collision checks stay linear. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const out: Interval[] = [sorted[0]];
  for (const iv of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Everything already on the calendar between two instants: confirmed
 * bookings, scheduled showings from the tours table, and — when Google is
 * connected — the agent's real free/busy blocks.
 *
 * An existing booking is widened by *its own* event type's buffers, so the
 * padding a meeting asked for protects the time around that meeting. Widening
 * only the candidate (which `computeSlots` also does, for busy blocks that
 * have no owning event type) would point the padding the wrong way: a
 * candidate's after-buffer would block time *before* someone else's booking
 * while leaving the slot immediately after it open.
 */
export async function collectBusy(
  userId: number,
  fromIso: string,
  toIso: string,
  opts: { excludeBookingId?: number; includeGoogle?: boolean } = {},
): Promise<Interval[]> {
  const busy: Interval[] = [];

  const buffersByType = new Map<number, { before: number; after: number }>();
  for (const et of storage.listBookingEventTypes()) {
    buffersByType.set(et.id, {
      before: Math.max(0, et.bufferBeforeMinutes) * 60_000,
      after: Math.max(0, et.bufferAfterMinutes) * 60_000,
    });
  }
  for (const b of storage.listBookingsInRange(fromIso, toIso, opts.excludeBookingId)) {
    const pad = buffersByType.get(b.eventTypeId) ?? { before: 0, after: 0 };
    busy.push({
      start: Date.parse(b.startsAt) - pad.before,
      end: Date.parse(b.endsAt) + pad.after,
    });
  }

  // Showings booked through the older tours flow occupy the calendar too.
  // They carry no duration, so assume the same hour the Google sync assumes.
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  for (const t of storage.listTours()) {
    if (t.status === "cancelled") continue;
    const start = Date.parse(t.scheduledFor);
    if (!Number.isFinite(start)) continue;
    const end = start + 60 * 60_000;
    if (end <= fromMs || start >= toMs) continue;
    busy.push({ start, end });
  }

  if (opts.includeGoogle !== false) {
    try {
      const { getFreeBusy } = await import("./google-calendar");
      const blocks = await getFreeBusy(userId, fromIso, toIso);
      for (const b of blocks) {
        const start = Date.parse(b.start);
        const end = Date.parse(b.end);
        if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end });
      }
    } catch (e: any) {
      // A Google outage must not take the booking page down — worst case we
      // offer a slot the agent has to decline.
      console.warn("[booking] free/busy lookup failed:", e?.message);
    }
  }

  return mergeIntervals(busy);
}

/**
 * Build the bookable slots for an event type across a date range.
 *
 * `fromDate`/`toDate` are inclusive YYYY-MM-DD keys in the event type's zone.
 * Returns one entry per day that has at least one slot.
 */
export function computeSlots(opts: {
  eventType: BookingEventType;
  fromDate: string;
  toDate: string;
  busy: Interval[];
  now?: Date;
  /** Existing confirmed bookings, for the per-day cap. */
  bookedStarts?: number[];
}): DaySlots[] {
  const et = opts.eventType;
  const tz = isValidTimeZone(et.timezone) ? et.timezone : "America/Edmonton";
  const now = opts.now ?? new Date();
  const duration = Math.max(5, et.durationMinutes) * 60_000;
  const bufferBefore = Math.max(0, et.bufferBeforeMinutes) * 60_000;
  const bufferAfter = Math.max(0, et.bufferAfterMinutes) * 60_000;
  const interval = Math.max(5, et.slotIntervalMinutes);
  const earliest = now.getTime() + Math.max(0, et.minimumNoticeMinutes) * 60_000;
  const horizon = now.getTime() + Math.max(1, et.advanceDays) * 86_400_000;

  const weekly = weeklyWindowsFor(et.id);
  const overrides = new Map(storage.listBookingDateOverrides(opts.fromDate).map((o) => [o.date, o]));
  const busy = mergeIntervals(opts.busy);

  const out: DaySlots[] = [];
  let dateKey = opts.fromDate;
  // Hard stop so a bad range can never spin: a year of days is plenty.
  for (let guard = 0; guard < 400 && dateKey <= opts.toDate; guard++, dateKey = addDaysToKey(dateKey, 1)) {
    const parts = parseDateKey(dateKey);
    if (!parts) break;

    // Local midnight tells us which weekday this date is in the agent's zone.
    const midnight = zonedTimeToUtc(parts.year, parts.month, parts.day, 0, tz);
    const dayOfWeek = zonedParts(midnight, tz).dayOfWeek;

    let windows = weekly.get(dayOfWeek) ?? [];
    const override = overrides.get(dateKey);
    if (override) {
      if (override.unavailable) continue; // Day closed outright.
      if (override.startMinute != null && override.endMinute != null) {
        windows = [{ startMinute: override.startMinute, endMinute: override.endMinute }];
      }
    }
    if (windows.length === 0) continue;

    // A per-day cap limits how many meetings get booked, not how many times
    // are shown: the day stays fully open until the cap is actually reached,
    // then closes entirely.
    const cap = et.maxPerDay ?? null;
    if (cap != null && opts.bookedStarts) {
      const bookedToday = opts.bookedStarts.filter(
        (ms) => zonedParts(new Date(ms), tz).date === dateKey,
      ).length;
      if (bookedToday >= cap) continue;
    }

    const slots: string[] = [];
    for (const w of windows) {
      for (let m = w.startMinute; m + et.durationMinutes <= w.endMinute; m += interval) {
        // Skip wall times that don't exist — on a spring-forward day a window
        // covering the gap would otherwise offer slots an hour off its
        // configured hours.
        const startDate = zonedTimeToUtcStrict(parts.year, parts.month, parts.day, m, tz);
        if (!startDate) continue;
        const start = startDate.getTime();
        const end = start + duration;
        if (start < earliest || start > horizon) continue;
        const guarded: Interval = { start: start - bufferBefore, end: end + bufferAfter };
        if (busy.some((b) => overlaps(guarded, b))) continue;
        slots.push(new Date(start).toISOString());
      }
    }

    if (slots.length > 0) {
      // Windows can overlap; de-dupe and order before handing to the client.
      out.push({ date: dateKey, slots: Array.from(new Set(slots)).sort() });
    }
  }

  return out;
}

/**
 * Re-check a single start time at the moment of booking. The slot list the
 * browser holds can be seconds or minutes stale, so this is what actually
 * decides whether a booking is allowed.
 */
export function isSlotBookable(opts: {
  eventType: BookingEventType;
  startIso: string;
  busy: Interval[];
  now?: Date;
  bookedStarts?: number[];
}): { ok: true } | { ok: false; reason: string } {
  const start = Date.parse(opts.startIso);
  if (!Number.isFinite(start)) return { ok: false, reason: "That start time isn't a valid date." };
  const tz = isValidTimeZone(opts.eventType.timezone)
    ? opts.eventType.timezone
    : "America/Edmonton";
  const dateKey = zonedParts(new Date(start), tz).date;
  const day = computeSlots({
    eventType: opts.eventType,
    fromDate: dateKey,
    toDate: dateKey,
    busy: opts.busy,
    now: opts.now,
    bookedStarts: opts.bookedStarts,
  })[0];
  if (!day || !day.slots.includes(new Date(start).toISOString())) {
    return { ok: false, reason: "That time is no longer available. Please pick another slot." };
  }
  return { ok: true };
}

// ---- Formatting + identifiers ---------------------------------------------

export function newBookingUid(): string {
  return randomBytes(16).toString("hex");
}

export function locationLabel(et: BookingEventType): string {
  switch (et.locationType) {
    case "phone":
      return et.locationDetail?.trim() || "Phone call — Spencer will call you";
    case "video":
      return et.locationDetail?.trim() || "Video call — link sent on confirmation";
    case "in_person":
      return et.locationDetail?.trim() || "In person";
    default:
      return et.locationDetail?.trim() || "Details to follow";
  }
}

/** e.g. "Thursday, October 9, 2025 at 2:00 PM MDT" */
export function formatInZone(iso: string, timeZone: string): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : "America/Edmonton";
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

// ---- ICS -------------------------------------------------------------------

function icsEscape(s: string): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 calendar file the invitee can add to Apple/Outlook/anything. */
export function buildIcs(opts: {
  booking: Booking;
  eventType: BookingEventType;
  organizerName: string;
  organizerEmail: string;
  origin: string;
}): string {
  const { booking, eventType } = opts;
  const cancelled = booking.status === "cancelled";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rivers Real Estate//Booking//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancelled ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${booking.uid}@riversrealestate.ca`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(booking.startsAt)}`,
    `DTEND:${icsStamp(booking.endsAt)}`,
    `SUMMARY:${icsEscape(`${eventType.name} — ${opts.organizerName}`)}`,
    `DESCRIPTION:${icsEscape(
      [
        eventType.description,
        "",
        `Location: ${locationLabel(eventType)}`,
        booking.notes ? `Notes: ${booking.notes}` : "",
        "",
        `Reschedule or cancel: ${opts.origin}/book/manage/${booking.uid}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )}`,
    `LOCATION:${icsEscape(locationLabel(eventType))}`,
    `ORGANIZER;CN=${icsEscape(opts.organizerName)}:mailto:${opts.organizerEmail}`,
    `ATTENDEE;CN=${icsEscape(booking.name)};RSVP=FALSE:mailto:${booking.email}`,
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    `SEQUENCE:${cancelled ? 1 : 0}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(eventType.name)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  // ICS wants CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}
