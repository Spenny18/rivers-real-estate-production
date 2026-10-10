// Which fields the Pillar 9 Property class actually defines.
//
// Asking a RETS Search for a field the class does not define fails the whole
// query, so anything beyond the fields rets-sync.ts has always selected is
// requested only once the feed's own metadata says it exists. The same lookup
// answers "does our licence include the legal description?" — see
// probePropertyFields and GET /api/admin/mls-sync/field-probe.
//
// Read-only: one metadata request, plus a single-row search in the probe.

import type { RetsClient } from "./rets-client";

export interface FeedField {
  systemName: string;
  longName: string | null;
  standardName: string | null;
}

/** Fields worth having for forms, by mls_listings column. First name the feed defines wins. */
export const OPTIONAL_LISTING_FIELDS: Record<string, string[]> = {
  exclusions: ["Exclusions"],
  listAgentName: ["ListAgentFullName"],
  listAgentPhone: ["ListAgentDirectPhone", "ListAgentPreferredPhone", "ListAgentOfficePhone"],
  listOffice: ["ListOfficeName"],
};

/** Names that might hold a legal description, title or the listing contacts — reported, not synced. */
const CANDIDATE = /legal|plan|block|^lot(?!\s*(size|features))|title|parcel|linc|exclu|inclu|agent.*(email|phone|name)|office.*(name|address|phone)/i;

const CACHE_MS = 24 * 60 * 60 * 1000;
let cache: { at: number; fields: FeedField[] } | null = null;

function collect(node: any, out: FeedField[]) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (typeof node.SystemName === "string" || typeof node.SystemName === "number") {
    const s = (v: any) => (v == null || v === "" ? null : String(v));
    out.push({ systemName: String(node.SystemName), longName: s(node.LongName), standardName: s(node.StandardName) });
    return;
  }
  for (const v of Object.values(node)) collect(v, out);
}

/** Every field of Property:Property, cached for a day. Throws if the metadata call fails. */
export async function propertyFields(client: RetsClient): Promise<FeedField[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.fields;
  const md = await client.getMetadata({ type: "METADATA-TABLE", id: "Property:Property" });
  const fields: FeedField[] = [];
  collect(md, fields);
  if (!fields.length) throw new Error("Property metadata listed no fields");
  cache = { at: Date.now(), fields };
  return fields;
}

/** The optional fields to add to the sync's Select, and which column each fills. */
export function optionalSelect(fields: FeedField[]): Array<{ column: string; field: string }> {
  const names = new Set(fields.map((f) => f.systemName));
  const out: Array<{ column: string; field: string }> = [];
  for (const [column, candidates] of Object.entries(OPTIONAL_LISTING_FIELDS)) {
    const field = candidates.find((c) => names.has(c));
    if (field) out.push({ column, field });
  }
  return out;
}

export function candidateFields(fields: FeedField[]): FeedField[] {
  return fields.filter((f) => CANDIDATE.test(f.systemName) || (f.longName && CANDIDATE.test(f.longName)));
}

export interface FieldProbeResult {
  totalFields: number;
  candidates: FeedField[];
  optionalSynced: Array<{ column: string; field: string }>;
  /** One active listing's values for the candidate fields, to see which are actually filled. */
  sample: { listingId: string; values: Record<string, string> } | null;
  sampleError?: string;
}

/** What the feed offers for forms: the candidate fields and one listing's values for them. */
export async function probePropertyFields(client: RetsClient): Promise<FieldProbeResult> {
  const fields = await propertyFields(client);
  const candidates = candidateFields(fields);
  const result: FieldProbeResult = { totalFields: fields.length, candidates, optionalSynced: optionalSelect(fields), sample: null };
  if (!candidates.length) return result;
  try {
    const r = await client.search({
      resource: "Property",
      class: "Property",
      query: "(StandardStatus=|A),(PostalCode=T2*)",
      select: ["ListingId", ...candidates.map((c) => c.systemName)].join(","),
      limit: 10,
    });
    // Ten listings, first non-empty value per field: one listing alone may
    // leave a field blank that the feed does carry.
    if (r.rows.length) {
      const values: Record<string, string> = {};
      for (const row of r.rows) {
        for (const c of candidates) {
          const v = row[c.systemName]?.trim();
          if (v && !values[c.systemName]) values[c.systemName] = v.slice(0, 300);
        }
      }
      result.sample = { listingId: r.rows[0].ListingId, values };
    }
  } catch (e: any) {
    result.sampleError = e?.message ?? String(e);
  }
  return result;
}
