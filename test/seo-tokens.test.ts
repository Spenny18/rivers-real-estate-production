import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-tokens-"));
process.env.DB_PATH = path.join(dir, "test.db");
const { fillTokens, shortPrice, tokenValuesFromStats, tokensIn, supportsMetaTokens, resolveMetaOverride } =
  await import("../server/seo-tokens");

test("short prices read like a snippet", () => {
  assert.equal(shortPrice(2_005_535), "$2M");
  assert.equal(shortPrice(2_450_000), "$2.5M");
  assert.equal(shortPrice(950_400), "$950K");
});

test("placeholders fill from live stats", () => {
  const v = tokenValuesFromStats({ activeCount: 11, avgPrice: 2_005_535 });
  assert.equal(
    fillTokens("Rosedale Calgary Real Estate: {avgPriceShort} Avg - Luxury Homes Calgary", v),
    "Rosedale Calgary Real Estate: $2M Avg - Luxury Homes Calgary",
  );
  assert.equal(
    fillTokens("{activeCount} active MLS listings averaging {avgPrice}.", v),
    "11 active MLS listings averaging $2,005,535.",
  );
});

test("a field with an unfillable placeholder falls back (null)", () => {
  const none = tokenValuesFromStats({ activeCount: 0, avgPrice: 2_000_000 });
  assert.equal(fillTokens("{activeCount} homes", none), null);
  assert.equal(fillTokens("{avgPriceShort} avg", none), null, "no price without live listings");
  assert.equal(fillTokens("{activeCount} homes", tokenValuesFromStats({ activeCount: 1, avgPrice: 1 })), null);
  assert.equal(fillTokens("{bogus} homes", tokenValuesFromStats({ activeCount: 5, avgPrice: 1 })), null);
});

test("text without placeholders is untouched", () => {
  assert.deepEqual(tokensIn("Plain title"), []);
  assert.equal(fillTokens("Plain title", {}), "Plain title");
  const o = { title: "Plain", description: null };
  assert.equal(resolveMetaOverride("/condos/x", o), o);
});

test("placeholders are only for neighbourhood pages", () => {
  assert.ok(supportsMetaTokens("/neighbourhoods/rosedale"));
  assert.ok(!supportsMetaTokens("/condos/the-concord"));
  assert.ok(!supportsMetaTokens("/neighbourhoods"));
  // A page with no stats resolves the templated field to null (page default).
  assert.deepEqual(
    resolveMetaOverride("/condos/the-concord", { title: "{activeCount} homes", description: "Plain description" }),
    { title: null, description: "Plain description" },
  );
});
