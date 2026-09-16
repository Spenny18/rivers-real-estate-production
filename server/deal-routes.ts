// HTTP surface for deals and e-signature.
//
//   /api/admin/deals/*       agent — the transaction files, behind requireAuth.
//   /api/admin/documents/*   agent — one PDF: signers, fields, send, void, files.
//   /api/admin/backups       agent — offsite backup status and "run now".
//   /api/sign/:token/*       public — the signer's page. No auth; the token in
//                            the emailed link is the only credential (256 bits,
//                            one per signer per document).
//
// Every file read goes through here: DOCUMENTS_ROOT is not a static mount.
// See server/signing.ts for how the final PDF is produced and
// server/backup.ts for where the copies go.

import type { Express, Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db, storage } from "./storage";
import {
  deals,
  dealDocuments,
  dealSigners,
  dealFields,
  dealEvents,
  createDealSchema,
  signerInputSchema,
  fieldInputSchema,
  SIGNING_ORDERS,
  type Deal,
  type DealDocument,
  type DealSigner,
  type DealField,
  type DealEvent,
} from "@shared/schema";
import { z } from "zod";
import {
  DOCUMENTS_ROOT,
  documentExists,
  documentKey,
  documentPath,
  ensureDocumentsRoot,
  readDocument,
  sha256Hex,
  writeDocument,
} from "./documents-store";
import { buildSignedPdf, inspectPdf } from "./signing";
import { sendEmail, buildSignRequestHtml, buildSignedCopyHtml, buildSignAgentNoticeHtml } from "./email";
import { publicOrigin } from "./origin";
import { backupStatus, queueDocumentsBackup, runBackup } from "./backup";
import { AGENT } from "./brand";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;
type RateLimit = (opts: { windowMs: number; max: number; key: string }) => Middleware;

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_SIGNATURE_PNG_BYTES = 400 * 1024;
const ATTACH_LIMIT_BYTES = 5 * 1024 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function clientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function userAgent(req: Request): string {
  return String(req.headers["user-agent"] ?? "").slice(0, 400);
}

function agentEmail(): string {
  return process.env.SPENCER_NOTIFY_EMAIL || process.env.RESEND_FROM_EMAIL || AGENT.email;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function bad(res: Response, status: number, message: string) {
  return res.status(status).json({ message });
}

function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid input";
}

// ---- Data access ----------------------------------------------------------------

interface Bundle {
  deal: Deal;
  document: DealDocument;
  signers: DealSigner[];
  fields: DealField[];
  events: DealEvent[];
}

function loadBundle(documentId: number): Bundle | null {
  const document = db.select().from(dealDocuments).where(eq(dealDocuments.id, documentId)).get();
  if (!document) return null;
  const deal = db.select().from(deals).where(eq(deals.id, document.dealId)).get();
  if (!deal) return null;
  const signers = db
    .select()
    .from(dealSigners)
    .where(eq(dealSigners.documentId, documentId))
    .orderBy(asc(dealSigners.orderIndex), asc(dealSigners.id))
    .all();
  const fields = db.select().from(dealFields).where(eq(dealFields.documentId, documentId)).orderBy(asc(dealFields.id)).all();
  const events = db.select().from(dealEvents).where(eq(dealEvents.documentId, documentId)).orderBy(asc(dealEvents.id)).all();
  return { deal, document, signers, fields, events };
}

function addEvent(
  documentId: number,
  type: string,
  opts: { signerId?: number | null; detail?: string | null; req?: Request } = {},
): void {
  db.insert(dealEvents)
    .values({
      documentId,
      signerId: opts.signerId ?? null,
      type,
      detail: opts.detail ?? null,
      ip: opts.req ? clientIp(opts.req) : null,
      userAgent: opts.req ? userAgent(opts.req) : null,
      at: nowIso(),
    })
    .run();
}

function touchDocument(id: number, patch: Partial<DealDocument>): DealDocument {
  db.update(dealDocuments)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(dealDocuments.id, id))
    .run();
  return db.select().from(dealDocuments).where(eq(dealDocuments.id, id)).get()!;
}

function touchDeal(id: number, patch: Partial<Deal>): Deal {
  db.update(deals)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(deals.id, id))
    .run();
  return db.select().from(deals).where(eq(deals.id, id)).get()!;
}

/** Whose turn it is. Parallel: everyone still pending. Sequential: the first. */
function signersWhoCanSignNow(b: Bundle): DealSigner[] {
  const open = b.signers.filter((s) => s.status !== "signed" && s.status !== "declined");
  if (b.document.signingOrder === "sequential") return open.slice(0, 1);
  return open;
}

// ---- Views ------------------------------------------------------------------------

