import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-assets-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.LISTING_ASSETS_FAKE = "1";

const { normalizeMyListing, normalizeStatus, upsertMyListing, listMyListings, getMyListing, roleFields } = await import("../server/my-listings");
const { graphicSvg, featureSheetSvg, rasterise, renderFeatureSheet, defaultOccasion, generateCopy, listAssets, listingFacts, wrap } = await import(
  "../server/listing-assets"
);

const row = {
  ListingId: "A2199999",
  ListingKeyNumeric: "123456",
  StandardStatus: "Active",
  ListPrice: "1850000",
  OriginalListPrice: "1950000",
  UnparsedAddress: "1234 elveden Drive SW",
  City: "Calgary",
  SubdivisionName: "SPRINGBANK HILL",
  BedroomsTotal: "5",
  BathroomsTotalInteger: "4",
  LivingAreaSF: "3420",
  YearBuilt: "2014",
  PhotosCount: "42",
  PublicRemarks: "A walkout estate home backing onto a ravine, with a chef's kitchen and a triple garage.",
};

test("a RETS row becomes a my_listings record", () => {
  const l = normalizeMyListing(row, "list", "2026-10-30T00:00:00.000Z")!;
  assert.equal(l.id, "A2199999");
  assert.equal(l.listingKey, 123456);
  assert.equal(l.listPrice, 1850000);
  assert.equal(l.status, "Active");
  assert.equal(l.photoCount, 42);
  assert.equal(normalizeMyListing({ ...row, ListingId: "" }, "list"), null);
});

test("statuses read the same whether the feed sends codes or words", () => {
  assert.equal(normalizeStatus("S"), "Sold");
  assert.equal(normalizeStatus("Closed"), "Sold");
  assert.equal(normalizeStatus("Pending"), "Pending");
  assert.equal(normalizeStatus("X"), "Expired");
  assert.equal(normalizeStatus(""), "Unknown");
});

test("agent ID fields are picked from what the feed defines", () => {
  const f = (n: string) => ({ systemName: n, longName: null, standardName: null });
  assert.deepEqual(roleFields([f("ListAgentMlsId"), f("BuyerAgentKey"), f("Other")]), [
    { role: "list", field: "ListAgentMlsId" },
    { role: "buyer", field: "BuyerAgentKey" },
  ]);
});

test("listings store and sort active ahead of sold", () => {
  upsertMyListing(normalizeMyListing({ ...row, ListingId: "A1", StandardStatus: "Sold", ClosePrice: "1800000", CloseDate: "2026-05-01" }, "list")!);
  upsertMyListing(normalizeMyListing(row, "list")!);
  assert.deepEqual(listMyListings().map((l) => l.id), ["A2199999", "A1"]);
  assert.equal(getMyListing("A1")!.closePrice, 1800000);
});

test("the occasion follows the status and the price history", () => {
  const l = getMyListing("A2199999")!;
  assert.equal(defaultOccasion(l), "new-price");
  assert.equal(defaultOccasion(getMyListing("A1")!), "just-sold");
});

test("every graphic format renders, the brokerage is on it, and a sold price stays off unless asked", () => {
  const sold = getMyListing("A1")!;
  for (const format of ["square", "story", "landscape"] as const) {
    const svg = graphicSvg(sold, format, { occasion: "just-sold" }, null);
    assert.match(svg, /SYNTERRA REALTY|Synterra Realty/);
    assert.doesNotMatch(svg, /1,800,000/);
    const png = rasterise(svg, 400);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
  }
  assert.match(graphicSvg(sold, "square", { occasion: "just-sold", showSoldPrice: true }, null), /Sold for \$1,800,000/);
  assert.match(graphicSvg(getMyListing("A2199999")!, "square", { occasion: "new-price" }, null), /Was \$1,950,000/);
});

test("the feature sheet is a one-page PDF", async () => {
  assert.match(featureSheetSvg(getMyListing("A2199999")!, []), /ravine/);
  const pdf = await renderFeatureSheet(getMyListing("A2199999")!);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});

test("copy facts leave a sold price out unless it is wanted, and copy is saved", async () => {
  const sold = getMyListing("A1")!;
  assert.doesNotMatch(listingFacts(sold, { occasion: "just-sold" }), /Sold price/);
  assert.match(listingFacts(sold, { occasion: "just-sold", showSoldPrice: true }), /Sold price: \$1,800,000/);
  const a = await generateCopy(sold, "instagram", { occasion: "just-sold" });
  assert.equal(listAssets("A1")[0].id, a.id);
});

test("wrap keeps to the line budget and marks what it cut", () => {
  const lines = wrap("one two three four five six seven eight nine ten eleven twelve", 20, 120, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /…$/);
});
