// Creating and editing contacts from the admin (server/contacts.ts).
//
//   POST  /api/admin/crm/contacts           { name, email?, phone?, stage?, source?, tags?, note? }
//   PATCH /api/admin/crm/contacts/:fubId    the same fields; contacts the app owns only

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { createNativeContact, findContact, isNativeContact, updateNativeContact } from "./contacts";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const fields = {
  name: z.string().trim().min(1, "A name is required").max(120),
  email: z.string().trim().email("That email doesn't look right").max(200).optional().nullable().or(z.literal("")),
  phone: z.string().trim().max(40).optional().nullable(),
  stage: z.string().trim().max(60).optional().nullable(),
  source: z.string().trim().max(120).optional().nullable(),
  tags: z.array(z.string().trim().max(60)).max(30).optional(),
};
const createSchema = z
  .object({ ...fields, note: z.string().trim().max(4000).optional().nullable() })
  .refine((b) => !!b.email || !!b.phone, "Add an email or a phone number");
const patchSchema = z.object(fields).partial();

export function registerContactRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  app.post("/api/admin/crm/contacts", requireAuth, (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Please check the form." });
    const b = parsed.data;
    const existing = findContact(b.email, b.phone);
    if (existing) {
      const c = storage.getCrmContact(existing);
      return res.status(409).json({ message: `${c?.name ?? "A contact"} already has that email or phone.`, fubId: existing });
    }
    const contact = createNativeContact({ ...b, source: b.source || "Added by hand" });
    if (b.note) {
      const now = new Date().toISOString();
      storage.upsertCrmActivities([
        {
          uid: `note:app:${contact.fubId}:${Date.now()}`,
          kind: "note",
          fubId: null,
          contactFubId: contact.fubId,
          title: "Note",
          body: b.note,
          direction: null,
          outcome: null,
          durationSeconds: null,
          occurredAt: now,
          dueAt: null,
          completed: false,
          assignedTo: null,
          raw: "{}",
          syncedAt: now,
        },
      ]);
    }
    res.status(201).json({ fubId: contact.fubId });
  });

  app.patch("/api/admin/crm/contacts/:fubId", requireAuth, (req, res) => {
    const fubId = String(req.params.fubId);
    if (!storage.getCrmContact(fubId)) return res.status(404).json({ message: "Contact not found" });
    if (!isNativeContact(fubId)) {
      return res.status(400).json({ message: "This contact comes from Follow Up Boss; edit it there, or it'll be overwritten on the next sync." });
    }
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Please check the form." });
    const b = parsed.data;
    // Changing the email or phone to one another contact has would make two.
    if (b.email || b.phone) {
      const other = findContact(b.email, b.phone);
      if (other && other !== fubId) {
        return res.status(409).json({ message: `${storage.getCrmContact(other)?.name ?? "Another contact"} already has that email or phone.`, fubId: other });
      }
    }
    updateNativeContact(fubId, b);
    res.json({ ok: true });
  });
}