function signerView(s: DealSigner, origin: string) {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    role: s.role,
    orderIndex: s.orderIndex,
    status: s.status,
    consentAt: s.consentAt,
    signedAt: s.signedAt,
    declinedAt: s.declinedAt,
    declineReason: s.declineReason,
    signatureKind: s.signatureKind,
    hasSignature: !!s.signatureKey,
    hasInitials: !!s.initialsKey,
    ip: s.ip,
    userAgent: s.userAgent,
    lastEmailAt: s.lastEmailAt,
    signUrl: `${origin}/sign/${s.token}`,
  };
}

function fieldView(f: DealField) {
  return {
    id: f.id,
    signerId: f.signerId,
    type: f.type,
    page: f.page,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
    required: f.required,
    label: f.label,
    value: f.value,
    filledAt: f.filledAt,
  };
}

function documentSummary(d: DealDocument, signers: DealSigner[]) {
  return {
    id: d.id,
    dealId: d.dealId,
    title: d.title,
    originalFilename: d.originalFilename,
    status: d.status,
    pageCount: d.pageCount,
    signingOrder: d.signingOrder,
    sentAt: d.sentAt,
    completedAt: d.completedAt,
    voidedAt: d.voidedAt,
    originalSha256: d.originalSha256,
    signedSha256: d.signedSha256,
    originalBytes: d.originalBytes,
    signedBytes: d.signedBytes,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    signerCount: signers.length,
    signedCount: signers.filter((s) => s.status === "signed").length,
  };
}

function documentDetail(b: Bundle, origin: string) {
  return {
    ...documentSummary(b.document, b.signers),
    message: b.document.message,
    voidReason: b.document.voidReason,
    pageSizes: JSON.parse(b.document.pageSizes) as Array<{ w: number; h: number }>,
    deal: { id: b.deal.id, title: b.deal.title, address: b.deal.address },
    signers: b.signers.map((s) => signerView(s, origin)),
    fields: b.fields.map(fieldView),
    events: b.events.map((e) => ({
      id: e.id,
      signerId: e.signerId,
      type: e.type,
      detail: e.detail,
      ip: e.ip,
      userAgent: e.userAgent,
      at: e.at,
    })),
    canSignNow: signersWhoCanSignNow(b).map((s) => s.id),
  };
}

function dealView(d: Deal) {
  const docs = db.select().from(dealDocuments).where(eq(dealDocuments.dealId, d.id)).orderBy(desc(dealDocuments.id)).all();
  const docIds = docs.map((x) => x.id);
  const signers = docIds.length ? db.select().from(dealSigners).where(inArray(dealSigners.documentId, docIds)).all() : [];
  const lead = d.leadId ? storage.getLead(d.leadId) : undefined;
  const awaiting = docs.filter((x) => x.status === "sent").length;
  return {
    id: d.id,
    title: d.title,
    address: d.address,
    kind: d.kind,
    status: d.status,
    leadId: d.leadId,
    leadName: lead?.name ?? null,
    listingId: d.listingId,
    mlsNumber: d.mlsNumber,
    notes: d.notes,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    documentCount: docs.length,
    awaitingSignature: awaiting,
    completedDocuments: docs.filter((x) => x.status === "completed").length,
    documents: docs.map((x) => documentSummary(x, signers.filter((s) => s.documentId === x.id))),
  };
}

// ---- Emails -----------------------------------------------------------------------

async function emailSigner(b: Bundle, s: DealSigner, opts: { reminder?: boolean } = {}): Promise<boolean> {
  const origin = publicOrigin();
  const r = await sendEmail({
    to: s.email,
    subject: `${opts.reminder ? "Reminder: " : ""}Please sign: ${b.document.title}`,
    html: buildSignRequestHtml({
      recipientName: s.name,
      documentTitle: b.document.title,
      dealTitle: b.deal.title,
      address: b.deal.address,
      message: b.document.message,
      signUrl: `${origin}/sign/${s.token}`,
      origin,
      reminder: opts.reminder,
    }),
    replyTo: process.env.RESEND_FROM_EMAIL,
    // Signing links are private to the signer: no CC to the agent.
    cc: "",
  });
  if (r.ok) {
    db.update(dealSigners)
      .set({ lastEmailAt: nowIso(), status: s.status === "pending" ? "sent" : s.status })
      .where(eq(dealSigners.id, s.id))
      .run();
    addEvent(b.document.id, opts.reminder ? "reminder" : "email_sent", { signerId: s.id, detail: s.email });
  } else {
    addEvent(b.document.id, "email_failed", { signerId: s.id, detail: r.error ?? "send failed" });
    console.error(`[esign] email to ${s.email} failed:`, r.error);
  }
  return r.ok;
}

