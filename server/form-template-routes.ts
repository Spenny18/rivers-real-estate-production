// HTTP surface for form templates (server/form-templates.ts). All admin.
//
//   /api/admin/form-templates            list, upload a blank
//   /api/admin/form-templates/:id        detail (boxes), edit, delete, blank PDF, preview
//   /api/admin/deals/:id/form-prefill    what the review screen starts with
//   /api/admin/deals/:id/documents/from-template
//                                        print the values, create the draft

import type { Express, Request, Response, NextFunction } from "express";
import fs from "node:fs";
import { z } from "zod";
import { FORM_TEMPLATE_KINDS, formTemplatePatchSchema, type FormTemplate } from "@shared/schema";
import { db } from "./storage";
import { formTemplates } from "@shared/schema";
import { eq } from "drizzle-orm";
import { documentExists, documentPath, readDocument } from "./documents-store";
import { getDeal, loadBundle, nowIso } from "./deal-store";
import { clientMeta, documentDetail } from "./deal-routes";
import { publicOrigin } from "./origin";
import {
  createDocumentFromTemplate,
  deleteTemplate,
  getTemplate,
  importFormTemplate,
  listTemplates,
  partySlots,
  prefillForDeal,
  renderFormPdf,
  signersFromValues,
  templateFields,
} from "./form-templates";
import { queueDocumentsBackup } from "./backup";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function bad(res: Response, status: number, message: string) {
  return res.status(status).json({ message });
}

function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid input";
}

