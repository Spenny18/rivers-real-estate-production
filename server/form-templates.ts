// Form templates: a blank AREA form with boxes drawn on it once, filled from
// the deal every time after.
//
//   importFormTemplate      store a blank PDF as a template
//   prefillForDeal          what the review screen starts with: the deal's
//                           data, the MLS listing, the agent, and whatever was
//                           typed on the previous form for this deal
//   renderFormPdf           print values into the blank (also the preview)
//   createDocumentFromTemplate
//                           render, store as a draft document, add the
//                           signers named on the form and their boxes
//
// Nothing here knows about HTTP; server/form-template-routes.ts does.

import { eq, desc, asc } from "drizzle-orm";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { db, storage } from "./storage";
import {
  deals,
  dealDocuments,
  dealSigners,
  dealFields,
  formTemplates,
  mlsListings,
  formTemplateFieldSchema,
  type Deal,
  type DealDocument,
  type FormTemplate,
  type FormTemplateField,
  type FormFillField,
  type FormSignField,
  type MlsListing,
} from "@shared/schema";
import { z } from "zod";
import {
  BINDING_BY_KEY,
  MAX_PARTIES,
  formatFillValue,
  parsePartyKey,
  partyKey,
  todayIso,
  type PartyRole,
} from "@shared/form-bindings";
import { documentPath, readDocument, sha256Hex, templateKey, writeDocument } from "./documents-store";
import { decryptPdfIfNeeded } from "./pdf-decrypt";
import { INK, drawCheck, drawTextInBox, fieldRect, inspectPdf, safe, wrap } from "./signing";
import { MAX_PDF_BYTES, importPdfDocument, newSignerToken, nowIso, touchDocument } from "./deal-store";
import { AGENT } from "./brand";
import { areaFormCode, detectBlanks, extractText } from "./pdf-text";
import { findAreaLayout } from "./area-layouts";
import { customKeyFor } from "@shared/form-bindings";
import fs from "node:fs";
import path from "node:path";

// ---- Templates -----------------------------------------------------------------------

export function getTemplate(id: number): FormTemplate | undefined {
  return db.select().from(formTemplates).where(eq(formTemplates.id, id)).get();
}

export function listTemplates(): FormTemplate[] {
  return db.select().from(formTemplates).orderBy(asc(formTemplates.kind), asc(formTemplates.name)).all();
}

export function templateFields(t: FormTemplate): FormTemplateField[] {
  const parsed = z.array(formTemplateFieldSchema).safeParse(JSON.parse(t.fields || "[]"));
  return parsed.success ? parsed.data : [];
}

/** Which buyer/seller slots (1-based) the form addresses, from fill and sign boxes. */
export function partySlots(fields: FormTemplateField[]): Record<PartyRole, number> {
  const out: Record<PartyRole, number> = { buyer: 0, seller: 0 };
  for (const f of fields) {
    if (f.kind === "fill") {
      const p = parsePartyKey(f.name);
      if (p) out[p.role] = Math.max(out[p.role], p.index);
    } else if (f.role === "buyer" || f.role === "seller") {
      out[f.role] = Math.max(out[f.role], f.roleIndex + 1);
    }
  }
  out.buyer = Math.min(out.buyer, MAX_PARTIES);
  out.seller = Math.min(out.seller, MAX_PARTIES);
  return out;
}

export interface ImportTemplateInput {
  name: string;
  kind: string;
  description?: string | null;
  bytes: Buffer;
  /** Filename, used as the name when none was given. */
  filename?: string | null;
}

export interface ImportTemplateResult {
  template: FormTemplate;
  /** The built-in AREA layout that was placed, if the footer code matched one. */
  matched: { id: string; name: string; code: string; measuredOn: string; sameRevision: boolean; boxes: number } | null;
  /** Underscored blanks turned into typed boxes when no layout matched. */
  detected: number;
}

/**
 * Validate and store a blank form. When the footer says which AREA form it
 * is, the built-in boxes are placed; otherwise every underscored blank
 * becomes a typed box labelled from the text beside it. Throws with a
 * user-facing message when the bytes are not a usable PDF.
 */
