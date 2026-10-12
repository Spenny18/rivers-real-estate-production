// Pillar 9 RETS sync — fetches all active Calgary listings, normalizes them
// into the mls_listings table, and records the run in mls_sync_runs.
//
// Strategy:
//   - Pillar 9's `City` field is not searchable in DMQL2 despite metadata saying so.
//     Workaround: filter on PostalCode prefixes that cover Calgary (T1Y, T2*, T3*)
//     plus StandardStatus=A, then post-filter rows where City === "Calgary".
//   - Page through results (Limit/Offset) to get all rows.
//   - Photos are fetched lazily via GetObject when a listing first appears.
//     For initial sync we just record `photoCount` and the photo URL pattern.
//   - Listings that disappear from the active feed get marked status="Removed".

import "dotenv/config";
import { RetsClient, RetsAuthError } from "./rets-client";
import { sqlite, storage } from "./storage";
import type { InsertMlsListing } from "@shared/schema";

const CALGARY_NEIGHBOURHOOD_HINTS: Array<[RegExp, string]> = [
  [/springbank\s*hill/i, "Springbank Hill"],
  [/aspen\s*woods/i, "Aspen Woods"],
  [/upper\s*mount\s*royal/i, "Upper Mount Royal"],
  [/mount\s*royal/i, "Upper Mount Royal"],
  [/elbow\s*park/i, "Elbow Park"],
  [/britannia/i, "Britannia"],
  [/bel\s*-?\s*aire/i, "Bel-Aire"],
];

function inferNeighbourhood(...sources: (string | undefined)[]): string | undefined {
  const blob = sources.filter(Boolean).join(" ");
  for (const [re, name] of CALGARY_NEIGHBOURHOOD_HINTS) {
    if (re.test(blob)) return name;
  }
  return undefined;
}

// Convert a RETS row (alphabetical columns) into an InsertMlsListing record.
function normalizeListing(row: Record<string, string>): InsertMlsListing | null {
  const listingId = row.ListingId?.trim();
  if (!listingId) return null;
  const listingKeyRaw = row.ListingKeyNumeric ? parseInt(row.ListingKeyNumeric, 10) : NaN;
  const listingKey = Number.isFinite(listingKeyRaw) ? listingKeyRaw : null;
  const listPriceNum = Number(row.ListPrice);
  if (!Number.isFinite(listPriceNum) || listPriceNum <= 0) return null;
  const lat = row.Latitude ? Number(row.Latitude) : null;
  const lng = row.Longitude ? Number(row.Longitude) : null;
  const sqft = row.LivingAreaSF ? Math.round(Number(row.LivingAreaSF)) : null;
  const beds = row.BedroomsTotal ? parseInt(row.BedroomsTotal, 10) : 0;
  const baths = row.BathroomsTotalInteger ? parseInt(row.BathroomsTotalInteger, 10) : 0;
  const yearBuilt = row.YearBuilt ? parseInt(row.YearBuilt, 10) : null;
  const photoCount = row.PhotosCount ? parseInt(row.PhotosCount, 10) : 0;
  const neighbourhood =
    inferNeighbourhood(undefined, undefined, row.PublicRemarks, row.UnparsedAddress) ?? null;

  // Pillar 9 standard photo URL — we'll wire real GetObject fetches later.
  // For now we use a placeholder that signals "no photo yet" so the UI can
  // show a tasteful card without flashing broken images.
  const heroImage = photoCount > 0 ? `/api/mls/${listingId}/photo/0` : null;

  return {
    id: listingId,
    mlsNumber: listingId,
    listingKey,
    status: row.StandardStatus || row.MlsStatus || "Active",
    listPrice: Math.round(listPriceNum),
    soldPrice: null,
    streetNumber: rawText(row.StreetNumber) ?? null,
    // Pillar 9 splits the street name across three RETS fields:
    //   StreetName = "26"     (just the name token)
    //   StreetSuffix = "Avenue" (Ave/Street/Road/etc.)
    //   StreetDirSuffix = "SW"  (quadrant)
    // We concatenate so the canonical full street name lives in one column,
    // matching what humans/admin seeds use ("26 Avenue SW").
    streetName: (() => {
      const parts = [
        rawText(row.StreetName),
        rawText(row.StreetSuffix),
        rawText(row.StreetDirSuffix),
      ].filter(Boolean);
      return parts.length ? parts.join(" ") : null;
    })(),
    unit: null,
    fullAddress: row.UnparsedAddress?.trim() || `${row.City || "Calgary"}, AB`,
    neighbourhood,
    city: row.City || "Calgary",
    province: "AB",
    postalCode: row.PostalCode || null,
    lat: lat && Number.isFinite(lat) ? lat : null,
    lng: lng && Number.isFinite(lng) ? lng : null,
    propertyType: row.PropertyType || "Residential",
    propertySubType: row.PropertySubType || null,
    beds: Number.isFinite(beds) ? beds : 0,
    bedsAbove: null,
    bedsBelow: null,
    baths: Number.isFinite(baths) ? baths : 0,
    halfBaths: null,
    sqft,
    sqftBelow: null,
    lotSize: null,
    yearBuilt: yearBuilt && Number.isFinite(yearBuilt) ? yearBuilt : null,
    parking: null,
    garageSpaces: null,
    listDate: rawText(row.ListingContractDate) ?? null,
    statusChangedAt: rawText(row.StatusChangeTimestamp) ?? null,
    daysOnMarket: null,
    description: row.PublicRemarks?.trim() || null,
    features: "[]",
    listAgentName: null,
    listAgentPhone: null,
    listOffice: null,
    heroImage,
    gallery: "[]",
    photoCount: Number.isFinite(photoCount) ? photoCount : 0,
    source: "pillar9",
    rawJson: null,
    syncedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    // ---- structured fields ----
    structureType: rawText(row.StructureType) ?? undefined,
    architecturalStyle: rawText(row.ArchitecturalStyle) ?? undefined,
    levels: rawText(row.Levels) ?? undefined,
    basement: rawText(row.Basement) ?? undefined,
    basementDevelopment: rawText(row.BasementDevelopment) ?? undefined,
    parkingFeatures: rawText(row.ParkingFeatures) ?? undefined,
    garageYn: rawBool(row.GarageYN) ?? undefined,
    lotFeatures: rawText(row.LotFeatures) ?? undefined,
    laundryFeatures: rawText(row.LaundryFeatures) ?? undefined,
    appliances: rawText(row.Appliances) ?? undefined,
    cooling: rawText(row.Cooling) ?? undefined,
    heating: rawText(row.Heating) ?? undefined,
    flooring: rawText(row.Flooring) ?? undefined,
    fireplacesTotal: rawInt(row.FireplacesTotal) ?? undefined,
    fireplaceFeatures: rawText(row.FireplaceFeatures) ?? undefined,
    poolPrivateYn: rawBool(row.PoolPrivateYN) ?? undefined,
    poolFeatures: rawText(row.PoolFeatures) ?? undefined,
    waterfrontYn: rawBool(row.WaterfrontYN) ?? undefined,
    view: rawText(row.View) ?? undefined,
    subdivision: rawText(row.SubdivisionName) ?? undefined,
    district: rawText(row.District) ?? undefined,
    condoFee: rawInt(row.AssociationFee) ?? undefined,
    associationFeeIncludes: rawText(row.AssociationFeeIncludes) ?? undefined,
    associationAmenities: rawText(row.AssociationAmenities) ?? undefined,
    accessibilityFeatures: rawText(row.AccessibilityFeatures) ?? undefined,
    inclusions: rawText(row.Inclusions) ?? undefined,
    exclusions: rawText(row.Exclusions) ?? undefined,
    zoning: rawText(row.Zoning) ?? undefined,
    suite: rawText(row.Suite) ?? undefined,
    legalSuiteYn: rawBool(row.LegalSuiteYN) ?? undefined,
    suiteLocation: rawText(row.SuiteLocation) ?? undefined,
  } as any;
}

