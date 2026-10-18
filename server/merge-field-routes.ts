// Merge fields and custom fields (server/merge-fields.ts).
//
//   GET    /api/admin/merge-fields                    the catalog, grouped, plus the custom fields
//   POST   /api/admin/custom-fields                   { label, type? } add one
//   DELETE /api/admin/custom-fields/:key              remove one added in the app
//   GET    /api/admin/contacts/:fubId/fields          a contact's custom field values
//   PUT    /api/admin/contacts/:fubId/fields/:key     { value } set (empty clears)
//   POST   /api/admin/merge-fields/preview            { contactFubId, text } the text filled in

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import {
  addCustomField,
  contactCustomFields,
  customFields,
  deleteCustomField,
  mergeFieldCatalog,
  renderMerge,
  setContactField,
  syncFubCustomFields,
  unknownFields,
} from "./merge-fields";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

export function registerMergeFieldRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  app.get("/api/admin/merge-fields", requireAuth, async (_req, res) => {
    // First visit after a deploy: pick up Follow Up Boss's custom fields now
    // rather than waiting for the next hourly sync.
    if (!customFields().some((f) => f.source === "fub")) await syncFubCustomFields(true).catch(() => 0);
    res.json({ fields: mergeFieldCatalog(), custom: customFields() });
  });

  app.post("/api/admin/custom-fields", requireAuth, (req, res) => {
    const r = addCustomField(String(req.body?.label ?? ""), String(req.body?.type ?? "text"));
    if ("error" in r) return res.status(400).json({ message: r.error });
    res.json({ ...r, custom: customFields() });
  });

  app.delete("/api/admin/custom-fields/:key", requireAuth, (req, res) => {
    if (!deleteCustomField(String(req.params.key))) {
      return res.status(400).json({ message: "Only fields added here can be removed; Follow Up Boss's come from its settings." });
    }
    res.json({ ok: true, custom: customFields() });
  });

  app.get("/api/admin/contacts/:fubId/fields", requireAuth, (req, res) => {
    const id = String(req.params.fubId);
    if (!storage.getCrmContact(id)) return res.status(404).json({ message: "Not found" });
    res.json(contactCustomFields(id));
  });

  app.put("/api/admin/contacts/:fubId/fields/:key", requireAuth, (req, res) => {
    const id = String(req.params.fubId);
    const key = String(req.params.key);
    if (!storage.getCrmContact(id)) return res.status(404).json({ message: "Not found" });
    if (!customFields().some((f) => f.key === key)) return res.status(400).json({ message: "No such field." });
    setContactField(id, key, typeof req.body?.value === "string" ? req.body.value : null);
    res.json(contactCustomFields(id));
  });

  app.post("/api/admin/merge-fields/preview", requireAuth, (req, res) => {
    const id = String(req.body?.contactFubId ?? "");
    const text = String(req.body?.text ?? "");
    if (!storage.getCrmContact(id)) return res.status(404).json({ message: "Not found" });
    res.json({ text: renderMerge(text, id), unknown: unknownFields(text) });
  });
}
