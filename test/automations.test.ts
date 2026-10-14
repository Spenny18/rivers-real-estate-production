import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A throwaway database, before anything opens storage. Texting/email aren't
// configured here, so nothing can actually be sent.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automations-"));
process.env.DB_PATH = path.join(dir, "test.db");
delete process.env.TWILIO_ACCOUNT_SID;

const contacts = await import("../server/contacts");
const auto = await import("../server/automations");
const { storage, sqlite } = await import("../server/storage");

const settle = () => new Promise((r) => setTimeout(r, 20));
let n = 0;
function person(extra: { phone?: string | null; email?: string | null; source?: string } = {}) {
  n += 1;
  return contacts.createNativeContact({
    name: `Pat Person${n}`,
    email: extra.email === undefined ? `pat${n}@example.com` : extra.email,
    phone: extra.phone === undefined ? "(403) 555-0100" : extra.phone,
    source: extra.source ?? "REW.ca",
  }).fubId;
}
const run = (id: number) => sqlite.prepare(`SELECT * FROM automation_runs WHERE id = ?`).get(id) as any;
const steps = (id: number) => sqlite.prepare(`SELECT * FROM automation_steps WHERE run_id = ? ORDER BY id`).all(id) as any[];

test("instant steps run straight through; an if/else takes the right branch", async () => {
  const a = auto.createAutomation({
    name: "Tagger",
    steps: [
      { id: "t1", type: "add_tag", tag: "Hot" },
      {
        id: "c1",
        type: "condition",
        check: "has_phone",
        yes: [{ id: "y1", type: "create_task", title: "Call {first_name}", dueInHours: 1 }],
        no: [{ id: "n1", type: "add_tag", tag: "No phone" }],
      },
    ],
  });
  auto.updateAutomation(a.id, { mode: "auto" });
  const c = person();
  const runId = auto.enroll(auto.getAutomation(a.id)!, c)!;
  await settle();
  assert.equal(run(runId).status, "completed");
  assert.deepEqual(auto.appTags(c), ["Hot"]);
  const task = (auto.listAppTasks() as any[]).find((t) => t.contactFubId === c);
  assert.equal(task.title, "Call Pat");
});

test("a wait holds the run until it's due", async () => {
  const a = auto.createAutomation({
    name: "Waiter",
    steps: [
      { id: "w1", type: "wait", amount: 2, unit: "days" },
      { id: "t1", type: "add_tag", tag: "Later" },
    ],
  });
  auto.updateAutomation(a.id, { mode: "auto" });
  const c = person();
  const runId = auto.enroll(auto.getAutomation(a.id)!, c)!;
  await settle();
  const r = run(runId);
  assert.equal(r.status, "active");
  assert.equal(r.step_id, "w1");
  assert.ok(new Date(r.next_at).getTime() > Date.now() + 47 * 3600_000);
  // Pretend the two days have passed.
  sqlite.prepare(`UPDATE automation_runs SET next_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), runId);
  await auto.tick();
  assert.equal(run(runId).status, "completed");
  assert.deepEqual(auto.appTags(c), ["Later"]);
});

test("in review mode a text waits for approval; skipping carries the plan on", async () => {
  const a = auto.createAutomation({
    name: "Reviewer",
    steps: [
      { id: "s1", type: "send_text", body: "Hi {first_name}, about {property}" },
      { id: "t1", type: "add_tag", tag: "After text" },
    ],
  });
  auto.updateAutomation(a.id, { mode: "review" });
  const c = person();
  const runId = auto.enroll(auto.getAutomation(a.id)!, c, { context: { property: "12 Elbow Dr SW" } })!;
  await settle();
  assert.equal(run(runId).status, "approval");
  const pending = auto.listPending().find((p) => p.runId === runId)!;
  assert.equal(pending.payload.body, "Hi Pat, about 12 Elbow Dr SW");
  assert.deepEqual(await auto.decide(pending.stepRowId, "skip"), { ok: true });
  await settle();
  assert.equal(run(runId).status, "completed");
  assert.deepEqual(auto.appTags(c), ["After text"]);
  // A second decision on the same message is refused.
  assert.equal((await auto.decide(pending.stepRowId, "send")).ok, false);
});

test("a text to someone without a phone is skipped, not stuck", async () => {
  const a = auto.createAutomation({ name: "No phone", steps: [{ id: "s1", type: "send_text", body: "Hi" }] });
  auto.updateAutomation(a.id, { mode: "review" });
  const c = person({ phone: null });
  const runId = auto.enroll(auto.getAutomation(a.id)!, c)!;
  await settle();
  assert.equal(run(runId).status, "completed");
  assert.equal(steps(runId).find((s) => s.step_id === "s1").status, "skipped");
});

test("a reply stops the plan", async () => {
  const a = auto.createAutomation({
    name: "Stopper",
    steps: [
      { id: "w1", type: "wait", amount: 1, unit: "minutes" },
      { id: "t1", type: "add_tag", tag: "Should not happen" },
    ],
  });
  auto.updateAutomation(a.id, { mode: "auto" });
  const c = person();
  const runId = auto.enroll(auto.getAutomation(a.id)!, c)!;
  await settle();
  storage.upsertCrmActivities([
    { uid: `text:test-${runId}`, kind: "text", contactFubId: c, direction: "inbound", body: "Yes please", occurredAt: new Date(Date.now() + 1000).toISOString(), completed: false, raw: "{}", syncedAt: new Date().toISOString() },
  ]);
  sqlite.prepare(`UPDATE automation_runs SET next_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), runId);
  await new Promise((r) => setTimeout(r, 1100));
  await auto.tick();
  assert.equal(run(runId).status, "stopped");
  assert.equal(run(runId).stopped_reason, "They replied");
  assert.deepEqual(auto.appTags(c), []);
});

