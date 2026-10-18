// Bulk texts (server/bulk-texts.ts).
//
//   GET  /api/admin/bulk-texts/options        stages, tags, sources to filter by
//   POST /api/admin/bulk-texts/audience       { filter } -> who that picks, and who can be texted
//   POST /api/admin/bulk-texts/preview        { body, contactIds } -> filled-in samples, held people
//   POST /api/admin/bulk-texts                { body, contactIds } -> start sending
//   GET  /api/admin/bulk-texts                past and running sends
//   GET  /api/admin/bulk-texts/:id            one send, with every recipient
//   POST /api/admin/bulk-texts/:id/cancel     stop the rest

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  MAX_RECIPIENTS,
  audienceOptions,
  cancelBulkText,
  getBulkText,
  listBulkTexts,
  previewBulk,
  resolveAudience,
  startBulkText,
} from "./bulk-texts";
import { smsConfigured } from "./sms";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const filterSchema = z.object({
  stages: z.array(z.string()).max(100).optional(),
  tags: z.array(z.string()).max(100).optional(),
  sources: z.array(z.string()).max(100).optional(),
  activeWithinDays: z.number().int().positive().max(3650).nullable().optional(),
  include: z.array(z.string()).max(MAX_RECIPIENTS).optional(),
});
const sendSchema = z.object({
  body: z.string().trim().min(1, "The message is empty.").max(1600, "That's too long for a text."),
  contactIds: z.array(z.string()).min(1, "Nobody is selected.").max(MAX_RECIPIENTS, `One bulk text can go to at most ${MAX_RECIPIENTS} people.`),
});

export function registerBulkTextRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;
  const bad = (res: Response, e: z.ZodError) => res.status(400).json({ message: e.issues[0]?.message ?? "Please check the request." });

  app.get("/api/admin/bulk-texts/options", requireAuth, (_req, res) => {
    res.json({ ...audienceOptions(), configured: smsConfigured().ok, maxRecipients: MAX_RECIPIENTS });
  });

  app.post("/api/admin/bulk-texts/audience", requireAuth, (req, res) => {
    const p = filterSchema.safeParse(req.body?.filter ?? {});
    if (!p.success) return bad(res, p.error);
    res.json(resolveAudience(p.data));
  });

  app.post("/api/admin/bulk-texts/preview", requireAuth, (req, res) => {
    const p = sendSchema.safeParse(req.body ?? {});
    if (!p.success) return bad(res, p.error);
    res.json(previewBulk(p.data.body, p.data.contactIds));
  });

  app.post("/api/admin/bulk-texts", requireAuth, (req, res) => {
    if (!smsConfigured().ok) return res.status(503).json({ message: "Texting isn't set up." });
    const p = sendSchema.safeParse(req.body ?? {});
    if (!p.success) return bad(res, p.error);
    const r = startBulkText(p.data.body, p.data.contactIds);
    if ("error" in r) return res.status(400).json({ message: r.error });
    res.json(r.bulk);
  });

  app.get("/api/admin/bulk-texts", requireAuth, (_req, res) => {
    res.json(listBulkTexts());
  });

  app.get("/api/admin/bulk-texts/:id", requireAuth, (req, res) => {
    const b = getBulkText(Number(req.params.id));
    if (!b) return res.status(404).json({ message: "Not found" });
    res.json(b);
  });

  app.post("/api/admin/bulk-texts/:id/cancel", requireAuth, (req, res) => {
    if (!cancelBulkText(Number(req.params.id))) return res.status(404).json({ message: "That send isn't running." });
    res.json({ ok: true });
  });
}
