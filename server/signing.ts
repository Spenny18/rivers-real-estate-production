// The e-signature engine: what turns an uploaded PDF plus everyone's answers
// into the final signed document.
//
// The original PDF is never modified. Signers fill fields (stored in
// deal_fields.value) and draw or type a signature (stored as a PNG under
// DOCUMENTS_ROOT). When the last signer finishes, `buildSignedPdf` loads the
// original, draws every field onto its page, appends a signature certificate
// and returns the bytes. The certificate carries the original file's SHA-256
// and every signer's consent, signature and network evidence; the SHA-256 of
// the final file is stored on the row (it cannot be printed inside itself).
//
// Coordinates: fields are stored as fractions of the page's width/height
// measured from the top-left, which is how the browser placed them. pdf-lib's
// origin is bottom-left, so y flips here.

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb, degrees } from "pdf-lib";
import type { DealDocument, DealEvent, DealField, DealSigner, Deal } from "@shared/schema";
import { AGENT } from "./brand";

export interface PageSize {
  w: number;
  h: number;
}

/** Page count and sizes (PDF points) of an uploaded PDF, or why it cannot be used. */
export async function inspectPdf(bytes: Uint8Array): Promise<{ pageCount: number; pageSizes: PageSize[] }> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e: any) {
    throw new Error(`That file could not be read as a PDF (${e?.message ?? "unknown error"}).`);
  }
  if (doc.isEncrypted) {
    throw new Error("This PDF is password-protected. Export it from WEBForms without a password and upload again.");
  }
  const pages = doc.getPages();
  if (pages.length === 0) throw new Error("This PDF has no pages.");
  return {
    pageCount: pages.length,
    pageSizes: pages.map((p) => {
      const { width, height } = p.getSize();
      const rot = ((p.getRotation().angle % 360) + 360) % 360;
      // A page rotated 90/270 is displayed sideways; the browser sees the
      // swapped dimensions, so that is what the field fractions refer to.
      return rot === 90 || rot === 270 ? { w: height, h: width } : { w: width, h: height };
    }),
  };
}

// ---- Drawing --------------------------------------------------------------------

const INK = rgb(0.05, 0.08, 0.2);
const MUTE = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.86, 0.88);
const GOLD = rgb(0.83, 0.69, 0.22);

/**
 * Standard-14 fonts only speak WinAnsi. Common typographic characters get
 * an ASCII stand-in; anything else becomes "?".
 */
const ASCII_STANDINS: Record<string, string> = {
  "—": "-", // em dash
  "–": "-", // en dash
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  "•": "*",
  " ": " ",
  "→": "->",
};
function safe(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/[—–‘’“”…• →]/g, (c) => ASCII_STANDINS[c] ?? "?")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function fitText(font: PDFFont, text: string, maxWidth: number, startSize: number, minSize = 5): number {
  let size = startSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return size;
}

/** Field box in page points, bottom-left origin, accounting for page rotation. */
function fieldRect(page: PDFPage, f: DealField): { x: number; y: number; w: number; h: number; rotate: number } {
  const { width, height } = page.getSize();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  if (rot === 0) {
    const w = f.w * width;
    const h = f.h * height;
    return { x: f.x * width, y: height - f.y * height - h, w, h, rotate: 0 };
  }
  // Displayed size is swapped for 90/270. Map the displayed top-left box back
  // into the unrotated page space. Only 90 and 270 are handled; 180 falls
  // back to unrotated placement (rare, and the admin sees the result before
  // sending).
  const dispW = rot === 90 || rot === 270 ? height : width;
  const dispH = rot === 90 || rot === 270 ? width : height;
  const bx = f.x * dispW;
  const by = f.y * dispH;
  const bw = f.w * dispW;
  const bh = f.h * dispH;
  if (rot === 90) {
    // Displayed x runs along the page's +y axis; displayed y runs along +x.
    return { x: by, y: bx, w: bh, h: bw, rotate: 90 };
  }
  if (rot === 270) {
    return { x: height - by - bh, y: width - bx - bw, w: bh, h: bw, rotate: 270 };
  }
  const w = f.w * width;
  const h = f.h * height;
  return { x: f.x * width, y: height - f.y * height - h, w, h, rotate: 0 };
}

