// HTTP surface for the scheduler.
//
//   /api/booking/*        public — the /book pages. No auth; the invitee's
//                         unguessable booking uid is the only credential.
//   /api/admin/booking/*  agent — everything behind requireAuth.
//
// Slot availability is always recomputed server-side at write time. The
// browser's slot list is only a suggestion; `isSlotBookable` is what decides.

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { createBookingSchema, LOCATION_TYPES, BOOKING_STATUSES } from "@shared/schema";
import type { BookingEventType, Booking } from "@shared/schema";
import {
  addDaysToKey,
  buildIcs,
  collectBusy,
  computeSlots,
  formatInZone,
  isSlotBookable,
  isValidTimeZone,
  locationLabel,
  newBookingUid,
  parseDateKey,
  todayKey,
  zonedParts,
  zonedTimeToUtc,
} from "./booking";
import {
  sendEmail,
  buildBookingConfirmationHtml,
  buildBookingAgentNotificationHtml,
  buildBookingCancellationHtml,
  buildBookingRescheduleHtml,
  type BookingEmailData,
} from "./email";
import { pushLeadToFollowUpBoss } from "./follow-up-boss";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function origin(): string {
  return (process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca").replace(/\/$/, "");
}

/** The agent the bookings belong to. Single-agent app — Spencer or user #1. */
function agentUser() {
  return (
    storage.getUserByEmail("spencer@riversrealestate.ca") ?? storage.getUserById(1) ?? null
  );
}

/** Everything the public booking page may see about an event type. */
function publicEventType(et: BookingEventType) {
  return {
    id: et.id,
    slug: et.slug,
    name: et.name,
    description: et.description,
    durationMinutes: et.durationMinutes,
    locationType: et.locationType,
    locationLabel: locationLabel(et),
    color: et.color,
    timezone: et.timezone,
    requirePhone: et.requirePhone,
    customQuestion: et.customQuestion,
    confirmationMessage: et.confirmationMessage,
    advanceDays: et.advanceDays,
    minimumNoticeMinutes: et.minimumNoticeMinutes,
  };
}

/** Everything the invitee's manage page may see about their own booking. */
function publicBooking(b: Booking, et: BookingEventType) {
  return {
    uid: b.uid,
    name: b.name,
    email: b.email,
    phone: b.phone,
    notes: b.notes,
    answer: b.answer,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    timezone: b.timezone,
    status: b.status,
    cancelReason: b.cancelReason,
    eventType: publicEventType(et),
  };
}

function emailData(
  b: Booking,
  et: BookingEventType,
  tz: string,
): BookingEmailData {
  return {
    eventName: et.name,
    whenLabel: formatInZone(b.startsAt, tz),
    durationMinutes: et.durationMinutes,
    locationLabel: locationLabel(et),
    inviteeName: b.name,
    inviteeEmail: b.email,
    inviteePhone: b.phone,
    notes: b.notes,
    question: et.customQuestion,
    answer: b.answer,
    manageUrl: `${origin()}/book/manage/${b.uid}`,
    origin: origin(),
  };
}

function agentEmail(): string {
  return (
    process.env.SPENCER_NOTIFY_EMAIL ||
    process.env.RESEND_FROM_EMAIL ||
    "spencer@riversrealestate.ca"
  );
}

/**
 * Push the booking onto Google Calendar and store the returned event id.
 * Never throws — a calendar hiccup must not fail the booking itself.
 */
async function mirrorToGoogle(booking: Booking, et: BookingEventType): Promise<Booking> {
  const user = agentUser();
  if (!user) return booking;
  try {
    const { syncBookingToGoogle } = await import("./google-calendar");
    const r = await syncBookingToGoogle(user.id, booking, et, origin());
    if (r.ok && r.eventId && r.eventId !== booking.googleEventId) {
      return storage.updateBooking(booking.id, { googleEventId: r.eventId }) ?? booking;
    }
  } catch (e: any) {
    console.warn("[booking] google sync failed:", e?.message);
  }
  return booking;
}

async function unmirrorFromGoogle(booking: Booking): Promise<void> {
  const user = agentUser();
  if (!user || !booking.googleEventId) return;
  try {
    const { deleteBookingFromGoogle } = await import("./google-calendar");
    await deleteBookingFromGoogle(user.id, booking.googleEventId);
    storage.updateBooking(booking.id, { googleEventId: null });
  } catch (e: any) {
    console.warn("[booking] google delete failed:", e?.message);
  }
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Express 5 types a route param as string | string[]; we only ever want one. */
function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export function registerBookingRoutes(
  app: Express,
  deps: {
    requireAuth: Middleware;
    rateLimit: (opts: { windowMs: number; max: number; key: string }) => Middleware;
  },
) {
  const { requireAuth, rateLimit } = deps;

  // Booking is a public write endpoint, so cap it per IP the same way the
  // inquiry form is capped.
  const bookLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, key: "booking" });
  const manageLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: "booking-manage" });

  // ======================= PUBLIC =========================================

  // The bookable meeting types, for /book.
  app.get("/api/booking/event-types", (_req, res) => {
    res.json(storage.listBookingEventTypes().filter((et) => et.active).map(publicEventType));
  });

  app.get("/api/booking/event-types/:slug", (req, res) => {
    const et = storage.getBookingEventTypeBySlug(param(req, "slug"));
    if (!et || !et.active) return res.status(404).json({ message: "Meeting type not found" });
    res.json(publicEventType(et));
  });

  /**
   * GET /api/booking/event-types/:slug/slots?from=YYYY-MM-DD&days=N
   *
   * Open slots for a date range, as UTC ISO starts grouped by local day.
   * The client renders them in whatever zone the visitor is in.
   */
  app.get("/api/booking/event-types/:slug/slots", async (req, res) => {
    const et = storage.getBookingEventTypeBySlug(param(req, "slug"));
    if (!et || !et.active) return res.status(404).json({ message: "Meeting type not found" });

    const tz = isValidTimeZone(et.timezone) ? et.timezone : "America/Edmonton";
    const today = todayKey(tz);
    const requested = typeof req.query.from === "string" ? req.query.from : "";
    // Never look further back than today — past slots aren't bookable anyway.
    const from = parseDateKey(requested) && requested >= today ? requested : today;
    const days = clamp(toInt(req.query.days, 35), 1, 62);
    const to = addDaysToKey(from, days - 1);

    // Widen the busy lookup by a day on each side so a meeting that starts
    // the evening before still blocks an early slot through its buffer.
    const fromParts = parseDateKey(addDaysToKey(from, -1))!;
    const toParts = parseDateKey(addDaysToKey(to, 2))!;
    const rangeStart = zonedTimeToUtc(fromParts.year, fromParts.month, fromParts.day, 0, tz);
    const rangeEnd = zonedTimeToUtc(toParts.year, toParts.month, toParts.day, 0, tz);

    const user = agentUser();
    const busy = user
      ? await collectBusy(user.id, rangeStart.toISOString(), rangeEnd.toISOString())
      : [];
    const bookedStarts = storage
      .listBookingsInRange(rangeStart.toISOString(), rangeEnd.toISOString())
      .filter((b) => b.eventTypeId === et.id)
      .map((b) => Date.parse(b.startsAt));

    const days_ = computeSlots({ eventType: et, fromDate: from, toDate: to, busy, bookedStarts });
    res.json({
      timezone: tz,
      from,
      to,
      durationMinutes: et.durationMinutes,
      days: days_,
    });
  });

  /** POST /api/booking/event-types/:slug/book — create a booking. */
  app.post("/api/booking/event-types/:slug/book", bookLimiter, async (req, res) => {
    const et = storage.getBookingEventTypeBySlug(param(req, "slug"));
    if (!et || !et.active) return res.status(404).json({ message: "Meeting type not found" });

    const parsed = createBookingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: parsed.error.issues[0]?.message ?? "Please check the form." });
    }
    const input = parsed.data;
    if (et.requirePhone && !input.phone?.trim()) {
      return res.status(400).json({ message: "A phone number is required for this meeting." });
    }
    const startMs = Date.parse(input.startsAt);
    if (!Number.isFinite(startMs)) {
      return res.status(400).json({ message: "That start time isn't valid." });
    }

    const user = agentUser();
    const windowStart = new Date(startMs - 24 * 3600_000).toISOString();
    const windowEnd = new Date(startMs + 24 * 3600_000).toISOString();
    const busy = user ? await collectBusy(user.id, windowStart, windowEnd) : [];
    const bookedStarts = storage
      .listBookingsInRange(windowStart, windowEnd)
      .filter((b) => b.eventTypeId === et.id)
      .map((b) => Date.parse(b.startsAt));

    const check = isSlotBookable({
      eventType: et,
      startIso: new Date(startMs).toISOString(),
      busy,
      bookedStarts,
    });
    if (!check.ok) return res.status(409).json({ message: check.reason });

    const inviteeTz = isValidTimeZone(input.timezone) ? input.timezone! : et.timezone;
    const booking = storage.createBooking({
      uid: newBookingUid(),
      eventTypeId: et.id,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: input.phone?.trim() || null,
      notes: input.notes?.trim() || null,
      answer: input.answer?.trim() || null,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(startMs + et.durationMinutes * 60_000).toISOString(),
      timezone: inviteeTz,
      status: "confirmed",
      listingId: input.listingId?.trim() || null,
      source: "booking_page",
    });

    // A booking is a lead. Record it in the CRM the same way an inquiry is,
    // so it shows up in /admin/leads and flows to Follow Up Boss.
    let withLead = booking;
    try {
      const lead = storage.createLead({
        listingId: booking.listingId ?? null,
        name: booking.name,
        email: booking.email,
        phone: booking.phone ?? null,
        message:
          `Booked: ${et.name} — ${formatInZone(booking.startsAt, et.timezone)}` +
          (booking.notes ? `\n\n${booking.notes}` : "") +
          (et.customQuestion && booking.answer
            ? `\n\n${et.customQuestion}\n${booking.answer}`
            : ""),
        source: `Booking — ${et.name}`,
        status: "new",
      } as any);
      withLead = storage.updateBooking(booking.id, { leadId: lead.id }) ?? booking;
    } catch (e: any) {
      console.warn("[booking] lead create failed:", e?.message);
    }

    const synced = await mirrorToGoogle(withLead, et);

    // Emails: confirmation to the invitee, heads-up to the agent.
    const d = emailData(synced, et, inviteeTz);
    sendEmail({
      to: synced.email,
      subject: `Confirmed: ${et.name} — ${formatInZone(synced.startsAt, inviteeTz)}`,
      html: buildBookingConfirmationHtml(d),
      replyTo: agentEmail(),
    }).catch((e) => console.warn("[booking] confirmation email failed:", e?.message));
    sendEmail({
      to: agentEmail(),
      subject: `New booking — ${synced.name}, ${formatInZone(synced.startsAt, et.timezone)}`,
      html: buildBookingAgentNotificationHtml(emailData(synced, et, et.timezone)),
      replyTo: synced.email,
    }).catch((e) => console.warn("[booking] agent email failed:", e?.message));

    pushLeadToFollowUpBoss({
      name: synced.name,
      email: synced.email,
      phone: synced.phone ?? undefined,
      message: `Booked ${et.name} for ${formatInZone(synced.startsAt, et.timezone)}.${
        synced.notes ? ` Notes: ${synced.notes}` : ""
      }`,
      source: `Booking — ${et.name}`,
    }).catch((e) => console.warn("[booking] FUB push failed:", e?.message));

    res.status(201).json(publicBooking(synced, et));
  });

  /** The invitee's own view of their booking — the uid is the credential. */
  app.get("/api/booking/bookings/:uid", (req, res) => {
    const b = storage.getBookingByUid(param(req, "uid"));
    if (!b) return res.status(404).json({ message: "Booking not found" });
    const et = storage.getBookingEventType(b.eventTypeId);
    if (!et) return res.status(404).json({ message: "Booking not found" });
    res.json(publicBooking(b, et));
  });

  /** The .ics file, for Apple Calendar / Outlook / anything non-Google. */
  app.get("/api/booking/bookings/:uid/ics", (req, res) => {
    const b = storage.getBookingByUid(param(req, "uid"));
    if (!b) return res.status(404).send("Not found");
    const et = storage.getBookingEventType(b.eventTypeId);
    if (!et) return res.status(404).send("Not found");
    const user = agentUser();
    const ics = buildIcs({
      booking: b,
      eventType: et,
      organizerName: user?.name ?? "Spencer Rivers",
      organizerEmail: agentEmail(),
      origin: origin(),
    });
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${et.slug}-${b.uid.slice(0, 8)}.ics"`);
    res.send(ics);
  });

  /** POST /api/booking/bookings/:uid/cancel — invitee cancels. */
  app.post("/api/booking/bookings/:uid/cancel", manageLimiter, async (req, res) => {
    const b = storage.getBookingByUid(param(req, "uid"));
    if (!b) return res.status(404).json({ message: "Booking not found" });
    const et = storage.getBookingEventType(b.eventTypeId);
    if (!et) return res.status(404).json({ message: "Booking not found" });
    if (b.status === "cancelled") return res.json(publicBooking(b, et));

    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
    await unmirrorFromGoogle(b);
    const updated =
      storage.updateBooking(b.id, {
        status: "cancelled",
        cancelReason: reason,
        cancelledAt: new Date().toISOString(),
        cancelledBy: "invitee",
        googleEventId: null,
      }) ?? b;

    const bookAgainUrl = `${origin()}/book/${et.slug}`;
    sendEmail({
      to: updated.email,
      subject: `Cancelled: ${et.name} — ${formatInZone(updated.startsAt, updated.timezone)}`,
      html: buildBookingCancellationHtml({
        ...emailData(updated, et, updated.timezone),
        reason,
        bookAgainUrl,
      }),
      replyTo: agentEmail(),
    }).catch(() => {});
    sendEmail({
      to: agentEmail(),
      subject: `Cancelled — ${updated.name}, ${formatInZone(updated.startsAt, et.timezone)}`,
      html: buildBookingCancellationHtml({
        ...emailData(updated, et, et.timezone),
        reason,
        bookAgainUrl,
        toAgent: true,
      }),
    }).catch(() => {});

    res.json(publicBooking(updated, et));
  });

  /** POST /api/booking/bookings/:uid/reschedule — invitee moves the time. */
  app.post("/api/booking/bookings/:uid/reschedule", manageLimiter, async (req, res) => {
    const b = storage.getBookingByUid(param(req, "uid"));
    if (!b) return res.status(404).json({ message: "Booking not found" });
    const et = storage.getBookingEventType(b.eventTypeId);
    if (!et) return res.status(404).json({ message: "Booking not found" });
    if (b.status === "cancelled") {
      return res.status(409).json({ message: "This booking was cancelled — please book a new time." });
    }

    const startMs = Date.parse(String(req.body?.startsAt ?? ""));
    if (!Number.isFinite(startMs)) {
      return res.status(400).json({ message: "Pick a new time first." });
    }

    const user = agentUser();
    const windowStart = new Date(startMs - 24 * 3600_000).toISOString();
    const windowEnd = new Date(startMs + 24 * 3600_000).toISOString();
    // The booking's current slot must not block its own move.
    const busy = user
      ? await collectBusy(user.id, windowStart, windowEnd, { excludeBookingId: b.id })
      : [];
    const bookedStarts = storage
      .listBookingsInRange(windowStart, windowEnd, b.id)
      .filter((x) => x.eventTypeId === et.id)
      .map((x) => Date.parse(x.startsAt));
    const check = isSlotBookable({
      eventType: et,
      startIso: new Date(startMs).toISOString(),
      busy,
      bookedStarts,
    });
    if (!check.ok) return res.status(409).json({ message: check.reason });

    const previousWhenLabel = formatInZone(b.startsAt, b.timezone);
    let updated =
      storage.updateBooking(b.id, {
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(startMs + et.durationMinutes * 60_000).toISOString(),
        status: "confirmed",
      }) ?? b;
    updated = await mirrorToGoogle(updated, et);

    sendEmail({
      to: updated.email,
      subject: `Moved: ${et.name} — ${formatInZone(updated.startsAt, updated.timezone)}`,
      html: buildBookingRescheduleHtml({
        ...emailData(updated, et, updated.timezone),
        previousWhenLabel,
      }),
      replyTo: agentEmail(),
    }).catch(() => {});
    sendEmail({
      to: agentEmail(),
      subject: `Rescheduled — ${updated.name}, ${formatInZone(updated.startsAt, et.timezone)}`,
      html: buildBookingRescheduleHtml({
        ...emailData(updated, et, et.timezone),
        previousWhenLabel: formatInZone(b.startsAt, et.timezone),
        toAgent: true,
      }),
    }).catch(() => {});

    res.json(publicBooking(updated, et));
  });

  // ======================= ADMIN ==========================================

  /** Dashboard summary: counts, next booking, connection state. */
  app.get("/api/admin/booking/stats", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    const now = new Date();
    const all = storage.listBookings();
    const upcoming = all.filter((b) => b.status === "confirmed" && Date.parse(b.startsAt) >= now.getTime());
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const weekAhead = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    const integ = storage.getUserIntegration(userId, "google");
    res.json({
      upcoming: upcoming.length,
      next: upcoming[0] ?? null,
      bookedLast7: all.filter((b) => b.createdAt >= weekAgo).length,
      upcomingNext7: upcoming.filter((b) => b.startsAt <= weekAhead).length,
      cancelled: all.filter((b) => b.status === "cancelled").length,
      total: all.length,
      eventTypes: storage.listBookingEventTypes().length,
      google: {
        connected: !!(integ && integ.active),
        configured:
          !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        accountEmail: integ?.accountEmail ?? null,
        // The free/busy scope was added after the first release; a token
        // issued before that needs one reconnect to gain it.
        freeBusyScope: !!integ?.scope?.includes("calendar.freebusy"),
      },
      origin: origin(),
    });
  });

  app.get("/api/admin/booking/bookings", requireAuth, (req, res) => {
    const status = typeof req.query.status === "string" && req.query.status !== "all"
      ? req.query.status
      : undefined;
    const rows = storage.listBookings({
      status,
      from: typeof req.query.from === "string" ? req.query.from : undefined,
      to: typeof req.query.to === "string" ? req.query.to : undefined,
    });
    const types = new Map(storage.listBookingEventTypes().map((et) => [et.id, et]));
    res.json(
      rows.map((b) => ({
        ...b,
        eventTypeName: types.get(b.eventTypeId)?.name ?? "Deleted meeting type",
        eventTypeColor: types.get(b.eventTypeId)?.color ?? "#23412d",
        manageUrl: `${origin()}/book/manage/${b.uid}`,
      })),
    );
  });

  /** Agent-side status change: confirm, complete, no-show, cancel. */
  app.patch("/api/admin/booking/bookings/:id", requireAuth, async (req, res) => {
    const id = toInt(param(req, "id"), NaN);
    const b = Number.isFinite(id) ? storage.getBooking(id) : undefined;
    if (!b) return res.status(404).json({ message: "Booking not found" });
    const et = storage.getBookingEventType(b.eventTypeId);

    const status = String(req.body?.status ?? "");
    if (!(BOOKING_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ message: "Unknown status" });
    }

    if (status === "cancelled" && b.status !== "cancelled") {
      await unmirrorFromGoogle(b);
      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
      const updated = storage.updateBooking(id, {
        status,
        cancelReason: reason,
        cancelledAt: new Date().toISOString(),
        cancelledBy: "agent",
        googleEventId: null,
      });
      if (et && updated) {
        sendEmail({
          to: updated.email,
          subject: `Cancelled: ${et.name} — ${formatInZone(updated.startsAt, updated.timezone)}`,
          html: buildBookingCancellationHtml({
            ...emailData(updated, et, updated.timezone),
            reason,
            bookAgainUrl: `${origin()}/book/${et.slug}`,
          }),
          replyTo: agentEmail(),
        }).catch(() => {});
      }
      return res.json(updated);
    }

    res.json(storage.updateBooking(id, { status }));
  });

  // ---- Event types --------------------------------------------------------

  app.get("/api/admin/booking/event-types", requireAuth, (_req, res) => {
    const counts = new Map<number, number>();
    for (const b of storage.listBookings({ status: "confirmed" })) {
      counts.set(b.eventTypeId, (counts.get(b.eventTypeId) ?? 0) + 1);
    }
    res.json(
      storage.listBookingEventTypes().map((et) => ({
        ...et,
        bookingCount: counts.get(et.id) ?? 0,
        publicUrl: `${origin()}/book/${et.slug}`,
        // Null means "uses the default weekly schedule".
        hasOwnSchedule: storage.listBookingAvailability(et.id).length > 0,
      })),
    );
  });

  function slugify(raw: string): string {
    return raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  /** Whitelist + coerce the editable fields of an event type. */
  function sanitizeEventType(body: any, existing?: BookingEventType) {
    const patch: Record<string, any> = {};
    const str = (k: string, max = 500) => {
      if (typeof body[k] === "string") patch[k] = body[k].trim().slice(0, max);
      else if (body[k] === null) patch[k] = null;
    };
    str("name", 120);
    str("description", 4000);
    str("locationDetail", 500);
    str("customQuestion", 300);
    str("confirmationMessage", 1000);
    if (typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color)) {
      patch.color = body.color;
    }
    if (typeof body.locationType === "string" && (LOCATION_TYPES as readonly string[]).includes(body.locationType)) {
      patch.locationType = body.locationType;
    }
    if (typeof body.timezone === "string" && isValidTimeZone(body.timezone)) {
      patch.timezone = body.timezone;
    }
    if (body.durationMinutes !== undefined) {
      patch.durationMinutes = clamp(toInt(body.durationMinutes, 30), 5, 480);
    }
    if (body.slotIntervalMinutes !== undefined) {
      patch.slotIntervalMinutes = clamp(toInt(body.slotIntervalMinutes, 30), 5, 240);
    }
    if (body.bufferBeforeMinutes !== undefined) {
      patch.bufferBeforeMinutes = clamp(toInt(body.bufferBeforeMinutes, 0), 0, 240);
    }
    if (body.bufferAfterMinutes !== undefined) {
      patch.bufferAfterMinutes = clamp(toInt(body.bufferAfterMinutes, 15), 0, 240);
    }
    if (body.minimumNoticeMinutes !== undefined) {
      patch.minimumNoticeMinutes = clamp(toInt(body.minimumNoticeMinutes, 240), 0, 20160);
    }
    if (body.advanceDays !== undefined) {
      patch.advanceDays = clamp(toInt(body.advanceDays, 60), 1, 365);
    }
    if (body.maxPerDay !== undefined) {
      patch.maxPerDay =
        body.maxPerDay === null || body.maxPerDay === "" ? null : clamp(toInt(body.maxPerDay, 1), 1, 50);
    }
    if (body.requirePhone !== undefined) patch.requirePhone = !!body.requirePhone;
    if (body.active !== undefined) patch.active = !!body.active;
    if (body.sortOrder !== undefined) patch.sortOrder = clamp(toInt(body.sortOrder, 0), 0, 999);

    // Slug: explicit if given, otherwise derived from the name on create.
    if (typeof body.slug === "string" && body.slug.trim()) {
      patch.slug = slugify(body.slug);
    } else if (!existing && typeof body.name === "string") {
      patch.slug = slugify(body.name);
    }
    return patch;
  }

  app.post("/api/admin/booking/event-types", requireAuth, (req, res) => {
    const userId = (req as any).authUserId as number;
    const patch = sanitizeEventType(req.body ?? {});
    if (!patch.name) return res.status(400).json({ message: "A name is required." });
    if (!patch.slug) return res.status(400).json({ message: "That name doesn't make a valid link." });
    if (storage.getBookingEventTypeBySlug(patch.slug)) {
      return res.status(409).json({ message: `The link /book/${patch.slug} is already taken.` });
    }
    const created = storage.createBookingEventType({ ...patch, userId } as any);
    res.status(201).json(created);
  });

  app.patch("/api/admin/booking/event-types/:id", requireAuth, (req, res) => {
    const id = toInt(param(req, "id"), NaN);
    const existing = Number.isFinite(id) ? storage.getBookingEventType(id) : undefined;
    if (!existing) return res.status(404).json({ message: "Meeting type not found" });
    const patch = sanitizeEventType(req.body ?? {}, existing);
    if (patch.slug && patch.slug !== existing.slug) {
      const clash = storage.getBookingEventTypeBySlug(patch.slug);
      if (clash && clash.id !== id) {
        return res.status(409).json({ message: `The link /book/${patch.slug} is already taken.` });
      }
    }
    res.json(storage.updateBookingEventType(id, patch as any));
  });

  app.delete("/api/admin/booking/event-types/:id", requireAuth, (req, res) => {
    const id = toInt(param(req, "id"), NaN);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    res.json({ ok: storage.deleteBookingEventType(id) });
  });

  // ---- Availability -------------------------------------------------------

  /**
   * GET /api/admin/booking/availability?eventTypeId=N
   * Omit eventTypeId (or pass "default") for the shared weekly schedule.
   */
  app.get("/api/admin/booking/availability", requireAuth, (req, res) => {
    const raw = req.query.eventTypeId;
    const eventTypeId =
      raw === undefined || raw === "" || raw === "default" ? null : toInt(raw, NaN);
    if (eventTypeId !== null && !Number.isFinite(eventTypeId)) {
      return res.status(400).json({ message: "Invalid eventTypeId" });
    }
    res.json(storage.listBookingAvailability(eventTypeId));
  });

  app.put("/api/admin/booking/availability", requireAuth, (req, res) => {
    const raw = req.body?.eventTypeId;
    const eventTypeId =
      raw === undefined || raw === null || raw === "" || raw === "default" ? null : toInt(raw, NaN);
    if (eventTypeId !== null && !Number.isFinite(eventTypeId)) {
      return res.status(400).json({ message: "Invalid eventTypeId" });
    }
    const windows = Array.isArray(req.body?.windows) ? req.body.windows : [];
    const clean: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }> = [];
    for (const w of windows) {
      const dayOfWeek = toInt(w?.dayOfWeek, NaN);
      const startMinute = toInt(w?.startMinute, NaN);
      const endMinute = toInt(w?.endMinute, NaN);
      if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;
      if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) continue;
      if (startMinute < 0 || endMinute > 1440 || endMinute <= startMinute) continue;
      clean.push({ dayOfWeek, startMinute, endMinute });
    }
    res.json(storage.replaceBookingAvailability(eventTypeId, clean));
  });

  // ---- Date overrides -----------------------------------------------------

  app.get("/api/admin/booking/overrides", requireAuth, (_req, res) => {
    // Only from today forward — past exceptions are noise in the UI.
    res.json(storage.listBookingDateOverrides(todayKey("America/Edmonton")));
  });

  app.post("/api/admin/booking/overrides", requireAuth, (req, res) => {
    const date = String(req.body?.date ?? "").trim();
    if (!parseDateKey(date)) {
      return res.status(400).json({ message: "Pick a date first." });
    }
    const unavailable = req.body?.unavailable !== false;
    let startMinute: number | null = null;
    let endMinute: number | null = null;
    if (!unavailable) {
      startMinute = clamp(toInt(req.body?.startMinute, 9 * 60), 0, 1440);
      endMinute = clamp(toInt(req.body?.endMinute, 17 * 60), 0, 1440);
      if (endMinute <= startMinute) {
        return res.status(400).json({ message: "The end time has to be after the start time." });
      }
    }
    res.status(201).json(
      storage.upsertBookingDateOverride({
        date,
        unavailable,
        startMinute,
        endMinute,
        note: typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 200) : null,
      } as any),
    );
  });

  app.delete("/api/admin/booking/overrides/:id", requireAuth, (req, res) => {
    const id = toInt(param(req, "id"), NaN);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
    res.json({ ok: storage.deleteBookingDateOverride(id) });
  });

  /**
   * The agent's own view of a day's slots — used by the admin's "book on
   * behalf of" flow so Spencer can add someone from a phone call.
   */
  app.post("/api/admin/booking/bookings", requireAuth, async (req, res) => {
    const et = storage.getBookingEventType(toInt(req.body?.eventTypeId, NaN));
    if (!et) return res.status(404).json({ message: "Meeting type not found" });
    const parsed = createBookingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: parsed.error.issues[0]?.message ?? "Please check the form." });
    }
    const input = parsed.data;
    const startMs = Date.parse(input.startsAt);
    if (!Number.isFinite(startMs)) {
      return res.status(400).json({ message: "That start time isn't valid." });
    }
    // The agent books over their own rules on purpose — if Spencer says the
    // Sunday 7am works, it works. Only a clash with another booking is
    // rejected, since that one is a real double-book.
    const clash = storage
      .listBookingsInRange(
        new Date(startMs).toISOString(),
        new Date(startMs + et.durationMinutes * 60_000).toISOString(),
      )
      .filter((b) => Date.parse(b.startsAt) < startMs + et.durationMinutes * 60_000
        && Date.parse(b.endsAt) > startMs);
    if (clash.length > 0) {
      return res.status(409).json({ message: `That overlaps ${clash[0].name}'s booking.` });
    }

    const booking = storage.createBooking({
      uid: newBookingUid(),
      eventTypeId: et.id,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: input.phone?.trim() || null,
      notes: input.notes?.trim() || null,
      answer: input.answer?.trim() || null,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(startMs + et.durationMinutes * 60_000).toISOString(),
      timezone: isValidTimeZone(input.timezone) ? input.timezone! : et.timezone,
      status: "confirmed",
      listingId: input.listingId?.trim() || null,
      source: "admin",
    });
    const synced = await mirrorToGoogle(booking, et);
    if (req.body?.notify !== false) {
      sendEmail({
        to: synced.email,
        subject: `Confirmed: ${et.name} — ${formatInZone(synced.startsAt, synced.timezone)}`,
        html: buildBookingConfirmationHtml(emailData(synced, et, synced.timezone)),
        replyTo: agentEmail(),
      }).catch(() => {});
    }
    res.status(201).json(synced);
  });

  /** Days the agent is available, for the admin's own calendar view. */
  app.get("/api/admin/booking/schedule-preview", requireAuth, async (req, res) => {
    const et = storage.getBookingEventType(toInt(req.query.eventTypeId, NaN));
    if (!et) return res.status(404).json({ message: "Meeting type not found" });
    const tz = isValidTimeZone(et.timezone) ? et.timezone : "America/Edmonton";
    const from = typeof req.query.from === "string" && parseDateKey(req.query.from)
      ? req.query.from
      : todayKey(tz);
    const days = clamp(toInt(req.query.days, 14), 1, 62);
    const to = addDaysToKey(from, days - 1);
    const fromParts = parseDateKey(from)!;
    const toParts = parseDateKey(addDaysToKey(to, 1))!;
    const userId = (req as any).authUserId as number;
    const busy = await collectBusy(
      userId,
      zonedTimeToUtc(fromParts.year, fromParts.month, fromParts.day, 0, tz).toISOString(),
      zonedTimeToUtc(toParts.year, toParts.month, toParts.day, 0, tz).toISOString(),
    );
    res.json({
      timezone: tz,
      days: computeSlots({ eventType: et, fromDate: from, toDate: to, busy }),
    });
  });
}

/** Exported for the SSR/meta layer so /book pages resolve their titles. */
export function bookingSlugExists(slug: string): boolean {
  const et = storage.getBookingEventTypeBySlug(slug);
  return !!(et && et.active);
}

export function publicEventTypeBySlug(slug: string) {
  const et = storage.getBookingEventTypeBySlug(slug);
  if (!et || !et.active) return null;
  return publicEventType(et);
}

/** Local-day helper re-exported for callers that only import this module. */
export { zonedParts };
