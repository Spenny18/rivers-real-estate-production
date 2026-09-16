// Capture a signature (or initials) as a PNG data URL.
//
// Two ways in: draw it with a finger, stylus or mouse, or type it and have
// it set in a script face. Both end up as the same thing — a transparent
// PNG, trimmed to the ink — so the server only ever handles images.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eraser, PenLine, Type } from "lucide-react";

export type SignatureKind = "drawn" | "typed";

export interface SignatureResult {
  kind: SignatureKind;
  png: string; // data:image/png;base64,...
}

const SCRIPT_FONT = "'Dancing Script', 'Brush Script MT', 'Segoe Script', cursive";
let fontRequested = false;
function ensureScriptFont() {
  if (fontRequested || typeof document === "undefined") return;
  fontRequested = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500;600&display=swap";
  document.head.appendChild(link);
}

/** Crop a canvas to its non-transparent pixels (plus padding) and export. */
function exportTrimmed(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 8;
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(width, maxX + pad) - sx;
  const sh = Math.min(height, maxY + pad) - sy;
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL("image/png");
}

export function SignaturePad({
  label,
  defaultTyped,
  onChange,
  compact,
}: {
  label: string;
  /** Starting text for the typed option (the signer's name or initials). */
  defaultTyped: string;
  onChange: (r: SignatureResult | null) => void;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<SignatureKind>("drawn");
  const [typed, setTyped] = useState(defaultTyped);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  const cssW = compact ? 240 : 520;
  const cssH = compact ? 110 : 180;
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;

  useEffect(() => {
    ensureScriptFont();
  }, []);

  // Size the canvas for the device pixel ratio once.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = cssW * dpr;
    c.height = cssH * dpr;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0b1230";
      ctx.lineWidth = compact ? 2 : 2.4;
    }
  }, [cssW, cssH, dpr, compact]);

  const emitDrawn = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const png = exportTrimmed(c);
    onChange(png ? { kind: "drawn", png } : null);
  }, [onChange]);

  const emitTyped = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) {
        onChange(null);
        return;
      }
      try {
        await (document as any).fonts?.load(`600 64px ${SCRIPT_FONT}`);
      } catch {}
      const c = document.createElement("canvas");
      const size = compact ? 72 : 96;
      const ctx = c.getContext("2d")!;
      ctx.font = `600 ${size}px ${SCRIPT_FONT}`;
      const w = Math.ceil(ctx.measureText(t).width) + 40;
      c.width = Math.max(w, 120) * 2;
      c.height = size * 1.7 * 2;
      const ctx2 = c.getContext("2d")!;
      ctx2.scale(2, 2);
      ctx2.font = `600 ${size}px ${SCRIPT_FONT}`;
      ctx2.fillStyle = "#0b1230";
      ctx2.textBaseline = "middle";
      ctx2.fillText(t, 20, (size * 1.7) / 2);
      const png = exportTrimmed(c);
      onChange(png ? { kind: "typed", png } : null);
    },
    [onChange, compact],
  );

  useEffect(() => {
    if (mode === "typed") void emitTyped(typed);
    else emitDrawn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // On a narrow phone max-width shrinks the element below its nominal
    // size; map back into the canvas's own coordinate space.
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * cssW) / r.width, y: ((e.clientY - r.top) * cssH) / r.height };
  };

  const clear = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) ctx.clearRect(0, 0, cssW, cssH);
    setHasInk(false);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">{label.toUpperCase()}</div>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant={mode === "drawn" ? "default" : "outline"} className="h-7 text-[11px]" onClick={() => setMode("drawn")}>
            <PenLine className="h-3 w-3 mr-1" /> Draw
          </Button>
          <Button type="button" size="sm" variant={mode === "typed" ? "default" : "outline"} className="h-7 text-[11px]" onClick={() => setMode("typed")}>
            <Type className="h-3 w-3 mr-1" /> Type
          </Button>
        </div>
      </div>

      {mode === "drawn" ? (
        <div className="relative">
          <canvas
            ref={canvasRef}
            style={{ width: cssW, height: cssH, touchAction: "none", maxWidth: "100%" }}
            className="border border-border bg-white rounded-sm cursor-crosshair"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drawing.current = true;
              last.current = pos(e);
            }}
            onPointerMove={(e) => {
              if (!drawing.current || !last.current) return;
              const ctx = e.currentTarget.getContext("2d");
              if (!ctx) return;
              const p = pos(e);
              ctx.beginPath();
              ctx.moveTo(last.current.x, last.current.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              last.current = p;
              if (!hasInk) setHasInk(true);
            }}
            onPointerUp={(e) => {
              if (drawing.current && last.current) {
                // A tap with no movement still leaves a dot.
                const ctx = e.currentTarget.getContext("2d");
                if (ctx) {
                  ctx.beginPath();
                  ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2);
                  ctx.fillStyle = "#0b1230";
                  ctx.fill();
                }
                setHasInk(true);
              }
              drawing.current = false;
              last.current = null;
              emitDrawn();
            }}
            onPointerLeave={() => {
              if (drawing.current) {
                drawing.current = false;
                last.current = null;
                emitDrawn();
              }
            }}
          />
          <div className="absolute left-3 right-3 bottom-8 border-b border-dashed border-muted-foreground/40 pointer-events-none" />
          <button
            type="button"
            onClick={clear}
            className="absolute top-2 right-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground bg-white/80 px-1.5 py-0.5 rounded-sm"
          >
            <Eraser className="h-3 w-3" /> Clear
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              void emitTyped(e.target.value);
            }}
            placeholder="Type your name"
            className="text-[14px]"
          />
          <div
            className="border border-border bg-white rounded-sm flex items-center px-4 overflow-hidden"
            style={{ height: cssH, fontFamily: SCRIPT_FONT, fontSize: compact ? 34 : 44, color: "#0b1230", maxWidth: "100%" }}
          >
            {typed || <span className="text-muted-foreground text-[13px] font-sans">Your signature will appear here</span>}
          </div>
        </div>
      )}
    </div>
  );
}
