// Reading a PDF's text layer on the server: which AREA form a blank is, and
// where its underscored blanks sit. pdf.js (already a dependency for the
// browser renderer) runs fine in Node; it is loaded lazily and through a
// plain dynamic import so esbuild leaves the ESM package alone.

import { createRequire } from "node:module";
import path from "node:path";

export interface TextItem {
  page: number;
  /** PDF points, bottom-left origin: the item's baseline start. */
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  str: string;
}

export interface PageText {
  pageCount: number;
  pageSizes: Array<{ w: number; h: number }>;
  items: TextItem[];
}

const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;
let pdfjsPromise: Promise<any> | null = null;

function pdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    const require = createRequire(import.meta.url ?? `file://${process.cwd()}/`);
    const entry = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsPromise = dynamicImport(`file://${entry}`).then((mod) => {
      const fonts = path.join(path.dirname(entry), "..", "..", "standard_fonts") + "/";
      return { mod, fonts };
    });
  }
  return pdfjsPromise;
}

/** Every text item on every page, in PDF points. Empty on any failure. */
export async function extractText(bytes: Uint8Array): Promise<PageText> {
  const out: PageText = { pageCount: 0, pageSizes: [], items: [] };
  try {
    const { mod, fonts } = await pdfjs();
    const doc = await mod.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, standardFontDataUrl: fonts, verbosity: 0 }).promise;
    out.pageCount = doc.numPages;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      out.pageSizes.push({ w: vp.width, h: vp.height });
      const tc = await page.getTextContent();
      for (const it of tc.items as any[]) {
        if (typeof it.str !== "string" || !it.str.trim()) continue;
        const [, b, , d, e, f] = it.transform as number[];
        const size = Math.hypot(b, d);
        out.items.push({ page: p, x: e, y: f, w: it.width, h: it.height || size, size, str: it.str });
      }
    }
    await doc.destroy();
  } catch (e) {
    console.warn("[forms] text extraction failed:", (e as any)?.message ?? e);
  }
  return out;
}

/** "AREA©158CLDA_JAN2026" → { id: "158", code: "AREA©158CLDA_JAN2026" }, from the footer of page 1. */
export function areaFormCode(text: PageText): { id: string; code: string } | null {
  for (const it of text.items) {
    if (it.page !== 1) continue;
    const m = /AREA\s*©?\s*(\d{2,4})([A-Z]*)(?:_?([A-Za-z0-9]+))?/.exec(it.str);
    if (m) return { id: m[1], code: it.str.trim() };
  }
  return null;
}

export interface DetectedBlank {
  page: number;
  x0: number;
  x1: number;
  /** Baseline of the underscores. */
  y: number;
  size: number;
  label: string;
}

// Approximate glyph widths (em) for splitting a mixed "Label: ______" item
// into its underscore runs; the run positions are scaled to the item width.
function charEm(ch: string): number {
  if (ch === "_") return 0.556;
  if (ch === " ") return 0.278;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[0-9]/.test(ch)) return 0.556;
  if (/[.,:;'’()]/.test(ch)) return 0.3;
  return 0.52;
}

/**
 * Underscored blanks with the label to their left ("Municipal address:").
 * Runs narrower than `minWidth` points (initials, ", 20__") are skipped.
 */
export function detectBlanks(text: PageText, minWidth = 40): DetectedBlank[] {
  const out: DetectedBlank[] = [];
  for (const it of text.items) {
    if (!/_{3,}/.test(it.str)) continue;
    const ems = Array.from(it.str, (c) => charEm(c) * it.size);
    const total = ems.reduce((a, b) => a + b, 0) || 1;
    const k = it.w / total;
    let x = it.x;
    let cur: { x0: number; x1: number; before: string } | null = null;
    const runs: Array<{ x0: number; x1: number; before: string }> = [];
    Array.from(it.str).forEach((c, i) => {
      const w = ems[i] * k;
      if (c === "_") {
        if (!cur) cur = { x0: x, x1: x + w, before: it.str.slice(0, i) };
        else cur.x1 = x + w;
      } else if (cur) {
        runs.push(cur);
        cur = null;
      }
      x += w;
    });
    if (cur) runs.push(cur);
    const sameLine = text.items.filter((o) => o.page === it.page && Math.abs(o.y - it.y) < 2 && o !== it && !/_{3,}/.test(o.str));
    for (const r of runs) {
      if (r.x1 - r.x0 < minWidth) continue;
      let label = r.before.replace(/_+/g, " ").trim();
      if (!label) {
        const left = sameLine.filter((o) => o.x + o.w <= r.x0 + 2).sort((a, b) => b.x - a.x)[0];
        label = left?.str.trim() ?? "";
      }
      label = label.split(/[,.;]\s+/).pop()!.replace(/[:\s]+$/, "").trim().slice(-48);
      out.push({ page: it.page, x0: r.x0, x1: r.x1, y: it.y, size: it.size, label });
    }
  }
  return out;
}