function summary(t: FormTemplate) {
  const fields = templateFields(t);
  const slots = partySlots(fields);
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    description: t.description,
    pageCount: t.pageCount,
    pageSizes: JSON.parse(t.pageSizes) as Array<{ w: number; h: number }>,
    bytes: t.bytes,
    sha256: t.sha256,
    fillCount: fields.filter((f) => f.kind === "fill").length,
    signCount: fields.filter((f) => f.kind === "sign").length,
    slots,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function detail(t: FormTemplate) {
  return { ...summary(t), fields: templateFields(t) };
}

const valuesSchema = z.record(z.string().max(80), z.string().max(4000));

export function registerFormTemplateRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  app.get("/api/admin/form-templates", requireAuth, (_req, res) => {
    res.json(listTemplates().map(summary));
  });

  const uploadSchema = z.object({
    name: z.string().trim().max(120).optional(),
    filename: z.string().trim().max(200).optional(),
    kind: z.enum(FORM_TEMPLATE_KINDS).optional(),
    description: z.string().trim().max(500).optional(),
    dataUrl: z.string().min(20, "Choose the blank form PDF"),
  });

  app.post("/api/admin/form-templates", requireAuth, async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)$/.exec(parsed.data.dataUrl);
    if (!m) return bad(res, 400, "Only PDF files can be used as a form.");
    const bytes = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
    try {
      const r = await importFormTemplate({ name: parsed.data.name ?? "", filename: parsed.data.filename, kind: parsed.data.kind ?? "other", description: parsed.data.description, bytes });
      queueDocumentsBackup();
      res.status(201).json({ ...detail(r.template), matched: r.matched, detected: r.detected });
    } catch (e: any) {
      const msg = String(e?.message ?? "Could not read that PDF.");
      return bad(res, /10 MB/.test(msg) ? 413 : 400, msg);
    }
  });

  app.get("/api/admin/form-templates/:id", requireAuth, (req, res) => {
    const t = getTemplate(Number(req.params.id));
    if (!t) return bad(res, 404, "Form not found");
    res.json(detail(t));
  });

  app.patch("/api/admin/form-templates/:id", requireAuth, (req, res) => {
    const t = getTemplate(Number(req.params.id));
    if (!t) return bad(res, 404, "Form not found");
    const parsed = formTemplatePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const v = parsed.data;
    if (v.fields) {
      for (const f of v.fields) {
        if (f.page > t.pageCount) return bad(res, 400, "A box is placed on a page that does not exist.");
      }
      const keys = v.fields.map((f) => f.key);
      if (new Set(keys).size !== keys.length) return bad(res, 400, "Duplicate box key.");
    }
    const patch: Partial<FormTemplate> = { updatedAt: nowIso() };
    if (v.name !== undefined) patch.name = v.name;
    if (v.kind !== undefined) patch.kind = v.kind;
    if (v.description !== undefined) patch.description = v.description || null;
    if (v.fields !== undefined) patch.fields = JSON.stringify(v.fields);
    db.update(formTemplates).set(patch).where(eq(formTemplates.id, t.id)).run();
    res.json(detail(getTemplate(t.id)!));
  });

  app.delete("/api/admin/form-templates/:id", requireAuth, (req, res) => {
    const t = getTemplate(Number(req.params.id));
    if (!t) return bad(res, 404, "Form not found");
    // Documents already made from it keep their own PDFs and values.
    deleteTemplate(t);
    res.json({ ok: true });
  });

  app.get("/api/admin/form-templates/:id/file", requireAuth, (req, res) => {
    const t = getTemplate(Number(req.params.id));
    if (!t || !documentExists(t.storageKey)) return bad(res, 404, "Form not found");
    const abs = documentPath(t.storageKey);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `inline; filename="${t.name.replace(/[^\w.-]+/g, "-")}.pdf"`);
    res.setHeader("Content-Length", String(fs.statSync(abs).size));
    fs.createReadStream(abs).pipe(res);
  });

  /** The blank with the given values printed, not stored: the review screen's preview. */
  app.post("/api/admin/form-templates/:id/preview", requireAuth, async (req, res) => {
    const t = getTemplate(Number(req.params.id));
    if (!t || !documentExists(t.storageKey)) return bad(res, 404, "Form not found");
    const parsed = valuesSchema.safeParse(req.body?.values ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    try {
      const bytes = await renderFormPdf(readDocument(t.storageKey), templateFields(t), parsed.data, { title: `${t.name} (preview)` });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "private, no-store");
      res.send(Buffer.from(bytes));
    } catch (e: any) {
      return bad(res, 500, `Could not render the preview: ${e?.message ?? e}`);
    }
  });

  app.get("/api/admin/deals/:id/form-prefill", requireAuth, (req, res) => {
    const deal = getDeal(Number(req.params.id));
    if (!deal) return bad(res, 404, "Deal not found");
    const t = getTemplate(Number(req.query.templateId));
    if (!t) return bad(res, 404, "Form not found");
    res.json({ template: detail(t), ...prefillForDeal(deal, t) });
  });

  const createSchema = z.object({
    templateId: z.number().int().positive(),
    title: z.string().trim().min(1, "Give the document a title").max(200),
    values: valuesSchema.default({}),
  });

  app.post("/api/admin/deals/:id/documents/from-template", requireAuth, async (req, res) => {
    const deal = getDeal(Number(req.params.id));
    if (!deal) return bad(res, 404, "Deal not found");
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const t = getTemplate(parsed.data.templateId);
    if (!t || !documentExists(t.storageKey)) return bad(res, 404, "Form not found");
    try {
      // Validate the parties before anything is written.
      signersFromValues(templateFields(t), parsed.data.values);
    } catch (e: any) {
      return bad(res, 400, String(e?.message ?? e));
    }
    try {
      const r = await createDocumentFromTemplate({ deal, template: t, title: parsed.data.title, values: parsed.data.values, ...clientMeta(req) });
      res.status(201).json({ ...documentDetail(loadBundle(r.document.id)!, publicOrigin()), signersAdded: r.signers, boxesPlaced: r.boxes, skippedBoxes: r.skippedBoxes });
    } catch (e: any) {
      return bad(res, 500, `Could not create the document: ${e?.message ?? e}`);
    }
  });
}