test("a new lead starts matching new-lead plans once, filtered by source", async () => {
  const rew = auto.createAutomation({ name: "REW leads", trigger: { type: "new_lead", sources: ["REW.ca"] }, steps: [{ id: "t", type: "add_tag", tag: "REW plan" }] });
  const zil = auto.createAutomation({ name: "Zillow leads", trigger: { type: "new_lead", sources: ["Zillow"] }, steps: [{ id: "t", type: "add_tag", tag: "Zillow plan" }] });
  auto.updateAutomation(rew.id, { mode: "auto" });
  auto.updateAutomation(zil.id, { mode: "auto" });
  const lead = storage.createLead({ name: "Lee Lead", email: "lee@example.com", phone: null, message: "About: 1 Main St", source: "REW.ca", listingId: null, status: "new" });
  await settle();
  const c = contacts.findContact("lee@example.com", null)!;
  assert.deepEqual(auto.appTags(c), ["REW plan"]);
  // The same person again doesn't start it twice.
  storage.createLead({ name: "Lee Lead", email: "lee@example.com", phone: null, message: "", source: "REW.ca", listingId: null, status: "new" });
  await settle();
  assert.equal((auto.runsFor({ contactId: c }) as any[]).length, 1);
  assert.ok(lead.id);
});

test("adding a tag starts tag-triggered plans", async () => {
  const a = auto.createAutomation({ name: "On VIP", trigger: { type: "tag_added", tag: "VIP" }, steps: [{ id: "t", type: "add_tag", tag: "VIP welcomed" }] });
  auto.updateAutomation(a.id, { mode: "auto" });
  const c = person();
  auto.addTag(c, "vip");
  await settle();
  assert.deepEqual(auto.appTags(c).sort(), ["VIP welcomed", "vip"]);
});

test("turning a plan off stops everyone in it and clears their pending messages", async () => {
  const a = auto.createAutomation({ name: "Switch", steps: [{ id: "s1", type: "send_email", subject: "Hi", body: "Hello" }] });
  auto.updateAutomation(a.id, { mode: "review" });
  const runId = auto.enroll(auto.getAutomation(a.id)!, person())!;
  await settle();
  assert.equal(run(runId).status, "approval");
  auto.updateAutomation(a.id, { mode: "off" });
  assert.equal(run(runId).status, "stopped");
  assert.equal(auto.listPending().filter((p) => p.runId === runId).length, 0);
});

test("folding the app's copy of a person into FUB's carries their plans and tags", async () => {
  const a = auto.createAutomation({ name: "Fold", steps: [{ id: "w", type: "wait", amount: 1, unit: "days" }] });
  auto.updateAutomation(a.id, { mode: "auto" });
  const appId = person({ email: "fold@example.com" });
  auto.addTag(appId, "Kept");
  auto.enroll(auto.getAutomation(a.id)!, appId);
  await settle();
  storage.upsertCrmContacts([{ fubId: "9001", name: "Pat Fold", email: "fold@example.com", tags: "[]", raw: "{}", syncedAt: new Date().toISOString() }]);
  contacts.reconcileNativeContacts();
  assert.deepEqual(auto.appTags("9001"), ["Kept"]);
  assert.equal((auto.runsFor({ contactId: "9001" }) as any[]).length, 1);
});

test("problems are reported before a plan can be switched on", () => {
  assert.deepEqual(auto.validateSteps([{ id: "a", type: "send_text", body: "" }]), ["A text step has no message."]);
  assert.match(
    auto
      .validateSteps([
        { id: "c", type: "condition", check: "has_phone", yes: [], no: [] },
        { id: "t", type: "add_tag", tag: "x" },
      ])
      .join(),
    /last step/,
  );
});

