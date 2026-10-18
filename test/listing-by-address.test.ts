import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-by-address-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.LEAD_INTAKE_FAKE = "1";

const { sqlite } = await import("../server/storage");
await import("../server/contacts");
const { findListingByAddress } = await import("../server/showings");
const intake = await import("../server/lead-intake");
const { storage } = await import("../server/storage");

const now = new Date().toISOString();
const add = sqlite.prepare(
  `INSERT INTO mls_listings (id, mls_number, list_price, full_address, city, province, status, synced_at, created_at) VALUES (?, ?, ?, ?, ?, 'AB', ?, ?, ?)`,
);
add.run("A2351995", "A2351995", 189000, "407 kanell Drive NE", "High River", "Active", now, now);
add.run("A2317375", "A2317375", 299000, "485, 3223 83 Street NW", "Calgary", "Removed", now, now);
add.run("A2346328", "A2346328", 289000, "485, 3223 83 Street NW", "Calgary", "Active", now, now);
add.run("A2348223", "A2348223", 899000, "66 Cougarstone Close SW", "Calgary", "Removed", now, now);

test("addresses as lead emails write them find their MLS listing", () => {
  assert.equal(findListingByAddress("407 Kanell Drive NE, High River, AB, T1V 1J6")?.mlsNumber, "A2351995");
  assert.equal(findListingByAddress("66 Cougarstone Close SW, Calgary, AB")?.mlsNumber, "A2348223");
});

test("a unit written 485-3223 matches the MLS's '485, 3223', preferring the active listing", () => {
  assert.equal(findListingByAddress("485-3223 83 Street NW, Calgary, AB, T3B 5P4")?.mlsNumber, "A2346328");
});

test("near misses find nothing rather than the wrong home", () => {
  assert.equal(findListingByAddress("407 Kanell Drive NW, High River"), null); // wrong quadrant
  assert.equal(findListingByAddress("409 Kanell Drive NE, High River"), null); // wrong number
  assert.equal(findListingByAddress("3223 83 Street NW, Calgary"), null); // the building, not a unit
  assert.equal(findListingByAddress("Kanell Drive NE"), null); // no number
  assert.equal(findListingByAddress(""), null);
});

test("a lead from a lead-source email is linked to the listing it asks about", () => {
  const source = intake.sourceForSender("noreply@rew.ca")!;
  const made = intake.createLeadFromIntake(source, {
    name: "Christel",
    email: "christel@example.com",
    phone: null,
    message: "About: 407 Kanell Drive NE, High River, AB, T1V 1J6",
    property: "407 Kanell Drive NE, High River, AB, T1V 1J6",
  });
  assert.equal(storage.getLead(made.leadId)!.listingId, "A2351995");
});
