// A box positioned on a rendered PDF page by page fractions: drag to move,
// drag the corner to resize, Delete to remove. Used by the document editor
// (signature boxes for a signer) and the form-template editor (fill boxes
// bound to deal data, sign boxes by signer slot). The caller decides what it
// says and what colour it is; this only knows geometry.

import { useRef } from "react";
import { Trash2 } from "lucide-react";

export interface BoxGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export function PlacedBox({
  id,
  box,
  colour,
  tag,
  text,
  title,
  editable,
  selected,
  solid,
  onSelect,
  onChange,
  onRemove,
}: {
  id: string;
  box: BoxGeometry;
  colour: string;
  /** Small label above the box (the signer's first name, "Fill"). */
  tag: string;
  /** What is shown inside the box. */
  text: string;
  title?: string;
  editable: boolean;
  selected: boolean;
  /** Solid border instead of dashed (for boxes filled with data). */
  solid?: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<BoxGeometry>) => void;
  onRemove: () => void;
}) {
  const drag = useRef<{ mode: "move" | "resize"; startX: number; startY: number; orig: BoxGeometry; rect: DOMRect } | null>(null);

  const onPointerDown = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-page]") as HTMLElement | null;
    const rect = (pageEl ?? (e.currentTarget as HTMLElement).parentElement!).getBoundingClientRect();
    drag.current = { mode, startX: e.clientX, startY: e.clientY, orig: { ...box }, rect };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.rect.width;
    const dy = (e.clientY - d.startY) / d.rect.height;
    if (d.mode === "move") {
      onChange({ x: clamp(d.orig.x + dx, 0, 1 - d.orig.w), y: clamp(d.orig.y + dy, 0, 1 - d.orig.h) });
    } else {
      onChange({ w: clamp(d.orig.w + dx, 0.01, 1 - d.orig.x), h: clamp(d.orig.h + dy, 0.008, 1 - d.orig.y) });
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      data-field={id}
      className={`absolute select-none ${editable ? "cursor-move" : ""}`}
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
        background: `${colour}22`,
        border: `${selected ? 2 : 1.5}px ${selected || solid ? "solid" : "dashed"} ${colour}`,
        boxShadow: selected ? `0 0 0 3px ${colour}33` : undefined,
        zIndex: selected ? 3 : 2,
      }}
      onPointerDown={onPointerDown("move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      title={title}
    >
      <div className="absolute inset-0 flex items-center px-1 overflow-hidden pointer-events-none">
        <span className="text-[10px] leading-none truncate" style={{ color: colour }}>
          {text}
        </span>
      </div>
      {tag ? (
        <div className="absolute -top-4 left-0 text-[9px] leading-none px-1 py-0.5 whitespace-nowrap pointer-events-none" style={{ background: colour, color: "#fff" }}>
          {tag}
        </div>
      ) : null}
      {editable ? (
        <>
          <div
            className="absolute -right-1.5 -bottom-1.5 w-3 h-3 rounded-sm cursor-nwse-resize"
            style={{ background: colour }}
            onPointerDown={onPointerDown("resize")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          {selected ? (
            <button
              className="absolute -top-4 -right-1 w-4 h-4 rounded-sm bg-foreground text-background flex items-center justify-center"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <Trash2 className="h-2.5 w-2.5" />
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
