// How an automatic date or time box is printed.
//
// Date and time boxes are never typed by the signer: they are filled by the
// server with the moment the signature was recorded, so the printed date is
// the evidence, not a claim. The format is chosen when the box is placed, to
// fit the blank on the form — AREA contracts print ", 20__" after the date and
// ". m." after the time, so there are formats that leave those parts out.

export type AutoKind = "date" | "time";

export const DATE_FORMATS = [
  { id: "long", label: "September 16, 2026" },
  { id: "short", label: "Sep 16, 2026" },
  { id: "iso", label: "2026-09-16" },
  { id: "numeric", label: "16/09/2026" },
  { id: "month-day", label: "September 16 (for a “, 20__” blank)" },
  { id: "yy", label: "26 (just the two-digit year)" },
] as const;

export const TIME_FORMATS = [
  { id: "ampm", label: "3:45 p.m." },
  { id: "ampm-short", label: "3:45 p (for a “. m.” blank)" },
  { id: "24h", label: "15:45" },
] as const;

export type DateFormatId = (typeof DATE_FORMATS)[number]["id"];
export type TimeFormatId = (typeof TIME_FORMATS)[number]["id"];

export const DEFAULT_DATE_FORMAT: DateFormatId = "long";
export const DEFAULT_TIME_FORMAT: TimeFormatId = "ampm";
export const SIGNING_TIME_ZONE = "America/Edmonton";

function parts(d: Date, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: SIGNING_TIME_ZONE, ...opts }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** The text stamped into an automatic box for a signing at `at`. */
export function formatStamp(kind: AutoKind, format: string | null | undefined, at: Date): string {
  if (kind === "date") {
    const p = parts(at, { year: "numeric", month: "long", day: "numeric" });
    const short = parts(at, { year: "numeric", month: "short", day: "numeric" });
    const num = parts(at, { year: "numeric", month: "2-digit", day: "2-digit" });
    switch ((format as DateFormatId) || DEFAULT_DATE_FORMAT) {
      case "short":
        return `${short.month.replace(/\.$/, "")} ${short.day}, ${short.year}`;
      case "iso":
        return `${num.year}-${num.month}-${num.day}`;
      case "numeric":
        return `${num.day}/${num.month}/${num.year}`;
      case "month-day":
        return `${p.month} ${p.day}`;
      case "yy":
        return num.year.slice(-2);
      case "long":
      default:
        return `${p.month} ${p.day}, ${p.year}`;
    }
  }
  const t = parts(at, { hour: "numeric", minute: "2-digit", hour12: true });
  const t24 = parts(at, { hour: "2-digit", minute: "2-digit", hour12: false });
  const ampm = (t.dayPeriod || "").toLowerCase().replace(/\./g, "").startsWith("p") ? "p" : "a";
  switch ((format as TimeFormatId) || DEFAULT_TIME_FORMAT) {
    case "ampm-short":
      return `${t.hour}:${t.minute} ${ampm}`;
    case "24h":
      return `${t24.hour}:${t24.minute}`;
    case "ampm":
    default:
      return `${t.hour}:${t.minute} ${ampm}.m.`;
  }
}

/** The caption printed under a stamped signature. */
export function signatureCaption(at: Date, documentRef: string): string {
  return `Signed ${formatStamp("date", "iso", at)} ${formatStamp("time", "ampm", at)} MT · ${documentRef}`;
}
