// When a deal changes under an open form (server/form-templates.ts pre-fills
// it), take the fresh pre-fill for every field the user hasn't touched and
// keep whatever they've typed in the rest. "Untouched" means it still holds
// exactly what the previous pre-fill put there.
export function mergePrefill(
  before: Record<string, string>,
  next: Record<string, string>,
  current: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Array.from(new Set([...Object.keys(before), ...Object.keys(next), ...Object.keys(current)]))) {
    const untouched = (current[k] ?? "") === (before[k] ?? "");
    const v = untouched ? next[k] : current[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}
