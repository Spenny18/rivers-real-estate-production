import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-alerts-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.TWILIO_ACCOUNT_SID = "AC123";
process.env.TWILIO_AUTH_TOKEN = "tok";
process.env.TWILIO_FROM_NUMBER = "+15876025820";
process.env.AGENT_CELL_NUMBER = "+14039669237";
process.env.PUBLIC_ORIGIN = "https://riversrealestate.ca";
delete process.env.FUB_API_KEY;

// A fake Twilio: records every text and says yes.
const sent: Array<{ to: string; body: string }> = [];
let sidN = 0;
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).includes("api.twilio.com")) {
    const p = new URLSearchParams(init.body);
    sent.push({ to: p.get("To")!, body: p.get("Body")! });
    return new Response(JSON.stringify({ sid: `SM${++sidN}` }), { status: 201 });
  }
  return new Response("{}", { status: 404 });
}) as any;

const { storage, sqlite } = await import("../server/storage");
await import("../server/contacts");
const la = await import("../server/lead-alerts");
const { mergeContactInto } = await import("../server/contacts");

beforeEach(() => {
  sent.length = 0;
  sqlite.exec(`DELETE FROM new_lead_texts`);
  la.saveAlertSettings({ enabled: true, quietHours: false });
});

const settle = () => new Promise((r) => setTimeout(r, 30));

test("the alert names the lead, their number, source and message, and links to them", () => {
  const b = la.alertBody({ name: "Jane Doe", phone: "403-555-0100", email: "jane@x.test", source: "Website · Contact", message: "Is   the Aspen Woods home still available?", contactId: "app-1" });
  const lines = b.split("\n");
  assert.equal(lines[0], "New lead · Website · Contact");
  assert.match(lines[1], /^Jane Doe · .*403.*555.*0100.* · jane@x\.test$/);
  assert.equal(lines[2], '"Is the Aspen Woods home still available?"');
  assert.equal(lines[3], "https://riversrealestate.ca/admin/crm?contact=app-1");
  assert.equal(lines[4], 'Text them: reply "4035550100: your message"');
  assert.match(la.alertBody({ name: "X", phone: null, email: null, source: null, again: true }), /^Enquiry again/);
});

test("quiet hours are 10 pm to 7 am Calgary time, and held alerts wait for 7 am", () => {
  // Read through the same time-zone rules the app uses, whatever Calgary's offset is that day.
  const calgary = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const night = new Date("2026-11-04T05:30:00Z"); // late evening Nov 3 in Calgary
  assert.ok(calgary(night) >= "22:00" || calgary(night) < "07:00");
  assert.equal(la.inQuietHours(night), true);
  assert.equal(la.inQuietHours(new Date("2026-11-04T18:00:00Z")), false); // midday
  const morning = la.nextMorning(night);
  assert.equal(calgary(morning), "07:00");
  assert.ok(morning > night && morning.getTime() - night.getTime() < 12 * 3600_000);
});

test("a new enquiry texts the cell from the business line, once", async () => {
  const lead = storage.createLead({ name: "Jane Doe", email: "jane@x.test", phone: "4035550100", message: "Hi", source: "Website · Contact" } as any);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "+14039669237");
  assert.match(sent[0].body, /^New lead · Website · Contact\nJane Doe/);
  assert.equal(la.alertRow(`lead:${lead.id}`).status, "sent");
  // The same key never sends twice.
  assert.equal(await la.queueAlert(`lead:${lead.id}`, { name: "x", phone: null, email: null, source: null }), "duplicate");
  // A second enquiry from the same person is flagged as a repeat.
  storage.createLead({ name: "Jane Doe", email: "jane@x.test", phone: "4035550100", message: "Again", source: "Website · Contact" } as any);
  await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /^Enquiry again/);
});

test("switched off, nothing is sent", async () => {
  la.saveAlertSettings({ enabled: false });
  assert.equal(await la.queueAlert("lead:off", { name: "x", phone: null, email: null, source: null }), "off");
  assert.equal(sent.length, 0);
});

test("with quiet hours on, a lead at night waits until 7 am", async () => {
  la.saveAlertSettings({ quietHours: true });
  const night = new Date("2026-11-04T05:30:00Z");
  assert.equal(await la.queueAlert("lead:night", { name: "Night Owl", phone: null, email: null, source: null }, night), "held");
  assert.equal(sent.length, 0);
  await la.flushAlerts(new Date("2026-11-04T09:00:00Z")); // 2 am: still waiting
  assert.equal(sent.length, 0);
  await la.flushAlerts(new Date("2026-11-04T14:05:00Z")); // 7:05 am
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Night Owl/);
  assert.equal(la.alertRow("lead:night").status, "sent");
});

test("a burst of leads becomes one summary text", async () => {
  const now = new Date();
  for (let i = 0; i < 9; i++) await la.queueAlert(`lead:b${i}`, { name: `Person ${i}`, phone: null, email: null, source: null }, now);
  assert.equal(sent.length, 6);
  assert.equal(la.alertRow("lead:b8").status, "burst");
  await la.flushAlerts(now);
  assert.equal(sent.length, 7);
  assert.match(sent[6].body, /^3 more new leads: Person 6, Person 7, Person 8/);
  assert.equal(la.alertRow("lead:b7").status, "summarized");
});

test("people only Follow Up Boss has alert once; the FUB copy of an app lead doesn't alert again", async () => {
  const now = new Date();
  const t = (mins: number) => new Date(now.getTime() + mins * 60_000).toISOString();
  const row = (id: string, name: string, email: string, created: string) => ({
    fubId: id, name, firstName: null, lastName: null, email, phone: null, stage: "Lead", source: "ReferralExchange", assignedTo: null,
    tags: "[]", fubCreatedAt: created, fubUpdatedAt: created, lastActivityAt: null, raw: "{}", syncedAt: created,
  });
  // Created before alerts were (re)enabled: ignored.
  storage.upsertCrmContacts([row("900", "Old Lead", "old@x.test", "2020-01-01T00:00:00.000Z")]);
  // A new FUB-only lead.
  storage.upsertCrmContacts([row("901", "Rita Referral", "rita@x.test", t(1))]);
  assert.equal(await la.alertForSyncedContacts(new Date(now.getTime() + 2 * 60_000)), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Rita Referral/);
  assert.match(sent[0].body, /ReferralExchange \(via Follow Up Boss\)/);
  assert.equal(await la.alertForSyncedContacts(new Date(now.getTime() + 3 * 60_000)), 0);

  // An app lead, then FUB's copy of the same person arrives and is folded in.
  const lead = storage.createLead({ name: "Wes Web", email: "wes@x.test", message: "Hi", source: "Website" } as any);
  await settle();
  const appId = la.alertRow(`lead:${lead.id}`).contact_fub_id as string;
  assert.ok(appId.startsWith("app-"));
  storage.upsertCrmContacts([row("902", "Wes Web", "wes@x.test", t(2))]);
  mergeContactInto(appId, "902");
  assert.equal(la.alertRow(`lead:${lead.id}`).contact_fub_id, "902");
  const before = sent.length;
  await la.alertForSyncedContacts(new Date(now.getTime() + 4 * 60_000));
  assert.equal(sent.length, before);
});
