// Spencer's own listings from Pillar 9, by agent ID.
//
// The active sync (rets-sync.ts) only holds what is on the market right now,
// and the history sync only the fields the market stats need. The Listings
// page wants every listing Spencer is on — active, pending and sold — with
// enough detail to build marketing from, so this asks the feed directly for
// the rows whose list, co-list or buyer agent is his Pillar 9 ID (CRIVERSP,
// or PILLAR9_AGENT_ID).
//
// The agent ID fields go by different names on different RETS servers, and a
// field the class does not define fails the whole search, so each role's
// field is picked from the feed's own metadata (rets-fields.ts). One search
// per role, no status filter: the feed returns every status it holds.
//
// Rows not seen in the latest successful run are kept (a sold listing ages
// out of the feed after a couple of years, and its marketing history is still
// worth having) and marked with missing_since.

import { RetsClient, RetsAuthError } from "./rets-client";
import { sqlite } from "./storage";
import { propertyFields, type FeedField } from "./rets-fields";

export function agentMlsId(): string {
  return (process.env.PILLAR9_AGENT_ID?.trim() || "CRIVERSP").toUpperCase();
}

export type MyListingRole = "list" | "co-list" | "buyer";

/** Candidate feed fields per role; the first one the feed defines wins. */
export const ROLE_FIELDS: Record<MyListingRole, string[]> = {
  list: ["ListAgentMlsId", "ListAgentLoginId", "ListAgentKey"],
  "co-list": ["CoListAgentMlsId", "CoListAgentLoginId", "CoListAgentKey"],
  buyer: ["BuyerAgentMlsId", "BuyerAgentLoginId", "BuyerAgentKey"],
};

const BASE_FIELDS = [
  "ListingId",
  "ListingKeyNumeric",
  "StandardStatus",
  "MlsStatus",
  "ListPrice",
  "OriginalListPrice",
  "ClosePrice",
  "CloseDate",
  "ListingContractDate",
  "StatusChangeTimestamp",
  "ModificationTimestamp",
  "DaysOnMarket",
  "UnparsedAddress",
  "City",
  "PostalCode",
  "SubdivisionName",
  "PropertyType",
  "PropertySubType",
  "StructureType",
  "BedroomsTotal",
  "BathroomsTotalInteger",
  "LivingAreaSF",
  "LotSizeSquareFeet",
  "LotSizeAcres",
  "YearBuilt",
  "GarageSpaces",
  "PhotosCount",
  "PublicRemarks",
  "Latitude",
  "Longitude",
  "AssociationFee",
];

export interface MyListing {
  id: string;
  listingKey: number | null;
  role: MyListingRole;
  status: string;
  listPrice: number | null;
  originalListPrice: number | null;
  closePrice: number | null;
  closeDate: string | null;
  listDate: string | null;
  statusChangedAt: string | null;
  daysOnMarket: number | null;
  address: string;
  city: string | null;
  postalCode: string | null;
  community: string | null;
  propertyType: string | null;
  propertySubType: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  lotSqft: number | null;
  yearBuilt: number | null;
  garageSpaces: number | null;
  condoFee: number | null;
  photoCount: number;
  remarks: string | null;
  lat: number | null;
  lng: number | null;
  syncedAt: string;
  missingSince: string | null;
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS my_listings (
    id TEXT PRIMARY KEY,
    listing_key INTEGER,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    list_price INTEGER,
    original_list_price INTEGER,
    close_price INTEGER,
    close_date TEXT,
    list_date TEXT,
    status_changed_at TEXT,
    days_on_market INTEGER,
    address TEXT NOT NULL,
    city TEXT,
    postal_code TEXT,
    community TEXT,
    property_type TEXT,
    property_sub_type TEXT,
    beds INTEGER,
    baths REAL,
    sqft INTEGER,
    lot_sqft INTEGER,
    year_built INTEGER,
    garage_spaces INTEGER,
    condo_fee INTEGER,
    photo_count INTEGER NOT NULL DEFAULT 0,
    remarks TEXT,
    lat REAL,
    lng REAL,
    synced_at TEXT NOT NULL,
    missing_since TEXT
  );
  CREATE TABLE IF NOT EXISTS my_listings_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    fetched INTEGER NOT NULL DEFAULT 0,
    fields TEXT,
    error TEXT
  );
