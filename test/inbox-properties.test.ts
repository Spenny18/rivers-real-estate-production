import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-properties-"));
process.env.DB_PATH = path.join(dir, "test.db");

const { contactProperties } = await import("../server/inbox");

const listing = (mls: string, address: string) => ({
  source: "mls" as const,
  mlsNumber: mls,
  address,
  summary: "$1.2M · 4 bd · 3 ba",
  price: 1_200_000,
  url: `https://riversrealestate.ca/mls/${mls}`,
  photoUrl: null,
});

test("one entry per listing, with every reason it's there, newest connection first", () => {
  const a = listing("A1000001", "18 Park Pt SW, Calgary, AB");
  const b = listing("A1000002", "40 Aspen Ridge Way SW, Calgary, AB");
  const out = contactProperties({
    favorites: [{ ...a, savedAt: "2026-10-01T12:00:00Z" }],
    showings: [
      { listing: a, at: "2026-10-10T20:00:00Z" },
      { listing: b, at: "2026-10-05T20:00:00Z" },
    ],
    views: [],
    deals: [],
    inquiries: [],
  });
  assert.deepEqual(
    out.map((p) => p.mlsNumber),
    ["A1000001", "A1000002"],
  );
  assert.deepEqual(out[0].reasons, ["Saved", "Showing Oct 10"]);
  assert.equal(out[0].lastAt, "2026-10-10T20:00:00Z");
  assert.equal(out[0].url, "https://riversrealestate.ca/mls/A1000001");
});

test("listings that can't be found are left out", () => {
  const out = contactProperties({
    favorites: [{ ...listing("A1"), source: "unknown" as const, savedAt: "2026-10-01T00:00:00Z" }] as any,
    showings: [],
    views: [{ mlsNumber: "NOPE123", at: "2026-10-02T00:00:00Z" }],
    deals: [{ mlsNumber: "NOPE456", at: "2026-10-03T00:00:00Z" }],
    inquiries: [{ listingId: "NOPE789", at: "2026-10-04T00:00:00Z" }],
  });
  assert.deepEqual(out, []);
});
