import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "community-report-subs-"));
process.env.DB_PATH = path.join(dir, "test.db");

const { storage, sqlite } = await import("../server/storage");
const subs = await import("../server/community-report-subs");
const { defaultReportPeriod } = await import("../server/market-report-render");

storage.upsertNeighbourhood({
  slug: "mission",
  name: "Mission",
  tagline: "Inner-city",
  heroImage: "/x.jpg",
  centerLat: 51.03,
  centerLng: -114.07,
  avgPrice: 500000,
} as any);

// Recent sales in Mission (mostly apartments, one townhouse), so it has a report scope.
const recent = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10);
storage.upsertMlsHistory(
  [1, 2, 3, 4].map((i) => ({
    id: `H${i}`,
    status: "S",
    listPrice: 400000,
    closePrice: 395000,
    closeDate: recent,
    listDate: recent,
    offMarketDate: recent,
    daysOnMarket: 20,
    propertyType: "Residential",
    propertySubType: i === 4 ? "Row/Townhouse" : "Apartment",
    city: "Calgary",
    postalCode: "T2S",
    subdivision: "Mission",
    district: null,
    fullAddress: `${i} Main St`,
    lat: null,
    lng: null,
    beds: 2,
    baths: 2,
    sqft: 900,
    yearBuilt: 2010,
    statusChangedAt: null,
    modifiedAt: null,
    syncedAt: new Date().toISOString(),
  })) as any,
);

// This month's stored report, so sending never needs a render.
const period = defaultReportPeriod();
storage.upsertMarketReport({
  period,
  kind: "subdivision",
  name: "Mission",
  city: "Calgary",
  cls: "apartment",
  title: "Mission",
  subtitle: "Apartment",
  pdfPath: `reports/${period}/mission-apartment.pdf`,
  png1Path: `reports/${period}/mission-apartment-1.png`,
  png2Path: `reports/${period}/mission-apartment-2.png`,
  png3Path: null,
  statsJson: "{}",
});

function fakeSend() {
  const sent: Array<{ to: string; subject: string; html: string; cc?: string }> = [];
  const send = async (input: any) => {
    sent.push(input);
    return { ok: true };
  };
  return { sent, send };
}

test("a contact is subscribed to a community the history can report on", () => {
  const opts = subs.optionsForNeighbourhood("mission");
  assert.ok(opts.ok);
  assert.equal(opts.ok && opts.defaultCls, "apartment");

  const r = subs.createSub({ email: " Sam@Example.com ", name: "Sam Lee", neighbourhoodSlug: "mission", cls: "apartment", crmContactId: "77" });
  assert.ok(r.ok);
  assert.equal(r.ok && r.sub.email, "sam@example.com");
  assert.equal(r.ok && r.sub.neighbourhoodName, "Mission");
  assert.equal(subs.listSubsForEmail("SAM@example.com").length, 1);

  // The same community + class again doesn't duplicate.
  const again = subs.createSub({ email: "sam@example.com", name: "Sam Lee", neighbourhoodSlug: "mission", cls: "apartment" });
  assert.ok(again.ok);
  assert.equal(subs.listSubsForEmail("sam@example.com").length, 1);
});

test("bad input is refused", () => {
  assert.equal(subs.createSub({ email: "nope", name: "X", neighbourhoodSlug: "mission", cls: "apartment" }).ok, false);
  assert.equal(subs.createSub({ email: "a@b.co", name: "X", neighbourhoodSlug: "nowhere", cls: "apartment" }).ok, false);
  // No detached sales in Mission, so detached isn't on offer.
  assert.equal(subs.createSub({ email: "a@b.co", name: "X", neighbourhoodSlug: "mission", cls: "detached" }).ok, false);
});

test("a due subscription is sent once per month, with an unsubscribe link and no CC", async () => {
  const sub = subs.listSubsForEmail("sam@example.com")[0];
  const day3 = new Date(`${new Date().toISOString().slice(0, 7)}-03T18:00:00Z`);
  assert.equal(subs.isDue(sub, day3), true);

  const { sent, send } = fakeSend();
  const r = await subs.sendSub(sub.id, { render: false, send });
  assert.equal(r.status, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "sam@example.com");
  assert.equal(sent[0].cc, "");
  assert.match(sent[0].subject, /^Mission Apartment market report/);
  assert.match(sent[0].html, /community-report\/unsubscribe\?t=/);
  assert.match(sent[0].html, /this month's Mission/);

  const after = subs.getSub(sub.id)!;
  assert.equal(after.lastSentPeriod, period);
  assert.equal(subs.isDue(after, day3), false);
});

test("nothing is due on the 1st, before last month's report exists", () => {
  const sub = { active: true, lastSentPeriod: null };
  const first = new Date(`${new Date().toISOString().slice(0, 7)}-01T19:00:00Z`);
  assert.equal(subs.isDue(sub, first), false);
});

test("without a stored report, a scheduled send waits instead of rendering", async () => {
  const r = subs.createSub({ email: "jo@example.com", name: "Jo", neighbourhoodSlug: "mission", cls: "all" });
  assert.ok(r.ok);
  const { sent, send } = fakeSend();
  const res = await subs.sendSub(r.ok ? r.sub.id : 0, { render: false, send });
  assert.equal(res.status, "waiting");
  assert.equal(sent.length, 0);
});

test("the unsubscribe token turns the subscription off; Spencer can turn it back on", () => {
  const sub = subs.listSubsForEmail("sam@example.com")[0];
  // The token is kept out of the API shape; read it the way the email does.
  const { token } = sqlite.prepare("SELECT token FROM community_report_subs WHERE id = ?").get(sub.id) as { token: string };
  assert.equal(subs.findByToken(token)?.active, true);
  const off = subs.unsubscribeByToken(token)!;
  assert.equal(off.active, false);
  assert.ok(off.unsubscribedAt);
  assert.equal(subs.isDue(off), false);
  assert.equal(subs.unsubscribeByToken("not-a-token"), null);

  const on = subs.setSubActive(sub.id, true)!;
  assert.equal(on.active, true);
  assert.equal(on.unsubscribedAt, null);
});
