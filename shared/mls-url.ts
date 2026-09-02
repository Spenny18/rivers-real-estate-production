export type MlsSlugSource = {
  id: string;
  mlsNumber: string;
  fullAddress: string;
  subdivision?: string | null;
  neighbourhood?: string | null;
  city: string;
  status?: string | null;
  syncedAt?: string | null;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", quot: '"', apos: "'", nbsp: " ", lt: "<", gt: ">",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', ndash: "-", mdash: "-",
};

// Pillar 9 delivers some fields HTML-escaped ("Wilson&#x2019;s Beach Estates").
// The escape has to come out before slugifying, or the entity itself lands in
// the URL as text: "wilson-x2019-s-beach-estates".
export function decodeMlsEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const token = body.toLowerCase();
    if (token.startsWith("#")) {
      const hex = token.startsWith("#x");
      const code = Number.parseInt(hex ? token.slice(2) : token.slice(1), hex ? 16 : 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[token] ?? match;
  });
}

export function slugifyMlsPart(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
}

function slugifyMlsText(value: string | null | undefined): string {
  // Drop apostrophes instead of letting them fall through to the generic
  // separator rule, so "Wilson's Beach Estates" reads as wilsons-beach-estates
  // rather than wilson-s-beach-estates.
  return slugifyMlsPart(decodeMlsEntities(value ?? "").replace(/['‘’]/g, ""));
}

// The feed spells "no subdivision" as a literal placeholder string rather than
// as null, so a truthy check alone lets "NONE" through into the URL.
const AREA_PLACEHOLDERS = new Set(["none", "n/a", "na", "null", "unknown", "not applicable"]);

function mlsAreaPart(listing: MlsSlugSource): string {
  for (const candidate of [listing.subdivision, listing.neighbourhood]) {
    const cleaned = decodeMlsEntities(candidate ?? "").trim();
    if (cleaned && !AREA_PLACEHOLDERS.has(cleaned.toLowerCase())) return cleaned;
  }
  return "property";
}

// Pillar 9 formats apartments as "1405, 1010 6 Street SW, Calgary...".
// Put the civic street address first and the unit second so condo URLs read
// naturally and consistently: 1010-6-street-sw-1405-beltline-calgary.
function mlsAddressPart(listing: MlsSlugSource): string {
  const parts = listing.fullAddress.split(",").map((part) => part.trim()).filter(Boolean);
  const first = parts[0] || listing.fullAddress;
  const second = parts[1] || "";
  const commaUnit = first.match(/^(?:#|unit\s*)?(\d+[a-z]?)$/i);
  const inlineUnit = first.match(/^#(\d+[a-z]?)\s+(\d+\s+.+)$/i);
  return commaUnit && /^\d+\s+/.test(second)
    ? `${second} ${commaUnit[1]}`
    : inlineUnit
      ? `${inlineUnit[2]} ${inlineUnit[1]}`
      : first;
}

export function mlsBaseSlug(listing: MlsSlugSource): string {
  return [mlsAddressPart(listing), mlsAreaPart(listing), listing.city]
    .map(slugifyMlsText).filter(Boolean).join("-");
}

// Slug format shipped before placeholder subdivisions and HTML entities were
// cleaned out of the area segment. Kept solely so URLs emitted under that
// format ("...-none-...", "...-x2019-...") can 301 to the current canonical.
export function mlsRawBaseSlug(listing: MlsSlugSource): string {
  return [mlsAddressPart(listing), listing.subdivision || listing.neighbourhood || "property", listing.city]
    .map(slugifyMlsPart).filter(Boolean).join("-");
}

// Slug format shipped before unit numbers were moved behind the street. Kept
// solely so old indexed/shared URLs can 301 to the new canonical format.
export function mlsLegacyBaseSlug(listing: MlsSlugSource): string {
  const address = listing.fullAddress.split(",")[0]?.trim() || listing.fullAddress;
  return [address, listing.subdivision || listing.neighbourhood || "property", listing.city]
    .map(slugifyMlsPart).filter(Boolean).join("-");
}

function assignSlugs<T extends MlsSlugSource>(
  listings: T[],
  baseFor: (listing: T) => string,
  collisionMode: "preferred-clean" | "all-suffixed",
): Map<string, string> {
  const groups = new Map<string, T[]>();
  for (const listing of listings) {
    const base = baseFor(listing) || slugifyMlsPart(listing.mlsNumber) || listing.id;
    groups.set(base, [...(groups.get(base) ?? []), listing]);
  }
  const result = new Map<string, string>();
  groups.forEach((group, base) => {
    if (group.length === 1) {
      result.set(group[0].id, base);
      return;
    }
    const ordered = [...group].sort((a, b) => {
      const active = Number((b.status ?? "").toLowerCase() === "active")
        - Number((a.status ?? "").toLowerCase() === "active");
      if (active !== 0) return active;
      const freshness = String(b.syncedAt ?? "").localeCompare(String(a.syncedAt ?? ""));
      return freshness || String(b.mlsNumber).localeCompare(String(a.mlsNumber));
    });
    for (let index = 0; index < ordered.length; index++) {
      const listing = ordered[index];
      const getsCleanSlug = collisionMode === "preferred-clean" && index === 0;
      result.set(
        listing.id,
        getsCleanSlug ? base : `${base}-${slugifyMlsPart(listing.mlsNumber || listing.id)}`,
      );
    }
  });
  return result;
}

export function assignMlsSeoSlugs<T extends MlsSlugSource>(listings: T[]): Map<string, string> {
  return assignSlugs(listings, mlsBaseSlug, "preferred-clean");
}

export function assignMlsLegacySeoSlugs<T extends MlsSlugSource>(listings: T[]): Map<string, string> {
  return assignSlugs(listings, mlsLegacyBaseSlug, "all-suffixed");
}

// Transitional format deployed briefly with street-first apartment addresses
// but an MLS suffix on every colliding record.
export function assignMlsPreviousSeoSlugs<T extends MlsSlugSource>(listings: T[]): Map<string, string> {
  return assignSlugs(listings, mlsRawBaseSlug, "all-suffixed");
}

// Slug -> listing id for every retired format, with anything that is also a
// live canonical slug removed. Those overlap constantly: a listing whose
// address yields one unambiguous base slug gets the same string out of every
// generator, and serving that as a "legacy" hit 301s the canonical URL to
// itself. An alias may only ever point at a URL that should redirect.
export function assignMlsAliasSlugLookup<T extends MlsSlugSource>(
  listings: T[],
): Map<string, string> {
  const canonicalSlugs = new Set(assignMlsSeoSlugs(listings).values());
  const lookup = new Map<string, string>();
  for (const aliases of [assignMlsLegacySeoSlugs(listings), assignMlsPreviousSeoSlugs(listings)]) {
    aliases.forEach((slug, id) => {
      if (canonicalSlugs.has(slug) || lookup.has(slug)) return;
      lookup.set(slug, id);
    });
  }
  return lookup;
}

export function mlsPropertyPath(listing: MlsSlugSource & { seoSlug?: string }): string {
  // A server-issued slug is authoritative. If a compact API response ever
  // omits it, use the stable MLS id so the server can 301 to the canonical URL
  // instead of inventing a partial address slug from missing fields.
  return `/mls/${listing.seoSlug || listing.id}`;
}
