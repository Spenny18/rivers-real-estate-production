// Data access shared by the deal routes, the inbox poller and the FUB hook:
// loading a document with everything attached to it, the audit trail, and
// turning PDF bytes into a draft document. Nothing here knows about HTTP.

import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "./storage";
import {
  deals,
  dealDocuments,
  dealSigners,
  dealFields,
  dealEvents,
  type Deal,
  type DealDocument,
  type DealSigner,
  type DealField,
  type DealEvent,
} from "@shared/schema";
import { documentKey, sha256Hex, writeDocument } from "./documents-store";
import { inspectPdf } from "./signing";
import { decryptPdfIfNeeded } from "./pdf-decrypt";
import { queueDocumentsBackup } from "./backup";
import { AGENT } from "./brand";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export function nowIso(): string {
  return new Date().toISOString();
}

/** A signer's private credential: 256 bits, in the emailed link. */
export function newSignerToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface Bundle {
  deal: Deal;
  document: DealDocument;
  signers: DealSigner[];
  fields: DealField[];
  events: DealEvent[];
}

export function getDeal(id: number): Deal | undefined {
  return db.select().from(deals).where(eq(deals.id, id)).get();
}

export function loadBundle(documentId: number): Bundle | null {
  const document = db.select().from(dealDocuments).where(eq(dealDocuments.id, documentId)).get();
  if (!document) return null;
  const deal = getDeal(document.dealId);
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

export function addEvent(
  documentId: number,
  type: string,
  opts: { signerId?: number | null; detail?: string | null; ip?: string | null; userAgent?: string | null } = {},
): void {
  db.insert(dealEvents)
    .values({
      documentId,
      signerId: opts.signerId ?? null,
      type,
      detail: opts.detail ?? null,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      at: nowIso(),
    })
    .run();
}

export function touchDocument(id: number, patch: Partial<DealDocument>): DealDocument {
  db.update(dealDocuments)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(dealDocuments.id, id))
    .run();
  return db.select().from(dealDocuments).where(eq(dealDocuments.id, id)).get()!;
}

export function touchDeal(id: number, patch: Partial<Deal>): Deal {
  db.update(deals)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(deals.id, id))
    .run();
  return getDeal(id)!;
}

/** Whose turn it is. Parallel: everyone still pending. Sequential: the first. */
export function signersWhoCanSignNow(b: Bundle): DealSigner[] {
  const open = b.signers.filter((s) => s.status !== "signed" && s.status !== "declined");
  if (b.document.signingOrder === "sequential") return open.slice(0, 1);
  return open;
}

// ---- The deal's inbound address ---------------------------------------------------

export function newInboxToken(): string {
  return randomBytes(5).toString("hex");
}

/**
 * The mailbox the poller reads, e.g. spencer@riversrealestate.ca. Overridable
 * because the Google connection may be a different Workspace account.
 */
export function inboxMailbox(): string {
  return (process.env.DEAL_INBOX_MAILBOX || AGENT.email).trim().toLowerCase();
}

/** spencer+deal-3f9a1c@riversrealestate.ca — Gmail delivers +tags to the base mailbox. */
export function dealInboxAddress(deal: Pick<Deal, "inboxToken">): string | null {
  if (!deal.inboxToken) return null;
  const [local, domain] = inboxMailbox().split("@");
  if (!local || !domain) return null;
  return `${local}+deal-${deal.inboxToken}@${domain}`;
}

/** Pull a deal token out of any address or subject line that carries one. */
export function extractInboxToken(text: string): string | null {
  const m = /deal-([a-f0-9]{8,12})\b/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

export function getDealByInboxToken(token: string): Deal | undefined {
  return db.select().from(deals).where(eq(deals.inboxToken, token)).get();
}

// ---- Creating a document from PDF bytes ---------------------------------------------

export interface ImportPdfInput {
  dealId: number;
  title: string;
  filename?: string | null;
  bytes: Buffer;
  source: "upload" | "email" | "template";
  /** Free text for the audit trail, e.g. "emailed by x@y from WEBForms". */
  detail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Validate, store and record a PDF as a draft document. Throws with a
 * user-facing message when the bytes are not a usable PDF.
 */
export async function importPdfDocument(input: ImportPdfInput): Promise<DealDocument> {
  if (input.bytes.length < 100 || input.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("That file is not a PDF.");
  if (input.bytes.length > MAX_PDF_BYTES) throw new Error("PDFs must be 10 MB or smaller.");
  // WEBForms exports carry an owner password (no editing/copying). Strip it so
  // the signature stamping can write to the pages; the stored original is the
  // decrypted copy and looks identical.
  const { bytes, decrypted } = await decryptPdfIfNeeded(input.bytes);
  const info = await inspectPdf(bytes);
  const created = db
    .insert(dealDocuments)
    .values({
      dealId: input.dealId,
      title: input.title.trim().slice(0, 200) || "Document",
      originalFilename: input.filename || null,
      source: input.source,
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
  const key = documentKey(input.dealId, id, "original.pdf");
  writeDocument(key, bytes);
  const doc = touchDocument(id, { storageKey: key });
  addEvent(id, "created", {
    detail: `${info.pageCount} page(s), ${bytes.length} bytes${decrypted ? ", owner-password encryption removed" : ""}${input.detail ? ` — ${input.detail}` : ""}`,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  touchDeal(input.dealId, {});
  queueDocumentsBackup();
  return doc;
}
