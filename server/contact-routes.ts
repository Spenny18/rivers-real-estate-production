// Creating and editing contacts from the admin (server/contacts.ts).
//
//   POST  /api/admin/crm/contacts           { name, email?, phone?, stage?, source?, tags?, note? }
//   PATCH /api/admin/crm/contacts/:fubId    the same fields; contacts the app owns only

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { createNativeContact, findContact } from "./contacts";
import { contactEditState, editContact } from "./contact-edits";
import { addNote, addTask, deleteNote, deleteTask, editNote, editTask, listTasks, setTaskDone, taskCounts } from "./notes-tasks";
import { exportSummary, writeExport } from "./crm-export";
import {
  createSmartList,
  deleteSmartList,
  filterOptions,
  filtersSchema,
  getSmartList,
  listSchema,
  reorderSmartLists,
  runFilters,
  seedStarterLists,
  smartListsWithCounts,
  updateSmartList,
  SORTS,
  type SmartListSort,
} from "./smart-lists";

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
    // FUB's contacts too: the edit is kept over the sync and sent on to FUB (contact-edits.ts).
    const r = editContact(fubId, b);
    res.json({ ok: true, changed: r?.changed ?? [], ...contactEditState(fubId) });
  });

  // ---- Notes (notes-tasks.ts) ---------------------------------------------------------

  const noteBody = z.object({ body: z.string().trim().min(1, "Write something first").max(10_000) });

  app.post("/api/admin/crm/contacts/:fubId/notes", requireAuth, (req, res) => {
    const fubId = String(req.params.fubId);
    if (!storage.getCrmContact(fubId)) return res.status(404).json({ message: "Contact not found" });
    const b = noteBody.safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: b.error.issues[0]?.message ?? "Invalid note" });
    res.json({ uid: addNote(fubId, b.data.body) });
  });

  app.patch("/api/admin/crm/notes", requireAuth, (req, res) => {
    const b = noteBody.extend({ uid: z.string() }).safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: b.error.issues[0]?.message ?? "Invalid note" });
    if (!editNote(b.data.uid, b.data.body)) return res.status(404).json({ message: "Only notes written in the app can be edited." });
    res.json({ ok: true });
  });

  app.delete("/api/admin/crm/notes", requireAuth, (req, res) => {
    if (!deleteNote(String(req.query.uid ?? ""))) return res.status(404).json({ message: "Only notes written in the app can be deleted." });
    res.json({ ok: true });
  });

  // ---- Tasks ----------------------------------------------------------------------------

  const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Pick a due date");

  app.get("/api/admin/crm/tasks", requireAuth, (req, res) => {
    const status = ["open", "done", "all"].includes(String(req.query.status)) ? (String(req.query.status) as "open" | "done" | "all") : "open";
    res.json({
      tasks: listTasks({ status, contactId: typeof req.query.contact === "string" ? req.query.contact : undefined }),
      counts: taskCounts(),
    });
  });

  app.post("/api/admin/crm/tasks", requireAuth, (req, res) => {
    const b = z
      .object({
        title: z.string().trim().min(1, "What's the task?").max(300),
        dueAt: isoDate,
        contactId: z.string().optional().nullable(),
        note: z.string().max(4000).optional().nullable(),
      })
      .safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: b.error.issues[0]?.message ?? "Invalid task" });
    if (b.data.contactId && !storage.getCrmContact(b.data.contactId)) return res.status(404).json({ message: "Contact not found" });
    res.json({ uid: addTask(b.data) });
  });

  app.patch("/api/admin/crm/tasks", requireAuth, (req, res) => {
    const b = z
      .object({
        uid: z.string(),
        title: z.string().trim().max(300).optional(),
        dueAt: isoDate.optional(),
        note: z.string().max(4000).optional().nullable(),
        completed: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: b.error.issues[0]?.message ?? "Invalid task" });
    const { uid, completed, ...edit } = b.data;
    if (completed !== undefined && !setTaskDone(uid, completed)) return res.status(404).json({ message: "Task not found" });
    if (Object.keys(edit).length && !editTask(uid, edit)) {
      return res.status(400).json({ message: "Only tasks made in the app can be edited; Follow Up Boss's can be completed." });
    }
    res.json({ ok: true });
  });

  app.delete("/api/admin/crm/tasks", requireAuth, (req, res) => {
    if (!deleteTask(String(req.query.uid ?? ""))) return res.status(404).json({ message: "Only tasks made in the app can be deleted." });
    res.json({ ok: true });
  });

  // ---- Export (crm-export.ts) ----------------------------------------------------------

  app.get("/api/admin/crm/export/summary", requireAuth, (_req, res) => {
    res.json({ tables: exportSummary() });
  });

  app.get("/api/admin/crm/export", requireAuth, async (_req, res) => {
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `attachment; filename="rivers-crm-export-${day}.zip"`);
    try {
      await writeExport(res);
      res.end();
    } catch (e: any) {
      console.error("[crm-export] failed:", e);
      // Headers are gone once the zip has started; cutting it short is all that's left.
      if (!res.headersSent) res.status(500).json({ message: e?.message ?? "Export failed" });
      else res.destroy(e);
    }
  });

  // ---- Smart lists (smart-lists.ts) ------------------------------------------------------

  app.get("/api/admin/crm/smart-lists", requireAuth, (_req, res) => {
    seedStarterLists();
    res.json({ lists: smartListsWithCounts(), options: filterOptions() });
  });

  app.post("/api/admin/crm/smart-lists", requireAuth, (req, res) => {
    const b = listSchema.safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: b.error.issues[0]?.message ?? "Invalid list" });
    res.json(createSmartList(b.data));
  });

  app.put("/api/admin/crm/smart-lists/:id", requireAuth, (req, res) => {
    const b = listSchema.safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: b.error.issues[0]?.message ?? "Invalid list" });
    const l = updateSmartList(Number(req.params.id), b.data);
    if (!l) return res.status(404).json({ message: "List not found" });
    res.json(l);
  });

  app.delete("/api/admin/crm/smart-lists/:id", requireAuth, (req, res) => {
    if (!deleteSmartList(Number(req.params.id))) return res.status(404).json({ message: "List not found" });
    res.json({ ok: true });
  });

  app.post("/api/admin/crm/smart-lists/reorder", requireAuth, (req, res) => {
    const ids = z.array(z.number().int()).max(500).safeParse(req.body?.ids);
    if (!ids.success) return res.status(400).json({ message: "ids required" });
    reorderSmartLists(ids.data);
    res.json({ ok: true });
  });

  app.get("/api/admin/crm/smart-lists/:id/contacts", requireAuth, (req, res) => {
    const l = getSmartList(Number(req.params.id));
    if (!l) return res.status(404).json({ message: "List not found" });
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
    res.json({ list: l, ...runFilters(l.filters, l.sort, { limit, offset }) });
  });

  /** Try filters before saving: the count and the first few matches. */
  app.post("/api/admin/crm/smart-lists/preview", requireAuth, (req, res) => {
    const f = filtersSchema.safeParse(req.body?.filters ?? {});
    if (!f.success) return res.status(400).json({ message: f.error.issues[0]?.message ?? "Invalid filters" });
    const sort = (String(req.body?.sort ?? "") in SORTS ? req.body.sort : "last_contact_asc") as SmartListSort;
    res.json(runFilters(f.data, sort, { limit: 8 }));
  });
}
