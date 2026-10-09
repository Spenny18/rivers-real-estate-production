// Admin API for showings (server/showings.ts) and the read-only Follow Up Boss
// appointment layer on /admin/calendar. Everything here is behind requireAuth.
//
//   GET   /api/admin/showings                 every showing, resolved for display
//   GET   /api/admin/showings/listing?mls=    preview a listing by MLS number
//   GET   /api/admin/showings/listing-search?q=  find listings by address
//   GET   /api/admin/showings/status          can invites go out, and how
//   POST  /api/admin/showings                 create (+ invite the client)
//   PATCH /api/admin/showings/:id             reschedule / edit / change status
//   POST  /api/admin/showings/:id/resend      re-send the client's invite
//   GET   /api/admin/calendar/fub-appointments  FUB's appointments, read-only

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { storage, sqlite } from "./storage";
import { googleCalendarReady } from "./google-calendar";
import {
  normalizeMlsNumber,
  resendInvite,
  resolveShowingListing,
  searchShowingListings,
  syncShowing,
  toShowingView,
} from "./showings";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const isoDate = z.string().refine((v) => Number.isFinite(Date.parse(v)), "A valid date and time is required");

const createSchema = z.object({
  mlsNumber: z.string().trim().min(3, "Enter an MLS number"),
  startsAt: isoDate,
  durationMinutes: z.number().int().min(15).max(240).default(60),
  contactFubId: z.string().trim().optional().nullable(),
  clientName: z.string().trim().max(120).optional().nullable(),
  clientEmail: z.string().trim().email("That email doesn't look right").optional().nullable().or(z.literal("")),
  clientPhone: z.string().trim().max(40).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  notifyClient: z.boolean().default(true),
});

const patchSchema = z.object({
  startsAt: isoDate.optional(),
  durationMinutes: z.number().int().min(15).max(240).optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(["requested", "confirmed", "completed", "cancelled"]).optional(),
  notifyClient: z.boolean().optional(),
});

function firstIssue(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Please check the form.";
}

