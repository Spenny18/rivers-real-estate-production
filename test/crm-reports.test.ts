import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-reports-"));
process.env.DB_PATH = path.join(dir, "test.db");

const { storage } = await import("../server/storage");
const { buildReport } = await import("../server/crm-reports");

const NOW = new Date("2026-11-03T18:00:00.000Z");
const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();
const DAYS = 24 * 60;

function contact(id: string, source: string, stage: string, createdMins: number) {
  return { fubId: id, name: id.toUpperCase(), firstName: null, lastName: null, email: null, phone: null, stage, source, assignedTo: null,
    tags: "[]", fubCreatedAt: at(createdMins), fubUpdatedAt: at(0), lastActivityAt: null, raw: "{}", syncedAt: at(0) };
}
let n = 0;
function act(kind: string, dir: string, cid: string, mins: number) {
  return { uid: `${kind}:t${++n}`, kind, fubId: null, contactFubId: cid, title: kind, body: null, direction: dir, outcome: null,
    durationSeconds: null, occurredAt: at(mins), dueAt: null, completed: false, assignedTo: null, raw: "{}", syncedAt: at(0) };
}

storage.upsertCrmContacts([
  contact("a", "Zillow", "Active Client", -3 * DAYS),       // answered in 3 minutes, now a client
  contact("b", "Zillow", "Lead", -2 * DAYS),                // answered in 2 hours
  contact("c", "Website", "Lead", -1 * DAYS),               // never contacted
  contact("d", "Referral", "Past Client", -10 * DAYS),      // answered after 2 days
  contact("old", "Zillow", "Lead", -60 * DAYS),             // outside a 30-day window
  contact("t", "Website", "Trash", -1 * DAYS),              // trash: not "waiting"
]);
storage.upsertCrmActivities([
  act("text", "outbound", "a", -3 * DAYS + 3),
  act("call", "inbound", "a", -3 * DAYS + 30),
  act("call", "outbound", "b", -2 * DAYS + 120),
  act("email", "outbound", "d", -10 * DAYS + 2 * DAYS),
  // The same email seen twice (sent from the app, mirrored back by FUB) counts once.
  act("email", "outbound", "d", -10 * DAYS + 2 * DAYS + 1),
  act("text", "inbound", "d", -5 * DAYS),
  // An outbound contact BEFORE the lead existed isn't a response.
  act("call", "outbound", "c", -1 * DAYS - 600),
  // Outside the window: not counted.
  act("call", "outbound", "old", -60 * DAYS + 5),
]);

test("summary: new leads, contacted, median response, and activity both ways", () => {
  const r = buildReport(30, NOW);
  assert.equal(r.summary.newLeads, 5);
  assert.equal(r.summary.contacted, 3);
  // Responses: 3 min, 120 min, 2880 min -> median 120.
  assert.equal(r.summary.medianResponseMinutes, 120);
  // c's early call is in the period, so it counts as a call made, but not as a response to c (contacted is 3, above).
  assert.deepEqual(r.summary.calls, { out: 2, in: 1 });
  assert.deepEqual(r.summary.texts, { out: 1, in: 1 });
  assert.deepEqual(r.summary.emails, { out: 1, in: 0 });
});

test("speed to lead buckets", () => {
  const r = buildReport(30, NOW);
  const b = Object.fromEntries(r.speed.map((s) => [s.label, s.count]));
  assert.equal(b["Within 5 minutes"], 1);
  assert.equal(b["5 to 60 minutes"], 0);
  assert.equal(b["1 to 24 hours"], 1);
  assert.equal(b["Over a day"], 1);
  assert.equal(b["Not contacted yet"], 2);
});

test("sources: leads, contacted, response and where they are now", () => {
  const r = buildReport(30, NOW);
  const z = r.sources.find((s) => s.source === "Zillow")!;
  assert.deepEqual([z.leads, z.contacted, z.nowActive], [2, 2, 1]);
  assert.equal(z.medianResponseMinutes, (3 + 120) / 2);
  assert.equal(r.sources[0].source, "Zillow"); // biggest first
  const ref = r.sources.find((s) => s.source === "Referral")!;
  assert.equal(ref.nowActive, 1); // Past Client counts
});

test("waiting: uncontacted leads, oldest first, without trash", () => {
  const r = buildReport(30, NOW);
  assert.deepEqual(r.waiting.map((w) => w.id), ["c"]);
});

test("weeks cover the period and add up", () => {
  const r = buildReport(30, NOW);
  assert.ok(r.weeks.length >= 4 && r.weeks.length <= 6);
  assert.equal(r.weeks.reduce((s, w) => s + w.newLeads, 0), 5);
  assert.equal(r.weeks.reduce((s, w) => s + w.texts, 0), 1);
  assert.ok(r.weeks.every((w, i) => i === 0 || w.week > r.weeks[i - 1].week));
});

test("a longer window takes in older leads; stages cover everyone", () => {
  assert.equal(buildReport(90, NOW).summary.newLeads, 6);
  const stages = Object.fromEntries(buildReport(30, NOW).stages.map((s) => [s.stage, s.count]));
  assert.equal(stages["Lead"], 3);
  assert.equal(stages["Active Client"], 1);
});
