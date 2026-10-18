import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contact-search-"));
process.env.DB_PATH = path.join(dir, "test.db");

const { storage } = await import("../server/storage");
storage.upsertCrmContacts([
  { fubId: "6107", name: "Abid Saeed", email: "saeed.abidsaeed@gmail.com", phone: "403 399 4330", tags: "[]", raw: "{}", syncedAt: new Date().toISOString() },
  { fubId: "6108", name: "Someone Else", email: "else@example.com", phone: "(587) 111-2222", tags: "[]", raw: "{}", syncedAt: new Date().toISOString() },
]);
const find = (q: string) => storage.listCrmContacts({ q }).map((c) => c.fubId);

test("contacts are found by name, email, or phone however it's typed", () => {
  assert.deepEqual(find("abid"), ["6107"]);
  assert.deepEqual(find("saeed.abid"), ["6107"]);
  for (const q of ["4033994330", "403-399-4330", "(403) 399 4330", "399 4330", "+1 403 399 4330".replace("+1 ", "")]) {
    assert.deepEqual(find(q), ["6107"], q);
  }
  assert.deepEqual(find("5871112222"), ["6108"]);
});
