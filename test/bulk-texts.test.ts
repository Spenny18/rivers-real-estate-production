import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-texts-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "token";
process.env.TWILIO_FROM_NUMBER = "+15876025820";
process.env.AGENT_CELL_NUMBER = "+14035550000";

// Twilio, faked: every send succeeds with a new sid, except to numbers that replied STOP on Twilio's side.
const sent: Array<{ to: string; body: string }> = [];
const twilioBlocked = new Set<string>();
globalThis.fetch = (async (_url: string, init: any) => {
  const p = new URLSearchParams(init.body);
  const to = p.get("To")!;
  if (twilioBlocked.has(to)) return new Response(JSON.stringify({ code: 21610, message: "Attempt to send to unsubscribed recipient" }), { status: 400 });
  sent.push({ to, body: p.get("Body")! });
  return new Response(JSON.stringify({ sid: `SM${sent.length}` }), { status: 201 });
}) as any;

const contacts = await import("../server/contacts");
const sms = await import("../server/sms");
const bulk = await import("../server/bulk-texts");
const { sqlite } = await import("../server/storage");

const noon = new Date("2026-10-20T18:00:00Z"); // noon in Calgary
const night = new Date("2026-10-21T05:00:00Z"); // 11 pm in Calgary

function person(name: string, phone: string | null, stage = "Lead", source = "REW.ca") {
  return contacts.createNativeContact({ name, phone, email: `${name.split(" ")[0].toLowerCase()}@example.com`, stage, source }).fubId;
}

const ann = person("Ann Avery", "(403) 555-0101", "Past Client");
const bob = person("Bob Brown", "403-555-0102", "Past Client");
const cat = person("Cat Cole", null, "Past Client");
const dup = person("Dee Dupe", "+1 403 555 0101", "Past Client");
const eve = person("Eve Evans", "4035550105", "Past Client");
const lead = person("Lou Lead", "4035550106", "Lead");
const noname = person("", "4035550107", "Past Client");

test("STOP and START replies opt people out and back in", async () => {
  assert.equal(sms.optKeyword("STOP"), "stop");
  assert.equal(sms.optKeyword(" Unsubscribe. "), "stop");
  assert.equal(sms.optKeyword("please stop texting me so much"), null);
  assert.equal(sms.optKeyword("start"), "start");
  await sms.handleInboundSms("+14035550105", "Stop", "SMin1");
  assert.equal(sms.isOptedOut("(403) 555-0105"), true);
  const r = await sms.sendSms("4035550105", "hi", { kind: "client" });
  assert.equal(r.ok, false);
  await sms.handleInboundSms("+14035550105", "START", "SMin2");
  assert.equal(sms.isOptedOut("4035550105"), false);
  await sms.handleInboundSms("+14035550105", "STOP", "SMin3");
});

test("the audience: filters pick people; no number, STOP and repeated numbers are marked", () => {
  assert.deepEqual(bulk.resolveAudience({}), [], "no filter picks nobody");
  const a = bulk.resolveAudience({ stages: ["past client"] });
  const by = Object.fromEntries(a.map((m) => [m.id, m.eligibility]));
  assert.equal(by[ann], "ok");
  assert.equal(by[bob], "ok");
  assert.equal(by[cat], "no_phone");
  assert.equal(by[dup], "duplicate");
  assert.equal(by[eve], "opted_out");
  assert.equal(by[lead], undefined);
  assert.equal(bulk.resolveAudience({ stages: ["Past Client"], include: [lead] }).some((m) => m.id === lead), true);
  const opts = bulk.audienceOptions();
  assert.equal(opts.stages.find((s) => s.name === "Past Client")!.count, 5, "only people with a textable number are counted");
});

test("preview fills in each person and holds anyone a field would be empty for", () => {
  const p = bulk.previewBulk("Hi {contact_first_name}, happy fall from {agent_first_name}!", [ann, noname]);
  assert.equal(p.samples[0].text.startsWith("Hi Ann, happy fall from"), true);
  assert.deepEqual(p.held.map((h) => h.id), [noname]);
  assert.equal(p.sendable, 1);
  assert.equal(bulk.previewBulk("Hi {contact_first_name|there}", [noname]).held.length, 0, "a fallback fills the gap");
  assert.deepEqual(bulk.previewBulk("Hi {contact_frist_name}", [ann]).unknownFields, ["contact_frist_name"]);
});

test("segments: 160 plain characters per text, 70 with emoji", () => {
  assert.equal(bulk.segments("a".repeat(160)), 1);
  assert.equal(bulk.segments("a".repeat(161)), 2);
  assert.equal(bulk.segments("🏡" + "a".repeat(70)), 2);
});

test("a bulk send: typo'd fields refuse; then it sends one at a time, skips, holds, and never at night", async () => {
  assert.match((bulk.startBulkText("Hi {contact_frist_name}", [ann]) as any).error, /isn't a merge field/);

  const started = bulk.startBulkText("Hi {contact_first_name}, quick market update for you.", [ann, bob, cat, dup, eve, noname]);
  assert.ok("bulk" in started);
  const id = started.bulk.id;
  // startBulkText kicks the first send right away; let it finish.
  await new Promise((r) => setTimeout(r, 50));
  sent.length = 0;
  sqlite.prepare(`UPDATE bulk_text_recipients SET status = 'queued', detail = NULL WHERE bulk_id = ? AND status = 'sent'`).run(id);

  assert.equal(await bulk.sendNext(night), false, "quiet hours: nothing goes out");
  assert.equal(sent.length, 0);

  twilioBlocked.add("+14035550102"); // Bob replied STOP on Twilio's side, not to the app
  while (await bulk.sendNext(noon));
  assert.deepEqual(sent, [{ to: "+14035550101", body: "Hi Ann, quick market update for you." }]);

  const b = bulk.getBulkText(id)!;
  const st = Object.fromEntries((b.recipients as any[]).map((r) => [r.contactId, r.status]));
  assert.deepEqual(st, { [ann]: "sent", [bob]: "failed", [cat]: "skipped", [dup]: "skipped", [eve]: "skipped", [noname]: "held" });
  assert.equal(b.status, "done");
  assert.equal(sms.isOptedOut("4035550102"), true, "Twilio's 21610 records the opt-out");

  // It's an ordinary client text: logged against Ann, so it's in her Inbox thread.
  const logged = sqlite.prepare(`SELECT contact_fub_id AS c FROM sms_messages WHERE direction = 'outbound' AND to_number = '+14035550101'`).all() as any[];
  assert.ok(logged.some((r) => r.c === ann));
});

test("cancelling stops the rest", async () => {
  const s = bulk.startBulkText("Hello {contact_first_name}", [ann, lead]) as any;
  await new Promise((r) => setTimeout(r, 50));
  // The kick sends at most one, so the other is still waiting.
  assert.equal(bulk.cancelBulkText(s.bulk.id), true);
  assert.equal(bulk.getBulkText(s.bulk.id)!.status, "cancelled");
  const before = sent.length;
  while (await bulk.sendNext(noon));
  assert.equal(sent.length, before);
});