async function notifyAgent(b: Bundle, kind: "signed" | "declined" | "completed", signer?: DealSigner): Promise<void> {
  const origin = publicOrigin();
  const subject =
    kind === "completed"
      ? `Completed: ${b.document.title}`
      : kind === "signed"
        ? `${signer?.name ?? "A signer"} signed ${b.document.title}`
        : `${signer?.name ?? "A signer"} declined ${b.document.title}`;
  const r = await sendEmail({
    to: agentEmail(),
    subject,
    html: buildSignAgentNoticeHtml({
      kind,
      signerName: signer?.name,
      reason: signer?.declineReason,
      documentTitle: b.document.title,
      dealTitle: b.deal.title,
      address: b.deal.address,
      adminUrl: `${origin}/admin/deals/${b.deal.id}/documents/${b.document.id}`,
      origin,
    }),
    cc: "",
  });
  if (!r.ok) console.error("[esign] agent notice failed:", r.error);
}

// ---- Completion -------------------------------------------------------------------

async function finalize(documentId: number): Promise<Bundle> {
  const b = loadBundle(documentId)!;
  const images = new Map<string, Uint8Array>();
  for (const s of b.signers) {
    for (const key of [s.signatureKey, s.initialsKey]) {
      if (key && documentExists(key)) images.set(key, readDocument(key));
    }
  }
  const completedAt = nowIso();
  b.document = { ...b.document, completedAt };
  addEvent(documentId, "completed");
  b.events = loadBundle(documentId)!.events;
  const bytes = await buildSignedPdf({
    deal: b.deal,
    document: b.document,
    signers: b.signers,
    fields: b.fields,
    events: b.events,
    original: readDocument(b.document.storageKey),
    images,
    origin: publicOrigin(),
  });
  const signedKey = documentKey(b.deal.id, b.document.id, "signed.pdf");
  writeDocument(signedKey, bytes);
  const signedSha256 = sha256Hex(bytes);
  b.document = touchDocument(documentId, {
    status: "completed",
    completedAt,
    signedKey,
    signedSha256,
    signedBytes: bytes.length,
  });
  queueDocumentsBackup();

  // Everyone gets the final copy. Attach it when it is small enough to be
  // welcome in an inbox; the link works regardless.
  const origin = publicOrigin();
  const attach = bytes.length <= ATTACH_LIMIT_BYTES;
  const attachment = attach
    ? [{ filename: `${safeFilename(b.document.title)}-signed.pdf`, content: Buffer.from(bytes).toString("base64") }]
    : undefined;
  for (const s of b.signers) {
    const r = await sendEmail({
      to: s.email,
      subject: `Signed copy: ${b.document.title}`,
      html: buildSignedCopyHtml({
        recipientName: s.name,
        documentTitle: b.document.title,
        dealTitle: b.deal.title,
        address: b.deal.address,
        signUrl: `${origin}/sign/${s.token}`,
        origin,
        sha256: signedSha256,
        attached: attach,
      }),
      attachments: attachment,
      cc: "",
    });
    if (!r.ok) console.error(`[esign] signed copy to ${s.email} failed:`, r.error);
  }
  await notifyAgent(b, "completed");
  return loadBundle(documentId)!;
}

