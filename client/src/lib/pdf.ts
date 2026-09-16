// pdf.js, loaded on demand in the browser only.
//
// pdfjs-dist touches DOM globals when its module evaluates, so it is never
// imported statically: the SSR bundle would crash. Callers await `loadPdf()`
// inside an effect. The worker ships as its own asset (Vite's `?url`).

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

let lib: Promise<typeof import("pdfjs-dist")> | null = null;

function pdfjs() {
  if (!lib) {
    lib = (async () => {
      // The "legacy" build carries pdf.js's own polyfills (e.g. the newer
      // Map methods its modern build assumes); a client's browser on a
      // phone is whatever it is, and this page must open for every signer.
      const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as typeof import("pdfjs-dist");
      const worker = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
      mod.GlobalWorkerOptions.workerSrc = worker;
      return mod;
    })();
  }
  return lib;
}

/** Fetch a PDF (with the app's auth headers when relevant) and open it. */
export async function loadPdf(url: string, headers: Record<string, string> = {}): Promise<PDFDocumentProxy> {
  const res = await fetch(url, { credentials: "include", headers });
  if (!res.ok) throw new Error(`${res.status}: could not load the PDF`);
  const data = await res.arrayBuffer();
  const mod = await pdfjs();
  return mod.getDocument({ data }).promise;
}

/** Render one page into a canvas at the given CSS width. */
export async function renderPage(page: PDFPageProxy, canvas: HTMLCanvasElement, cssWidth: number): Promise<void> {
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(cssWidth * base.height) / base.width}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
}

export type { PDFDocumentProxy, PDFPageProxy };