`);

// ---- Normalising --------------------------------------------------------------------

function text(v: string | undefined): string | null {
  const s = v?.trim();
  return s ? s : null;
}

function int(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "A" / "Active" / "Active Under Contract"… → the label the app shows. */
export function normalizeStatus(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  const u = s.toUpperCase();
  if (!u) return "Unknown";
  if (u === "A" || u === "ACTIVE") return "Active";
  if (u === "S" || u.startsWith("SOLD") || u === "CLOSED") return "Sold";
  if (u === "P" || u.startsWith("PENDING") || u.includes("UNDER CONTRACT") || u === "U") return "Pending";
  if (u === "X" || u.startsWith("EXPIRED")) return "Expired";
  if (u === "W" || u.startsWith("WITHDRAWN")) return "Withdrawn";
  if (u === "T" || u.startsWith("TERMINATED") || u.startsWith("CANCEL")) return "Terminated";
  if (u.startsWith("COMING")) return "Coming Soon";
  return s;
}

/** One RETS row → a my_listings record; null when it has no ListingId. */
export function normalizeMyListing(row: Record<string, string>, role: MyListingRole, now = new Date().toISOString()): MyListing | null {
  const id = text(row.ListingId);
  if (!id) return null;
  const lotSqft = int(row.LotSizeSquareFeet) ?? (num(row.LotSizeAcres) != null ? Math.round(num(row.LotSizeAcres)! * 43560) : null);
  return {
    id,
    listingKey: int(row.ListingKeyNumeric),
    role,
    status: normalizeStatus(row.StandardStatus || row.MlsStatus),
    listPrice: int(row.ListPrice),
    originalListPrice: int(row.OriginalListPrice),
    closePrice: int(row.ClosePrice),
    closeDate: text(row.CloseDate),
    listDate: text(row.ListingContractDate),
    statusChangedAt: text(row.StatusChangeTimestamp),
    daysOnMarket: int(row.DaysOnMarket),
    address: text(row.UnparsedAddress) ?? `${text(row.City) ?? "Calgary"}, AB`,
    city: text(row.City),
    postalCode: text(row.PostalCode),
    community: text(row.SubdivisionName),
    propertyType: text(row.PropertyType),
    propertySubType: text(row.PropertySubType) ?? text(row.StructureType),
    beds: int(row.BedroomsTotal),
    baths: num(row.BathroomsTotalInteger),
    sqft: int(row.LivingAreaSF),
    lotSqft,
    yearBuilt: int(row.YearBuilt),
    garageSpaces: int(row.GarageSpaces),
    condoFee: int(row.AssociationFee),
    photoCount: int(row.PhotosCount) ?? 0,
    remarks: text(row.PublicRemarks),
    lat: num(row.Latitude),
    lng: num(row.Longitude),
    syncedAt: now,
    missingSince: null,
  };
}

// ---- Store --------------------------------------------------------------------------

const COLUMNS: Array<[keyof MyListing, string]> = [
  ["id", "id"],
  ["listingKey", "listing_key"],
  ["role", "role"],
  ["status", "status"],
  ["listPrice", "list_price"],
  ["originalListPrice", "original_list_price"],
  ["closePrice", "close_price"],
  ["closeDate", "close_date"],
  ["listDate", "list_date"],
  ["statusChangedAt", "status_changed_at"],
  ["daysOnMarket", "days_on_market"],
  ["address", "address"],
  ["city", "city"],
  ["postalCode", "postal_code"],
  ["community", "community"],
  ["propertyType", "property_type"],
  ["propertySubType", "property_sub_type"],
  ["beds", "beds"],
  ["baths", "baths"],
  ["sqft", "sqft"],
  ["lotSqft", "lot_sqft"],
  ["yearBuilt", "year_built"],
  ["garageSpaces", "garage_spaces"],
  ["condoFee", "condo_fee"],
  ["photoCount", "photo_count"],
  ["remarks", "remarks"],
  ["lat", "lat"],
  ["lng", "lng"],
  ["syncedAt", "synced_at"],
  ["missingSince", "missing_since"],
];

const upsertStmt = sqlite.prepare(
  `INSERT INTO my_listings (${COLUMNS.map(([, c]) => c).join(", ")})
   VALUES (${COLUMNS.map(([k]) => `@${k}`).join(", ")})
   ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter(([k]) => k !== "id").map(([, c]) => `${c} = excluded.${c}`).join(", ")}`,
);

function fromRow(r: Record<string, any>): MyListing {
  const out = {} as Record<string, any>;
  for (const [k, c] of COLUMNS) out[k] = r[c] ?? null;
  out.photoCount = r.photo_count ?? 0;
  return out as MyListing;
}

export function upsertMyListing(l: MyListing) {
  upsertStmt.run(Object.fromEntries(COLUMNS.map(([k]) => [k, l[k] ?? null])));
}

export function listMyListings(): MyListing[] {
  const rows = sqlite
    .prepare(
      `SELECT * FROM my_listings
       ORDER BY CASE status WHEN 'Active' THEN 0 WHEN 'Coming Soon' THEN 1 WHEN 'Pending' THEN 2 WHEN 'Sold' THEN 3 ELSE 4 END,
                COALESCE(close_date, status_changed_at, list_date) DESC`,
    )
    .all() as Record<string, any>[];
  return rows.map(fromRow);
}

export function getMyListing(id: string): MyListing | null {
  const r = sqlite.prepare("SELECT * FROM my_listings WHERE id = ?").get(id) as Record<string, any> | undefined;
  return r ? fromRow(r) : null;
}

export interface MyListingsSyncRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  fetched: number;
  fields: string | null;
  error: string | null;
}

export function lastMyListingsSync(): MyListingsSyncRun | null {
  const r = sqlite.prepare("SELECT * FROM my_listings_sync ORDER BY id DESC LIMIT 1").get() as Record<string, any> | undefined;
  if (!r) return null;
  return { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, fetched: r.fetched, fields: r.fields, error: r.error };
}

// ---- Sync ---------------------------------------------------------------------------

/** Which field the feed uses for each role's agent ID. */
export function roleFields(fields: FeedField[]): Array<{ role: MyListingRole; field: string }> {
  const names = new Set(fields.map((f) => f.systemName));
  const out: Array<{ role: MyListingRole; field: string }> = [];
  for (const [role, candidates] of Object.entries(ROLE_FIELDS) as Array<[MyListingRole, string[]]>) {
    const field = candidates.find((c) => names.has(c));
    if (field) out.push({ role, field });
  }
  return out;
}

let running: Promise<MyListingsSyncRun> | null = null;

export function retsConfigured(): boolean {
  return !!(process.env.RETS_LOGIN_URL && process.env.RETS_USERNAME && process.env.RETS_PASSWORD);
}

export function syncMyListings(): Promise<MyListingsSyncRun> {
  if (!running) running = doSync().finally(() => (running = null));
  return running;
}

export function myListingsSyncRunning(): boolean {
  return running !== null;
}

async function doSync(): Promise<MyListingsSyncRun> {
  const startedAt = new Date().toISOString();
  const runId = Number(
    sqlite.prepare("INSERT INTO my_listings_sync (started_at, status) VALUES (?, 'running')").run(startedAt).lastInsertRowid,
  );
  const finish = (status: string, fetched: number, fields: string | null, error: string | null) => {
    const finishedAt = new Date().toISOString();
    sqlite
      .prepare("UPDATE my_listings_sync SET finished_at = ?, status = ?, fetched = ?, fields = ?, error = ? WHERE id = ?")
      .run(finishedAt, status, fetched, fields, error, runId);
    return { id: runId, startedAt, finishedAt, status, fetched, fields, error };
  };
  if (!retsConfigured()) return finish("error", 0, null, "Pillar 9 isn't connected: RETS_LOGIN_URL, RETS_USERNAME and RETS_PASSWORD must be set.");

  const client = new RetsClient({
    loginUrl: process.env.RETS_LOGIN_URL!,
    username: process.env.RETS_USERNAME!,
    password: process.env.RETS_PASSWORD!,
    userAgent: process.env.RETS_USER_AGENT ?? "RiversRealEstate/1.0",
    uaPassword: process.env.RETS_UA_PASSWORD || undefined,
  });
  let fetched = 0;
  let fieldNote: string | null = null;
  try {
    await client.login();
    const fields = await propertyFields(client);
    const names = new Set(fields.map((f) => f.systemName));
    const roles = roleFields(fields);
    fieldNote = roles.map((r) => `${r.role}:${r.field}`).join(", ") || null;
    if (!roles.some((r) => r.role === "list")) {
      throw new Error(`The feed defines none of ${ROLE_FIELDS.list.join(", ")}, so listings can't be matched to ${agentMlsId()}.`);
    }
    const select = BASE_FIELDS.filter((f) => names.has(f)).join(",");
    const id = agentMlsId();
    const now = new Date().toISOString();
    const seen = new Set<string>();
    // List side first: a listing Spencer also sold to his own buyer comes back
    // under both roles, and the listing role is the one to keep.
    for (const { role, field } of roles) {
      const pageSize = 200;
      for (let offset = 0; offset <= 5000; offset += pageSize) {
        const r = await client.search({ resource: "Property", class: "Property", query: `(${field}=${id})`, select, limit: pageSize, offset });
        fetched += r.rows.length;
        sqlite.transaction(() => {
          for (const row of r.rows) {
            const l = normalizeMyListing(row, role, now);
            if (!l) continue;
            if (seen.has(l.id)) continue;
            seen.add(l.id);
            upsertMyListing(l);
          }
        })();
        if (r.rows.length < pageSize) break;
      }
    }
    sqlite
      .prepare(`UPDATE my_listings SET missing_since = COALESCE(missing_since, ?) WHERE synced_at <> ?`)
      .run(now, now);
    console.log(`[my-listings] ${id}: ${seen.size} listings (${fieldNote})`);
    return finish("success", fetched, fieldNote, null);
  } catch (err: any) {
    const message = err instanceof RetsAuthError ? `RETS auth failed: ${err.message}` : err?.message || String(err);
    console.error("[my-listings] sync failed:", message);
    return finish("error", fetched, fieldNote, message);
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

let timer: NodeJS.Timeout | null = null;

/** Every six hours (MY_LISTINGS_SYNC_HOURS), when the MLS sync is on. */
export function startMyListingsCron() {
  if (process.env.RETS_SYNC_ENABLED !== "true" || timer) return;
  const hours = Math.max(1, Number(process.env.MY_LISTINGS_SYNC_HOURS ?? "6"));
  setTimeout(() => syncMyListings().catch(() => {}), 60_000);
  timer = setInterval(() => syncMyListings().catch(() => {}), hours * 60 * 60 * 1000);
}