const SELECT_FIELDS = [
  "ListingId",
  "ListingKeyNumeric",
  "ListPrice",
  "StreetNumber",
  "StreetName",
  "StreetSuffix",
  "StreetDirSuffix",
  "City",
  "PostalCode",
  "StandardStatus",
  "MlsStatus",
  "BedroomsTotal",
  "BathroomsTotalInteger",
  "LivingAreaSF",
  "PropertyType",
  "PropertySubType",
  "UnparsedAddress",
  "Latitude",
  "Longitude",
  "PhotosCount",
  "PublicRemarks",
  "ModificationTimestamp",
  "StatusChangeTimestamp",
  "ListingContractDate",
  "YearBuilt",
  // ---- structured fields used by filters ----
  "StructureType",
  "ArchitecturalStyle",
  "Levels",
  "Basement",
  "BasementDevelopment",
  "ParkingFeatures",
  "GarageYN",
  "GarageSpaces",
  "LotFeatures",
  "LaundryFeatures",
  "Appliances",
  "Cooling",
  "Heating",
  "Flooring",
  "FireplacesTotal",
  "FireplaceFeatures",
  "PoolFeatures",
  "SubdivisionName",
  "District",
  "AssociationFee",
  "AssociationFeeIncludes",
  "AssociationAmenities",
  "AccessibilityFeatures",
  "Inclusions",
  "Zoning",
  "Suite",
  "SuiteLocation",
  "DaysOnMarket",
  "LotSizeAcres",
  "LotSizeSquareFeet",
].join(",");

function rawText(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function rawBool(v: any): boolean | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (s === "Y" || s === "YES" || s === "TRUE" || s === "1") return true;
  if (s === "N" || s === "NO" || s === "FALSE" || s === "0") return false;
  return null;
}

