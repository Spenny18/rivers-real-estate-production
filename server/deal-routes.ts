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
import fs from "node:fs";
import path from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import { db, storage } from "./storage";
import {
  type Bundle,
  addEvent,
  dealInboxAddress,
  getDeal,
  importPdfDocument,
  loadBundle,
  newInboxToken,
  newSignerToken,
  nowIso,
  signersWhoCanSignNow,
  touchDeal,
  touchDocument,
} from "./deal-store";
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
  type DealEnvelope,
  type DealEnvelopeRecipient,
} from "@shared/schema";
import {
  createEnvelope,
  envelopeBundles,
  getEnvelope,
  listEnvelopesForDeal,
  normEmail,
  peopleIn,
  progressFor,
  recipientByToken,
  recipientsOf,
  refreshEnvelopeStatus,
  signerFor,
  touchEnvelope,
  updateRecipient,
} from "./envelope-store";
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
import { buildSignedPdf } from "./signing";
import {
  sendEmail,
  buildSignRequestHtml,
  buildSignedCopyHtml,
  buildSignAgentNoticeHtml,
  buildEnvelopeSignRequestHtml,
  buildEnvelopeSignedCopyHtml,
} from "./email";
import { publicOrigin } from "./origin";
import { backupStatus, queueDocumentsBackup, runBackup } from "./backup";
import { AGENT } from "./brand";
import { inboxStatus, pollDealInbox, recentInboundForDeal } from "./deal-inbox";
import { FUB_PERSON_URL, noteOnFub } from "./deal-fub";
import { contactAddress } from "./form-templates";
import { requireAccount, type AccountReq } from "./account";
import { AGENT_SIGNER_ID, dealFieldTemplates, templateFieldSchema, type TemplateField } from "@shared/schema";
import { formatStamp } from "@shared/esign-format";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;
type RateLimit = (opts: { windowMs: number; max: number; key: string }) => Middleware;

const MAX_SIGNATURE_PNG_BYTES = 400 * 1024;
const ATTACH_LIMIT_BYTES = 5 * 1024 * 1024;

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

function bad(res: Response, status: number, message: string) {
  return res.status(status).json({ message });
}

function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid input";
}

