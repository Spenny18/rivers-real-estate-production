import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A throwaway database and the offline stand-in for Claude, before anything opens storage.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-intake-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.LEAD_INTAKE_FAKE = "1";

const intake = await import("../server/lead-intake");
await import("../server/contacts");
const { storage } = await import("../server/storage");

const b64 = (s: string) => Buffer.from(s).toString("base64url");

test("sources are recognised by sender domain, including subdomains", () => {
  assert.equal(intake.sourceForSender("Real Estate Works <noreply@rew.ca>")?.label, "REW.ca");
  assert.equal(intake.sourceForSender("support@em8244.referralexchange.com")?.label, "ReferralExchange");
  assert.equal(intake.sourceForSender("Pat <pat@gmail.com>"), null);
  // A lookalike domain is not the source.
  assert.equal(intake.sourceForSender("x@notrew.ca"), null);
});

test("email text keeps link addresses and isn't cut at From:/Date: lines", () => {
  const html = `<p>From: Jane Buyer</p><p>Date: Oct 13</p><a href="https://www.referralexchange.com/r/13900295">Click Here to View Referral</a>`;
  const text = intake.leadEmailText({ id: "x", payload: { mimeType: "text/html", body: { data: b64(html) } } });
  assert.match(text, /From: Jane Buyer/);
  assert.match(text, /Date: Oct 13/);
  assert.match(text, /Click Here to View Referral \(https:\/\/www\.referralexchange\.com\/r\/13900295\)/);
});

test("a clear lead becomes a lead and a contact with the source's name", async () => {
  const source = intake.sourceForSender("noreply@rew.ca")!;
  const row = await intake.processLeadEmail(source, {
    gmailId: "g1",
    from: "noreply@rew.ca",
    subject: "New homeseeker",
    body: "Name: Jane Buyer\nEmail: jane@example.com\nPhone: (403) 555-0101\nMessage: Can I see it Saturday?",
    receivedAt: new Date().toISOString(),
  });
  assert.equal(row.status, "imported");
  const lead = storage.getLead(row.leadId!)!;
  assert.equal(lead.source, "REW.ca");
  assert.equal(lead.email, "jane@example.com");
  const contact = storage.getCrmContact(row.contactFubId!)!;
  assert.equal(contact.source, "REW.ca");
});

test("the same person from the same source within a day is not a second lead", async () => {
  const source = intake.sourceForSender("noreply@rew.ca")!;
  const row = await intake.processLeadEmail(source, {
    gmailId: "g2",
    from: "noreply@rew.ca",
    subject: "Claimed homeseeker",
    body: "Name: Jane Buyer\nEmail: jane@example.com",
    receivedAt: new Date().toISOString(),
  });
  assert.equal(row.status, "duplicate");
});

test("an email with no way to reach the person waits for review, and creates nothing", async () => {
  const before = storage.listLeads().length;
  const source = intake.sourceForSender("support@referralexchange.com")!;
  const row = await intake.processLeadEmail(source, {
    gmailId: "g3",
    from: "support@referralexchange.com",
    subject: "New Buyer Referral in Calgary from ReferralExchange",
    body: "Hi Spencer, a new Buyer referral is available. Call 888-881-7520. support@referralexchange.com",
    receivedAt: new Date().toISOString(),
  });
  assert.notEqual(row.status, "imported");
  assert.equal(row.leadId, null);
  assert.equal(storage.listLeads().length, before);
});

test("older mail read as a sample creates no lead", async () => {
  const before = storage.listLeads().length;
  const source = intake.sourceForSender("noreply@zillow.com")!;
  const row = await intake.processLeadEmail(
    source,
    { gmailId: "g4", from: "noreply@zillow.com", subject: "Lead", body: "Name: Sam Seller\nEmail: sam@example.com", receivedAt: new Date().toISOString() },
    "sample",
  );
  assert.equal(row.status, "sample");
  assert.equal(storage.listLeads().length, before);
});

test("a lead with only a phone number is still a lead", () => {
  const source = intake.sourceForSender("noreply@rew.ca")!;
  const made = intake.createLeadFromIntake(source, { name: "Phone Only", email: null, phone: "(587) 555-0199", message: "" });
  assert.equal(made.duplicate, false);
  assert.equal(storage.getLead(made.leadId)!.phone, "(587) 555-0199");
});

test("a reminder about someone already in contacts is attached to them, not a new lead", async () => {
  const before = storage.listLeads().length;
  const source = intake.sourceForSender("support@referralexchange.com")!;
  const row = await intake.processLeadEmail(source, {
    gmailId: "g5",
    from: "support@referralexchange.com",
    subject: "Progress report reminder",
    body: "Progress report reminder for your referral.\nName: Jane Buyer\nEmail: jane@example.com",
    receivedAt: new Date().toISOString(),
  });
  assert.equal(row.status, "follow_up");
  assert.ok(row.contactFubId);
  assert.equal(storage.listLeads().length, before);
});

test("a reminder about someone not in contacts waits for review", async () => {
  const source = intake.sourceForSender("noreply@yelp.com")!;
  const row = await intake.processLeadEmail(source, {
    gmailId: "g6",
    from: "noreply@yelp.com",
    subject: "Reminder: Abid is waiting",
    body: "Reminder: a customer is waiting.\nName: Abid\nPhone: (403) 555-0142",
    receivedAt: new Date().toISOString(),
  });
  assert.equal(row.status, "needs_review");
  assert.equal(row.leadId, null);
});