test("automatic texts wait for 8 am Calgary time", () => {
  // 03:30 UTC on a summer date is 9:30 pm in Calgary (MDT, UTC−6).
  const late = new Date("2026-07-10T03:30:00Z");
  const t = auto.nextTextableTime(late);
  assert.equal(t.toISOString(), "2026-07-10T14:00:00.000Z");
  // Mid-afternoon is fine as is.
  const day = new Date("2026-07-10T20:00:00Z");
  assert.equal(auto.nextTextableTime(day).getTime(), day.getTime());
});

test("sending everything waiting for a plan clears its queue and carries each person on", async () => {
  const a = auto.createAutomation({
    name: "Release",
    steps: [
      { id: "s1", type: "send_text", body: "Hi {first_name}" },
      { id: "t1", type: "add_tag", tag: "Released" },
    ],
  });
  auto.updateAutomation(a.id, { mode: "review" });
  const c1 = person();
  const c2 = person();
  const r1 = auto.enroll(auto.getAutomation(a.id)!, c1)!;
  const r2 = auto.enroll(auto.getAutomation(a.id)!, c2)!;
  await settle();
  assert.equal(auto.listPending().filter((p) => p.automationId === a.id).length, 2);
  auto.updateAutomation(a.id, { mode: "auto" });
  // Texting isn't configured in tests, so both sends fail — but nothing is left stuck.
  const result = await auto.sendAllPending(a.id);
  assert.deepEqual(result, { sent: 0, failed: 2 });
  await settle();
  assert.equal(auto.listPending().filter((p) => p.automationId === a.id).length, 0);
  for (const [r, c] of [[r1, c1], [r2, c2]] as const) {
    assert.equal(run(r).status, "completed");
    assert.deepEqual(auto.appTags(c), ["Released"]);
  }
});

test("lead type comes from what the lead said, then from the source", () => {
  assert.equal(auto.leadTypeFor("Contact page · selling"), "seller");
  assert.equal(auto.leadTypeFor("Contact page · valuation"), "seller");
  assert.equal(auto.leadTypeFor("Home valuation widget"), "seller");
  assert.equal(auto.leadTypeFor("home_eval"), "seller");
  assert.equal(auto.leadTypeFor("Community report request"), "seller");
  assert.equal(auto.leadTypeFor("Contact page · buying"), "buyer");
  assert.equal(auto.leadTypeFor("listing_unlock"), "buyer");
  assert.equal(auto.leadTypeFor("REW.ca"), "buyer");
  // A lead email says outright, whatever the source.
  assert.equal(auto.leadTypeFor("REW.ca", "About: 1 Main St\n\n(seller lead via REW.ca)"), "seller");
  assert.equal(auto.leadTypeFor("Realtor.ca", "(renter lead via Realtor.ca)"), "renter");
});

test("buyer and seller plans each get only their own leads; 'any' gets both", async () => {
  const buyers = auto.createAutomation({ name: "Buyers", trigger: { type: "new_lead", leadType: "buyer" }, steps: [{ id: "t", type: "add_tag", tag: "B" }] });
  const sellers = auto.createAutomation({ name: "Sellers", trigger: { type: "new_lead", leadType: "seller" }, steps: [{ id: "t", type: "add_tag", tag: "S" }] });
  const any = auto.createAutomation({ name: "Any", trigger: { type: "new_lead" }, steps: [{ id: "t", type: "add_tag", tag: "A" }] });
  for (const a of [buyers, sellers, any]) auto.updateAutomation(a.id, { mode: "auto" });
  storage.createLead({ name: "Sally Seller", email: "sally@example.com", phone: null, message: "", source: "Home valuation widget", listingId: null, status: "new" });
  storage.createLead({ name: "Bob Buyer", email: "bob@example.com", phone: null, message: "About: 9 Elm St", source: "listing_unlock", listingId: null, status: "new" });
  storage.createLead({ name: "Rita Renter", email: "rita@example.com", phone: null, message: "(renter lead via Realtor.ca)", source: "Realtor.ca", listingId: null, status: "new" });
  await settle();
  const tags = (email: string) => auto.appTags(contacts.findContact(email, null)!).filter((t) => ["A", "B", "S"].includes(t)).sort();
  assert.deepEqual(tags("sally@example.com"), ["A", "S"]);
  assert.deepEqual(tags("bob@example.com"), ["A", "B"]);
  assert.deepEqual(tags("rita@example.com"), ["A"]);
});