interface DrawContext {
  font: PDFFont;
  bold: PDFFont;
  images: Map<string, PDFImage>; // key -> embedded png
}

function drawImageInBox(page: PDFPage, img: PDFImage, r: { x: number; y: number; w: number; h: number; rotate: number }) {
  // Keep the aspect ratio, fill up to 92% of the box, sit on the box's
  // baseline so a drawn signature looks like it was written on the line.
  const pad = 0.04;
  const boxW = r.w * (1 - pad * 2);
  const boxH = r.h * (1 - pad * 2);
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  if (r.rotate === 0) {
    page.drawImage(img, { x: r.x + (r.w - w) / 2, y: r.y + r.h * pad, width: w, height: h });
  } else {
    // Rotated pages: draw rotated about the box's centre. pdf-lib rotates
    // about the image's own origin, so offset accordingly.
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (r.rotate === 90) {
      page.drawImage(img, { x: cx + h / 2, y: cy - w / 2, width: w, height: h, rotate: degrees(90) });
    } else {
      page.drawImage(img, { x: cx - h / 2, y: cy + w / 2, width: w, height: h, rotate: degrees(270) });
    }
  }
}

function drawTextInBox(page: PDFPage, ctx: DrawContext, text: string, r: { x: number; y: number; w: number; h: number; rotate: number }) {
  const t = safe(text);
  if (!t) return;
  const boxW = r.rotate === 0 ? r.w : r.h;
  const boxH = r.rotate === 0 ? r.h : r.w;
  const size = fitText(ctx.font, t, boxW - 6, Math.min(boxH * 0.62, 11));
  const textH = ctx.font.heightAtSize(size);
  if (r.rotate === 0) {
    page.drawText(t, { x: r.x + 3, y: r.y + (r.h - textH) / 2 + size * 0.22, size, font: ctx.font, color: INK });
  } else if (r.rotate === 90) {
    page.drawText(t, { x: r.x + r.w - (r.w - textH) / 2 - size * 0.22, y: r.y + 3, size, font: ctx.font, color: INK, rotate: degrees(90) });
  } else {
    page.drawText(t, { x: r.x + (r.w - textH) / 2 + size * 0.22, y: r.y + r.h - 3, size, font: ctx.font, color: INK, rotate: degrees(270) });
  }
}

function drawCheck(page: PDFPage, r: { x: number; y: number; w: number; h: number }) {
  const s = Math.min(r.w, r.h) * 0.7;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const thickness = Math.max(1.2, s * 0.12);
  page.drawLine({ start: { x: cx - s * 0.4, y: cy }, end: { x: cx - s * 0.1, y: cy - s * 0.32 }, thickness, color: INK });
  page.drawLine({ start: { x: cx - s * 0.1, y: cy - s * 0.32 }, end: { x: cx + s * 0.45, y: cy + s * 0.38 }, thickness, color: INK });
}

export interface SignedPdfInput {
  deal: Deal;
  document: DealDocument;
  signers: DealSigner[];
  fields: DealField[];
  events: DealEvent[];
  original: Uint8Array;
  /** PNG bytes by storage key (signature and initials images). */
  images: Map<string, Uint8Array>;
  origin: string;
}

