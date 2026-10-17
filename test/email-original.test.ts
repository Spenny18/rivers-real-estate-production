import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-original-"));
process.env.DB_PATH = path.join(dir, "test.db");

const { renderEmailDocument } = await import("../server/email-original");

const reply = `<div>Saturday works, thanks!</div>
<div class="gmail_quote"><div>On Fri, Spencer wrote:</div><blockquote>Does Saturday work?</blockquote></div>`;

test("pictures load when allowed, and stay blocked otherwise", () => {
  const body = `<p>Hi</p><img src="https://example.com/house.jpg">`;
  assert.match(renderEmailDocument(body, new Map(), true).html, /img-src data: https: http:/);
  assert.match(renderEmailDocument(body, new Map(), false).html, /img-src data:;/);
  assert.equal(renderEmailDocument(body, new Map(), true).remoteImages, 1);
});

test("quoted earlier replies are hidden only when asked", () => {
  const hidden = renderEmailDocument(reply, new Map(), true, { hideQuoted: true }).html;
  assert.match(hidden, /\.gmail_quote[^{]*\{display:none!important\}/);
  // Still in the document, just not shown.
  assert.match(hidden, /Does Saturday work\?/);
  const full = renderEmailDocument(reply, new Map(), true).html;
  assert.doesNotMatch(full, /display:none!important/);
});

test("Apple Mail and Outlook quotes are marked so they can be hidden", () => {
  const apple = renderEmailDocument(`<p>Yes</p><blockquote type="cite">Earlier</blockquote>`, new Map(), true, { hideQuoted: true }).html;
  assert.match(apple, /<blockquote class="lhc-quote"/);
  const outlook = renderEmailDocument(`<p>Yes</p><div id="divRplyFwdMsg">From: Spencer</div><div>Earlier</div>`, new Map(), true, {
    hideQuoted: true,
  }).html;
  assert.match(outlook, /<div class="lhc-quote-start"/);
});

test("nothing in an email can run", () => {
  const html = renderEmailDocument(`<p onclick="x()">Hi</p><script>alert(1)</script>`, new Map(), true).html;
  assert.doesNotMatch(html, /<script|onclick/);
});