function safeFilename(s: string): string {
  return s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

// ---- Routes --------------------------------------------------------------------------

export function registerDealRoutes(app: Express, deps: { requireAuth: Middleware; rateLimit: RateLimit }) {
  const { requireAuth, rateLimit } = deps;
  ensureDocumentsRoot();
  console.log(`[esign] documents at ${DOCUMENTS_ROOT}`);

  const signLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, key: "sign" });
  const signWriteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, key: "sign-write" });

  // ---- Deals ---------------------------------------------------------------------

  app.get("/api/admin/deals", requireAuth, (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = (status ? db.select().from(deals).where(eq(deals.status, status)) : db.select().from(deals))
      .orderBy(desc(deals.updatedAt))
      .all();
    res.json(rows.map(dealView));
  });

  app.post("/api/admin/deals", requireAuth, (req, res) => {
    const parsed = createDealSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const v = parsed.data;
    const r = db
      .insert(deals)
      .values({
        title: v.title,
        address: v.address || null,
        kind: v.kind ?? "purchase",
        status: v.status ?? "active",
        leadId: v.leadId ?? null,
        listingId: v.listingId || null,
        mlsNumber: v.mlsNumber || null,
        notes: v.notes || null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    const deal = db.select().from(deals).where(eq(deals.id, Number(r.lastInsertRowid))).get()!;
    res.status(201).json(dealView(deal));
  });

  app.get("/api/admin/deals/:id", requireAuth, (req, res) => {
    const deal = db.select().from(deals).where(eq(deals.id, Number(req.params.id))).get();
    if (!deal) return bad(res, 404, "Deal not found");
    res.json(dealView(deal));
  });

  app.patch("/api/admin/deals/:id", requireAuth, (req, res) => {
    const deal = db.select().from(deals).where(eq(deals.id, Number(req.params.id))).get();
    if (!deal) return bad(res, 404, "Deal not found");
    const parsed = createDealSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const v = parsed.data;
    const patch: Partial<Deal> = {};
    if (v.title !== undefined) patch.title = v.title;
    if (v.address !== undefined) patch.address = v.address || null;
    if (v.kind !== undefined) patch.kind = v.kind;
    if (v.status !== undefined) patch.status = v.status;
    if (v.leadId !== undefined) patch.leadId = v.leadId;
    if (v.listingId !== undefined) patch.listingId = v.listingId || null;
    if (v.mlsNumber !== undefined) patch.mlsNumber = v.mlsNumber || null;
    if (v.notes !== undefined) patch.notes = v.notes || null;
    res.json(dealView(touchDeal(deal.id, patch)));
  });

  app.delete("/api/admin/deals/:id", requireAuth, (req, res) => {
    const deal = db.select().from(deals).where(eq(deals.id, Number(req.params.id))).get();
    if (!deal) return bad(res, 404, "Deal not found");
    const docs = db.select().from(dealDocuments).where(eq(dealDocuments.dealId, deal.id)).all();
    if (docs.some((d) => d.status === "completed" || d.status === "sent")) {
      return bad(res, 409, "This deal has documents that were sent or completed. Archive it instead of deleting it.");
    }
    for (const d of docs) deleteDocumentRows(d);
    db.delete(deals).where(eq(deals.id, deal.id)).run();
    res.json({ ok: true });
  });

  // ---- Documents -------------------------------------------------------------------

  const uploadSchema = z.object({
    title: z.string().trim().min(1, "Give the document a title").max(200),
    filename: z.string().trim().max(200).optional(),
    dataUrl: z.string().min(20, "Choose a PDF to upload"),
  });

  app.post("/api/admin/deals/:id/documents", requireAuth, async (req, res) => {
    const deal = db.select().from(deals).where(eq(deals.id, Number(req.params.id))).get();
    if (!deal) return bad(res, 404, "Deal not found");
    const parsed = uploadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const { title, filename, dataUrl } = parsed.data;
    const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) return bad(res, 400, "Only PDF files can be uploaded.");
    const bytes = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
    if (bytes.length < 100 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return bad(res, 400, "That file is not a PDF.");
    if (bytes.length > MAX_PDF_BYTES) return bad(res, 413, "PDFs must be 10 MB or smaller.");
    let info: { pageCount: number; pageSizes: Array<{ w: number; h: number }> };
    try {
      info = await inspectPdf(bytes);
    } catch (e: any) {
      return bad(res, 400, e?.message ?? "Could not read that PDF.");
    }
    const created = db
      .insert(dealDocuments)
      .values({
        dealId: deal.id,
        title,
        originalFilename: filename || null,
        status: "draft",
        storageKey: "pending",
        originalSha256: sha256Hex(bytes),
        originalBytes: bytes.length,
        pageCount: info.pageCount,
        pageSizes: JSON.stringify(info.pageSizes),
        signingOrder: "parallel",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    const id = Number(created.lastInsertRowid);
    const key = documentKey(deal.id, id, "original.pdf");
    writeDocument(key, bytes);
    touchDocument(id, { storageKey: key });
    addEvent(id, "created", { req, detail: `${info.pageCount} page(s), ${bytes.length} bytes` });
    touchDeal(deal.id, {});
    queueDocumentsBackup();
    res.status(201).json(documentDetail(loadBundle(id)!, publicOrigin()));
  });

  app.get("/api/admin/documents/:id", requireAuth, (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    res.json(documentDetail(b, publicOrigin()));
  });

  const patchDocSchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    signingOrder: z.enum(SIGNING_ORDERS).optional(),
    message: z.string().max(2000).nullable().optional(),
  });

  app.patch("/api/admin/documents/:id", requireAuth, (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    const parsed = patchDocSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const v = parsed.data;
    if (b.document.status !== "draft" && (v.signingOrder !== undefined || v.message !== undefined)) {
      return bad(res, 409, "Signing order and message are fixed once a document has been sent.");
    }
    const patch: Partial<DealDocument> = {};
    if (v.title !== undefined) patch.title = v.title;
    if (v.signingOrder !== undefined) patch.signingOrder = v.signingOrder;
    if (v.message !== undefined) patch.message = v.message || null;
    touchDocument(b.document.id, patch);
    res.json(documentDetail(loadBundle(b.document.id)!, publicOrigin()));
  });

  /** Replace the signer list. Draft only. Fields of removed signers go too. */
  app.put("/api/admin/documents/:id/signers", requireAuth, (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    if (b.document.status !== "draft") return bad(res, 409, "Signers can only be changed on a draft.");
    const parsed = z.array(signerInputSchema).max(12).safeParse(req.body ?? []);
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const incoming = parsed.data;
    const emails = incoming.map((s) => s.email.toLowerCase());
    if (new Set(emails).size !== emails.length) return bad(res, 400, "Each signer needs a different email address.");
    const keepIds = new Set<number>();
    incoming.forEach((s, i) => {
      if (s.id && b.signers.some((x) => x.id === s.id)) {
        db.update(dealSigners)
          .set({ name: s.name, email: s.email, role: s.role ?? "buyer", orderIndex: i })
          .where(eq(dealSigners.id, s.id))
          .run();
        keepIds.add(s.id);
      } else {
        const r = db
          .insert(dealSigners)
          .values({
            documentId: b.document.id,
            name: s.name,
            email: s.email,
            role: s.role ?? "buyer",
            orderIndex: i,
            token: newToken(),
            status: "pending",
            createdAt: nowIso(),
          })
          .run();
        keepIds.add(Number(r.lastInsertRowid));
      }
    });
    for (const s of b.signers) {
      if (!keepIds.has(s.id)) {
        db.delete(dealFields).where(eq(dealFields.signerId, s.id)).run();
        db.delete(dealSigners).where(eq(dealSigners.id, s.id)).run();
      }
    }
    touchDocument(b.document.id, {});
    res.json(documentDetail(loadBundle(b.document.id)!, publicOrigin()));
  });

  /** Replace the field layout. Draft only. */
  app.put("/api/admin/documents/:id/fields", requireAuth, (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    if (b.document.status !== "draft") return bad(res, 409, "Fields can only be changed on a draft.");
    const parsed = z.array(fieldInputSchema).max(400).safeParse(req.body ?? []);
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const signerIds = new Set(b.signers.map((s) => s.id));
    for (const f of parsed.data) {
      if (!signerIds.has(f.signerId)) return bad(res, 400, "A field points at a signer who is not on this document.");
      if (f.page > b.document.pageCount) return bad(res, 400, "A field is placed on a page that does not exist.");
    }
    db.delete(dealFields).where(eq(dealFields.documentId, b.document.id)).run();
    for (const f of parsed.data) {
      db.insert(dealFields)
        .values({
          documentId: b.document.id,
          signerId: f.signerId,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          required: f.required ?? true,
          label: f.label || null,
        })
        .run();
    }
    touchDocument(b.document.id, {});
    res.json(documentDetail(loadBundle(b.document.id)!, publicOrigin()));
  });

  app.post("/api/admin/documents/:id/send", requireAuth, async (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    if (b.document.status !== "draft") return bad(res, 409, "This document has already been sent.");
    if (b.signers.length === 0) return bad(res, 400, "Add at least one signer before sending.");
    for (const s of b.signers) {
      const mine = b.fields.filter((f) => f.signerId === s.id);
      if (!mine.some((f) => f.type === "signature")) {
        return bad(res, 400, `${s.name} has no signature box on the document. Place one before sending.`);
      }
    }
    if (!process.env.RESEND_API_KEY) return bad(res, 503, "Email is not configured (RESEND_API_KEY), so signing links cannot be sent.");
    const sentAt = nowIso();
    touchDocument(b.document.id, { status: "sent", sentAt });
    addEvent(b.document.id, "sent", { req, detail: `${b.signers.length} signer(s), ${b.document.signingOrder}` });
    const fresh = loadBundle(b.document.id)!;
    const targets = signersWhoCanSignNow(fresh);
    let failures = 0;
    for (const s of targets) {
      const ok = await emailSigner(fresh, s);
      if (!ok) failures += 1;
    }
    touchDeal(b.deal.id, {});
    const out = documentDetail(loadBundle(b.document.id)!, publicOrigin());
    if (failures) return res.status(207).json({ ...out, warning: `${failures} signing email(s) could not be sent. Use Remind to retry.` });
    res.json(out);
  });

  app.post("/api/admin/documents/:id/remind", requireAuth, async (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    if (b.document.status !== "sent") return bad(res, 409, "Only a document that is out for signature can be reminded.");
    const signerId = typeof req.body?.signerId === "number" ? req.body.signerId : null;
    const targets = signersWhoCanSignNow(b).filter((s) => (signerId ? s.id === signerId : true));
    if (!targets.length) return bad(res, 400, "Nobody is waiting to sign right now.");
    let sent = 0;
    for (const s of targets) if (await emailSigner(b, s, { reminder: true })) sent += 1;
    res.json({ ...documentDetail(loadBundle(b.document.id)!, publicOrigin()), sent });
  });

  app.post("/api/admin/documents/:id/void", requireAuth, async (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    if (b.document.status === "completed") return bad(res, 409, "A completed document cannot be voided. Send a new one instead.");
    if (b.document.status === "voided") return bad(res, 409, "Already voided.");
    const reason = String(req.body?.reason ?? "").trim().slice(0, 500) || null;
    touchDocument(b.document.id, { status: "voided", voidedAt: nowIso(), voidReason: reason });
    addEvent(b.document.id, "voided", { req, detail: reason });
    touchDeal(b.deal.id, {});
    res.json(documentDetail(loadBundle(b.document.id)!, publicOrigin()));
  });

  app.delete("/api/admin/documents/:id", requireAuth, (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    if (b.document.status === "completed" || b.document.status === "sent") {
      return bad(res, 409, "Documents that were sent or completed are kept as records. Void it instead.");
    }
    deleteDocumentRows(b.document);
    touchDeal(b.deal.id, {});
    res.json({ ok: true });
  });

  app.get("/api/admin/documents/:id/file", requireAuth, (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    const which = req.query.which === "signed" ? "signed" : "original";
    sendPdf(res, b, which, req.query.download === "1");
  });

  app.get("/api/admin/documents/:id/signature/:signerId", requireAuth, (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    sendSignatureImage(res, b, Number(req.params.signerId), req.query.kind === "initials" ? "initials" : "signature");
  });

  // ---- Backups -----------------------------------------------------------------------

  app.get("/api/admin/backups", requireAuth, (_req, res) => {
    res.json(backupStatus());
  });

  app.post("/api/admin/backups/run", requireAuth, async (req, res) => {
    const kind = req.body?.kind === "documents" ? "documents" : "full";
    const run = await runBackup(kind);
    res.status(run.status === "ok" ? 200 : 502).json({ run, status: backupStatus() });
  });

  // ---- Public: the signer's page ----------------------------------------------------------

  function bySignerToken(token: string): { b: Bundle; signer: DealSigner } | null {
    if (!token || token.length < 20 || token.length > 128) return null;
    const signer = db.select().from(dealSigners).where(eq(dealSigners.token, token)).get();
    if (!signer) return null;
    const b = loadBundle(signer.documentId);
    if (!b) return null;
    return { b, signer };
  }

  function signerPageView(b: Bundle, signer: DealSigner) {
    const canSign =
      b.document.status === "sent" &&
      signer.status !== "signed" &&
      signer.status !== "declined" &&
      signersWhoCanSignNow(b).some((s) => s.id === signer.id);
    const waitingOn = b.document.signingOrder === "sequential" && b.document.status === "sent" && !canSign
      ? signersWhoCanSignNow(b)[0]?.name ?? null
      : null;
    return {
      document: {
        id: b.document.id,
        title: b.document.title,
        status: b.document.status,
        pageCount: b.document.pageCount,
        pageSizes: JSON.parse(b.document.pageSizes),
        message: b.document.message,
        signingOrder: b.document.signingOrder,
        completedAt: b.document.completedAt,
        originalSha256: b.document.originalSha256,
        signedSha256: b.document.signedSha256,
        signedBytes: b.document.signedBytes,
      },
      deal: { title: b.deal.title, address: b.deal.address },
      agent: { name: AGENT.name, brokerage: AGENT.brokerage, phone: AGENT.phone, email: AGENT.email },
      signer: {
        id: signer.id,
        name: signer.name,
        email: signer.email,
        role: signer.role,
        status: signer.status,
        consentAt: signer.consentAt,
        signedAt: signer.signedAt,
        declinedAt: signer.declinedAt,
      },
      others: b.signers
        .filter((s) => s.id !== signer.id)
        .map((s) => ({ id: s.id, name: s.name, role: s.role, status: s.status, hasSignature: !!s.signatureKey, hasInitials: !!s.initialsKey })),
      fields: b.fields.map((f) => ({ ...fieldView(f), mine: f.signerId === signer.id })),
      canSign,
      waitingOn,
    };
  }

  app.get("/api/sign/:token", signLimiter, (req, res) => {
    const hit = bySignerToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    const { b, signer } = hit;
    // First open is evidence: record it once, and move sent → viewed.
    if (b.document.status === "sent" && (signer.status === "sent" || signer.status === "pending")) {
      db.update(dealSigners).set({ status: "viewed" }).where(eq(dealSigners.id, signer.id)).run();
      addEvent(b.document.id, "viewed", { signerId: signer.id, req });
    }
    const fresh = bySignerToken(String(req.params.token))!;
    res.setHeader("Cache-Control", "no-store");
    res.json(signerPageView(fresh.b, fresh.signer));
  });

  app.get("/api/sign/:token/file", signLimiter, (req, res) => {
    const hit = bySignerToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    const which = req.query.which === "signed" ? "signed" : "original";
    if (which === "signed" && hit.b.document.status === "completed" && req.query.download === "1") {
      addEvent(hit.b.document.id, "downloaded", { signerId: hit.signer.id, req });
    }
    sendPdf(res, hit.b, which, req.query.download === "1");
  });

  app.get("/api/sign/:token/signature/:signerId", signLimiter, (req, res) => {
    const hit = bySignerToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    sendSignatureImage(res, hit.b, Number(req.params.signerId), req.query.kind === "initials" ? "initials" : "signature");
  });

  app.post("/api/sign/:token/consent", signWriteLimiter, (req, res) => {
    const hit = bySignerToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    const { b, signer } = hit;
    if (b.document.status !== "sent") return bad(res, 409, "This document is no longer open for signing.");
    if (!signer.consentAt) {
      db.update(dealSigners)
        .set({ consentAt: nowIso(), ip: clientIp(req), userAgent: userAgent(req) })
        .where(eq(dealSigners.id, signer.id))
        .run();
      addEvent(b.document.id, "consented", { signerId: signer.id, req, detail: "Agreed to use electronic records and signatures" });
    }
    const fresh = bySignerToken(String(req.params.token))!;
    res.json(signerPageView(fresh.b, fresh.signer));
  });

  const pngDataUrl = z
    .string()
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Signature image must be a PNG")
    .max(Math.ceil((MAX_SIGNATURE_PNG_BYTES * 4) / 3) + 64, "Signature image is too large");

  const completeSchema = z.object({
    values: z.record(z.string(), z.string().max(2000)).default({}),
    signature: z.object({ kind: z.enum(["drawn", "typed"]), png: pngDataUrl }),
    initials: z.object({ png: pngDataUrl }).optional(),
  });

  app.post("/api/sign/:token/complete", signWriteLimiter, async (req, res) => {
    const hit = bySignerToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    const { b, signer } = hit;
    if (b.document.status !== "sent") return bad(res, 409, "This document is no longer open for signing.");
    if (signer.status === "signed") return bad(res, 409, "You have already signed this document.");
    if (signer.status === "declined") return bad(res, 409, "You declined this document.");
    if (!signersWhoCanSignNow(b).some((s) => s.id === signer.id)) {
      return bad(res, 409, "It is not your turn to sign yet. You will get an email when it is.");
    }
    if (!signer.consentAt) return bad(res, 400, "Please agree to sign electronically first.");
    const parsed = completeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const { values, signature, initials } = parsed.data;

    const mine = b.fields.filter((f) => f.signerId === signer.id);
    const needsInitials = mine.some((f) => f.type === "initials");
    if (needsInitials && !initials) return bad(res, 400, "Please add your initials as well.");
    for (const f of mine) {
      if (!f.required) continue;
      if (f.type === "signature" || f.type === "initials") continue;
      const v = values[String(f.id)];
      if (f.type === "checkbox") continue; // an unchecked required box is a choice, not an omission
      if (!v || !v.trim()) return bad(res, 400, `Please fill in ${f.label || (f.type === "date" ? "the date" : "every text box")}.`);
    }

    const sigBytes = Buffer.from(signature.png.split(",")[1], "base64");
    if (sigBytes.length > MAX_SIGNATURE_PNG_BYTES || !isPng(sigBytes)) return bad(res, 400, "Signature image is not a valid PNG.");
    const sigKey = documentKey(b.deal.id, b.document.id, `sig-${signer.id}.png`);
    writeDocument(sigKey, sigBytes);
    let iniKey: string | null = null;
    if (initials) {
      const iniBytes = Buffer.from(initials.png.split(",")[1], "base64");
      if (iniBytes.length > MAX_SIGNATURE_PNG_BYTES || !isPng(iniBytes)) return bad(res, 400, "Initials image is not a valid PNG.");
      iniKey = documentKey(b.deal.id, b.document.id, `ini-${signer.id}.png`);
      writeDocument(iniKey, iniBytes);
    }

    const at = nowIso();
    for (const f of mine) {
      let value: string | null;
      if (f.type === "signature" || f.type === "initials") value = "signed";
      else if (f.type === "checkbox") value = values[String(f.id)] === "true" ? "true" : "false";
      else value = (values[String(f.id)] ?? "").trim() || null;
      db.update(dealFields).set({ value, filledAt: at }).where(eq(dealFields.id, f.id)).run();
    }
    db.update(dealSigners)
      .set({
        status: "signed",
        signedAt: at,
        signatureKind: signature.kind,
        signatureKey: sigKey,
        initialsKey: iniKey,
        ip: clientIp(req),
        userAgent: userAgent(req),
      })
      .where(eq(dealSigners.id, signer.id))
      .run();
    addEvent(b.document.id, "signed", { signerId: signer.id, req, detail: `${signature.kind} signature, ${mine.length} field(s)` });

    let fresh = loadBundle(b.document.id)!;
    const allSigned = fresh.signers.every((s) => s.status === "signed");
    if (allSigned) {
      try {
        fresh = await finalize(b.document.id);
      } catch (e: any) {
        console.error("[esign] finalize failed:", e);
        addEvent(b.document.id, "finalize_failed", { detail: String(e?.message ?? e) });
        // The signature is recorded; the agent can retry from the admin.
      }
    } else {
      const signed = fresh.signers.find((s) => s.id === signer.id)!;
      void notifyAgent(fresh, "signed", signed);
      if (fresh.document.signingOrder === "sequential") {
        for (const next of signersWhoCanSignNow(fresh)) {
          if (next.status === "pending") await emailSigner(fresh, next);
        }
      }
    }
    touchDeal(b.deal.id, {});
    const out = bySignerToken(String(req.params.token))!;
    res.json(signerPageView(out.b, out.signer));
  });

  app.post("/api/sign/:token/decline", signWriteLimiter, async (req, res) => {
    const hit = bySignerToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    const { b, signer } = hit;
    if (b.document.status !== "sent") return bad(res, 409, "This document is no longer open for signing.");
    if (signer.status === "signed") return bad(res, 409, "You have already signed this document.");
    const reason = String(req.body?.reason ?? "").trim().slice(0, 1000) || null;
    const at = nowIso();
    db.update(dealSigners)
      .set({ status: "declined", declinedAt: at, declineReason: reason, ip: clientIp(req), userAgent: userAgent(req) })
      .where(eq(dealSigners.id, signer.id))
      .run();
    touchDocument(b.document.id, { status: "declined" });
    addEvent(b.document.id, "declined", { signerId: signer.id, req, detail: reason });
    const fresh = loadBundle(b.document.id)!;
    void notifyAgent(fresh, "declined", fresh.signers.find((s) => s.id === signer.id));
    touchDeal(b.deal.id, {});
    const out = bySignerToken(String(req.params.token))!;
    res.json(signerPageView(out.b, out.signer));
  });

  /** Admin retry when the final PDF could not be produced (e.g. a disk hiccup). */
  app.post("/api/admin/documents/:id/finalize", requireAuth, async (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    if (b.document.status === "completed") return bad(res, 409, "Already completed.");
    if (!(b.document.status === "sent" && b.signers.length && b.signers.every((s) => s.status === "signed"))) {
      return bad(res, 409, "Not every signer has signed yet.");
    }
    try {
      await finalize(b.document.id);
    } catch (e: any) {
      return bad(res, 500, `Could not build the signed PDF: ${e?.message ?? e}`);
    }
    res.json(documentDetail(loadBundle(b.document.id)!, publicOrigin()));
  });
}

// ---- File responses -------------------------------------------------------------------

function sendPdf(res: Response, b: Bundle, which: "original" | "signed", download: boolean) {
  const key = which === "signed" ? b.document.signedKey : b.document.storageKey;
  if (!key || !documentExists(key)) return bad(res, 404, which === "signed" ? "The signed copy is not ready yet." : "File not found");
  const abs = documentPath(key);
  const name = `${safeFilename(b.document.title)}${which === "signed" ? "-signed" : ""}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${name}"`);
  res.setHeader("Content-Length", String(fs.statSync(abs).size));
  fs.createReadStream(abs).pipe(res);
}

function sendSignatureImage(res: Response, b: Bundle, signerId: number, kind: "signature" | "initials") {
  const s = b.signers.find((x) => x.id === signerId);
  const key = kind === "initials" ? s?.initialsKey : s?.signatureKey;
  if (!s || !key || !documentExists(key)) return bad(res, 404, "Not signed yet");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(documentPath(key)).pipe(res);
}

function isPng(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function deleteDocumentRows(d: DealDocument) {
  db.delete(dealFields).where(eq(dealFields.documentId, d.id)).run();
  db.delete(dealSigners).where(eq(dealSigners.documentId, d.id)).run();
  db.delete(dealEvents).where(eq(dealEvents.documentId, d.id)).run();
  db.delete(dealDocuments).where(eq(dealDocuments.id, d.id)).run();
  // The folder holds only this document's files. Best-effort; the backup
  // copy (if any) is left alone on purpose — deleting a draft is not a
  // reason to lose an offsite record.
  try {
    fs.rmSync(path.dirname(documentPath(d.storageKey)), { recursive: true, force: true });
  } catch {}
}

