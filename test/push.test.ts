import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
process.env.DB_PATH = path.join(dir, "test.db");
delete process.env.TWILIO_ACCOUNT_SID;

const { storage, sqlite } = await import("../server/storage");
const webpush = (await import("web-push")).default;
const push = await import("../server/push");

// A fake push service: records what would be sent; endpoints with "gone" answer 410.
const sent: Array<{ endpoint: string; payload: any; opts: any }> = [];
(webpush as any).sendNotification = async (sub: any, payload: string, opts: any) => {
  if (sub.endpoint.includes("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
  if (sub.endpoint.includes("flaky")) throw Object.assign(new Error("Server error"), { statusCode: 500, body: "try later" });
  sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
  return { statusCode: 201 };
};

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: "BNcR", auth: "tBHI" } });

beforeEach(() => {
  sent.length = 0;
  sqlite.exec(`DELETE FROM push_subscriptions; DELETE FROM push_settings; DELETE FROM push_task_sent;`);
});

test("the signing keys are made once and kept", () => {
  const a = push.vapidKeys();
  assert.match(a.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  const row = sqlite.prepare(`SELECT value FROM app_secrets WHERE key = 'vapid_public_key'`).get() as { value: string };
  assert.equal(row.value, a.publicKey);
  assert.equal(push.vapidKeys().publicKey, a.publicKey);
});

test("a notification goes to every device, signed, with its link", async () => {
  push.saveSubscription(sub("https://web.push.apple.com/abc"), "iPhone · Home Screen app");
  push.saveSubscription(sub("https://fcm.googleapis.com/def"), "Mac · Chrome");
  const r = await push.notify("lead", { title: "New lead: Jane", body: "Zillow", url: "/admin/crm?contact=1" });
  assert.deepEqual(r, { sent: 2, failed: 0 });
  assert.equal(sent[0].payload.title, "New lead: Jane");
  assert.equal(sent[0].payload.url, "/admin/crm?contact=1");
  assert.equal(sent[0].opts.vapidDetails.publicKey, push.vapidKeys().publicKey);
  assert.equal(sent[0].opts.urgency, "high");
  assert.deepEqual(push.listDevices().map((d) => d.service), ["Apple (iPhone, iPad or Mac)", "Chrome"]);
});

test("a kind switched off sends nothing; the others still do", async () => {
  push.saveSubscription(sub("https://web.push.apple.com/abc"), null);
  push.savePushSettings({ email: false });
  assert.equal(push.pushSettings().email, false);
  assert.equal(push.pushSettings().lead, true);
  assert.deepEqual(await push.notify("email", { title: "x", body: "y" }), { sent: 0, failed: 0 });
  assert.equal((await push.notify("text", { title: "x", body: "y" })).sent, 1);
});

test("a device that's gone is dropped; a failing one keeps its error", async () => {
  push.saveSubscription(sub("https://web.push.apple.com/gone"), null);
  push.saveSubscription(sub("https://web.push.apple.com/flaky"), null);
  const r = await push.notify("lead", { title: "x", body: "y" });
  assert.deepEqual(r, { sent: 0, failed: 2 });
  const devices = push.listDevices();
  assert.deepEqual(devices.map((d) => d.endpoint), ["https://web.push.apple.com/flaky"]);
  assert.match(devices[0].lastError ?? "", /try later/);
});

test("tasks coming due notify once", async () => {
  push.saveSubscription(sub("https://web.push.apple.com/abc"), null);
  const now = new Date("2026-11-03T20:00:00.000Z");
  const mk = (uid: string, dueMins: number, completed = false) => ({
    uid, kind: "task", fubId: null, contactFubId: null, title: `Do ${uid}`, body: null, direction: null, outcome: null, durationSeconds: null,
    occurredAt: now.toISOString(), dueAt: new Date(now.getTime() + dueMins * 60_000).toISOString(), completed, assignedTo: null, raw: "{}", syncedAt: now.toISOString(),
  });
  storage.upsertCrmActivities([mk("task:app-task-a", -3), mk("task:app-task-b", 120), mk("task:app-task-c", -2, true), mk("task:app-task-d", -600)]);
  assert.equal(await push.pushDueTasks(now), 1); // only a: b is later, c is done, d is long past
  assert.equal(sent[0].payload.body, "Do task:app-task-a");
  assert.equal(sent[0].payload.url, "/admin/crm?tab=tasks");
  assert.equal(await push.pushDueTasks(new Date(now.getTime() + 60_000)), 0);
});

test("a new lead pushes, even with the text alerts off", async () => {
  push.saveSubscription(sub("https://web.push.apple.com/abc"), null);
  await import("../server/contacts");
  const la = await import("../server/lead-alerts");
  la.saveAlertSettings({ enabled: false });
  storage.createLead({ name: "Paula Push", email: "paula@x.test", message: "Hi there", source: "Website · Contact" } as any);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "New lead: Paula Push");
  assert.match(sent[0].payload.body, /Website · Contact · Hi there/);
  assert.match(sent[0].payload.url, /^\/admin\/crm\?contact=app-/);
});