export async function importFormTemplate(input: ImportTemplateInput): Promise<ImportTemplateResult> {
  if (input.bytes.length < 100 || input.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("That file is not a PDF.");
  if (input.bytes.length > MAX_PDF_BYTES) throw new Error("PDFs must be 10 MB or smaller.");
  const { bytes } = await decryptPdfIfNeeded(input.bytes);
  const info = await inspectPdf(bytes);

  const text = await extractText(bytes);
  const code = areaFormCode(text);
  const layout = code ? findAreaLayout(code.id) : undefined;
  let fields: FormTemplateField[] = [];
  let matched: ImportTemplateResult["matched"] = null;
  let detected = 0;
  let name = input.name.trim().slice(0, 120);
  let kind = input.kind;
  let description = input.description?.trim() || null;
  if (layout && layout.pageCount === info.pageCount) {
    fields = layout.fields().filter((f) => f.page <= info.pageCount);
    matched = { id: layout.id, name: layout.name, code: code!.code, measuredOn: layout.measuredOn, sameRevision: code!.code === layout.measuredOn, boxes: fields.length };
    if (!name || name === (input.filename ?? "").replace(/\.pdf$/i, "")) name = layout.name;
    if (kind === "other") kind = layout.kind;
    if (!description) description = `${layout.description}${matched.sameRevision ? "" : ` Boxes were measured on ${layout.measuredOn}; this blank is ${code!.code} — check them.`}`;
  } else if (text.items.length) {
    const seen = new Set<string>();
    for (const bl of detectBlanks(text)) {
      const size = text.pageSizes[bl.page - 1] ?? { w: 612, h: 792 };
      const h = Math.max(11, Math.min(16, bl.size + 5));
      const base = bl.label ? customKeyFor(bl.label) : `custom.blank-p${bl.page}`;
      let key = base;
      for (let i = 2; seen.has(key); i++) key = `${base}-${i}`;
      seen.add(key);
      fields.push({
        kind: "fill",
        key: `d${fields.length + 1}`,
        page: bl.page,
        x: bl.x0 / size.w,
        y: (size.h - (bl.y - 3 + h)) / size.h,
        w: (bl.x1 - bl.x0) / size.w,
        h: h / size.h,
        name: key,
        label: bl.label || `Blank (page ${bl.page})`,
        dataType: "text",
        align: "left",
        fontSize: null,
        format: null,
      });
      detected += 1;
    }
  }
  if (!name) name = (input.filename ?? "").replace(/\.pdf$/i, "").trim() || "Form";

  const r = db
    .insert(formTemplates)
    .values({
      name,
      kind,
      description,
      storageKey: "pending",
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      pageCount: info.pageCount,
      pageSizes: JSON.stringify(info.pageSizes),
      fields: JSON.stringify(fields),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  const id = Number(r.lastInsertRowid);
  const key = templateKey(id, "blank.pdf");
  writeDocument(key, bytes);
  db.update(formTemplates).set({ storageKey: key }).where(eq(formTemplates.id, id)).run();
  return { template: getTemplate(id)!, matched, detected };
}

export function deleteTemplate(t: FormTemplate): void {
  db.delete(formTemplates).where(eq(formTemplates.id, t.id)).run();
  try {
    fs.rmSync(path.dirname(documentPath(t.storageKey)), { recursive: true, force: true });
  } catch {}
}

// ---- Prefill ---------------------------------------------------------------------------

export type ValueSource = "deal" | "listing" | "agent" | "contact" | "previous" | "auto";

export interface Prefill {
  values: Record<string, string>;
  sources: Record<string, ValueSource>;
  /** The document whose answers were carried forward, if any. */
  carriedFrom: { id: number; title: string; createdAt: string } | null;
  /** The listing the property details came from, if any. */
  listing: { id: string; mlsNumber: string; address: string } | null;
  slots: Record<PartyRole, number>;
}

function listingForDeal(deal: Deal): MlsListing | undefined {
  if (deal.listingId) {
    const byId = storage.getMlsListingById(deal.listingId);
    if (byId) return byId;
  }
  if (deal.mlsNumber) {
    return db.select().from(mlsListings).where(eq(mlsListings.mlsNumber, deal.mlsNumber.trim().toUpperCase())).get()
      ?? db.select().from(mlsListings).where(eq(mlsListings.mlsNumber, deal.mlsNumber.trim())).get();
  }
  return undefined;
}

/**
 * The mailing address Follow Up Boss holds for a person, from the mirrored
 * person JSON (`addresses: [{ type, street, city, state, code, country }]`).
 * The home address wins over an office one; the first one otherwise.
 */
export function contactAddress(contact: { raw: string } | undefined): string | null {
  if (!contact) return null;
  let raw: any;
  try {
    raw = JSON.parse(contact.raw || "{}");
  } catch {
    return null;
  }
  const list: any[] = Array.isArray(raw?.addresses) ? raw.addresses : raw?.address ? [raw.address] : [];
  const pick = list.find((a) => a && typeof a === "object" && String(a.type ?? "").toLowerCase() === "home") ?? list.find((a) => a && typeof a === "object");
  if (!pick) return null;
  const street = String(pick.street ?? pick.street1 ?? pick.address ?? "").trim();
  const city = String(pick.city ?? "").trim();
  const state = String(pick.state ?? pick.province ?? "").trim();
  const code = String(pick.code ?? pick.postalCode ?? pick.zip ?? "").trim();
  const line = [street, city, [state, code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return line || null;
}

function streetOf(l: MlsListing): string {
  const num = [l.unit ? `${l.unit} -` : "", l.streetNumber ?? "", l.streetName ?? ""].filter(Boolean).join(" ").trim();
  return num || l.fullAddress.split(",")[0].trim();
}

const PROVINCE_NAMES: Record<string, string> = { AB: "Alberta", BC: "British Columbia", SK: "Saskatchewan", MB: "Manitoba", ON: "Ontario" };

/** The newest document on the deal that was made from a form, with its values. */
function previousFormDocument(dealId: number): DealDocument | undefined {
  return db
    .select()
    .from(dealDocuments)
    .where(eq(dealDocuments.dealId, dealId))
    .orderBy(desc(dealDocuments.id))
    .all()
    .find((d) => d.formValues && d.status !== "voided");
}

/**
 * Values for every key the template uses. Data-backed keys always come from
 * the data; typed keys carry forward from the previous form on this deal.
 * The parties: whoever signed the previous form, else the deal's client.
 */
export function prefillForDeal(deal: Deal, template: FormTemplate): Prefill {
  const fields = templateFields(template);
  const slots = partySlots(fields);
  const values: Record<string, string> = {};
  const sources: Record<string, ValueSource> = {};
  const set = (key: string, v: string | null | undefined, source: ValueSource) => {
    const s = (v ?? "").toString().trim();
    if (!s) return;
    values[key] = s;
    sources[key] = source;
  };

  // 1. Carried forward from the previous form (typed and party values).
  const prev = previousFormDocument(deal.id);
  let carriedFrom: Prefill["carriedFrom"] = null;
  if (prev?.formValues) {
    let prevValues: Record<string, string> = {};
    try {
      prevValues = JSON.parse(prev.formValues);
    } catch {}
    for (const [k, v] of Object.entries(prevValues)) {
      const b = BINDING_BY_KEY[k];
      if (b && (b.source === "agent" || b.source === "auto")) continue;
      set(k, v, "previous");
    }
    if (Object.keys(prevValues).length) carriedFrom = { id: prev.id, title: prev.title, createdAt: prev.createdAt };
  }

  // 2. Live data wins over what was carried for data-backed keys.
  const listing = listingForDeal(deal);
  set("property.address", deal.address || listing?.fullAddress, deal.address ? "deal" : "listing");
  set("property.mls", deal.mlsNumber || listing?.mlsNumber, deal.mlsNumber ? "deal" : "listing");
  if (listing) {
    set("property.street", streetOf(listing), "listing");
    set("property.city", listing.city, "listing");
    set("property.province", PROVINCE_NAMES[listing.province] ?? listing.province, "listing");
    set("property.postal", listing.postalCode, "listing");
    set("property.listPrice", listing.listPrice ? String(listing.listPrice) : null, "listing");
    set("property.type", listing.propertySubType || listing.propertyType, "listing");
    set("listing.brokerage", listing.listOffice, "listing");
    set("listing.agent", listing.listAgentName, "listing");
    set("listing.agentPhone", listing.listAgentPhone, "listing");
  } else if (deal.address) {
    // "123 Elbow Dr SW, Calgary, AB T2S 2A1" → street / city.
    const parts = deal.address.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      set("property.street", parts[0], "deal");
      set("property.city", parts[1].replace(/\s+(AB|Alberta)\b.*$/i, ""), "deal");
    }
  }
  if (!values["property.city"]) set("property.city", "Calgary", "auto");
  if (!values["property.province"]) set("property.province", "Alberta", "auto");

  set("agent.name", AGENT.name, "agent");
  set("agent.brokerage", AGENT.brokerage, "agent");
  set("agent.phone", AGENT.phone, "agent");
  set("agent.email", AGENT.email, "agent");
  set("agent.address", AGENT.address, "agent");
  if (!values["offer.depositHolder"]) set("offer.depositHolder", AGENT.brokerage, "agent");
  if (!values["offer.contractProvidedBy"]) set("offer.contractProvidedBy", deal.kind === "listing" ? "seller's" : "buyer's", "auto");

  const today = todayIso();
  set("document.date", today, "auto");
  set("document.year", today.slice(2, 4), "auto");

  // 3. The client, when nobody was carried forward into the first slot.
  const clientRole: PartyRole = deal.kind === "listing" ? "seller" : "buyer";
  const contact = deal.crmContactFubId ? storage.getCrmContact(deal.crmContactFubId) : undefined;
  if (slots[clientRole] > 0 && !values[partyKey(clientRole, 1, "name")] && !values[partyKey(clientRole, 1, "email")]) {
    const lead = deal.leadId ? storage.getLead(deal.leadId) : undefined;
    const name = contact?.name || lead?.name;
    const email = contact?.email || lead?.email;
    const phone = contact?.phone || lead?.phone;
    if (name || email) {
      set(partyKey(clientRole, 1, "name"), name, "contact");
      set(partyKey(clientRole, 1, "email"), email, "contact");
      set(partyKey(clientRole, 1, "phone"), phone, "contact");
      set(partyKey(clientRole, 1, "address"), contactAddress(contact), "contact");
    }
  }
  // The mailing address from Follow Up Boss, whenever the first slot is that
  // person and the address is still blank (a previous form may predate it).
  if (slots[clientRole] > 0 && contact && !values[partyKey(clientRole, 1, "address")]) {
    const sameEmail = contact.email && (values[partyKey(clientRole, 1, "email")] ?? "").trim().toLowerCase() === contact.email.trim().toLowerCase();
    if (sameEmail) set(partyKey(clientRole, 1, "address"), contactAddress(contact), "contact");
  }

  return {
    values,
    sources,
    carriedFrom,
    listing: listing ? { id: listing.id, mlsNumber: listing.mlsNumber, address: listing.fullAddress } : null,
    slots,
  };
}

// ---- Rendering --------------------------------------------------------------------------

function drawFill(page: PDFPage, font: PDFFont, f: FormFillField, raw: string | undefined) {
  const text = formatFillValue(f.dataType, raw, f.format);
  if (!text) return;
  const r = fieldRect(page, f);
  if (f.dataType === "checkbox") {
    drawCheck(page, r);
    return;
  }
  if (f.dataType !== "multiline" || r.rotate !== 0) {
    drawTextInBox(page, { font }, text, r, { align: f.align, maxSize: f.fontSize ?? 11 });
    return;
  }
  // Multi-line: shrink until the wrapped text fits the box, then print from the top.
  const t = safe(text);
  const maxW = r.w - 6;
  let size = f.fontSize ?? 9;
  let lines = wrap(font, t, size, maxW);
  while (size > 5 && lines.length * size * 1.25 > r.h - 4) {
    size -= 0.5;
    lines = wrap(font, t, size, maxW);
  }
  const lineH = size * 1.25;
  let y = r.y + r.h - 3 - size;
  for (const line of lines) {
    if (y < r.y - size * 0.2) break;
    const tw = font.widthOfTextAtSize(line, size);
    const x = f.align === "center" ? r.x + (r.w - tw) / 2 : f.align === "right" ? r.x + r.w - 3 - tw : r.x + 3;
    page.drawText(line, { x, y, size, font, color: INK });
    y -= lineH;
  }
}

/** The blank with every fill box printed. Sign boxes are left for the signers. */
export async function renderFormPdf(blank: Uint8Array, fields: FormTemplateField[], values: Record<string, string>, meta: { title: string }): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(blank, { ignoreEncryption: true, updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  for (const f of fields) {
    if (f.kind !== "fill") continue;
    const page = pages[f.page - 1];
    if (!page) continue;
    drawFill(page, font, f, values[f.name]);
  }
  pdf.setTitle(meta.title);
  pdf.setProducer(`${AGENT.business} forms`);
  pdf.setModificationDate(new Date());
  return pdf.save({ useObjectStreams: false });
}

// ---- Creating the document -----------------------------------------------------------------

export interface CreateFromTemplateInput {
  deal: Deal;
  template: FormTemplate;
  title: string;
  values: Record<string, string>;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreateFromTemplateResult {
  document: DealDocument;
  signers: number;
  boxes: number;
  /** Sign boxes dropped because their party was left blank. */
  skippedBoxes: number;
}

interface SlotSigner {
  role: string;
  roleIndex: number;
  name: string;
  email: string;
}

/**
 * The signers a filled form names: buyers and sellers with a name and an
 * email, in slot order, then the agent for any agent box. A party with a name
 * but no email (or the reverse) is an error the review screen must fix.
 */
export function signersFromValues(fields: FormTemplateField[], values: Record<string, string>): SlotSigner[] {
  const slots = partySlots(fields);
  const out: SlotSigner[] = [];
  for (const role of ["buyer", "seller"] as const) {
    for (let i = 1; i <= slots[role]; i++) {
      const name = (values[partyKey(role, i, "name")] ?? "").trim();
      const email = (values[partyKey(role, i, "email")] ?? "").trim();
      if (!name && !email) continue;
      const who = `${i === 1 ? "The first" : i === 2 ? "The second" : `Number ${i}`} ${role}`;
      if (!name) throw new Error(`${who} has an email but no name.`);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${who} (${name}) needs a valid email address to receive the signing link.`);
      out.push({ role, roleIndex: i - 1, name, email });
    }
  }
  if (fields.some((f) => f.kind === "sign" && f.role === "agent")) {
    out.push({ role: "agent", roleIndex: 0, name: AGENT.name, email: AGENT.email });
  }
  const emails = out.map((s) => s.email.toLowerCase());
  if (new Set(emails).size !== emails.length) throw new Error("Each party needs a different email address.");
  return out;
}

export async function createDocumentFromTemplate(input: CreateFromTemplateInput): Promise<CreateFromTemplateResult> {
  const fields = templateFields(input.template);
  const signers = signersFromValues(fields, input.values);
  const blank = readDocument(input.template.storageKey);
  const bytes = Buffer.from(await renderFormPdf(blank, fields, input.values, { title: input.title }));
  const document = await importPdfDocument({
    dealId: input.deal.id,
    title: input.title,
    filename: `${input.template.name.replace(/[^\w.-]+/g, "-")}.pdf`,
    bytes,
    source: "template",
    detail: `from form "${input.template.name}"`,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  const bySlot = new Map<string, number>();
  signers.forEach((s, i) => {
    const r = db
      .insert(dealSigners)
      .values({
        documentId: document.id,
        name: s.name,
        email: s.email,
        role: s.role,
        orderIndex: i,
        token: newSignerToken(),
        status: "pending",
        createdAt: nowIso(),
      })
      .run();
    bySlot.set(`${s.role}:${s.roleIndex}`, Number(r.lastInsertRowid));
  });

  let boxes = 0;
  let skippedBoxes = 0;
  for (const f of fields) {
    if (f.kind !== "sign" || f.page > document.pageCount) continue;
    const signerId = bySlot.get(`${f.role}:${f.roleIndex}`);
    if (!signerId) {
      skippedBoxes += 1;
      continue;
    }
    db.insert(dealFields)
      .values({ documentId: document.id, signerId, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, format: f.format ?? null })
      .run();
    boxes += 1;
  }

  // Keep only keys the form actually uses, so nothing typed in error follows the deal around.
  const used = new Set(fields.filter((f): f is FormFillField => f.kind === "fill").map((f) => f.name));
  const slots = partySlots(fields);
  for (const role of ["buyer", "seller"] as const) for (let i = 1; i <= slots[role]; i++) for (const a of ["name", "email", "phone", "address"] as const) used.add(partyKey(role, i, a));
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.values)) if (used.has(k) && v.trim()) kept[k] = v.trim();
  const updated = touchDocument(document.id, { formTemplateId: input.template.id, formValues: JSON.stringify(kept) });
  db.update(deals).set({ updatedAt: nowIso() }).where(eq(deals.id, input.deal.id)).run();
  return { document: updated, signers: signers.length, boxes, skippedBoxes };
}
