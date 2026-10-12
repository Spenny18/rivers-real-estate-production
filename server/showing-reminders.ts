// Morning-of text reminders for showings, from the business line (server/sms.ts).
//
// When it goes out (Calgary time):
//   - 8:00 a.m. on the day of the showing, or
//   - 6:00 p.m. the evening before, for a showing that starts before 9:00 a.m.
//     (an 8 a.m. text for an 8:30 showing is too late to be useful).
//
// Who gets one: a confirmed showing with notifyClient on and a client phone
// number. Not one booked after its reminder time — the client was just sent
// the invite — and never twice (tours.reminderSentAt). A job that was down
// over the reminder time still sends late, as long as the showing is at least
// 30 minutes away.

import { storage } from "./storage";
import { sendSms, smsConfigured } from "./sms";
import { zonedParts, zonedTimeToUtc } from "./booking";
import { AGENT } from "./brand";
import { SHOWING_TIME_ZONE, resolveShowingListing, showingClient } from "./showings";
import { showingStreetLine } from "@shared/showing-address";
import type { Tour } from "@shared/schema";

const MORNING_MINUTE = 8 * 60;
const EVENING_BEFORE_MINUTE = 18 * 60;
const EARLY_SHOWING_MINUTE = 9 * 60;
const TOO_LATE_MS = 30 * 60_000;
const TICK_MS = 5 * 60_000;

/** When this showing's reminder is due, as a UTC instant. */
export function reminderDueAt(startIso: string): Date {
  const start = new Date(startIso);
  const local = zonedParts(start, SHOWING_TIME_ZONE);
  if (local.minuteOfDay >= EARLY_SHOWING_MINUTE) {
    return zonedTimeToUtc(local.year, local.month, local.day, MORNING_MINUTE, SHOWING_TIME_ZONE);
  }
  // The evening before: step back a calendar day in local terms.
  const prev = zonedParts(new Date(zonedTimeToUtc(local.year, local.month, local.day, 12 * 60, SHOWING_TIME_ZONE).getTime() - 86_400_000), SHOWING_TIME_ZONE);
  return zonedTimeToUtc(prev.year, prev.month, prev.day, EVENING_BEFORE_MINUTE, SHOWING_TIME_ZONE);
}

function localTime(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SHOWING_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function localDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SHOWING_TIME_ZONE, weekday: "long", month: "short", day: "numeric" }).format(new Date(iso));
}

export function buildReminderText(tour: Tour, now = new Date()): string {
  const listing = resolveShowingListing(tour.listingId);
  const client = showingClient(tour);
  const first = client?.name.trim().split(/\s+/)[0];
  const sameDay = zonedParts(now, SHOWING_TIME_ZONE).date === zonedParts(new Date(tour.scheduledFor), SHOWING_TIME_ZONE).date;
  const when = sameDay ? `today at ${localTime(tour.scheduledFor)}` : `tomorrow (${localDay(tour.scheduledFor)}) at ${localTime(tour.scheduledFor)}`;
  // The town, when the address carries one, without the province.
  const town = listing.address.split(",").map((s) => s.trim()).find((p, i) => i > 0 && !/^\d/.test(p) && !/^(AB|Alberta)$/i.test(p));
  const place = `${showingStreetLine(listing.address)}${town ? `, ${town}` : ""}`;
  return [
    `Hi${first ? ` ${first}` : ""}, a reminder of your showing ${when} at ${place}.`,
    tour.notes ? tour.notes.trim() : null,
    `Reply here if anything changes. See you there!`,
    `${AGENT.name}, ${AGENT.business}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function reminderEligible(tour: Tour, now = new Date()): { due: boolean; reason?: string } {
  if (tour.reminderSentAt) return { due: false, reason: "already sent" };
  if (tour.status !== "confirmed") return { due: false, reason: `status ${tour.status}` };
  if (!tour.notifyClient) return { due: false, reason: "notifications off" };
  if (!showingClient(tour)?.phone) return { due: false, reason: "no client phone" };
  const start = Date.parse(tour.scheduledFor);
  const due = reminderDueAt(tour.scheduledFor).getTime();
  if (now.getTime() < due) return { due: false, reason: "not yet" };
  if (start - now.getTime() < TOO_LATE_MS) return { due: false, reason: "too close to the showing" };
  if (Date.parse(tour.createdAt) >= due) return { due: false, reason: "booked after its reminder time" };
  return { due: true };
}

export async function sendShowingReminder(tour: Tour, now = new Date()): Promise<{ ok: boolean; error?: string }> {
  const client = showingClient(tour);
  const r = await sendSms(client!.phone!, buildReminderText(tour, now), {
    kind: "reminder",
    contactFubId: tour.contactFubId,
    tourId: tour.id,
  });
  storage.updateTour(tour.id, r.ok ? { reminderSentAt: new Date().toISOString(), reminderError: null } : { reminderError: (r.error ?? "send failed").slice(0, 300) });
  return r;
}

export async function reminderTick(now = new Date()): Promise<number> {
  if (!smsConfigured().ok) return 0;
  // Only showings in the next ~day and a half can be due.
  const horizon = now.getTime() + 36 * 3600_000;
  let sent = 0;
  for (const tour of storage.listTours()) {
    const start = Date.parse(tour.scheduledFor);
    if (!(start > now.getTime() && start < horizon)) continue;
    // A failed send isn't retried every five minutes into a dead number.
    if (tour.reminderError) continue;
    if (!reminderEligible(tour, now).due) continue;
    const r = await sendShowingReminder(tour, now);
    if (r.ok) sent++;
    else console.error(`[reminders] showing #${tour.id}: ${r.error}`);
  }
  if (sent) console.log(`[reminders] sent ${sent} showing reminder${sent === 1 ? "" : "s"}`);
  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startShowingReminderCron() {
  if (timer) return;
  timer = setInterval(() => {
    reminderTick().catch((e) => console.error("[reminders] uncaught:", e));
  }, TICK_MS);
  console.log(`[reminders] scheduled (every ${TICK_MS / 60_000} min; ${smsConfigured().ok ? "texting configured" : "waiting for Twilio settings"})`);
}
