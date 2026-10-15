import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-activity-"));
process.env.DB_PATH = path.join(dir, "test.db");

const contacts = await import("../server/contacts");
await import("../server/tracking");
const { recentContactActivity } = await import("../server/dashboard-activity");
const { sqlite, storage } = await import("../server/storage");

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
function event(email: string, kind: string, minutesAgo: number, extra: { path?: string; title?: string; props?: object } = {}) {
  sqlite
    .prepare(`INSERT INTO web_events (email, kind, path, title, props, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(email, kind, extra.path ?? null, extra.title ?? null, JSON.stringify(extra.props ?? {}), ago(minutesAgo));
}

const winnie = contacts.createNativeContact({ name: "Winnie Ho", email: "winnie@example.com", phone: "(403) 555-0101", stage: "Lead" }).fubId;
contacts.createNativeContact({ name: "Roxanne W", email: "rox@example.com", stage: "Lead" });

event("winnie@example.com", "pageview", 120, { path: "/condos", title: "Calgary Luxury Condos" });
event("winnie@example.com", "email_open", 30, { title: "Are you still looking?" });
event("rox@example.com", "email_open", 5, { title: "New listings", props: { likelyAutomated: true } });
event("rox@example.com", "pageview", 60, { path: "/blog", title: "Journal" });
event("spencer@riversrealestate.ca", "pageview", 1, { path: "/", title: "Home" });
event("stranger@example.com", "email_click", 10, { title: "Market update", path: "https://riversrealestate.ca/market" });
event("winnie@example.com", "pageview", 60 * 24 * 40, { path: "/old" });

test("one row per person, newest activity first, with how many other things they did", () => {
  const rows = recentContactActivity({ days: 30 });
  const names = rows.map((r) => r.name ?? r.email);
  assert.deepEqual(names, ["stranger@example.com", "Winnie Ho", "Roxanne W"]);
  const w = rows.find((r) => r.contactFubId === winnie)!;
  assert.equal(w.kind, "open");
  assert.equal(w.label, "Opened email - Are you still looking?");
  assert.equal(w.count, 2); // the open and the condos visit; the 40-day-old visit is outside the window
  assert.equal(w.phone, "(403) 555-0101");
  assert.equal(w.stage, "Lead");
});

test("Spencer's own browsing and automated opens are left out", () => {
  const rows = recentContactActivity({ days: 30 });
  assert.ok(!rows.some((r) => r.email === "spencer@riversrealestate.ca"));
  const rox = rows.find((r) => r.name === "Roxanne W")!;
  assert.equal(rox.kind, "visit"); // the automated open 5 minutes ago didn't count
});

test("filters show only that kind of activity", () => {
  const opens = recentContactActivity({ days: 30, filter: "open" });
  assert.deepEqual(opens.map((r) => r.name), ["Winnie Ho"]);
  const clicks = recentContactActivity({ days: 30, filter: "click" });
  assert.deepEqual(clicks.map((r) => r.email), ["stranger@example.com"]);
});

test("enquiries show what they asked about", () => {
  storage.createLead({ name: "Adele G", email: "adele@example.com", phone: "(613) 555-7723", message: "About: 212-3223 83 Street NW\n\nIs it available?", source: "REW.ca", listingId: null, status: "new" });
  const rows = recentContactActivity({ days: 30, filter: "inquiry" });
  assert.equal(rows[0].name, "Adele G");
  assert.equal(rows[0].label, "Inquiry - 212-3223 83 Street NW (REW.ca)");
});
