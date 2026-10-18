// Text and email templates (server/templates.ts).
//
//   GET    /api/admin/templates?kind=email|text
//   POST   /api/admin/templates                 { kind, name, subject?, body }
//   PATCH  /api/admin/templates/:id             { name?, subject?, body? }
//   DELETE /api/admin/templates/:id
//   POST   /api/admin/templates/import-fub      copy (or refresh) Follow Up Boss's templates

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { createTemplate, deleteTemplate, importFubTemplates, listTemplates, updateTemplate } from "./templates";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const createSchema = z.object({
  kind: z.enum(["email", "text"]),
  name: z.string().trim().min(1, "Give the template a name.").max(150),
  subject: z.string().max(300).optional().nullable(),
  body: z.string().trim().min(1, "The template is empty.").max(20000),
});
const patchSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  subject: z.string().max(300).optional().nullable(),
  body: z.string().trim().min(1, "The template is empty.").max(20000).optional(),
});

export function registerTemplateRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  app.get("/api/admin/templates", requireAuth, (req, res) => {
    const kind = req.query.kind === "email" || req.query.kind === "text" ? req.query.kind : undefined;
    res.json(listTemplates(kind));
  });

  app.post("/api/admin/templates", requireAuth, (req, res) => {
    const p = createSchema.safeParse(req.body ?? {});
    if (!p.success) return res.status(400).json({ message: p.error.issues[0]?.message ?? "Please check the template." });
    res.json(createTemplate(p.data));
  });

  app.patch("/api/admin/templates/:id", requireAuth, (req, res) => {
    const p = patchSchema.safeParse(req.body ?? {});
    if (!p.success) return res.status(400).json({ message: p.error.issues[0]?.message ?? "Please check the template." });
    const t = updateTemplate(Number(req.params.id), p.data);
    if (!t) return res.status(404).json({ message: "Not found" });
    res.json(t);
  });

  app.delete("/api/admin/templates/:id", requireAuth, (req, res) => {
    if (!deleteTemplate(Number(req.params.id))) return res.status(404).json({ message: "Not found" });
    res.json({ ok: true });
  });

  app.post("/api/admin/templates/import-fub", requireAuth, async (_req, res) => {
    const r = await importFubTemplates();
    if (r.error && !r.email && !r.text) return res.status(502).json({ message: r.error, ...r });
    res.json(r);
  });
}
