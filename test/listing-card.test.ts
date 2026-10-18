import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-card-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.PUBLIC_ORIGIN = "https://riversrealestate.ca";

const { sqlite } = await import("../server/storage");
const { emailHtml, listingFromUrl } = await import("../server/listing-card");
const { createTrackedEmail } = await import("../server/tracking");

const now = new Date().toISOString();
sqlite
  .prepare(
    `INSERT INTO mls_listings (id, mls_number, list_price, full_address, city, province, beds, baths, status, hero_image, synced_at, created_at)
     VALUES ('A2351995', 'A2351995', 170000, '407 kanell Drive NE', 'High River', 'AB', 4, 1, 'Active', '/api/mls/A2351995/photo/0', ?, ?)`,
  )
  .run(now, now);

const body = `Hi Christel,

The monthly lot fee for this unit is $990.

407 kanell Drive NE, High River, AB · $170K · 4 bd · 1 ba
https://riversrealestate.ca/mls/A2351995

Spencer`;

test("a listing link on its own line becomes a property card, and the address line above it goes", () => {
  const html = emailHtml(body, createTrackedEmail("christel@example.com", "407 Kanell", { kind: "crm", channel: "gmail" }));
  fs.writeFileSync(path.join(dir, "sample.html"), html);
  assert.match(html, /<table role="presentation"/);
  assert.match(html, />\$170K</);
  assert.match(html, />4 bd · 1 ba</);
  assert.match(html, />View listing</);
  assert.match(html, /<img src="https:\/\/riversrealestate\.ca\/api\/mls\/A2351995\/photo\/0"/);
  // The address now lives in the card only.
  assert.equal(html.match(/407 Kanell Drive NE, High River, AB/g)?.length, 2); // the card's address and the photo's alt text
  assert.doesNotMatch(html, /407 kanell Drive NE, High River, AB · \$170K/);
  // The rest of the message is untouched.
  assert.match(html, /The monthly lot fee for this unit is \$990\.<br>/);
  assert.match(html, /Spencer/);
  // The card's link is tracked.
  assert.match(html, /href="https:\/\/riversrealestate\.ca\/t\/c\//);
});

test("links inside a sentence, and links elsewhere, stay ordinary links", () => {
  const html = emailHtml(
    "See https://riversrealestate.ca/mls/A2351995 when you can.\nhttps://example.com/listing",
    createTrackedEmail("christel@example.com", "x", { kind: "crm", channel: "gmail" }),
  );
  assert.doesNotMatch(html, /<table role="presentation"/);
  assert.match(html, /<a href=/);
});

test("only the site's own listing pages are recognised", () => {
  assert.equal(listingFromUrl("https://riversrealestate.ca/mls/A2351995")?.mlsNumber, "A2351995");
  assert.equal(listingFromUrl("https://www.riversrealestate.ca/mls/A2351995/")?.mlsNumber, "A2351995");
  assert.equal(listingFromUrl("https://evil.example/mls/A2351995"), null);
  assert.equal(listingFromUrl("https://riversrealestate.ca/mls/NOPE"), null);
  assert.equal(listingFromUrl("https://riversrealestate.ca/blog/A2351995"), null);
});

test(`sample card written to ${dir}/sample.html`, () => {
  assert.ok(fs.existsSync(path.join(dir, "sample.html")));
});
