import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "templates-"));
process.env.DB_PATH = path.join(dir, "test.db");

const t = await import("../server/templates");

test("Follow Up Boss's %fields% become the app's {fields}, same names", () => {
  assert.equal(
    t.fubToMergeFields("Hi %contact_first_name% this is %sender_first_name%. Offer sent for %custom_trx_address%."),
    "Hi {contact_first_name} this is {sender_first_name}. Offer sent for {custom_trx_address}.",
  );
  assert.equal(t.fubToMergeFields("50% off, 100%"), "50% off, 100%"); // not fields
});

test("a designed email becomes readable plain text, links kept", () => {
  const html = `<html><head><style>p{color:red}</style></head><body><table><tr><td><h1>Final Note</h1>
    <p>Hi %contact_first_name%,</p><p>It's been about three months&nbsp;since you reached out.</p>
    <ul><li>Guide one</li><li>Guide two</li></ul>
    <p><a href="https://riversrealestate.ca/mls">See listings</a></p></td></tr></table></body></html>`;
  assert.equal(
    t.htmlToTemplateText(html),
    "Final Note\n\nHi %contact_first_name%,\n\nIt's been about three months since you reached out.\n\n• Guide one\n• Guide two\n\nSee listings (https://riversrealestate.ca/mls)",
  );
});

test("templates can be created, edited, listed by kind, and deleted", () => {
  const a = t.createTemplate({ kind: "text", name: "Showing follow-up", body: "Hi {contact_first_name|there}, thanks for coming out to {inquiry_address}!" });
  const b = t.createTemplate({ kind: "email", name: "Market update", subject: "Your {contact_city} update", body: "Hi {contact_first_name}," });
  assert.equal(a.subject, null);
  assert.equal(b.subject, "Your {contact_city} update");
  assert.deepEqual(t.listTemplates("text").map((x) => x.name), ["Showing follow-up"]);
  assert.equal(t.updateTemplate(a.id, { body: "Thanks {contact_first_name}!" })!.body, "Thanks {contact_first_name}!");
  assert.equal(t.deleteTemplate(b.id), true);
  assert.equal(t.getTemplate(b.id), null);
});

test("a template using a field the app doesn't have is flagged", () => {
  const x = t.createTemplate({ kind: "text", name: "Old one", body: "Hi {contact_frist_name}, see {lender_name}" });
  assert.deepEqual(x.unknownFields.sort(), ["contact_frist_name", "lender_name"]);
});
