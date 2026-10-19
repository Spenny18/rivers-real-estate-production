import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-attachments-"));
process.env.DB_PATH = path.join(dir, "test.db");

const att = await import("../server/email-attachments");
const { buildMime } = await import("../server/gmail");

/** The parts of a multipart body, split on its boundary. */
function parts(mime: string, boundary: string): string[] {
  return mime.split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, ""));
}

test("with attachments the message is multipart/mixed: the message, then each file", () => {
  const pdf = Buffer.from("%PDF-1.4 pretend pdf bytes \x00\x01\x02");
  const mime = buildMime("spencer@example.com", {
    to: "pat@example.com",
    subject: "Your documents",
    text: "Hi Pat,\nAttached.",
    html: "<p>Hi Pat,<br>Attached.</p>",
    attachments: [
      { filename: "Offer.pdf", contentType: "application/pdf", data: pdf },
      { filename: "Résumé du bien.txt", contentType: "text/plain", data: Buffer.from("é") },
    ],
  });
  const [head] = mime.split("\r\n\r\n");
  const mixed = head.match(/multipart\/mixed; boundary="([^"]+)"/)![1];
  const ps = parts(mime, mixed);
  assert.equal(ps.length, 3);
  assert.match(ps[0], /^Content-Type: multipart\/alternative; boundary=/);
  assert.match(ps[0], /text\/plain[\s\S]*text\/html/);

  assert.match(ps[1], /Content-Type: application\/pdf; name="Offer.pdf"/);
  assert.match(ps[1], /Content-Disposition: attachment; filename="Offer.pdf"/);
  const b64 = ps[1].split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.deepEqual(Buffer.from(b64, "base64"), pdf, "the file survives byte for byte");
  assert.ok(ps[1].split("\r\n").every((l) => l.length <= 78), "base64 lines are wrapped");

  // A non-ASCII name: an ASCII stand-in plus the exact name, RFC 2231 encoded.
  assert.match(ps[2], /filename="Re_sume_ du bien.txt"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20du%20bien.txt/);
});

test("without attachments nothing changes", () => {
  const mime = buildMime("a@example.com", { to: "b@example.com", subject: "Hi", text: "Hello" });
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.doesNotMatch(mime, /multipart/);
  const plainWithFile = buildMime("a@example.com", {
    to: "b@example.com",
    subject: "Hi",
    text: "Hello",
    attachments: [{ filename: "a.txt", contentType: "text/plain", data: Buffer.from("x") }],
  });
  assert.match(plainWithFile, /multipart\/mixed[\s\S]*text\/plain; charset="UTF-8"[\s\S]*Hello[\s\S]*filename="a.txt"/);
});

test("uploads: held by id, names cleaned, 25 MB limit, gone once sent", () => {
  assert.equal(att.cleanFilename('C:\\Users\\me\\"bad"\nname.pdf'), "badname.pdf");
  assert.equal(att.cleanFilename(""), "attachment");
  assert.deepEqual(att.holdAttachment("x.bin", "", Buffer.alloc(0)), { error: "That file is empty." });
  assert.ok("error" in att.holdAttachment("big.bin", "", Buffer.alloc(att.MAX_TOTAL_BYTES + 1)));

  const a = att.holdAttachment("a.pdf", "application/pdf", Buffer.from("aaa")) as { id: string };
  const b = att.holdAttachment("b.jpg", "not a type", Buffer.from("bbb")) as { id: string };
  const t = att.takeAttachments([a.id, b.id]) as { files: any[] };
  assert.deepEqual(t.files.map((f) => [f.filename, f.contentType]), [
    ["a.pdf", "application/pdf"],
    ["b.jpg", "application/octet-stream"],
  ]);
  assert.deepEqual(att.takeAttachments(undefined), { files: [] });
  att.releaseAttachments(t.files);
  assert.match((att.takeAttachments([a.id]) as any).error, /attach it again/);
});

test("together they can't pass Gmail's limit", () => {
  const half = Buffer.alloc(14 * 1024 * 1024);
  const x = att.holdAttachment("x", "", half) as { id: string };
  const y = att.holdAttachment("y", "", half) as { id: string };
  assert.match((att.takeAttachments([x.id, y.id]) as any).error, /25 MB/);
  assert.equal(att.dropAttachment(x.id), true);
  assert.equal(att.dropAttachment(y.id), true);
});

test("big messages go to Gmail's upload endpoint as raw RFC 822, keeping the thread", async () => {
  const { sendRequest } = await import("../server/gmail");
  const small = sendRequest("Subject: hi\r\n\r\nhello", "t1");
  assert.equal(small.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(JSON.parse(String(small.body)).threadId, "t1");

  const raw = "Subject: big\r\n\r\n" + "A".repeat(5 * 1024 * 1024);
  const big = sendRequest(raw, "t2");
  assert.equal(big.url, "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart");
  const b = big.headers["Content-Type"].match(/boundary="([^"]+)"/)![1];
  const body = String(big.body);
  assert.match(body, new RegExp(`--${b}\\r\\nContent-Type: application/json; charset=UTF-8\\r\\n\\r\\n\\{"threadId":"t2"\\}`));
  assert.ok(body.includes(`Content-Type: message/rfc822\r\n\r\n${raw}\r\n--${b}--`));
});
