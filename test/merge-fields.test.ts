import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-fields-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.PUBLIC_ORIGIN = "https://riversrealestate.ca";
process.env.TWILIO_FROM_NUMBER = "+15876025820";

const { sqlite, storage } = await import("../server/storage");
const contacts = await import("../server/contacts");
const mf = await import("../server/merge-fields");

const now = new Date().toISOString();
sqlite
  .prepare(
    `INSERT INTO mls_listings (id, mls_number, list_price, full_address, city, province, beds, baths, status, synced_at, created_at)
     VALUES ('A2351995', 'A2351995', 170000, '407 kanell Drive NE', 'High River', 'AB', 4, 1, 'Active', ?, ?)`,
  )
  .run(now, now);

// A contact synced from Follow Up Boss, with an address and a custom field.
storage.upsertCrmContacts([
  {
    fubId: "6200",
    name: "Christel Vance",
    firstName: "Christel",
    lastName: "Vance",
    email: "christel@example.com",
    phone: "403-990-3153",
    stage: "Lead",
    source: "REW.ca",
    tags: "[]",
    raw: JSON.stringify({
      addresses: [{ street: "12 Elbow Dr SW", city: "Calgary", state: "AB", code: "T2S 1A1", country: "Cal Zone Sw" }],
      customBirthday: "1985-05-03",
      customSpouseName: "Mark",
    }),
    syncedAt: now,
  },
]);
sqlite
  .prepare(`INSERT INTO custom_fields (key, label, type, source, fub_name, created_at) VALUES (?, ?, ?, 'fub', ?, ?)`)
  .run("custom_birthday", "Birthday", "date", "customBirthday", now);
sqlite
  .prepare(`INSERT INTO custom_fields (key, label, type, source, fub_name, created_at) VALUES (?, ?, ?, 'fub', ?, ?)`)
  .run("custom_spouse_name", "Spouse Name", "text", "customSpouseName", now);
storage.createLead({
  name: "Christel Vance",
  email: "christel@example.com",
  phone: null,
  message: "About: 407 Kanell Drive NE, High River, AB, T1V 1J6\n\nHow much is the lot rent?",
  source: "REW.ca",
  listingId: null,
  status: "new",
});

test("contact, address, agent and company fields fill in", () => {
  const out = mf.renderMerge(
    "{contact_first_name} {contact_last_name} · {contact_phone} · {contact_email} · {contact_address} · {contact_city} · {company_name} · {agent_name} · {agent_phone} · {agent_mobile_phone} · {sender_first_name}",
    "6200",
  );
  assert.equal(
    out,
    "Christel Vance · 403-990-3153 · christel@example.com · 12 Elbow Dr SW, Calgary, AB T2S 1A1 · Calgary · Rivers Real Estate · Spencer Rivers · (587) 602-5820 · (403) 966-9237 · Spencer",
  );
});

test("the inquiry address and its link come from their latest enquiry", () => {
  assert.equal(mf.renderMerge("{inquiry_address}", "6200"), "407 Kanell Drive NE, High River, AB");
  assert.match(mf.renderMerge("{inquiry_address_url}", "6200"), /^https:\/\/riversrealestate\.ca\/mls\//);
  assert.equal(mf.renderMerge("{lead_source}", "6200"), "REW.ca");
});

test("Follow Up Boss custom fields fill in, dates written out", () => {
  assert.equal(mf.renderMerge("{custom_spouse_name}, born {custom_birthday}", "6200"), "Mark, born May 3, 1985");
});

test("fields added in the app can be set per contact and win over Follow Up Boss's", () => {
  const r = mf.addCustomField("Preferred Neighbourhood");
  assert.deepEqual(r, { key: "custom_preferred_neighbourhood" });
  assert.ok("error" in mf.addCustomField("Preferred neighbourhood")); // same key
  mf.setContactField("6200", "custom_preferred_neighbourhood", "Aspen Woods");
  mf.setContactField("6200", "custom_spouse_name", "Marcus");
  assert.equal(mf.renderMerge("{custom_preferred_neighbourhood} / {custom_spouse_name}", "6200"), "Aspen Woods / Marcus");
  assert.ok(mf.mergeFieldCatalog().some((f) => f.token === "custom_preferred_neighbourhood" && f.group === "Custom"));
  assert.equal(mf.deleteCustomField("custom_birthday"), false); // Follow Up Boss's can't be removed here
  assert.equal(mf.deleteCustomField("custom_preferred_neighbourhood"), true);
});

test("empty fields: blank, or the fallback after |; old names keep their old defaults", () => {
  const bare = contacts.createNativeContact({ name: "", email: "bare@example.com" }).fubId;
  assert.equal(mf.renderMerge("Hi {contact_first_name},", bare), "Hi ,");
  assert.equal(mf.renderMerge("Hi {contact_first_name|there},", bare), "Hi there,");
  assert.equal(mf.renderMerge("Hi {first_name}, about {property}", bare), "Hi there, about the property");
});

test("unknown fields are reported and left as typed", () => {
  assert.deepEqual(mf.unknownFields("Hi {contact_frist_name} and {contact_phone}"), ["contact_frist_name"]);
  assert.equal(mf.renderMerge("{contact_frist_name}", "6200"), "{contact_frist_name}");
  assert.deepEqual(mf.unknownFields("Old ones still fine: {first_name} {property} {agent_first_name}"), []);
});

test("custom field keys are made from labels", () => {
  assert.equal(mf.customKeyFor("Kid Name(s)"), "custom_kid_names");
  assert.equal(mf.customKeyFor("Condo Doc Review Condition Date"), "custom_condo_doc_review_condition_date");
});
