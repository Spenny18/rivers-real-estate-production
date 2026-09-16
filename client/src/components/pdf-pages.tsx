// Renders every page of a PDF, one canvas per page, with an overlay layer
// per page that callers fill with positioned boxes (fields to place, fields
// to sign). Overlay children position themselves with percentages, so the
// same fractions work at any width.
//
// Used by the admin field editor (/admin/deals/.../documents/:id) and the
// public signer page (/sign/:token).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { loadPdf, renderPage, type PDFDocumentProxy } from "@/lib/pdf";
import type { PageSize } from "@/lib/esign-types";

export interface PdfPagesProps {
  url: string;
  headers?: Record<string, string>;
  pageSizes: PageSize[];
  /** CSS width of each page. */
  width: number;
  /** Rendered on top of each page (1-based page number). */
  overlay?: (page: number, size: { width: number; height: number }) => ReactNode;
  onPageClick?: (page: number, fraction: { x: number; y: number }, e: React.MouseEvent) => void;
  className?: string;
  /** Called once the document is opened; page count comes from the PDF itself. */
  onLoaded?: (pageCount: number) => void;
  /** Extra fetch options (e.g. POST a body to a preview endpoint). */
  init?: RequestInit;
  /** Changes reload the document even when the URL is the same. */
  version?: string | number;
}

export function PdfPages({ url, headers, pageSizes, width, overlay, onPageClick, className, onLoaded, init, version }: PdfPagesProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    loadPdf(url, headers, init)
      .then((d) => {
        if (cancelled) {
          d.destroy();
          return;
        }
        opened = d;
        setDoc(d);
        onLoaded?.(d.numPages);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? "Could not load the PDF");
      });
    return () => {
      cancelled = true;
      opened?.destroy();
    };
    // headers are per-URL; the URL (plus version) is the identity of the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, version]);

  if (error) {
    return <div className="text-[13px] text-destructive py-8 text-center">{error}</div>;
  }
  if (!doc) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading document…
      </div>
    );
  }

  const count = doc.numPages;
  return (
    <div className={className}>
      {Array.from({ length: count }, (_, i) => {
        const size = pageSizes[i] ?? pageSizes[0] ?? { w: 612, h: 792 };
        const height = (width * size.h) / size.w;
        return (
          <div key={i} data-page={i + 1} className="relative mx-auto mb-6 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.18),0_8px_24px_rgba(0,0,0,0.08)]" style={{ width, height }}>
            <PageCanvas doc={doc} page={i + 1} width={width} />
            <div
              className="absolute inset-0"
              onClick={(e) => {
                if (!onPageClick) return;
                const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                onPageClick(i + 1, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, e);
              }}
            >
              {overlay?.(i + 1, { width, height })}
            </div>
            <div className="absolute -bottom-5 left-0 right-0 text-center text-[10px] tracking-[0.18em] text-muted-foreground font-display">
              PAGE {i + 1} OF {count}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PageCanvas({ doc, page, width }: { doc: PDFDocumentProxy; page: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const canvas = ref.current;
    if (!canvas) return;
    doc
      .getPage(page)
      .then((p) => (cancelled ? undefined : renderPage(p, canvas, width)))
      .catch((e) => console.error("[pdf] render failed:", e));
    return () => {
      cancelled = true;
    };
  }, [doc, page, width]);
  return <canvas ref={ref} className="block" />;
}