function rawInt(v: any): number | null {
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

export async function runSync(): Promise<{
  status: "success" | "error" | "skipped";
  fetched: number;
  upserted: number;
  removed: number;
  errorMessage?: string;
}> {
  if (process.env.RETS_SYNC_ENABLED !== "true") {
    return { status: "skipped", fetched: 0, upserted: 0, removed: 0 };
  }

  const run = storage.startSyncRun({ source: "pillar9" });
  console.log(`[mls-sync] starting run #${run.id}`);

  const client = new RetsClient({
    loginUrl: process.env.RETS_LOGIN_URL!,
    username: process.env.RETS_USERNAME!,
    password: process.env.RETS_PASSWORD!,
    userAgent: process.env.RETS_USER_AGENT ?? "RiversRealEstate/1.0",
    uaPassword: process.env.RETS_UA_PASSWORD || undefined,
  });

  let fetched = 0;
  let upserted = 0;
  let removed = 0;
  const seenIds = new Set<string>();

  try {
    await client.login();

    // Iterate every postal-code prefix Pillar 9 serves so we cover Calgary +
    // surrounding municipalities (Rocky View, Foothills, Airdrie, Cochrane,
    // Okotoks, Strathmore, etc.) Pillar 9's service area is roughly all
    // Alberta postal codes starting with T0, T1, T2, T3, T4. Loop them all.
    const prefixes = [
      "T0A*", "T0B*", "T0C*", "T0E*", "T0G*", "T0H*", "T0J*", "T0K*", "T0L*", "T0M*", "T0P*", "T0V*",
      "T1A*", "T1B*", "T1C*", "T1G*", "T1H*", "T1J*", "T1K*", "T1L*", "T1M*", "T1P*", "T1R*", "T1S*", "T1V*", "T1W*", "T1X*", "T1Y*", "T1Z*",
      "T2*", "T3*",
      "T4A*", "T4B*", "T4C*", "T4E*", "T4G*", "T4H*", "T4J*", "T4L*", "T4M*", "T4N*", "T4P*", "T4R*", "T4S*", "T4T*", "T4V*", "T4X*",
    ];
    for (const prefix of prefixes) {
      let offset = 0;
      const pageSize = 200;
      while (true) {
        const result = await client.search({
          resource: "Property",
          class: "Property",
          query: `(StandardStatus=|A),(PostalCode=${prefix})`,
          select: SELECT_FIELDS,
          limit: pageSize,
          offset,
        });
        if (result.rows.length === 0) break;
        fetched += result.rows.length;
        // One transaction per page: 200 upserts as a single commit instead of
        // 200, so the page saves in a fraction of the time and the event loop
        // (which serves the site) is free again while the next page downloads.
        // Per-row commits kept the server busy for seconds each hourly sync.
        sqlite.transaction(() => {
          for (const row of result.rows) {
            // No city post-filter — we want the whole Pillar 9 service area
            // (Calgary + Rocky View + Foothills + Cochrane + Airdrie + …).
            const listing = normalizeListing(row);
            if (!listing) continue;
            storage.upsertMlsListing(listing);
            seenIds.add(listing.id);
            upserted++;
          }
        })();
        if (result.rows.length < pageSize) break;
        offset += pageSize;
        // Safety cap per prefix — generous so we can cover dense urban prefixes
        // (T2/T3 cover most of Calgary and routinely have 3-4k active listings each).
        if (offset > 10000) break;
      }
    }

    // Mark anything we've seen previously but didn't see this run as removed.
    removed = storage.markMlsListingsRemovedExcept(Array.from(seenIds));

    storage.refreshNeighbourhoodActiveCounts();

    storage.finishSyncRun(run.id, {
      status: "success",
      fetched,
      upserted,
      removed,
    });
    console.log(`[mls-sync] run #${run.id} done: fetched=${fetched} upserted=${upserted} removed=${removed}`);
    return { status: "success", fetched, upserted, removed };
  } catch (err: any) {
    const message = err instanceof RetsAuthError
      ? `RETS auth failed: ${err.message}`
      : err?.message || String(err);
    console.error(`[mls-sync] run #${run.id} failed:`, message);
    storage.finishSyncRun(run.id, {
      status: "error",
      fetched,
      upserted,
      removed,
      errorMessage: message,
    });
    return { status: "error", fetched, upserted, removed, errorMessage: message };
  } finally {
    // Thousands of individual upserts run in one sync. Keep the previous
    // lookup usable throughout the batch, then rebuild lazily once from the
    // completed dataset instead of forcing every concurrent page request to
    // rebuild it between rows.
    storage.invalidateMlsSlugCaches();
    try { await client.logout(); } catch {}
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSyncCron() {
  if (process.env.RETS_SYNC_ENABLED !== "true") {
    console.log("[mls-sync] disabled (RETS_SYNC_ENABLED != true)");
    return;
  }
  if (timer) return;
  const intervalHours = Math.max(1, Number(process.env.RETS_SYNC_INTERVAL_HOURS ?? "1"));
  const intervalMs = intervalHours * 60 * 60 * 1000;
  console.log(`[mls-sync] scheduled every ${intervalHours}h`);
  // Kick off an immediate run, but defer slightly so server boot finishes first.
  setTimeout(() => {
    runSync().catch((err) => console.error("[mls-sync] uncaught:", err));
  }, 5000);
  timer = setInterval(() => {
    runSync().catch((err) => console.error("[mls-sync] uncaught:", err));
  }, intervalMs);
}

export function stopSyncCron() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
