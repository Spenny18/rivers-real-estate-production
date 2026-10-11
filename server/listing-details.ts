// Listing details that only forms use: the legal description, LINC, title
// type and the listing agent's email and office phone, from Pillar 9.
//
// Kept out of mls_listings on purpose: the public listing endpoints return
// whole mls_listings rows, and none of this belongs on the public site.
// Filled by rets-sync.ts (when the feed defines the fields — rets-fields.ts),
// read by the form prefill (form-templates.ts).

import { sqlite } from "./storage";

export interface ListingDetails {
  legalPlan: string | null;
  legalBlock: string | null;
  legalLot: string | null;
  legalUnit: string | null;
  /** Pillar 9's TaxLegalDescription, e.g. "1610979;10". */
  legalDescription: string | null;
  /** LINC number (Pillar 9 ParcelNumber). */
  parcelNumber: string | null;
  /** "Fee Simple", "Condominium"… */
  titleLand: string | null;
  listAgentEmail: string | null;
  listOfficePhone: string | null;
}

/** Feed field names per column; the first one the feed defines wins. */
export const DETAIL_FIELDS: Record<keyof ListingDetails, string[]> = {
  legalPlan: ["LegalPlan", "TaxLegalPlan"],
  legalBlock: ["TaxBlock", "LegalBlock"],
  legalLot: ["TaxLot", "LegalLot", "LotNumber"],
  legalUnit: ["LegalUnitNumber"],
  legalDescription: ["TaxLegalDescription"],
  parcelNumber: ["ParcelNumber"],
  titleLand: ["TitleLand"],
  listAgentEmail: ["ListAgentEmail"],
  listOfficePhone: ["ListOfficePhone"],
};

const COLUMNS: Array<[keyof ListingDetails, string]> = [
  ["legalPlan", "legal_plan"],
  ["legalBlock", "legal_block"],
  ["legalLot", "legal_lot"],
  ["legalUnit", "legal_unit"],
  ["legalDescription", "legal_description"],
  ["parcelNumber", "parcel_number"],
  ["titleLand", "title_land"],
  ["listAgentEmail", "list_agent_email"],
  ["listOfficePhone", "list_office_phone"],
];

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS mls_listing_details (
    listing_id TEXT PRIMARY KEY,
    ${COLUMNS.map(([, c]) => `${c} TEXT`).join(",\n    ")},
    updated_at TEXT NOT NULL
  );
`);

const upsertStmt = sqlite.prepare(
  `INSERT INTO mls_listing_details (listing_id, ${COLUMNS.map(([, c]) => c).join(", ")}, updated_at)
   VALUES (@listingId, ${COLUMNS.map(([k]) => `@${k}`).join(", ")}, @updatedAt)
   ON CONFLICT(listing_id) DO UPDATE SET ${COLUMNS.map(([, c]) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`,
);

/** Store what the feed sent for one listing. Nothing to store → no row. */
export function upsertListingDetails(listingId: string, d: Partial<ListingDetails>) {
  const row: Record<string, string | null> = { listingId, updatedAt: new Date().toISOString() };
  let any = false;
  for (const [k] of COLUMNS) {
    const v = d[k]?.trim() || null;
    row[k] = v;
    if (v) any = true;
  }
  if (!any) return;
  upsertStmt.run(row);
}

export function getListingDetails(listingId: string): ListingDetails | null {
  const r = sqlite.prepare("SELECT * FROM mls_listing_details WHERE listing_id = ?").get(listingId) as Record<string, string | null> | undefined;
  if (!r) return null;
  const out = {} as ListingDetails;
  for (const [k, c] of COLUMNS) out[k] = r[c] ?? null;
  return out;
}
