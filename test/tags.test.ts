import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tags-"));
process.env.DB_PATH = path.join(dir, "test.db");
delete process.env.FUB_API_KEY;

const { storage, sqlite } = await import("../server/storage");
const tags = await import("../server/tags");
const sl = await import("../server/smart-lists");
const { applyContactOverrides } = await import("../server/contact-edits");

const now = new Date().toISOString();
function contact(id: string, t: string[], o: Record<string, any> = {}) {
  return {
    fubId: id, name: o.name ?? id, firstName: null, lastName: null, email: o.email ?? `${id}@x.test`, phone: null,
    stage: o.stage ?? "Lead", source: null, assignedTo: null, tags: JSON.stringify(t),
    fubCreatedAt: now, fubUpdatedAt: now, lastActivityAt: null, raw: "{}", syncedAt: now,
  };
}
storage.upsertCrmContacts([
  contact("1", ["Buyer", "Aspen Woods"], { stage: "Hot" }),
  contact("2", ["buyer"], { stage: "Hot" }),
  contact("3", [], { stage: "Sphere" }),
]);

test("tags from both stores show together, and a new tag joins an existing spelling", () => {
  assert.equal(tags.tagContacts(["3"], ["BUYER", "  Investor  "]), 2);
  assert.deepEqual(tags.contactTags("3"), ["Buyer", "Investor"]);
  // Already has it (case-insensitively): nothing new.
  assert.equal(tags.tagContacts(["1"], ["buyer"]), 0);
  const counts = Object.fromEntries(tags.listTags().map((t) => [t.tag.toLowerCase(), t.count]));
  assert.equal(counts.buyer, 3);
  assert.equal(counts.investor, 1);
});

test("removing a Follow Up Boss tag sticks through the sync", () => {
  assert.equal(tags.untagContacts(["1"], ["aspen woods"]), 1);
  assert.deepEqual(tags.contactTags("1"), ["Buyer"]);
  // The next sync brings FUB's old tags; the override puts the edit back.
  const [synced] = applyContactOverrides([contact("1", ["Buyer", "Aspen Woods"])]);
  assert.deepEqual(JSON.parse(synced.tags), ["Buyer"]);
});

test("bulk tagging a smart list tags everyone in it", () => {
  const list = sl.createSmartList({ name: "Hot", filters: { stages: ["Hot"] } });
  const ids = sl.listMembers(list.filters).map((m) => m.fubId).sort();
  assert.deepEqual(ids, ["1", "2"]);
  assert.equal(tags.tagContacts(ids, ["Spring 2027"]), 2);
  assert.equal(sl.runFilters({ tagsAny: ["spring 2027"] }).total, 2);
  // List rows show both stores' tags.
  const row = sl.runFilters({ stages: ["Hot"] }, "name").contacts.find((c) => c.fubId === "2")!;
  assert.deepEqual(JSON.parse(row.tags!).sort(), ["Spring 2027", "buyer"]);
});

test("renaming merges into an existing tag and changes every contact", () => {
  assert.equal(tags.renameTag("Spring 2027", "Investor"), 2);
  assert.deepEqual(tags.contactTags("1"), ["Buyer", "Investor"]);
  assert.deepEqual(tags.contactTags("2"), ["buyer", "Investor"]);
  assert.equal(tags.listTags().find((t) => t.tag === "Investor")?.count, 3);
  assert.equal(tags.listTags().some((t) => t.tag === "Spring 2027"), false);
});

test("deleting a tag removes it from both stores", () => {
  assert.equal(tags.deleteTag("buyer"), 3);
  for (const id of ["1", "2", "3"]) assert.equal(tags.contactTags(id).some((t) => t.toLowerCase() === "buyer"), false);
  assert.equal((sqlite.prepare(`SELECT COUNT(*) AS n FROM contact_tags WHERE lower(tag) = 'buyer'`).get() as { n: number }).n, 0);
});
