import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assignMlsAliasSlugLookup,
  assignMlsLegacySeoSlugs,
  assignMlsPreviousSeoSlugs,
  assignMlsSeoSlugs,
  decodeMlsEntities,
  mlsBaseSlug,
  mlsLegacyBaseSlug,
  mlsRawBaseSlug,
  type MlsSlugSource,
} from "../shared/mls-url.js";

function listing(overrides: Partial<MlsSlugSource> = {}): MlsSlugSource {
  return {
    id: "A1000001",
    mlsNumber: "A1000001",
    fullAddress: "262 Township Road",
    subdivision: null,
    neighbourhood: null,
    city: "Rural Rocky View County",
    status: "Active",
    syncedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

// The regression that put every listing detail page into an infinite 301 loop:
// /mls/:segment resolves a request through the alias maps, and for an address
// that yields one unambiguous base slug every generator returned the SAME
// string. The canonical URL therefore looked like a legacy URL and redirected
// to itself. Whatever else changes about slug formats, an alias must never
// collide with the canonical slug of the same listing.
test("alias slugs never collide with the canonical slug", () => {
  const rows = [
    listing({ id: "A1", mlsNumber: "A1", fullAddress: "262 Township Road", subdivision: "NONE" }),
    listing({ id: "A2", mlsNumber: "A2", fullAddress: "4711 51 Avenue", city: "Camrose", subdivision: "Downtown Camrose" }),
    listing({ id: "A3", mlsNumber: "A3", fullAddress: "1405, 1010 6 Street SW", city: "Calgary", subdivision: "Beltline" }),
    listing({ id: "A4", mlsNumber: "A4", fullAddress: "12 Wilson Way", city: "Sylvan Lake", subdivision: "Wilson&#x2019;s Beach Estates" }),
  ];

  const canonical = assignMlsSeoSlugs(rows);
  const aliases = assignMlsAliasSlugLookup(rows);

  const live = new Set(canonical.values());
  for (const [slug, id] of aliases) {
    assert.ok(
      !live.has(slug),
      `alias ${slug} (-> ${id}) is also a canonical slug — /mls/${slug} would 301 to itself`,
    );
  }
  // ...and the alias map is not simply empty, which would pass the above
  // while silently dropping every legitimate legacy redirect.
  assert.ok(aliases.size > 0, "alias lookup is empty — no legacy URL would redirect");
});


// The guard in server/index.ts is the backstop for the loop. This asserts the
// condition that guard tests: resolving a canonical slug through the alias map
// must be recognisable as "already canonical" rather than as a legacy hit.
// What the /mls/:segment handler relies on: a request for a canonical slug
// must not resolve through the alias map at all, so it falls through to SSR.
test("a canonical slug never resolves as a legacy alias", () => {
  const rows = [
    listing({ id: "A1", mlsNumber: "A1", subdivision: "NONE" }),
    listing({ id: "A2", mlsNumber: "A2", fullAddress: "4711 51 Avenue", city: "Camrose", subdivision: "Downtown Camrose" }),
  ];
  const canonical = assignMlsSeoSlugs(rows);
  const aliases = assignMlsAliasSlugLookup(rows);
  for (const slug of canonical.values()) {
    assert.equal(aliases.get(slug), undefined, `canonical ${slug} resolved as an alias`);
  }
});

// The retired formats must still be reachable, or the 301s they exist for
// silently stop working.
test("retired slug formats still redirect", () => {
  const rows = [listing({ id: "A1", mlsNumber: "A1", subdivision: "NONE" })];
  const aliases = assignMlsAliasSlugLookup(rows);
  assert.equal(
    aliases.get("262-township-road-none-rural-rocky-view-county"),
    "A1",
    "the -none- URLs live since Aug 26 no longer redirect",
  );
});

test("placeholder subdivisions do not reach the URL", () => {
  for (const placeholder of ["NONE", "none", "N/A", "Unknown", "  none  "]) {
    const slug = mlsBaseSlug(listing({ subdivision: placeholder }));
    assert.equal(
      slug,
      "262-township-road-property-rural-rocky-view-county",
      `subdivision ${JSON.stringify(placeholder)} leaked into the slug: ${slug}`,
    );
  }
});

test("a placeholder subdivision falls through to the neighbourhood", () => {
  const slug = mlsBaseSlug(listing({ subdivision: "NONE", neighbourhood: "Springbank Hill" }));
  assert.equal(slug, "262-township-road-springbank-hill-rural-rocky-view-county");
});

test("HTML entities are decoded before slugifying", () => {
  assert.equal(decodeMlsEntities("Wilson&#x2019;s Beach Estates"), "Wilson’s Beach Estates");
  assert.equal(decodeMlsEntities("Smith &amp; Co"), "Smith & Co");
  assert.equal(decodeMlsEntities("Wilson&#8217;s"), "Wilson’s");
  // Unrecognised entities are left alone rather than mangled further.
  assert.equal(decodeMlsEntities("A&notreal;B"), "A&notreal;B");
  assert.equal(decodeMlsEntities("plain text"), "plain text");

  const slug = mlsBaseSlug(listing({
    fullAddress: "12 Wilson Way",
    city: "Sylvan Lake",
    subdivision: "Wilson&#x2019;s Beach Estates",
  }));
  assert.equal(slug, "12-wilson-way-wilsons-beach-estates-sylvan-lake");
  assert.ok(!slug.includes("x2019"), `entity leaked into slug: ${slug}`);
});

test("out-of-range numeric entities are left intact", () => {
  assert.equal(decodeMlsEntities("&#x110000;"), "&#x110000;");
  assert.equal(decodeMlsEntities("&#99999999;"), "&#99999999;");
});

test("the unit-behind-street format is preserved", () => {
  const slug = mlsBaseSlug(listing({
    fullAddress: "1405, 1010 6 Street SW",
    city: "Calgary",
    subdivision: "Beltline",
  }));
  assert.equal(slug, "1010-6-street-sw-1405-beltline-calgary");
});

test("the raw and legacy formats still reproduce the URLs they exist to redirect", () => {
  const row = listing({ subdivision: "NONE" });
  // The format live between Aug 26 and this fix — the "-none-" URLs.
  assert.equal(mlsRawBaseSlug(row), "262-township-road-none-rural-rocky-view-county");
  // The format shipped before unit numbers moved behind the street.
  assert.equal(
    mlsLegacyBaseSlug(listing({ fullAddress: "1405, 1010 6 Street SW", city: "Calgary", subdivision: "Beltline" })),
    "1405-beltline-calgary",
  );
});

test("colliding addresses still get MLS-suffixed canonical slugs", () => {
  const rows = [
    listing({ id: "A1", mlsNumber: "A1", status: "Active" }),
    listing({ id: "A2", mlsNumber: "A2", status: "Sold" }),
  ];
  const canonical = assignMlsSeoSlugs(rows);
  assert.equal(canonical.get("A1"), "262-township-road-property-rural-rocky-view-county");
  assert.equal(canonical.get("A2"), "262-township-road-property-rural-rocky-view-county-a2");
});

// The clean URL a collision group's preferred listing held under the previous
// format is the one that was actually served and shared. The all-suffixed
// alias map never reproduces it, so without its own aliases ~60 live listings
// would have gone from a redirect loop straight to a 404.
test("a previous-format clean URL from a collision group still redirects", () => {
  const rows = [
    listing({ id: "A1", mlsNumber: "A1", subdivision: "NONE", status: "Active", syncedAt: "2026-09-02T00:00:00Z" }),
    listing({ id: "A2", mlsNumber: "A2", subdivision: "NONE", status: "Active", syncedAt: "2026-09-01T00:00:00Z" }),
  ];
  const aliases = assignMlsAliasSlugLookup(rows);
  // Served before the fix: A1 clean, A2 suffixed.
  assert.equal(aliases.get("262-township-road-none-rural-rocky-view-county"), "A1");
  assert.equal(aliases.get("262-township-road-none-rural-rocky-view-county-a2"), "A2");
  const canonical = new Set(assignMlsSeoSlugs(rows).values());
  for (const slug of aliases.keys()) assert.ok(!canonical.has(slug), `${slug} is both alias and canonical`);
});
