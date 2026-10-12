// The short form of a showing's address, for titles: email subjects, the
// calendar event name, the calendar grid.
//
// Taking everything before the first comma works for a house ("38 Lissington
// Drive SW, Calgary, AB") but not for a condo, which the MLS feed formats unit
// first: "134, 48 Glamis Green SW, Calgary, AB" would shorten to "134". The
// street goes first and the unit after it, the way people say it:
// "48 Glamis Green SW #134".
export function showingStreetLine(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const isNumberOnly = (p: string) => /^(?:#|unit\s*|suite\s*)?\d+[a-z]?$/i.test(p);
  const isStreet = (p: string) => /^\d+[a-z]?\s+\S/i.test(p);
  // Leading number-only parts, then the civic address: "134, 48 Glamis Green
  // SW" (unit), "306, 68, 7930 Bowness Road NW" (unit, building).
  let i = 0;
  while (i < parts.length && isNumberOnly(parts[i])) i++;
  if (i > 0 && i < parts.length && isStreet(parts[i])) {
    const unit = parts[0].replace(/^(?:#|unit\s*|suite\s*)/i, "");
    // Three or more is a multi-lot listing ("1, 3, 5, 7 Landsdown Close"),
    // not a unit: keep the numbers as listed.
    return i <= 2 ? `${parts[i]} #${unit}` : parts.slice(0, i + 1).join(", ");
  }
  // A house number split from its street by a comma: "51, Westwood Court".
  if (i === 1 && parts[1] && /^[a-z]/i.test(parts[1])) return `${parts[0]} ${parts[1]}`;
  const first = parts[0] ?? address.trim();
  const inlineUnit = first.match(/^#(\d+[a-z]?)\s+(\d+[a-z]?\s+.+)$/i);
  if (inlineUnit) return `${inlineUnit[2]} #${inlineUnit[1]}`;
  return first;
}
