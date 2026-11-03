/**
 * Live-data placeholders for title/description overrides set from the SEO
 * console. An override like "Rosedale Calgary Real Estate: {avgPriceShort} Avg"
 * is stored as written and filled in at render time, so the number in the
 * search snippet follows the market instead of freezing on the day the fix was
 * applied.
 *
 * Only neighbourhood pages have live stats (activeCount / avgPrice on the row,
 * refreshed after every MLS sync by storage.refreshNeighbourhoodActiveCounts).
 * If any placeholder in a field can't be filled — wrong page type, no active
 * listings — that field resolves to null and the page's own default title or
 * description is used instead. A snippet never shows "{activeCount}" or
 * "0 active listings".
 */
import { storage } from "./storage";

export const META_TOKENS = {
  activeCount: "number of active MLS listings, e.g. 11",
  avgPrice: "average active list price, e.g. $2,005,535",
  avgPriceShort: "average active list price, rounded, e.g. $2M or $2.4M or $950K",
} as const;

export type MetaToken = keyof typeof META_TOKENS;
export type TokenValues = Partial<Record<MetaToken, string>>;

const TOKEN_RE = /\{([A-Za-z]+)\}/g;

/** Every {placeholder} name used in a string, known or not. */
export function tokensIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(text.matchAll(TOKEN_RE), (m) => m[1]);
}

export function isMetaToken(name: string): name is MetaToken {
  return Object.prototype.hasOwnProperty.call(META_TOKENS, name);
}

/** "$2M", "$2.4M", "$950K". */
export function shortPrice(n: number): string {
  if (n >= 1_000_000) {
    const m = Math.round(n / 100_000) / 10;
    return `$${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  return `$${Math.round(n / 1000)}K`;
}

/** Placeholder values from a neighbourhood row. A value is left out when it
 *  would read badly in a snippet (fewer than two listings, no price). */
export function tokenValuesFromStats(stats: { activeCount?: number | null; avgPrice?: number | null }): TokenValues {
  const v: TokenValues = {};
  const count = stats.activeCount ?? 0;
  // "1 active MLS listings" / "0 active listings" — fall back instead.
  if (count >= 2) {
    v.activeCount = String(count);
    // An average over listings that no longer exist is the stale number this
    // module exists to avoid, so price tokens need live listings too.
    const avg = stats.avgPrice ?? 0;
    if (avg > 0) {
      v.avgPrice = `$${Math.round(avg).toLocaleString("en-CA")}`;
      v.avgPriceShort = shortPrice(avg);
    }
  }
  return v;
}

/** Which pages can use placeholders at all. */
export function supportsMetaTokens(path: string): boolean {
  return /^\/neighbourhoods\/[^/]+$/.test(path);
}

/** Current placeholder values for a page; empty when it has none. */
export function tokenValuesForPath(path: string): TokenValues {
  const m = path.match(/^\/neighbourhoods\/([^/]+)$/);
  if (!m) return {};
  const row = storage.getNeighbourhoodBySlug(m[1]);
  return row ? tokenValuesFromStats(row) : {};
}

/** Fill placeholders, or null if any can't be filled. Text without
 *  placeholders comes back unchanged. */
export function fillTokens(text: string | null | undefined, values: TokenValues): string | null {
  if (!text) return null;
  let missing = false;
  const out = text.replace(TOKEN_RE, (_whole, name: string) => {
    const v = isMetaToken(name) ? values[name] : undefined;
    if (v == null) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

/** An override with its placeholders filled for today. Values are looked up
 *  only when a field actually uses a placeholder. */
export function resolveMetaOverride(
  path: string,
  o: { title: string | null; description: string | null },
): { title: string | null; description: string | null } {
  if (!tokensIn(o.title).length && !tokensIn(o.description).length) return o;
  const values = tokenValuesForPath(path);
  return { title: fillTokens(o.title, values), description: fillTokens(o.description, values) };
}
