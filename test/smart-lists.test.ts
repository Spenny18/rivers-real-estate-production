import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-lists-"));
process.env.DB_PATH = path.join(dir, "test.db");

const { storage, sqlite } = await import("../server/storage");
await import("../server/sms");
await import("../server/tracking");
const sl = await import("../server/smart-lists");
const { addTask } = await import("../server/notes-tasks");

const NOW = new Date("2026-11-03T12:00:00.000Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();

function contact(id: string, o: Record<string, any>) {
  return {
    fubId: id, name: o.name ?? id, firstName: null, lastName: null, email: o.email ?? null, phone: o.phone ?? null,
    stage: o.stage ?? "Lead", source: o.source ?? null, assignedTo: null, tags: JSON.stringify(o.tags ?? []),
    fubCreatedAt: o.created ?? ago(100), fubUpdatedAt: ago(1), lastActivityAt: null, raw: "{}", syncedAt: ago(0),
  };
}
function act(uid: string, kind: string, cid: string, at: string) {
  return { uid, kind, fubId: null, contactFubId: cid, title: kind, body: null, direction: null, outcome: null, durationSeconds: null,
    occurredAt: at, dueAt: null, completed: false, assignedTo: null, raw: "{}", syncedAt: at };
}

storage.upsertCrmContacts([
  contact("hot-old", { name: "Hannah Hot", stage: "Hot Prospect", tags: ["Buyer", "Aspen Woods"], email: "h@x.test", source: "Zillow" }),
  contact("hot-new", { name: "Harry Hot", stage: "Hot Prospect", tags: ["buyer"], phone: "403 555 0101" }),
  contact("past", { name: "Pat Past", stage: "Past Client", tags: ["closed-2024"], email: "p@x.test" }),
  contact("fresh", { name: "Fran Fresh", stage: "Lead", created: ago(2), source: "Website · Contact" }),
  contact("sphere", { name: "Sam Sphere", stage: "Sphere" }),
]);
storage.upsertCrmActivities([
  act("call:1", "call", "hot-old", ago(20)),
  act("event:1", "event", "hot-old", ago(1)), // a website visit isn't contact
  act("text:1", "text", "hot-new", ago(3)),
  act("email:1", "email", "past", ago(200)),
]);
// The app's own channels count too.
sqlite.prepare(`INSERT INTO sms_messages (direction, kind, from_number, to_number, body, contact_fub_id, created_at) VALUES ('outbound','client','+1','+2','hi','sphere',?)`).run(ago(5));
sqlite.prepare(`INSERT INTO contact_tags (contact_fub_id, tag, created_at) VALUES ('sphere', 'VIP', ?)`).run(ago(1));

const ids = (f: any, sort?: any) => sl.runFilters(f, sort, { now: NOW }).contacts.map((c) => c.fubId);

test("stage and last contact: hot leads not contacted in 7 days", () => {
  assert.deepEqual(ids({ stages: ["hot prospect"], lastContact: { op: "older", days: 7 } }), ["hot-old"]);
  assert.deepEqual(ids({ stages: ["Hot Prospect"], lastContact: { op: "within", days: 7 } }), ["hot-new"]);
});

test("last contact comes from calls, texts and emails on either system, not website visits", () => {
  const r = sl.runFilters({}, "last_contact_desc", { now: NOW }).contacts;
  const at = Object.fromEntries(r.map((c) => [c.fubId, c.lastContactAt]));
  assert.equal(at["hot-old"], ago(20));
  assert.equal(at["sphere"], ago(5));
  assert.equal(at["fresh"], null);
  assert.deepEqual(ids({ lastContact: { op: "never" } }), ["fresh"]);
  // Never-contacted first, then longest since contact.
  assert.deepEqual(ids({}, "last_contact_asc"), ["fresh", "past", "hot-old", "sphere", "hot-new"]);
});

test("tags match FUB's and the app's, ignoring case; tagsNone excludes", () => {
  assert.deepEqual(ids({ tagsAny: ["BUYER"] }, "name").sort(), ["hot-new", "hot-old"]);
  assert.deepEqual(ids({ tagsAny: ["vip"] }), ["sphere"]);
  assert.deepEqual(ids({ stages: ["Hot Prospect"], tagsNone: ["aspen woods"] }), ["hot-new"]);
});

test("created, sources, email/phone and text search", () => {
  assert.deepEqual(ids({ created: { op: "within", days: 7 } }), ["fresh"]);
  assert.deepEqual(ids({ sources: ["zillow"] }), ["hot-old"]);
  assert.deepEqual(ids({ hasPhone: true }), ["hot-new"]);
  assert.deepEqual(ids({ hasEmail: false }, "name"), ["fresh", "hot-new", "sphere"]);
  assert.deepEqual(ids({ q: "5550101" }), ["hot-new"]);
  assert.deepEqual(ids({ q: "pat" }), ["past"]);
});

test("task filters", () => {
  addTask({ title: "Call back", dueAt: ago(1), contactId: "past" });
  addTask({ title: "Later", dueAt: new Date(NOW.getTime() + 5 * 86400_000).toISOString(), contactId: "fresh" });
  assert.deepEqual(ids({ hasOverdueTask: true }), ["past"]);
  assert.deepEqual(ids({ hasOpenTask: true }, "name"), ["fresh", "past"]);
});

test("saved lists are created, counted, edited, reordered and deleted", () => {
  const a = sl.createSmartList({ name: "Hot", filters: { stages: ["Hot Prospect"] } });
  const b = sl.createSmartList({ name: "Past", filters: { stages: ["Past Client"] }, sort: "name" });
  const counted = sl.smartListsWithCounts();
  assert.deepEqual(counted.map((l) => [l.name, l.count]), [["Hot", 2], ["Past", 1]]);
  sl.updateSmartList(a.id, { name: "Hot buyers", filters: { stages: ["Hot Prospect"], tagsAny: ["Aspen Woods"] } });
  assert.equal(sl.smartListsWithCounts()[0].count, 1);
  sl.reorderSmartLists([b.id, a.id]);
  assert.deepEqual(sl.listSmartLists().map((l) => l.name), ["Past", "Hot buyers"]);
  assert.equal(sl.deleteSmartList(a.id), true);
  assert.equal(sl.getSmartList(a.id), null);
  assert.throws(() => sl.createSmartList({ name: "", filters: {} }));
  assert.equal(sl.filtersSchema.safeParse({ nonsense: 1 }).success, false);
});

test("starter lists only use stages that exist, and are made once", () => {
  for (const l of sl.listSmartLists()) sl.deleteSmartList(l.id);
  const made = sl.seedStarterLists();
  const names = sl.listSmartLists().map((l) => l.name);
  assert.ok(made >= 4);
  assert.ok(names.includes("Hot, no contact in 7 days"));
  assert.ok(!names.includes("Nurture, no contact in 30 days")); // no Nurture stage here
  const past = sl.listSmartLists().find((l) => l.name.startsWith("Past clients"))!;
  assert.deepEqual(past.filters.stages, ["Past Client", "Sphere"]); // each stage once, whatever its case
  assert.equal(sl.seedStarterLists(), 0);
  // Not even after every list is deleted.
  for (const l of sl.listSmartLists()) sl.deleteSmartList(l.id);
  assert.equal(sl.seedStarterLists(), 0);
  const opts = sl.filterOptions();
  assert.equal(opts.stages[0].value, "Hot Prospect");
  assert.ok(opts.tags.some((t) => t.value === "VIP"));
});
