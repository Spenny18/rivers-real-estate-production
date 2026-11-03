import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contact-edits-"));
process.env.DB_PATH = path.join(dir, "test.db");
delete process.env.FUB_API_KEY; // no write-back in tests

const { storage } = await import("../server/storage");
const { editContact, applyContactOverrides, contactEditState, fubPersonBody } = await import("../server/contact-edits");
const { createNativeContact } = await import("../server/contacts");

const now = "2026-11-03T00:00:00.000Z";
function fubRow(over: Record<string, any> = {}) {
  return {
    fubId: "4242",
    name: "Jane Doe",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@old.test",
    phone: "403 555 0100",
    stage: "Lead",
    source: "Zillow",
    assignedTo: "Spencer Rivers",
    tags: JSON.stringify(["buyer"]),
    fubCreatedAt: now,
    fubUpdatedAt: now,
    lastActivityAt: now,
    raw: JSON.stringify({
      id: 4242,
      emails: [
        { value: "jane@old.test", type: "home", isPrimary: 1 },
        { value: "jane@work.test", type: "work", isPrimary: 0 },
      ],
      phones: [{ value: "403 555 0100", type: "mobile", isPrimary: 1 }],
    }),
    syncedAt: now,
    ...over,
  };
}

test("a Follow Up Boss contact can be edited, and only changed fields are kept", () => {
  storage.upsertCrmContacts([fubRow()]);
  // The form sends every field; only stage and tags differ.
  const r = editContact("4242", { name: "Jane Doe", email: "jane@old.test", phone: "403 555 0100", stage: "Hot Prospect", source: "Zillow", tags: ["buyer", "altadore"] });
  assert.deepEqual(r?.changed.sort(), ["stage", "tags"]);
  const c = storage.getCrmContact("4242")!;
  assert.equal(c.stage, "Hot Prospect");
  assert.deepEqual(JSON.parse(c.tags as any), ["buyer", "altadore"]);
  assert.deepEqual(contactEditState("4242").editedFields.sort(), ["stage", "tags"]);
  // Saving the same values again changes nothing.
  assert.deepEqual(editContact("4242", { stage: "Hot Prospect" })?.changed, []);
});

test("the sync keeps the app's edits but still brings FUB's other changes", () => {
  // FUB sends its own (older) stage and tags, and a new phone number.
  const [synced] = applyContactOverrides([fubRow({ phone: "403 555 0199", fubUpdatedAt: "2026-11-04T00:00:00.000Z" })]);
  storage.upsertCrmContacts([synced]);
  const c = storage.getCrmContact("4242")!;
  assert.equal(c.stage, "Hot Prospect");
  assert.deepEqual(JSON.parse(c.tags as any), ["buyer", "altadore"]);
  assert.equal(c.phone, "403 555 0199");
});

test("a renamed contact keeps its first and last name through the sync", () => {
  editContact("4242", { name: "Jane Smith-Doe" });
  const [synced] = applyContactOverrides([fubRow()]);
  assert.equal(synced.name, "Jane Smith-Doe");
  assert.equal(synced.firstName, "Jane");
  assert.equal(synced.lastName, "Smith-Doe");
});

test("rows without edits pass through the sync untouched", () => {
  const row = fubRow({ fubId: "999", name: "Someone Else" });
  assert.equal(applyContactOverrides([row])[0], row);
});

test("the write-back to FUB carries only the edited fields and keeps FUB's other emails", () => {
  editContact("4242", { email: "jane@new.test" });
  const c = storage.getCrmContact("4242")!;
  const body = fubPersonBody(c as any, ["email", "stage"]);
  assert.deepEqual(Object.keys(body).sort(), ["emails", "stage"]);
  assert.equal(body.emails[0].value, "jane@new.test");
  assert.equal(body.emails[0].isPrimary, true);
  assert.deepEqual(body.emails.slice(1).map((e: any) => e.value), ["jane@old.test", "jane@work.test"]);
  assert.equal(body.stage, "Hot Prospect");
  // Making an existing address primary doesn't duplicate it.
  const b2 = fubPersonBody({ ...c, email: "jane@work.test" } as any, ["email"]);
  assert.deepEqual(b2.emails.map((e: any) => e.value), ["jane@work.test", "jane@old.test"]);
  assert.equal(b2.emails[0].type, "work");
});

test("contacts added in the app are still edited in place", () => {
  const n = createNativeContact({ name: "New Lead", email: "new@lead.test" });
  const r = editContact(n.fubId, { stage: "Nurture", phone: "587 555 0123" });
  assert.deepEqual(r?.changed.sort(), ["phone", "stage"]);
  assert.equal(storage.getCrmContact(n.fubId)!.stage, "Nurture");
  assert.deepEqual(contactEditState(n.fubId).editedFields, []);
});

test("an unknown contact is reported as missing", () => {
  assert.equal(editContact("nope", { stage: "Lead" }), null);
});

test("edits are sent to Follow Up Boss with PUT, and a failure is shown without undoing the edit", async () => {
  const { pushContactToFub } = await import("../server/contact-edits");
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  process.env.FUB_API_KEY = "test-key";
  try {
    let fail = true;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return fail ? new Response("nope", { status: 500 }) : new Response("{}", { status: 200 });
    }) as any;
    editContact("4242", { source: "Referral" });
    await new Promise((r) => setTimeout(r, 20)); // the edit's own push
    const last = calls.at(-1)!;
    assert.equal(last.method, "PUT");
    assert.match(last.url, /\/v1\/people\/4242$/);
    assert.equal(last.body.source, "Referral");
    assert.match(contactEditState("4242").fubPushError ?? "", /nope/);
    assert.equal(storage.getCrmContact("4242")!.source, "Referral");

    fail = false;
    const r = await pushContactToFub("4242");
    assert.equal(r.ok, true);
    assert.equal(contactEditState("4242").fubPushError, null);
    // Nothing left to send.
    const before = calls.length;
    await pushContactToFub("4242");
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.FUB_API_KEY;
  }
});
