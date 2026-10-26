import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-fix-alt-"));
process.env.DB_PATH = path.join(dir, "test.db");
const { groupMetaAlternatives, appliedStatus } = await import("../server/seo-store");

const blog = (index: number, title: string | null, variantGroup?: string, extra: object = {}) => ({
  index,
  variantGroup,
  op: { type: "edit_blog", slug: "calgary-luxury-penthouses", title, excerpt: null, ...extra },
});

test("an untagged title change joins the other titles for the same post", () => {
  // Fix #36: alternatives 5 and 6 were tagged, 7 wasn't.
  const g = "penthouse-meta:calgary-luxury-penthouses";
  const changes = groupMetaAlternatives([
    blog(4, null, undefined, { bodyEdits: [{ find: "a", replace: "b" }] }),
    blog(5, "Eau Claire to East Village", g),
    blog(6, "The Cost of Ownership", g),
    blog(7, "Listings 48h Early"),
  ]);
  assert.equal(changes[0].variantGroup, undefined, "a body-only edit is not an alternative");
  assert.deepEqual(changes.slice(1).map((c) => c.variantGroup), [g, g, g]);
});

test("untagged title changes on one page are grouped; other pages are separate", () => {
  const changes = groupMetaAlternatives([
    { index: 0, op: { type: "set_meta", path: "/condos", title: "A", description: null } },
    { index: 1, op: { type: "set_meta", path: "/condos", title: "B", description: null } },
    { index: 2, op: { type: "set_meta", path: "/neighbourhoods", title: "C", description: null } },
  ]);
  assert.equal(changes[0].variantGroup, "meta:/condos");
  assert.equal(changes[1].variantGroup, "meta:/condos");
  assert.equal(changes[2].variantGroup, undefined);
});

test("unpicked alternatives don't make a fix partly applied", () => {
  const changes = [
    { index: 0, applied: true },
    { index: 1, applied: true, variantGroup: "g" },
    { index: 2, variantGroup: "g" },
    { index: 3, variantGroup: "g" },
  ];
  assert.equal(appliedStatus(changes), "applied");
});

test("a failed or skipped change still makes it partly applied", () => {
  assert.equal(appliedStatus([{ index: 0, applied: true }, { index: 1, applied: false }]), "partially_applied");
  assert.equal(appliedStatus([{ index: 0, applied: true }, { index: 1 }]), "partially_applied");
  // A group with nothing picked is something left out.
  assert.equal(appliedStatus([{ index: 0, applied: true }, { index: 1, variantGroup: "g" }, { index: 2, variantGroup: "g" }]), "partially_applied");
  assert.equal(appliedStatus([{ index: 0 }, { index: 1 }]), "ready");
});
