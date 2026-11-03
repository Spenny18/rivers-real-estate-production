import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-tasks-"));
process.env.DB_PATH = path.join(dir, "test.db");
delete process.env.FUB_API_KEY;

const { storage, sqlite } = await import("../server/storage");
const nt = await import("../server/notes-tasks");
const { writeExport, csvCell, isSecretColumn, exportSummary } = await import("../server/crm-export");

const now = new Date().toISOString();
storage.upsertCrmContacts([
  { fubId: "77", name: "Sam Lee", firstName: "Sam", lastName: "Lee", email: "sam@x.test", phone: null, stage: "Lead", source: "Zillow", assignedTo: null, tags: "[]", fubCreatedAt: now, fubUpdatedAt: now, lastActivityAt: null, raw: '{"customFoo":"bar, \\"baz\\""}', syncedAt: now },
]);

test("notes are added to a contact's history, and only the app's can be changed", () => {
  const uid = nt.addNote("77", "  Wants a walkout in Aspen Woods  ");
  const row = storage.listCrmActivities({ contactFubId: "77", limit: 10 }).find((a) => a.uid === uid)!;
  assert.equal(row.kind, "note");
  assert.equal(row.body, "Wants a walkout in Aspen Woods");
  assert.ok(storage.getCrmContact("77")!.lastActivityAt);
  assert.equal(nt.editNote(uid, "Wants a walkout"), true);
  assert.equal(nt.editNote("note:12345", "FUB's note"), false);
  assert.equal(nt.deleteNote(uid), true);
  assert.equal(storage.listCrmActivities({ contactFubId: "77", limit: 10 }).some((a) => a.uid === uid), false);
});

test("tasks are created, listed by due date, edited, completed and deleted", () => {
  const later = nt.addTask({ title: "Send CMA", dueAt: new Date(Date.now() + 3 * 86400_000).toISOString(), contactId: "77" });
  const soon = nt.addTask({ title: "Call Sam", dueAt: new Date(Date.now() - 3600_000).toISOString(), contactId: "77", note: "re: offer" });
  const general = nt.addTask({ title: "Order signs", dueAt: new Date(Date.now() + 86400_000).toISOString() });
  const open = nt.listTasks();
  assert.deepEqual(open.map((t) => t.title), ["Call Sam", "Order signs", "Send CMA"]);
  assert.equal(open[0].contactName, "Sam Lee");
  assert.equal(open[0].origin, "app");
  assert.equal(nt.listTasks({ contactId: "77" }).length, 2);
  assert.equal(nt.taskCounts().overdue, 1);

  assert.equal(nt.editTask(later, { title: "Send CMA + comps" }), true);
  assert.equal(nt.setTaskDone(soon, true), true);
  assert.deepEqual(nt.listTasks().map((t) => t.uid), [general, later]);
  assert.equal(nt.listTasks({ status: "done" })[0].uid, soon);
  assert.equal(nt.deleteTask(general), true);
  assert.equal(nt.listTasks().length, 1);
});

test("a Follow Up Boss task completed here stays completed through the sync", () => {
  const row = {
    uid: "task:9001", kind: "task", fubId: "9001", contactFubId: "77", title: "FUB task", body: null, direction: null, outcome: null,
    durationSeconds: null, occurredAt: now, dueAt: now, completed: false, assignedTo: null, raw: "{}", syncedAt: now,
  };
  storage.upsertCrmActivities([row]);
  assert.equal(nt.editTask("task:9001", { title: "nope" }), false); // FUB's can't be edited
  assert.equal(nt.setTaskDone("task:9001", true), true);
  storage.upsertCrmActivities([row]); // the sync brings it back open
  nt.applyTaskCompletions();
  assert.equal(nt.listTasks({ status: "done" }).some((t) => t.uid === "task:9001"), true);
});

test("CSV cells are quoted when they need to be, and credentials are left out", () => {
  assert.equal(csvCell('a, "b"'), '"a, ""b"""');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(isSecretColumn("password_hash"), true);
  assert.equal(isSecretColumn("refresh_token"), true);
  assert.equal(isSecretColumn("contact_fub_id"), false);
  assert.ok(exportSummary().some((t) => t.table === "crm_contacts" && t.rows === 1));
});

test("the export is a valid zip of CSVs with every contact and activity", async () => {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c) => chunks.push(c));
  const r = await writeExport(out);
  out.end();
  const zipPath = path.join(dir, "export.zip");
  fs.writeFileSync(zipPath, Buffer.concat(chunks));
  assert.ok(r.tables > 5);
  // unzip -t checks every entry's CRC and size.
  const tested = execFileSync("unzip", ["-t", zipPath]).toString();
  assert.match(tested, /No errors detected/);
  const listing = execFileSync("unzip", ["-Z1", zipPath]).toString().split("\n");
  assert.ok(listing.includes("README.txt"));
  assert.ok(listing.includes("crm_contacts.csv"));
  assert.ok(!listing.includes("users.csv") && !listing.includes("admin_sessions.csv"));
  const contacts = execFileSync("unzip", ["-p", zipPath, "crm_contacts.csv"]).toString();
  assert.match(contacts, /Sam Lee/);
  assert.match(contacts, /"\{""customFoo"":""bar, \\""baz\\""""\}"/); // raw JSON survives quoting
  const acts = execFileSync("unzip", ["-p", zipPath, "crm_activities.csv"]).toString();
  assert.match(acts, /Send CMA \+ comps/);
});

test("the export reads tables in pages, so big tables and other queries both work", async () => {
  const rows = Array.from({ length: 4500 }, (_, i) => ({
    uid: `event:bulk-${i}`, kind: "event", fubId: String(i), contactFubId: "77", title: `Viewed ${i}`, body: null, direction: null, outcome: null,
    durationSeconds: null, occurredAt: now, dueAt: null, completed: false, assignedTo: null, raw: "{}", syncedAt: now,
  }));
  storage.upsertCrmActivities(rows);
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c) => {
    chunks.push(c);
    // Another request using the database mid-export must not fail.
    sqlite.prepare("SELECT COUNT(*) FROM crm_contacts").get();
  });
  await writeExport(out);
  const zipPath = path.join(dir, "big.zip");
  fs.writeFileSync(zipPath, Buffer.concat(chunks));
  const acts = execFileSync("unzip", ["-p", zipPath, "crm_activities.csv"], { maxBuffer: 64 * 1024 * 1024 }).toString();
  assert.match(acts, /Viewed 0\r\n|Viewed 0,/);
  assert.match(acts, /Viewed 4499/);
});
