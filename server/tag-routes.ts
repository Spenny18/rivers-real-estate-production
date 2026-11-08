// Contact tags (server/tags.ts).
//
//   GET    /api/admin/crm/tags                      every tag with its contact count
//   GET    /api/admin/crm/contacts/:fubId/tags      one contact's tags
//   POST   /api/admin/crm/contacts/:fubId/tags      { add?: string[], remove?: string[] }
//   POST   /api/admin/crm/tags/bulk                 { listId | contactIds, add?, remove? }
//   POST   /api/admin/crm/tags/rename               { from, to }
//   POST   /api/admin/crm/tags/delete               { tag }

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { getSmartList, listMembers } from "./smart-lists";
import { MAX_TAG_LENGTH, contactTags, deleteTag, listTags, renameTag, tagContacts, untagContacts } from "./tags";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const tag = z.string().trim().min(1).max(MAX_TAG_LENGTH);
const tagChange = z.object({ add: z.array(tag).max(30).optional(), remove: z.array(tag).max(30).optional() });
const bulk = tagChange.extend({
  listId: z.number().int().optional(),
  contactIds: z.array(z.string().min(1)).max(5000).optional(),
});

export function registerTagRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  app.get("/api/admin/crm/tags", requireAuth, (_req, res) => {
    res.json({ tags: listTags() });
  });

  app.get("/api/admin/crm/contacts/:fubId/tags", requireAuth, (req, res) => {
    const id = String(req.params.fubId);
    if (!storage.getCrmContact(id)) return res.status(404).json({ message: "Contact not found" });
    res.json({ tags: contactTags(id) });
  });

  app.post("/api/admin/crm/contacts/:fubId/tags", requireAuth, (req, res) => {
    const id = String(req.params.fubId);
    if (!storage.getCrmContact(id)) return res.status(404).json({ message: "Contact not found" });
    const b = tagChange.safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: "Tags must be 1–60 characters" });
    if (b.data.remove?.length) untagContacts([id], b.data.remove);
    if (b.data.add?.length) tagContacts([id], b.data.add);
    res.json({ tags: contactTags(id) });
  });

  app.post("/api/admin/crm/tags/bulk", requireAuth, (req, res) => {
    const b = bulk.safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: "Tags must be 1–60 characters" });
    if (!b.data.add?.length && !b.data.remove?.length) return res.status(400).json({ message: "Choose a tag to add or remove" });
    let ids: string[];
    if (b.data.listId != null) {
      const l = getSmartList(b.data.listId);
      if (!l) return res.status(404).json({ message: "List not found" });
      ids = listMembers(l.filters).map((m) => m.fubId);
    } else if (b.data.contactIds?.length) {
      ids = b.data.contactIds;
    } else {
      return res.status(400).json({ message: "Choose a list or contacts" });
    }
    const removed = b.data.remove?.length ? untagContacts(ids, b.data.remove) : 0;
    const added = b.data.add?.length ? tagContacts(ids, b.data.add) : 0;
    res.json({ ok: true, contacts: ids.length, added, removed });
  });

  app.post("/api/admin/crm/tags/rename", requireAuth, (req, res) => {
    const b = z.object({ from: tag, to: tag }).safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: "Tags must be 1–60 characters" });
    res.json({ ok: true, contacts: renameTag(b.data.from, b.data.to), tags: listTags() });
  });

  app.post("/api/admin/crm/tags/delete", requireAuth, (req, res) => {
    const b = z.object({ tag }).safeParse(req.body ?? {});
    if (!b.success) return res.status(400).json({ message: "Which tag?" });
    res.json({ ok: true, contacts: deleteTag(b.data.tag), tags: listTags() });
  });
}
