import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-signature-"));
process.env.DB_PATH = path.join(dir, "test.db");

const { signatureText, withSignature } = await import("../server/gmail-signature");
const { emailHtml } = await import("../server/listing-card");
const { createTrackedEmail } = await import("../server/tracking");

// Shaped like a Blinq signature: a spacer ".", then a linked card image.
const sigHtml =
  `<div dir="ltr"><img src="https://card.example/px" alt="" height="1" width="1">` +
  `<table><tbody><tr><td style="color:white">.</td></tr><tr><td><a href="https://card.example/me">` +
  `<img width="540" alt="View my contact details here: https://card.example/me" src="https://card.example/card.png"></a></td></tr></tbody></table></div>`;

test("the plain-text version keeps what the picture says and drops spacers", () => {
  assert.equal(signatureText(sigHtml), "View my contact details here: https://card.example/me");
  assert.equal(signatureText("<div>Spencer Rivers<br>Rivers Real Estate<br>(403) 966-9237</div>"), "Spencer Rivers\nRivers Real Estate\n(403) 966-9237");
});

test("the signature goes on both parts, after the message", () => {
  const sig = { html: sigHtml, text: signatureText(sigHtml) };
  const out = withSignature({ text: "Hi Christel,\n\nSee you Saturday.\n", html: "<html><body><div>Hi</div></body></html>" }, sig);
  assert.equal(out.text, "Hi Christel,\n\nSee you Saturday.\n\nView my contact details here: https://card.example/me");
  assert.match(out.html!, /<div>Hi<\/div><div style="margin-top:16px;"><div dir="ltr">.*<\/div><\/body>/s);
});

test("its links aren't rewritten by open/click tracking", () => {
  const tracked = emailHtml("Hi there", createTrackedEmail("c@example.com", "s", { kind: "crm", channel: "gmail" }));
  const out = withSignature({ text: "Hi there", html: tracked }, { html: sigHtml, text: "x" });
  assert.match(out.html!, /href="https:\/\/card\.example\/me"/);
  // The email's own open pixel is still there.
  assert.match(out.html!, /\/t\/o\//);
});

test("no signature, no change; no HTML part, one is made so the picture shows", () => {
  const plain = { text: "Hi" };
  assert.deepEqual(withSignature(plain, null), plain);
  const made = withSignature({ text: "Hi <there>" }, { html: sigHtml, text: "x" });
  assert.match(made.html!, /Hi &lt;there&gt;/);
  assert.match(made.html!, /card\.example\/card\.png/);
});