export async function buildSignedPdf(input: SignedPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(input.original, { ignoreEncryption: true, updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const images = new Map<string, PDFImage>();
  for (const [key, bytes] of Array.from(input.images.entries())) {
    try {
      images.set(key, await pdf.embedPng(bytes));
    } catch (e: any) {
      throw new Error(`Signature image ${key} could not be embedded: ${e?.message ?? e}`);
    }
  }
  const ctx: DrawContext = { font, bold, images };
  const pages = pdf.getPages();
  const signerById = new Map(input.signers.map((s) => [s.id, s]));

  for (const f of input.fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const signer = signerById.get(f.signerId);
    if (!signer) continue;
    const r = fieldRect(page, f);
    switch (f.type) {
      case "signature":
      case "initials": {
        const key = f.type === "signature" ? signer.signatureKey : signer.initialsKey;
        const img = key ? images.get(key) : undefined;
        if (img) drawImageInBox(page, img, r);
        break;
      }
      case "checkbox":
        if (f.value === "true") drawCheck(page, r);
        break;
      case "date":
      case "text":
        if (f.value) drawTextInBox(page, ctx, f.value, r);
        break;
    }
  }

  appendCertificate(pdf, ctx, input);

  pdf.setTitle(`${input.document.title} — signed`);
  pdf.setProducer(`${AGENT.business} e-signature`);
  pdf.setModificationDate(new Date());
  return pdf.save({ useObjectStreams: false });
}

// ---- Certificate --------------------------------------------------------------------

const LETTER = { w: 612, h: 792 };
const MARGIN = 54;

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    d.toLocaleString("en-CA", {
      timeZone: "America/Edmonton",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " MT"
  );
}

const EVENT_LABELS: Record<string, string> = {
  created: "Document created",
  uploaded: "PDF uploaded",
  sent: "Sent for signature",
  email_sent: "Signing email sent",
  reminder: "Reminder sent",
  viewed: "Document viewed",
  consented: "Agreed to sign electronically",
  signed: "Signed",
  declined: "Declined to sign",
  voided: "Voided",
  completed: "All parties signed — document completed",
  downloaded: "Signed copy downloaded",
};

function appendCertificate(pdf: PDFDocument, ctx: DrawContext, input: SignedPdfInput) {
  const { font, bold } = ctx;
  let page = pdf.addPage([LETTER.w, LETTER.h]);
  let y = LETTER.h - MARGIN;
  const contentW = LETTER.w - MARGIN * 2;

  const newPage = () => {
    page = pdf.addPage([LETTER.w, LETTER.h]);
    y = LETTER.h - MARGIN;
  };
  const need = (h: number) => {
    if (y - h < MARGIN) newPage();
  };
  const text = (s: string, opts: { size?: number; bold?: boolean; color?: any; x?: number; maxWidth?: number } = {}) => {
    const f = opts.bold ? bold : font;
    const size = opts.size ?? 9.5;
    const maxWidth = opts.maxWidth ?? contentW - ((opts.x ?? MARGIN) - MARGIN);
    const lines = wrap(f, safe(s), size, maxWidth);
    for (const line of lines) {
      need(size * 1.4);
      page.drawText(line, { x: opts.x ?? MARGIN, y: y - size, size, font: f, color: opts.color ?? INK });
      y -= size * 1.4;
    }
  };
  const rule = () => {
    need(10);
    page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: LETTER.w - MARGIN, y: y - 4 }, thickness: 0.6, color: RULE });
    y -= 12;
  };
  const kv = (k: string, v: string) => {
    const size = 9.5;
    const keyW = 120;
    const lines = wrap(font, safe(v), size, contentW - keyW);
    need(size * 1.45 * Math.max(1, lines.length));
    page.drawText(safe(k).toUpperCase(), { x: MARGIN, y: y - size, size: 7.5, font: bold, color: MUTE });
    for (const line of lines) {
      page.drawText(line, { x: MARGIN + keyW, y: y - size, size, font, color: INK });
      y -= size * 1.45;
    }
  };

  // Header
  page.drawText(safe(AGENT.business).toUpperCase(), { x: MARGIN, y: y - 10, size: 10, font: bold, color: GOLD });
  page.drawText("SIGNATURE CERTIFICATE", { x: LETTER.w - MARGIN - bold.widthOfTextAtSize("SIGNATURE CERTIFICATE", 10), y: y - 10, size: 10, font: bold, color: MUTE });
  y -= 30;
  text(input.document.title, { size: 18, bold: true });
  y -= 4;
  text(
    "This certificate records how the preceding document was signed electronically. Each signature is attributed to the person by the private link emailed to them, their consent to sign electronically, and the network details captured at the time.",
    { size: 8.5, color: MUTE },
  );
  y -= 6;
  rule();

  kv("Deal", `${input.deal.title}${input.deal.address ? ` — ${input.deal.address}` : ""}`);
  kv("Document ID", `RRE-${input.deal.id}-${input.document.id}`);
  kv("Pages signed", String(input.document.pageCount));
  kv("Original SHA-256", input.document.originalSha256);
  kv("Sent", fmtWhen(input.document.sentAt));
  kv("Completed", fmtWhen(input.document.completedAt ?? new Date().toISOString()));
  kv("Signing order", input.document.signingOrder === "sequential" ? "One at a time, in the order below" : "All parties at once");
  kv("Sent by", `${AGENT.name}, ${AGENT.brokerage}`);
  y -= 6;
  rule();

  // Signers
  text("Parties", { size: 12, bold: true });
  y -= 4;
  const sorted = input.signers.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  for (const s of sorted) {
    need(96);
    const top = y;
    const imgKey = s.signatureKey;
    const img = imgKey ? ctx.images.get(imgKey) : undefined;
    const boxW = 150;
    const boxH = 60;
    const boxX = LETTER.w - MARGIN - boxW;
    page.drawRectangle({ x: boxX, y: top - boxH, width: boxW, height: boxH, borderColor: RULE, borderWidth: 0.6 });
    if (img) {
      const scale = Math.min((boxW - 12) / img.width, (boxH - 12) / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: boxX + (boxW - w) / 2, y: top - boxH + (boxH - h) / 2, width: w, height: h });
    } else {
      page.drawText(s.status === "declined" ? "DECLINED" : "NOT SIGNED", { x: boxX + 40, y: top - boxH / 2 - 3, size: 8, font: bold, color: MUTE });
    }
    const colW = contentW - boxW - 16;
    text(`${s.name}`, { size: 11, bold: true, maxWidth: colW });
    text(`${s.email} · ${roleLabel(s.role)}`, { size: 8.5, color: MUTE, maxWidth: colW });
    y -= 2;
    const small = (k: string, v: string) => {
      const size = 8.5;
      need(size * 1.4);
      page.drawText(safe(k), { x: MARGIN, y: y - size, size: 7, font: bold, color: MUTE });
      const lines = wrap(font, safe(v), size, colW - 82);
      for (const line of lines) {
        page.drawText(line, { x: MARGIN + 82, y: y - size, size, font, color: INK });
        y -= size * 1.4;
      }
    };
    small("STATUS", statusLabel(s));
    small("CONSENTED", fmtWhen(s.consentAt));
    small("SIGNED", fmtWhen(s.signedAt));
    small("METHOD", s.signatureKind === "typed" ? "Typed signature" : s.signatureKind === "drawn" ? "Drawn signature" : "—");
    small("IP ADDRESS", s.ip ?? "—");
    small("DEVICE", (s.userAgent ?? "—").slice(0, 140));
    if (s.declineReason) small("REASON", s.declineReason);
    y = Math.min(y, top - boxH) - 14;
  }
  rule();

  // Timeline
  text("Audit trail", { size: 12, bold: true });
  y -= 4;
  const signerName = (id: number | null) => (id ? (input.signers.find((s) => s.id === id)?.name ?? "") : "");
  for (const e of input.events) {
    const who = signerName(e.signerId);
    const label = EVENT_LABELS[e.type] ?? e.type;
    const line = `${fmtWhen(e.at)}   ${label}${who ? ` — ${who}` : ""}${e.ip ? `   (${e.ip})` : ""}${e.detail && e.type !== "email_sent" ? `   ${e.detail}` : ""}`;
    text(line, { size: 8.5 });
  }
  y -= 8;
  rule();
  text(
    `Verification: the SHA-256 of the original PDF is printed above. The SHA-256 of this complete signed file is stored with the deal at ${input.origin} and shown on the document page; a copy whose hash matches is unaltered. Generated by ${AGENT.business} (${AGENT.site}) for ${AGENT.name}, ${AGENT.brokerage}, ${AGENT.address}.`,
    { size: 7.5, color: MUTE },
  );
}

function roleLabel(role: string): string {
  return { buyer: "Buyer", seller: "Seller", agent: "Agent", witness: "Witness", other: "Party" }[role] ?? role;
}

function statusLabel(s: DealSigner): string {
  switch (s.status) {
    case "signed":
      return "Signed";
    case "declined":
      return "Declined";
    case "viewed":
      return "Viewed, not signed";
    case "sent":
      return "Sent, not opened";
    default:
      return "Pending";
  }
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        // A single over-long token (a hash, a user agent) is split by character.
        if (font.widthOfTextAtSize(word, size) > maxWidth) {
          let chunk = "";
          for (const ch of word) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else {
          line = word;
        }
      }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}
