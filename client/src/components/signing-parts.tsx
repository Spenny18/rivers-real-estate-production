// Pieces shared by the single-document signing page (pages/sign.tsx) and the
// envelope signing page (pages/sign-envelope.tsx), so both look and behave
// the same.

import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { isAutoField, type FieldView } from "@/lib/esign-types";
import { formatStamp } from "@shared/esign-format";

export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 4);
}

export function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-secondary/30 text-foreground">{children}</div>;
}

export function Notice({ tone, icon, title, children }: { tone: "info" | "good" | "warn"; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const styles = {
    info: "border-[#D4AF37] bg-[#D4AF37]/10 text-foreground",
    good: "border-emerald-500 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50",
    warn: "border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-50",
  }[tone];
  return (
    <div className={`border-l-4 rounded-sm px-4 py-3 text-[14px] leading-relaxed flex gap-3 ${styles}`}>
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div className="mt-0.5">{children}</div>
      </div>
    </div>
  );
}

export function SignerFieldBox({
  signatureUrl,
  field,
  colour,
  editable,
  value,
  preview,
  signedByMe,
  onChange,
  onSign,
}: {
  /** Where a signer's stored signature or initials image is served from. */
  signatureUrl: (signerId: number, kind: "signature" | "initials") => string;
  field: FieldView & { mine: boolean };
  colour: string;
  editable: boolean;
  value: string;
  preview: string | null;
  signedByMe: boolean;
  onChange: (v: string) => void;
  onSign: () => void;
}) {
  const style: React.CSSProperties = {
    left: `${field.x * 100}%`,
    top: `${field.y * 100}%`,
    width: `${field.w * 100}%`,
    height: `${field.h * 100}%`,
  };
  const isImage = field.type === "signature" || field.type === "initials";
  const otherSigned = !field.mine && field.value === "signed";
  const imgSrc = isImage
    ? field.mine
      ? preview ?? (signedByMe ? signatureUrl(field.signerId, field.type as "signature" | "initials") : null)
      : otherSigned
        ? signatureUrl(field.signerId, field.type as "signature" | "initials")
        : null
    : null;

  if (isImage) {
    return (
      <div
        className={`absolute flex items-end justify-center ${editable ? "cursor-pointer" : ""}`}
        style={{ ...style, background: imgSrc ? "transparent" : `${colour}22`, border: imgSrc ? "none" : `1.5px dashed ${colour}` }}
        onClick={editable ? onSign : undefined}
        title={field.mine ? (editable ? "Click to sign" : "") : `${field.type === "initials" ? "Initials" : "Signature"} of another party`}
      >
        {imgSrc ? (
          <img src={imgSrc} alt="" className="max-w-[92%] max-h-[92%] object-contain pointer-events-none" />
        ) : (
          <span className="text-[10px] leading-none pb-1" style={{ color: colour }}>
            {field.mine ? (field.type === "initials" ? "Initial here" : "Sign here") : ""}
          </span>
        )}
      </div>
    );
  }

  if (field.type === "checkbox") {
    return (
      <div className="absolute flex items-center justify-center" style={{ ...style, background: editable ? `${colour}22` : "transparent", border: editable ? `1.5px dashed ${colour}` : "none" }}>
        {editable ? (
          <Checkbox checked={value === "true"} onCheckedChange={(v) => onChange(v ? "true" : "false")} className="h-full w-full max-h-4 max-w-4 bg-white" />
        ) : value === "true" ? (
          <span className="text-[12px] leading-none">✓</span>
        ) : null}
      </div>
    );
  }

  // date / time: never typed — a preview of what will be stamped, then the stamped value.
  if (isAutoField(field.type)) {
    const text = value || (editable ? formatStamp(field.type as "date" | "time", field.format, new Date()) : "");
    return (
      <div
        className="absolute flex items-center px-1 overflow-hidden"
        style={{ ...style, background: editable ? `${colour}14` : "transparent", border: editable ? `1px dashed ${colour}` : "none" }}
        title={editable ? "Filled automatically when you sign" : undefined}
      >
        <span className="text-[10px] leading-none truncate" style={{ color: editable && !value ? colour : undefined, opacity: editable && !value ? 0.8 : 1 }}>
          {text}
        </span>
      </div>
    );
  }

  // text
  if (!editable) {
    return (
      <div className="absolute flex items-center px-0.5 overflow-hidden" style={style}>
        <span className="text-[10px] leading-none truncate">{value}</span>
      </div>
    );
  }
  return (
    <div className="absolute" style={style}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.label || "Type here"}
        className="h-full w-full rounded-none px-1 text-[11px] leading-none"
        style={{ background: `${colour}18`, borderColor: colour, minHeight: 0 }}
      />
    </div>
  );
}