export function registerShowingRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;
  const userIdOf = (req: Request) => (req as any).authUserId as number;

  app.get("/api/admin/showings", requireAuth, (_req, res) => {
    res.json(storage.listTours().map(toShowingView));
  });

  app.get("/api/admin/showings/status", requireAuth, (req, res) => {
    const google = googleCalendarReady(userIdOf(req));
    const email = !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL;
    res.json({ google, email, canInvite: google || email });
  });

  app.get("/api/admin/showings/listing", requireAuth, (req, res) => {
    const mls = normalizeMlsNumber(String(req.query.mls ?? ""));
    if (mls.length < 3) return res.status(400).json({ message: "Enter an MLS number" });
    const listing = resolveShowingListing(mls);
    if (listing.source !== "mls") return res.status(404).json({ message: `No listing found for MLS® ${mls}` });
    const row = storage.getMlsListingById(mls);
    res.json({ ...listing, status: row?.status ?? null });
  });

  // Search by address (or MLS number) for the New showing dialog.
  app.get("/api/admin/showings/listing-search", requireAuth, (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 120);
    if (q.length < 3) return res.json([]);
    res.json(searchShowingListings(q, 8));
  });

  app.post("/api/admin/showings", requireAuth, async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: firstIssue(parsed.error) });
    const b = parsed.data;
    const mls = normalizeMlsNumber(b.mlsNumber);
    if (resolveShowingListing(mls).source !== "mls") {
      return res.status(404).json({ message: `No listing found for MLS® ${mls}` });
    }

    // A CRM contact fills in whatever the form left blank.
    const contact = b.contactFubId ? storage.getCrmContact(b.contactFubId) : undefined;
    if (b.contactFubId && !contact) return res.status(404).json({ message: "That contact isn't in the CRM" });
    const clientName = b.clientName?.trim() || contact?.name || null;
    const clientEmail = b.clientEmail?.trim() || contact?.email || null;
    const clientPhone = b.clientPhone?.trim() || contact?.phone || null;
    if (!clientName) return res.status(400).json({ message: "Choose a client or enter their name" });
    if (b.notifyClient && !clientEmail) {
      return res.status(400).json({ message: "The client needs an email address to receive an invite" });
    }

    const tour = storage.createTour({
      listingId: mls,
      leadId: null,
      scheduledFor: new Date(b.startsAt).toISOString(),
      status: "confirmed",
      notes: b.notes?.trim() || null,
      durationMinutes: b.durationMinutes,
      clientName,
      clientEmail,
      clientPhone,
      contactFubId: contact?.fubId ?? null,
      notifyClient: b.notifyClient,
    } as any);
    try {
      const delivery = await syncShowing(userIdOf(req), tour.id);
      res.status(201).json({ showing: toShowingView(storage.getTour(tour.id)!), delivery });
    } catch (e: any) {
      // The showing exists; say what didn't happen rather than pretend it failed.
      console.error("[showings] create sync failed:", e?.message ?? e);
      res.status(201).json({
        showing: toShowingView(storage.getTour(tour.id)!),
        delivery: { calendar: "failed", client: "failed", channel: null, error: String(e?.message ?? e) },
      });
    }
  });

  app.patch("/api/admin/showings/:id", requireAuth, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const existing = Number.isFinite(id) ? storage.getTour(id) : undefined;
    if (!existing) return res.status(404).json({ message: "Showing not found" });
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: firstIssue(parsed.error) });
    const b = parsed.data;

    const patch: Record<string, unknown> = {};
    if (b.startsAt !== undefined) patch.scheduledFor = new Date(b.startsAt).toISOString();
    if (b.durationMinutes !== undefined) patch.durationMinutes = b.durationMinutes;
    if (b.notes !== undefined) patch.notes = b.notes?.trim() || null;
    if (b.status !== undefined) patch.status = b.status;
    if (b.notifyClient !== undefined) patch.notifyClient = b.notifyClient;
    if (Object.keys(patch).length) storage.updateTour(id, patch as any);

    const changedTime =
      (patch.scheduledFor !== undefined && patch.scheduledFor !== existing.scheduledFor) ||
      (patch.durationMinutes !== undefined && patch.durationMinutes !== existing.durationMinutes);
    try {
      const delivery = await syncShowing(userIdOf(req), id, { changedTime });
      res.json({ showing: toShowingView(storage.getTour(id)!), delivery });
    } catch (e: any) {
      console.error("[showings] update sync failed:", e?.message ?? e);
      res.json({
        showing: toShowingView(storage.getTour(id)!),
        delivery: { calendar: "failed", client: "failed", channel: null, error: String(e?.message ?? e) },
      });
    }
  });

  app.post("/api/admin/showings/:id/resend", requireAuth, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const tour = Number.isFinite(id) ? storage.getTour(id) : undefined;
    if (!tour) return res.status(404).json({ message: "Showing not found" });
    if (tour.status !== "confirmed") return res.status(400).json({ message: "Only a confirmed showing has an invite to send" });
    try {
      const delivery = await resendInvite(userIdOf(req), id);
      res.json({ showing: toShowingView(storage.getTour(id)!), delivery });
    } catch (e: any) {
      res.status(502).json({ message: String(e?.message ?? e) });
    }
  });

  /**
   * Follow Up Boss appointments from the hourly CRM mirror, so showings still
   * booked there are visible on the calendar while scheduling moves here.
   * Read-only: they're edited in FUB until it's switched off.
   */
  app.get("/api/admin/calendar/fub-appointments", requireAuth, (req, res) => {
    const from = Date.parse(String(req.query.from ?? "")) || Date.now() - 45 * 86_400_000;
    const to = Date.parse(String(req.query.to ?? "")) || Date.now() + 90 * 86_400_000;
    const rows = sqlite
      .prepare(
        `SELECT a.uid, a.fub_id AS fubId, a.title, a.body, a.occurred_at AS startsAt,
                a.duration_seconds AS durationSeconds, a.contact_fub_id AS contactFubId,
                c.name AS contactName
         FROM crm_activities a
         LEFT JOIN crm_contacts c ON c.fub_id = a.contact_fub_id
         WHERE a.kind = 'appointment' AND a.occurred_at IS NOT NULL`,
      )
      .all() as Array<{
      uid: string;
      fubId: string | null;
      title: string | null;
      body: string | null;
      startsAt: string;
      durationSeconds: number | null;
      contactFubId: string | null;
      contactName: string | null;
    }>;
    // Compared as instants, not strings: FUB timestamps carry offsets.
    res.json(
      rows
        .filter((r) => {
          const t = Date.parse(r.startsAt);
          return Number.isFinite(t) && t >= from && t <= to;
        })
        .map((r) => ({
          ...r,
          startsAt: new Date(r.startsAt).toISOString(),
          endsAt: new Date(Date.parse(r.startsAt) + (r.durationSeconds || 3600) * 1000).toISOString(),
        }))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    );
  });
}