/** addEvent with the request's network details attached. */
function addEventFromReq(documentId: number, type: string, opts: { signerId?: number | null; detail?: string | null; req?: Request } = {}) {
  addEvent(documentId, type, {
    signerId: opts.signerId,
    detail: opts.detail,
    ip: opts.req ? clientIp(opts.req) : null,
    userAgent: opts.req ? userAgent(opts.req) : null,
  });
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
    format: f.format,
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
    source: d.source,
    formTemplateId: d.formTemplateId,
    status: d.status,
    envelopeId: d.envelopeId ?? null,
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

export function documentDetail(b: Bundle, origin: string) {
  return {
    ...documentSummary(b.document, b.signers),
    message: b.document.message,
    voidReason: b.document.voidReason,
    formValues: b.document.formValues ? (JSON.parse(b.document.formValues) as Record<string, string>) : null,
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
  const contact = d.crmContactFubId ? storage.getCrmContact(d.crmContactFubId) : undefined;
  const crmDeal = d.crmDealFubId ? storage.listCrmDeals({ contactFubId: d.crmContactFubId ?? undefined, limit: 200 }).find((x) => x.fubId === d.crmDealFubId) : undefined;
  return {
    id: d.id,
    title: d.title,
    address: d.address,
    kind: d.kind,
    status: d.status,
    leadId: d.leadId,
    leadName: lead?.name ?? null,
    leadEmail: lead?.email ?? null,
    listingId: d.listingId,
    mlsNumber: d.mlsNumber,
    notes: d.notes,
    crmContactFubId: d.crmContactFubId,
    crmContact: contact
      ? { fubId: contact.fubId, name: contact.name, email: contact.email, phone: contact.phone, address: contactAddress(contact), stage: contact.stage, url: FUB_PERSON_URL(contact.fubId) }
      : null,
    crmDealFubId: d.crmDealFubId,
    crmDeal: crmDeal ? { fubId: crmDeal.fubId, name: crmDeal.name, stageName: crmDeal.stageName, value: crmDeal.value, status: crmDeal.status } : null,
    inboxAddress: dealInboxAddress(d),
    inbound: recentInboundForDeal(d.id).map((m) => ({
      id: m.id,
      from: m.fromAddress,
      subject: m.subject,
      receivedAt: m.receivedAt,
      status: m.status,
      detail: m.detail,
      documentIds: JSON.parse(m.documentIds) as number[],
    })),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    documentCount: docs.length,
    awaitingSignature: awaiting,
    completedDocuments: docs.filter((x) => x.status === "completed").length,
    documents: docs.map((x) => documentSummary(x, signers.filter((s) => s.documentId === x.id))),
    envelopes: listEnvelopesForDeal(d.id).map(envelopeView).reverse(),
  };
}

/** An envelope as the deal page shows it: its documents and each person's progress. */
function envelopeView(env: DealEnvelope) {
  const bundles = envelopeBundles(env.id);
  return {
    id: env.id,
    title: env.title,
    message: env.message,
    status: env.status,
    sentAt: env.sentAt,
    completedAt: env.completedAt,
    voidedAt: env.voidedAt,
    voidReason: env.voidReason,
    documents: bundles.map((b) => ({ id: b.document.id, title: b.document.title, status: b.document.status, signingOrder: b.document.signingOrder })),
    recipients: recipientsOf(env.id).map((r) => {
      const p = progressFor(r, bundles);
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        status: r.status,
        lastEmailAt: r.lastEmailAt,
        total: p.total,
        signed: p.signed,
        canSignNow: p.canSignNow.length,
        waiting: p.waiting.length,
        signUrl: `${publicOrigin()}/sign/e/${r.token}`,
      };
    }),
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
    addEventFromReq(b.document.id, opts.reminder ? "reminder" : "email_sent", { signerId: s.id, detail: s.email });
  } else {
    addEventFromReq(b.document.id, "email_failed", { signerId: s.id, detail: r.error ?? "send failed" });
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

// Documents whose signed PDF is being built right now. The last two signers
// finishing at the same moment would otherwise both see "everyone has signed"
// and both build (and email) the final copy.
const finalizing = new Set<number>();

async function finalize(documentId: number): Promise<Bundle> {
  const current = loadBundle(documentId)!;
  if (current.document.status === "completed" || finalizing.has(documentId)) return current;
  finalizing.add(documentId);
  try {
    return await buildFinal(documentId);
  } finally {
    finalizing.delete(documentId);
  }
}

async function buildFinal(documentId: number): Promise<Bundle> {
  const b = loadBundle(documentId)!;
  const images = new Map<string, Uint8Array>();
  for (const s of b.signers) {
    for (const key of [s.signatureKey, s.initialsKey]) {
      if (key && documentExists(key)) images.set(key, readDocument(key));
    }
  }
  const completedAt = nowIso();
  b.document = { ...b.document, completedAt };
  addEventFromReq(documentId, "completed");
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

  // In an envelope, the signed copies, the agent notice and the FUB note go
  // out once for the whole envelope when its last document completes.
  if (b.document.envelopeId) return loadBundle(documentId)!;

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
  void noteOnFub(
    b.deal,
    `Signed: ${b.document.title}`,
    `${b.document.title} was signed by all parties (${b.signers.map((s) => s.name).join(", ")}) on ${new Date(completedAt).toLocaleString("en-CA", { timeZone: "America/Edmonton" })}.\nDeal: ${b.deal.title}${b.deal.address ? ` — ${b.deal.address}` : ""}\nSigned file SHA-256: ${signedSha256}\n${origin}/admin/deals/${b.deal.id}/documents/${b.document.id}`,
  );
  return loadBundle(documentId)!;
}

function safeFilename(s: string): string {
  return s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

// ---- Routes --------------------------------------------------------------------------

export function clientMeta(req: Request): { ip: string; userAgent: string } {
  return { ip: clientIp(req), userAgent: userAgent(req) };
}

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
        crmContactFubId: v.crmContactFubId || null,
        crmDealFubId: v.crmDealFubId || null,
        inboxToken: newInboxToken(),
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
    if (v.crmContactFubId !== undefined) {
      patch.crmContactFubId = v.crmContactFubId || null;
      // A deal belongs to a person; changing the person drops the FUB deal.
      if ((v.crmContactFubId || null) !== deal.crmContactFubId) patch.crmDealFubId = null;
    }
    if (v.crmDealFubId !== undefined) patch.crmDealFubId = v.crmDealFubId || null;
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
    const deal = getDeal(Number(req.params.id));
    if (!deal) return bad(res, 404, "Deal not found");
    const parsed = uploadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const { title, filename, dataUrl } = parsed.data;
    const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) return bad(res, 400, "Only PDF files can be uploaded.");
    const bytes = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
    let doc: DealDocument;
    try {
      doc = await importPdfDocument({ dealId: deal.id, title, filename, bytes, source: "upload", ip: clientIp(req), userAgent: userAgent(req) });
    } catch (e: any) {
      const msg = String(e?.message ?? "Could not read that PDF.");
      return bad(res, /10 MB/.test(msg) ? 413 : 400, msg);
    }
    res.status(201).json(documentDetail(loadBundle(doc.id)!, publicOrigin()));
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
            token: newSignerToken(),
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
      if (f.signerId === AGENT_SIGNER_ID) {
        if (f.type !== "text" && f.type !== "checkbox") return bad(res, 400, "Only text and checkbox boxes can be filled in by you.");
      } else if (!signerIds.has(f.signerId)) return bad(res, 400, "A field points at a signer who is not on this document.");
      if (f.page > b.document.pageCount) return bad(res, 400, "A field is placed on a page that does not exist.");
    }
    const at = nowIso();
    db.delete(dealFields).where(eq(dealFields.documentId, b.document.id)).run();
    for (const f of parsed.data) {
      const self = f.signerId === AGENT_SIGNER_ID;
      const value = !self ? null : f.type === "checkbox" ? (f.value === "true" ? "true" : "false") : f.value?.trim() || null;
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
          required: self ? false : f.required ?? true,
          label: f.label || null,
          format: f.format || null,
          value,
          filledAt: self ? at : null,
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
    addEventFromReq(b.document.id, "sent", { req, detail: `${b.signers.length} signer(s), ${b.document.signingOrder}` });
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
    if (b.document.envelopeId) return bad(res, 409, "This document was sent in an envelope. Remind from the envelope on the deal page.");
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
    if (b.document.envelopeId && b.document.status === "sent") {
      return bad(res, 409, "This document was sent in an envelope. Void the envelope from the deal page.");
    }
    const reason = String(req.body?.reason ?? "").trim().slice(0, 500) || null;
    touchDocument(b.document.id, { status: "voided", voidedAt: nowIso(), voidReason: reason });
    addEventFromReq(b.document.id, "voided", { req, detail: reason });
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

  // ---- Inbox (forms emailed from WEBForms) ---------------------------------------------

  app.get("/api/admin/deals/inbox/status", requireAuth, (_req, res) => {
    res.json(inboxStatus());
  });

  app.post("/api/admin/deals/inbox/check", requireAuth, async (_req, res) => {
    const result = await pollDealInbox();
    res.status(result.ok ? 200 : 502).json({ message: result.error ?? undefined, result, status: inboxStatus() });
  });

  /** FUB deals for a contact, from the mirror — for the deal page's picker. */
  app.get("/api/admin/crm-deals", requireAuth, (req, res) => {
    const contactFubId = typeof req.query.contactFubId === "string" ? req.query.contactFubId : "";
    if (!contactFubId) return res.json([]);
    res.json(
      storage.listCrmDeals({ contactFubId, limit: 100 }).map((d) => ({ fubId: d.fubId, name: d.name, stageName: d.stageName, value: d.value, status: d.status })),
    );
  });

  // ---- Saved layouts ---------------------------------------------------------------------

  function templateView(t: typeof dealFieldTemplates.$inferSelect) {
    const fields = JSON.parse(t.fields) as TemplateField[];
    return {
      id: t.id,
      name: t.name,
      pageCount: t.pageCount,
      pageSizes: JSON.parse(t.pageSizes) as Array<{ w: number; h: number }>,
      fieldCount: fields.length,
      slots: Array.from(new Set(fields.filter((f) => f.role !== "self").map((f) => `${f.role}:${f.roleIndex}`))).map((k) => {
        const [role, idx] = k.split(":");
        return { role, roleIndex: Number(idx) };
      }),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  app.get("/api/admin/field-templates", requireAuth, (_req, res) => {
    res.json(db.select().from(dealFieldTemplates).orderBy(desc(dealFieldTemplates.updatedAt)).all().map(templateView));
  });

  /** Save the current document's boxes as a reusable layout, keyed by signer slot. */
  app.post("/api/admin/field-templates", requireAuth, (req, res) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 120);
    const documentId = Number(req.body?.documentId);
    if (!name) return bad(res, 400, "Give the layout a name.");
    const b = loadBundle(documentId);
    if (!b) return bad(res, 404, "Document not found");
    if (!b.fields.length) return bad(res, 400, "Place at least one box before saving a layout.");
    // Slot = position among signers with the same role, in signing order.
    const slotOf = new Map<number, { role: string; roleIndex: number }>();
    const counts: Record<string, number> = {};
    for (const s of b.signers) {
      const idx = counts[s.role] ?? 0;
      counts[s.role] = idx + 1;
      slotOf.set(s.id, { role: s.role, roleIndex: idx });
    }
    slotOf.set(AGENT_SIGNER_ID, { role: "self", roleIndex: 0 });
    const fields: TemplateField[] = b.fields
      .filter((f) => slotOf.has(f.signerId))
      .map((f) => ({ ...slotOf.get(f.signerId)!, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, format: f.format } as TemplateField));
    const parsed = z.array(templateFieldSchema).safeParse(fields);
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const existing = db.select().from(dealFieldTemplates).where(eq(dealFieldTemplates.name, name)).get();
    if (existing) {
      db.update(dealFieldTemplates)
        .set({ pageCount: b.document.pageCount, pageSizes: b.document.pageSizes, fields: JSON.stringify(parsed.data), updatedAt: nowIso() })
        .where(eq(dealFieldTemplates.id, existing.id))
        .run();
      return res.json({ ...templateView(db.select().from(dealFieldTemplates).where(eq(dealFieldTemplates.id, existing.id)).get()!), replaced: true });
    }
    const r = db
      .insert(dealFieldTemplates)
      .values({ name, pageCount: b.document.pageCount, pageSizes: b.document.pageSizes, fields: JSON.stringify(parsed.data), createdAt: nowIso(), updatedAt: nowIso() })
      .run();
    res.status(201).json(templateView(db.select().from(dealFieldTemplates).where(eq(dealFieldTemplates.id, Number(r.lastInsertRowid))).get()!));
  });

  app.delete("/api/admin/field-templates/:id", requireAuth, (req, res) => {
    const r = db.delete(dealFieldTemplates).where(eq(dealFieldTemplates.id, Number(req.params.id))).run();
    if (!r.changes) return bad(res, 404, "Layout not found");
    res.json({ ok: true });
  });

  /** Replace a draft's boxes with a saved layout, mapped onto its current signers. */
  app.post("/api/admin/documents/:id/apply-template", requireAuth, (req, res) => {
    const b = loadBundle(Number(req.params.id));
    if (!b) return bad(res, 404, "Document not found");
    if (b.document.status !== "draft") return bad(res, 409, "Boxes can only be changed on a draft.");
    if (!b.signers.length) return bad(res, 400, "Add and save the signers first, then apply a layout.");
    const t = db.select().from(dealFieldTemplates).where(eq(dealFieldTemplates.id, Number(req.body?.templateId))).get();
    if (!t) return bad(res, 404, "Layout not found");
    const fields = JSON.parse(t.fields) as TemplateField[];
    const bySlot = new Map<string, number>([["self:0", AGENT_SIGNER_ID]]);
    const counts: Record<string, number> = {};
    for (const s of b.signers) {
      const idx = counts[s.role] ?? 0;
      counts[s.role] = idx + 1;
      bySlot.set(`${s.role}:${idx}`, s.id);
    }
    let skipped = 0;
    const rows = fields
      .filter((f) => f.page <= b.document.pageCount)
      .map((f) => {
        const signerId = bySlot.get(`${f.role}:${f.roleIndex}`);
        if (signerId === undefined) {
          skipped += 1;
          return null;
        }
        return { documentId: b.document.id, signerId, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, format: f.format ?? null };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    db.delete(dealFields).where(eq(dealFields.documentId, b.document.id)).run();
    for (const row of rows) db.insert(dealFields).values(row).run();
    touchDocument(b.document.id, {});
    const pageMismatch = t.pageCount !== b.document.pageCount;
    res.json({ ...documentDetail(loadBundle(b.document.id)!, publicOrigin()), applied: rows.length, skipped, pageMismatch });
  });

  // ---- Client portal: my documents --------------------------------------------------------

  app.get("/api/account/documents", requireAccount, (req: AccountReq, res) => {
    const email = req.accountUser!.email.toLowerCase();
    const origin = publicOrigin();
    const mine = db.select().from(dealSigners).all().filter((s) => s.email.toLowerCase() === email);
    const out = mine
      .map((s) => {
        const b = loadBundle(s.documentId);
        if (!b || b.document.status === "draft") return null;
        return {
          id: b.document.id,
          title: b.document.title,
          dealTitle: b.deal.title,
          address: b.deal.address,
          status: b.document.status,
          signerStatus: s.status,
          sentAt: b.document.sentAt,
          signedAt: s.signedAt,
          completedAt: b.document.completedAt,
          canSignNow: b.document.status === "sent" && signersWhoCanSignNow(b).some((x) => x.id === s.id),
          signUrl: `${origin}/sign/${s.token}`,
          downloadUrl: b.document.status === "completed" ? `/api/sign/${s.token}/file?which=signed&download=1` : null,
          others: b.signers.filter((x) => x.id !== s.id).map((x) => ({ name: x.name, role: x.role, status: x.status })),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""));
    res.json(out);
  });

  // ---- Backups -----------------------------------------------------------------------

  app.get("/api/admin/backups", requireAuth, (_req, res) => {
    res.json(backupStatus());
  });

  app.post("/api/admin/backups/run", requireAuth, async (req, res) => {
    const kind = req.body?.kind === "documents" ? "documents" : "full";
    const run = await runBackup(kind);
    // `message` first: the admin's error toast shows it instead of the raw body.
    res.status(run.status === "ok" ? 200 : 502).json({ message: run.error ?? undefined, run, status: backupStatus() });
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
      addEventFromReq(b.document.id, "viewed", { signerId: signer.id, req });
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
      addEventFromReq(hit.b.document.id, "downloaded", { signerId: hit.signer.id, req });
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
      addEventFromReq(b.document.id, "consented", { signerId: signer.id, req, detail: "Agreed to use electronic records and signatures" });
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

  type SignInput = z.infer<typeof completeSchema>;

  /** Why this signer can't sign this document right now, or null if they can. */
  function cannotSign(b: Bundle, signer: DealSigner): { status: number; message: string } | null {
    if (b.document.status !== "sent") return { status: 409, message: `${b.document.title} is no longer open for signing.` };
    if (signer.status === "signed") return { status: 409, message: `You have already signed ${b.document.title}.` };
    if (signer.status === "declined") return { status: 409, message: `You declined ${b.document.title}.` };
    if (!signersWhoCanSignNow(b).some((s) => s.id === signer.id)) {
      return { status: 409, message: "It is not your turn to sign yet. You will get an email when it is." };
    }
    if (!signer.consentAt) return { status: 400, message: "Please agree to sign electronically first." };
    return null;
  }

  /** What's missing from a submission for one document, or null. */
  function invalidSubmission(b: Bundle, signer: DealSigner, values: Record<string, string>, hasInitials: boolean): string | null {
    const mine = b.fields.filter((f) => f.signerId === signer.id);
    if (mine.some((f) => f.type === "initials") && !hasInitials) return "Please add your initials as well.";
    for (const f of mine) {
      if (!f.required || f.type !== "text") continue; // only typed boxes can be left empty
      const v = values[String(f.id)];
      if (!v || !v.trim()) return `Please fill in ${f.label || "every text box"}${b.document.envelopeId ? ` on ${b.document.title}` : ""}.`;
    }
    return null;
  }

  function decodePng(dataUrl: string): Buffer | null {
    const bytes = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
    return bytes.length <= MAX_SIGNATURE_PNG_BYTES && isPng(bytes) ? bytes : null;
  }

  /** Record one signer's signature on one document. The checks above must have passed. */
  function recordSignature(
    b: Bundle,
    signer: DealSigner,
    input: { values: Record<string, string>; kind: "drawn" | "typed"; sigBytes: Buffer; iniBytes: Buffer | null },
    req: Request,
  ) {
    const mine = b.fields.filter((f) => f.signerId === signer.id);
    const sigKey = documentKey(b.deal.id, b.document.id, `sig-${signer.id}.png`);
    writeDocument(sigKey, input.sigBytes);
    let iniKey: string | null = null;
    if (input.iniBytes) {
      iniKey = documentKey(b.deal.id, b.document.id, `ini-${signer.id}.png`);
      writeDocument(iniKey, input.iniBytes);
    }
    const at = nowIso();
    const signedAt = new Date(at);
    for (const f of mine) {
      let value: string | null;
      if (f.type === "signature" || f.type === "initials") value = "signed";
      else if (f.type === "checkbox") value = input.values[String(f.id)] === "true" ? "true" : "false";
      // Date and time come from the server clock at this moment, never from
      // the browser: the printed date is evidence of when the signature was
      // recorded, in the signing time zone.
      else if (f.type === "date" || f.type === "time") value = formatStamp(f.type, f.format, signedAt);
      else value = (input.values[String(f.id)] ?? "").trim() || null;
      db.update(dealFields).set({ value, filledAt: at }).where(eq(dealFields.id, f.id)).run();
    }
    db.update(dealSigners)
      .set({
        status: "signed",
        signedAt: at,
        signatureKind: input.kind,
        signatureKey: sigKey,
        initialsKey: iniKey,
        ip: clientIp(req),
        userAgent: userAgent(req),
      })
      .where(eq(dealSigners.id, signer.id))
      .run();
    addEventFromReq(b.document.id, "signed", {
      signerId: signer.id,
      req,
      detail: `${input.kind} signature, ${mine.length} field(s)${b.document.envelopeId ? ", signed in envelope" : ""}`,
    });
  }

  /**
   * After a signature lands: build the final copy when everyone has signed,
   * otherwise move the document along. Returns the signers whose turn it now
   * is on a sequential document — an envelope emails them its own link.
   */
  async function afterSigned(documentId: number, signerId: number): Promise<DealSigner[]> {
    const fresh = loadBundle(documentId)!;
    if (fresh.signers.every((s) => s.status === "signed")) {
      try {
        await finalize(documentId);
      } catch (e: any) {
        console.error("[esign] finalize failed:", e);
        addEventFromReq(documentId, "finalize_failed", { detail: String(e?.message ?? e) });
        // The signature is recorded; the agent can retry from the admin.
      }
      return [];
    }
    // On a sequential document the next signer's turn starts now.
    const nextUp = fresh.document.signingOrder === "sequential" ? signersWhoCanSignNow(fresh).filter((n) => n.id !== signerId) : [];
    if (!fresh.document.envelopeId) {
      void notifyAgent(fresh, "signed", fresh.signers.find((s) => s.id === signerId));
      // Alone, the next signer has never been emailed (their link only goes
      // out on their turn), so "pending" is exactly who to tell.
      for (const next of nextUp) if (next.status === "pending") await emailSigner(fresh, next);
    }
    // In an envelope they may already have its email (for other documents),
    // so the envelope tells them this one is ready regardless.
    return nextUp;
  }

  app.post("/api/sign/:token/complete", signWriteLimiter, async (req, res) => {
    const hit = bySignerToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    const { b, signer } = hit;
    const blocked = cannotSign(b, signer);
    if (blocked) return bad(res, blocked.status, blocked.message.replace(b.document.title, "this document"));
    const parsed = completeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const { values, signature, initials } = parsed.data;
    const invalid = invalidSubmission(b, signer, values, !!initials);
    if (invalid) return bad(res, 400, invalid);
    const sigBytes = decodePng(signature.png);
    if (!sigBytes) return bad(res, 400, "Signature image is not a valid PNG.");
    const iniBytes = initials ? decodePng(initials.png) : null;
    if (initials && !iniBytes) return bad(res, 400, "Initials image is not a valid PNG.");

    recordSignature(b, signer, { values, kind: signature.kind, sigBytes, iniBytes }, req);
    const nextUp = await afterSigned(b.document.id, signer.id);
    // A document from an envelope signed through its own link (the client
    // portal lists documents one by one) still moves the envelope along.
    if (b.document.envelopeId) await envelopeAfterSigning(b.document.envelopeId, signer.email, nextUp);
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
    // Declining one document of an envelope declines the envelope.
    if (b.document.envelopeId) {
      await declineEnvelope(b.document.envelopeId, signer.email, reason, req);
      const out = bySignerToken(String(req.params.token))!;
      return res.json(signerPageView(out.b, out.signer));
    }
    const at = nowIso();
    db.update(dealSigners)
      .set({ status: "declined", declinedAt: at, declineReason: reason, ip: clientIp(req), userAgent: userAgent(req) })
      .where(eq(dealSigners.id, signer.id))
      .run();
    touchDocument(b.document.id, { status: "declined" });
    addEventFromReq(b.document.id, "declined", { signerId: signer.id, req, detail: reason });
    const fresh = loadBundle(b.document.id)!;
    void notifyAgent(fresh, "declined", fresh.signers.find((s) => s.id === signer.id));
    void noteOnFub(fresh.deal, `Declined: ${fresh.document.title}`, `${signer.name} declined to sign ${fresh.document.title}.${reason ? ` Reason: ${reason}` : ""}`);
    touchDeal(b.deal.id, {});
    const out = bySignerToken(String(req.params.token))!;
    res.json(signerPageView(out.b, out.signer));
  });

  // ---- Envelopes: several documents, one email, one signing session ----------------------
  //
  // Each document keeps its own signers, fields, order, signed PDF and
  // certificate; the envelope gives each *person* one link for all of theirs.
  // Per-document audit events are still written for every step, so each
  // document's certificate reads the same as if it had been sent alone.

  function envelopeUrl(r: DealEnvelopeRecipient): string {
    return `${publicOrigin()}/sign/e/${r.token}`;
  }

  /** Email one person the documents waiting on them. */
  async function emailRecipient(env: DealEnvelope, r: DealEnvelopeRecipient, opts: { reminder?: boolean } = {}): Promise<boolean> {
    const bundles = envelopeBundles(env.id);
    const deal = getDeal(env.dealId)!;
    // Only what they can sign now; a document that's waiting on someone else
    // gets its own email when their turn comes.
    const ready = new Set(progressFor(r, bundles).canSignNow);
    const theirs = bundles.filter((b) => ready.has(b.document.id));
    if (!theirs.length) return true;
    const origin = publicOrigin();
    const result = await sendEmail({
      to: r.email,
      subject: `${opts.reminder ? "Reminder: " : ""}Please sign: ${env.title}${theirs.length > 1 ? ` (${theirs.length} documents)` : ""}`,
      html: buildEnvelopeSignRequestHtml({
        recipientName: r.name,
        envelopeTitle: env.title,
        documents: theirs.map((b) => ({ title: b.document.title })),
        dealTitle: deal.title,
        address: deal.address,
        message: env.message,
        signUrl: envelopeUrl(r),
        origin,
        reminder: opts.reminder,
      }),
      replyTo: process.env.RESEND_FROM_EMAIL,
      cc: "", // signing links are private to the signer
    });
    const at = nowIso();
    if (result.ok) updateRecipient(r.id, { lastEmailAt: at, status: r.status === "pending" ? "sent" : r.status });
    for (const b of theirs) {
      const s = signerFor(b, r.email)!;
      if (result.ok) {
        db.update(dealSigners).set({ lastEmailAt: at, status: s.status === "pending" ? "sent" : s.status }).where(eq(dealSigners.id, s.id)).run();
        addEventFromReq(b.document.id, opts.reminder ? "reminder" : "email_sent", { signerId: s.id, detail: `${r.email} (envelope: ${env.title})` });
      } else {
        addEventFromReq(b.document.id, "email_failed", { signerId: s.id, detail: result.error ?? "send failed" });
      }
    }
    if (!result.ok) console.error(`[esign] envelope email to ${r.email} failed:`, result.error);
    return result.ok;
  }

  function syncRecipientStatuses(envId: number) {
    const bundles = envelopeBundles(envId);
    for (const r of recipientsOf(envId)) {
      const p = progressFor(r, bundles);
      if (p.declined && r.status !== "declined") updateRecipient(r.id, { status: "declined" });
      else if (p.total > 0 && p.signed === p.total && r.status !== "signed") updateRecipient(r.id, { status: "signed" });
    }
  }

  /** Every signed copy to every person, one notice to Spencer, one FUB note. */
  async function completeEnvelope(env: DealEnvelope) {
    const bundles = envelopeBundles(env.id);
    const deal = getDeal(env.dealId)!;
    const origin = publicOrigin();
    for (const r of recipientsOf(env.id)) {
      const theirs = bundles.filter((b) => signerFor(b, r.email) && b.document.signedKey);
      if (!theirs.length) continue;
      const total = theirs.reduce((n, b) => n + (b.document.signedBytes ?? 0), 0);
      const attach = total <= ATTACH_LIMIT_BYTES;
      const result = await sendEmail({
        to: r.email,
        subject: `Signed copies: ${env.title}`,
        html: buildEnvelopeSignedCopyHtml({
          recipientName: r.name,
          envelopeTitle: env.title,
          documents: theirs.map((b) => ({ title: b.document.title, sha256: b.document.signedSha256 })),
          dealTitle: deal.title,
          address: deal.address,
          signUrl: envelopeUrl(r),
          origin,
          attached: attach,
        }),
        attachments: attach
          ? theirs.map((b) => ({
              filename: `${safeFilename(b.document.title)}-signed.pdf`,
              content: Buffer.from(readDocument(b.document.signedKey!)).toString("base64"),
            }))
          : undefined,
        cc: "",
      });
      if (!result.ok) console.error(`[esign] envelope signed copies to ${r.email} failed:`, result.error);
    }
    const sendResult = await sendEmail({
      to: agentEmail(),
      subject: `Completed: ${env.title}`,
      html: buildSignAgentNoticeHtml({
        kind: "completed",
        documentTitle: `${env.title} (${bundles.length} document${bundles.length === 1 ? "" : "s"})`,
        dealTitle: deal.title,
        address: deal.address,
        adminUrl: `${origin}/admin/deals/${deal.id}`,
        origin,
      }),
      cc: "",
    });
    if (!sendResult.ok) console.error("[esign] envelope agent notice failed:", sendResult.error);
    const people = recipientsOf(env.id).map((r) => r.name).join(", ");
    void noteOnFub(
      deal,
      `Signed: ${env.title}`,
      `All ${bundles.length} document(s) in ${env.title} were signed by ${people}.\n` +
        bundles.map((b) => `- ${b.document.title} — SHA-256 ${b.document.signedSha256}`).join("\n") +
        `\nDeal: ${deal.title}${deal.address ? ` — ${deal.address}` : ""}\n${origin}/admin/deals/${deal.id}`,
    );
  }

  /**
   * After someone signs in an envelope (from its link or a document's own):
   * update everyone's progress, email whoever's turn has come on a sequential
   * document, and complete the envelope once its last document is.
   */
  async function envelopeAfterSigning(envId: number, signerEmail: string, nextUp: DealSigner[]) {
    syncRecipientStatuses(envId);
    const before = getEnvelope(envId)!.status;
    const env = refreshEnvelopeStatus(envId);
    if (before !== "completed" && env.status === "completed") return completeEnvelope(env);

    // One email per person, however many documents just opened up for them.
    const recipients = recipientsOf(envId);
    const emails = new Set(nextUp.map((n) => normEmail(n.email)).filter((e) => e !== normEmail(signerEmail)));
    for (const r of recipients) if (emails.has(normEmail(r.email))) await emailRecipient(env, r);

    const signer = recipients.find((r) => normEmail(r.email) === normEmail(signerEmail));
    const deal = getDeal(env.dealId)!;
    const r = await sendEmail({
      to: agentEmail(),
      subject: `${signer?.name ?? "A signer"} signed ${env.title}`,
      html: buildSignAgentNoticeHtml({
        kind: "signed",
        signerName: signer?.name,
        documentTitle: env.title,
        dealTitle: deal.title,
        address: deal.address,
        adminUrl: `${publicOrigin()}/admin/deals/${deal.id}`,
        origin: publicOrigin(),
      }),
      cc: "",
    });
    if (!r.ok) console.error("[esign] envelope agent notice failed:", r.error);
  }

  /** Declining any document declines the envelope: nothing in it goes ahead. */
  async function declineEnvelope(envId: number, email: string, reason: string | null, req: Request) {
    const at = nowIso();
    let who: string | null = null;
    for (const b of envelopeBundles(envId)) {
      if (b.document.status !== "sent") continue;
      const s = signerFor(b, email);
      if (s && s.status !== "signed") {
        who = s.name;
        db.update(dealSigners)
          .set({ status: "declined", declinedAt: at, declineReason: reason, ip: clientIp(req), userAgent: userAgent(req) })
          .where(eq(dealSigners.id, s.id))
          .run();
        addEventFromReq(b.document.id, "declined", { signerId: s.id, req, detail: reason });
      } else {
        addEventFromReq(b.document.id, "declined", { req, detail: `Envelope declined by ${email}${reason ? `: ${reason}` : ""}` });
      }
      touchDocument(b.document.id, { status: "declined" });
    }
    syncRecipientStatuses(envId);
    const env = refreshEnvelopeStatus(envId);
    const deal = getDeal(env.dealId)!;
    const r = await sendEmail({
      to: agentEmail(),
      subject: `${who ?? email} declined ${env.title}`,
      html: buildSignAgentNoticeHtml({
        kind: "declined",
        signerName: who ?? email,
        reason,
        documentTitle: env.title,
        dealTitle: deal.title,
        address: deal.address,
        adminUrl: `${publicOrigin()}/admin/deals/${deal.id}`,
        origin: publicOrigin(),
      }),
      cc: "",
    });
    if (!r.ok) console.error("[esign] envelope agent notice failed:", r.error);
    void noteOnFub(deal, `Declined: ${env.title}`, `${who ?? email} declined to sign ${env.title}.${reason ? ` Reason: ${reason}` : ""}`);
    touchDeal(deal.id, {});
  }

  const envelopeCreateSchema = z.object({
    documentIds: z.array(z.number().int().positive()).min(1, "Pick at least one document").max(20),
    title: z.string().trim().min(1, "Give the envelope a title").max(200),
    message: z.string().trim().max(2000).optional().nullable(),
  });

  app.post("/api/admin/deals/:id/envelopes", requireAuth, async (req, res) => {
    const deal = getDeal(Number(req.params.id));
    if (!deal) return bad(res, 404, "Deal not found");
    const parsed = envelopeCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const ids = Array.from(new Set(parsed.data.documentIds));
    const bundles: Bundle[] = [];
    for (const id of ids) {
      const b = loadBundle(id);
      if (!b || b.deal.id !== deal.id) return bad(res, 404, "A selected document isn't on this deal.");
      if (b.document.status !== "draft") return bad(res, 409, `${b.document.title} has already been sent.`);
      if (b.document.envelopeId) return bad(res, 409, `${b.document.title} is already in an envelope.`);
      if (b.signers.length === 0) return bad(res, 400, `${b.document.title} has no signers yet.`);
      for (const s of b.signers) {
        if (!b.fields.some((f) => f.signerId === s.id && f.type === "signature")) {
          return bad(res, 400, `${s.name} has no signature box on ${b.document.title}. Place one before sending.`);
        }
      }
      bundles.push(b);
    }
    if (!process.env.RESEND_API_KEY) return bad(res, 503, "Email is not configured (RESEND_API_KEY), so signing links cannot be sent.");

    const env = createEnvelope({
      dealId: deal.id,
      title: parsed.data.title,
      message: parsed.data.message || null,
      documentIds: ids,
      people: peopleIn(bundles),
    });
    const sentAt = nowIso();
    for (const b of bundles) {
      touchDocument(b.document.id, { status: "sent", sentAt });
      addEventFromReq(b.document.id, "sent", { req, detail: `${b.signers.length} signer(s), ${b.document.signingOrder}, in envelope "${env.title}"` });
    }
    let failures = 0;
    const fresh = envelopeBundles(env.id);
    for (const r of recipientsOf(env.id)) {
      if (progressFor(r, fresh).canSignNow.length === 0) continue; // their turn comes later
      if (!(await emailRecipient(env, r))) failures += 1;
    }
    touchDeal(deal.id, {});
    const out = envelopeView(getEnvelope(env.id)!);
    if (failures) return res.status(207).json({ ...out, warning: `${failures} signing email(s) could not be sent. Use Remind to retry.` });
    res.status(201).json(out);
  });

  app.post("/api/admin/envelopes/:id/remind", requireAuth, async (req, res) => {
    const env = getEnvelope(Number(req.params.id));
    if (!env) return bad(res, 404, "Envelope not found");
    if (env.status !== "sent") return bad(res, 409, "Only an envelope that is out for signature can be reminded.");
    const recipientId = typeof req.body?.recipientId === "number" ? req.body.recipientId : null;
    const bundles = envelopeBundles(env.id);
    const targets = recipientsOf(env.id).filter((r) => (recipientId ? r.id === recipientId : true) && progressFor(r, bundles).canSignNow.length > 0);
    if (!targets.length) return bad(res, 400, "Nobody is waiting to sign right now.");
    let sent = 0;
    for (const r of targets) if (await emailRecipient(env, r, { reminder: true })) sent += 1;
    res.json({ ...envelopeView(getEnvelope(env.id)!), sent });
  });

  app.post("/api/admin/envelopes/:id/void", requireAuth, async (req, res) => {
    const env = getEnvelope(Number(req.params.id));
    if (!env) return bad(res, 404, "Envelope not found");
    if (env.status === "completed") return bad(res, 409, "A completed envelope cannot be voided.");
    if (env.status === "voided") return bad(res, 409, "Already voided.");
    const reason = String(req.body?.reason ?? "").trim().slice(0, 500) || null;
    const at = nowIso();
    for (const b of envelopeBundles(env.id)) {
      if (b.document.status === "completed" || b.document.status === "voided") continue;
      touchDocument(b.document.id, { status: "voided", voidedAt: at, voidReason: reason });
      addEventFromReq(b.document.id, "voided", { req, detail: `Envelope voided${reason ? `: ${reason}` : ""}` });
    }
    touchEnvelope(env.id, { status: "voided", voidedAt: at, voidReason: reason });
    touchDeal(env.dealId, {});
    res.json(envelopeView(getEnvelope(env.id)!));
  });

  // ---- Public: one person's envelope ----

  function byEnvelopeToken(token: string): { env: DealEnvelope; r: DealEnvelopeRecipient; bundles: Bundle[] } | null {
    const r = recipientByToken(token);
    if (!r) return null;
    const env = getEnvelope(r.envelopeId);
    if (!env) return null;
    return { env, r, bundles: envelopeBundles(env.id) };
  }

  function envelopeSignerView(env: DealEnvelope, r: DealEnvelopeRecipient, bundles: Bundle[]) {
    const deal = getDeal(env.dealId)!;
    const documents = bundles
      .map((b) => ({ b, s: signerFor(b, r.email) }))
      .filter((x): x is { b: Bundle; s: DealSigner } => !!x.s)
      .map(({ b, s }) => signerPageView(b, s));
    return {
      envelope: { id: env.id, title: env.title, message: env.message, status: env.status, completedAt: env.completedAt },
      deal: { title: deal.title, address: deal.address },
      agent: { name: AGENT.name, brokerage: AGENT.brokerage, phone: AGENT.phone, email: AGENT.email },
      recipient: { name: r.name, email: r.email, status: r.status, consentAt: r.consentAt },
      documents,
    };
  }

  /** The envelope document a request names, if this person signs it. */
  function envelopeDoc(hit: NonNullable<ReturnType<typeof byEnvelopeToken>>, docId: number) {
    const b = hit.bundles.find((x) => x.document.id === docId);
    const s = b && signerFor(b, hit.r.email);
    return b && s ? { b, s } : null;
  }

  app.get("/api/sign/e/:token", signLimiter, (req, res) => {
    const hit = byEnvelopeToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    // First open is evidence on each document, as with a single document.
    for (const b of hit.bundles) {
      const s = signerFor(b, hit.r.email);
      if (s && b.document.status === "sent" && (s.status === "sent" || s.status === "pending")) {
        db.update(dealSigners).set({ status: "viewed" }).where(eq(dealSigners.id, s.id)).run();
        addEventFromReq(b.document.id, "viewed", { signerId: s.id, req, detail: "via envelope" });
      }
    }
    if (hit.r.status === "pending" || hit.r.status === "sent") updateRecipient(hit.r.id, { status: "viewed" });
    const fresh = byEnvelopeToken(String(req.params.token))!;
    res.setHeader("Cache-Control", "no-store");
    res.json(envelopeSignerView(fresh.env, fresh.r, fresh.bundles));
  });

  app.get("/api/sign/e/:token/doc/:docId/file", signLimiter, (req, res) => {
    const hit = byEnvelopeToken(String(req.params.token));
    const d = hit && envelopeDoc(hit, Number(req.params.docId));
    if (!d) return bad(res, 404, "This signing link is not valid.");
    const which = req.query.which === "signed" ? "signed" : "original";
    if (which === "signed" && d.b.document.status === "completed" && req.query.download === "1") {
      addEventFromReq(d.b.document.id, "downloaded", { signerId: d.s.id, req });
    }
    sendPdf(res, d.b, which, req.query.download === "1");
  });

  app.get("/api/sign/e/:token/doc/:docId/signature/:signerId", signLimiter, (req, res) => {
    const hit = byEnvelopeToken(String(req.params.token));
    const d = hit && envelopeDoc(hit, Number(req.params.docId));
    if (!d) return bad(res, 404, "This signing link is not valid.");
    sendSignatureImage(res, d.b, Number(req.params.signerId), req.query.kind === "initials" ? "initials" : "signature");
  });

  app.post("/api/sign/e/:token/consent", signWriteLimiter, (req, res) => {
    const hit = byEnvelopeToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    if (hit.env.status !== "sent") return bad(res, 409, "These documents are no longer open for signing.");
    const at = nowIso();
    // One agreement, recorded on every document it covers.
    for (const b of hit.bundles) {
      const s = signerFor(b, hit.r.email);
      if (!s || b.document.status !== "sent" || s.consentAt) continue;
      db.update(dealSigners).set({ consentAt: at, ip: clientIp(req), userAgent: userAgent(req) }).where(eq(dealSigners.id, s.id)).run();
      addEventFromReq(b.document.id, "consented", { signerId: s.id, req, detail: "Agreed to use electronic records and signatures (envelope)" });
    }
    if (!hit.r.consentAt) updateRecipient(hit.r.id, { consentAt: at });
    const fresh = byEnvelopeToken(String(req.params.token))!;
    res.json(envelopeSignerView(fresh.env, fresh.r, fresh.bundles));
  });

  const envelopeCompleteSchema = completeSchema.omit({ values: true }).extend({
    documents: z.record(z.string(), z.record(z.string(), z.string().max(2000))).default({}),
  });

  app.post("/api/sign/e/:token/complete", signWriteLimiter, async (req, res) => {
    const hit = byEnvelopeToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    if (hit.env.status !== "sent") return bad(res, 409, "These documents are no longer open for signing.");
    const parsed = envelopeCompleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, 400, firstIssue(parsed.error));
    const { documents, signature, initials } = parsed.data;
    const sigBytes = decodePng(signature.png);
    if (!sigBytes) return bad(res, 400, "Signature image is not a valid PNG.");
    const iniBytes = initials ? decodePng(initials.png) : null;
    if (initials && !iniBytes) return bad(res, 400, "Initials image is not a valid PNG.");

    // Everything this person can sign right now, all at once. Check every
    // document before recording any, so a problem on the third doesn't leave
    // the first two signed and the rest not.
    const todo = progressFor(hit.r, hit.bundles).canSignNow;
    if (!todo.length) return bad(res, 409, "There's nothing for you to sign right now.");
    const plan: Array<{ b: Bundle; s: DealSigner; values: Record<string, string> }> = [];
    for (const docId of todo) {
      const d = envelopeDoc(hit, docId)!;
      const blocked = cannotSign(d.b, d.s);
      if (blocked) return bad(res, blocked.status, blocked.message);
      const values = documents[String(docId)] ?? {};
      const invalid = invalidSubmission(d.b, d.s, values, !!initials);
      if (invalid) return bad(res, 400, invalid);
      plan.push({ ...d, values });
    }
    const nextUp: DealSigner[] = [];
    for (const { b, s, values } of plan) recordSignature(b, s, { values, kind: signature.kind, sigBytes, iniBytes }, req);
    for (const { b, s } of plan) nextUp.push(...(await afterSigned(b.document.id, s.id)));
    await envelopeAfterSigning(hit.env.id, hit.r.email, nextUp);
    touchDeal(hit.env.dealId, {});
    const fresh = byEnvelopeToken(String(req.params.token))!;
    res.json(envelopeSignerView(fresh.env, fresh.r, fresh.bundles));
  });

  app.post("/api/sign/e/:token/decline", signWriteLimiter, async (req, res) => {
    const hit = byEnvelopeToken(String(req.params.token));
    if (!hit) return bad(res, 404, "This signing link is not valid.");
    if (hit.env.status !== "sent") return bad(res, 409, "These documents are no longer open for signing.");
    const reason = String(req.body?.reason ?? "").trim().slice(0, 1000) || null;
    await declineEnvelope(hit.env.id, hit.r.email, reason, req);
    const fresh = byEnvelopeToken(String(req.params.token))!;
    res.json(envelopeSignerView(fresh.env, fresh.r, fresh.bundles));
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

