// The SEO pass of Nov 2026: Search Console URL variants, "fixed, waiting on
// Google", hub-and-spoke cluster links and the neighbourhood title format.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// seo-keywords opens the database on import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-structure-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.PUBLIC_ORIGIN = "https://riversrealestate.ca";

const { mergeGscUrlVariants, derivedKeyword } = await import("../server/seo-keywords");
const { markAwaitingGoogle, sortOpportunities } = await import("../server/seo-opportunities");
const { clusterLinksFor, anchorFor } = await import("../server/cluster-links");
const { neighbourhoodPlace, neighbourhoodSeoTitle, neighbourhoodSeoDescription } = await import("../shared/neighbourhood-seo");
type Opportunity = import("../server/seo-opportunities").Opportunity;

// ---- Search Console URL variants ----

test("www, http and trailing-slash variants merge into one row per path and query", () => {
  const rows = mergeGscUrlVariants([
    { page: "https://riversrealestate.ca/", query: "spencer rivers", clicks: 9, impressions: 143, position: 7.6 },
    { page: "https://www.riversrealestate.ca/", query: "spencer rivers", clicks: 0, impressions: 100, position: 4.4 },
    { page: "https://riversrealestate.ca/neighbourhoods/mahogany", query: "mahogany calgary", clicks: 0, impressions: 23, position: 65.5 },
    { page: "http://riversrealestate.ca/neighbourhoods/mahogany/", query: "mahogany calgary", clicks: 0, impressions: 18, position: 78.4 },
    { page: "https://riversrealestate.ca/", query: "spencer rivers calgary", clicks: 5, impressions: 103, position: 4 },
  ]);
  assert.equal(rows.length, 3);
  const home = rows.find((r) => r.query === "spencer rivers")!;
  assert.equal(home.page, "https://riversrealestate.ca/");
  assert.equal(home.impressions, 243);
  assert.equal(home.clicks, 9);
  // Impression-weighted: (7.6×143 + 4.4×100) / 243
  assert.ok(Math.abs(home.position - (7.6 * 143 + 4.4 * 100) / 243) < 1e-9);
  const mahogany = rows.find((r) => r.query === "mahogany calgary")!;
  assert.equal(mahogany.page, "https://riversrealestate.ca/neighbourhoods/mahogany");
  assert.equal(mahogany.impressions, 41);
});

// ---- fixed, waiting on Google ----

const opp = (id: string, type: Opportunity["type"], paths: string[], gain: number): Opportunity => ({
  id, type, paths, category: "content", query: null, headline: id, why: "", action: "", queries: [],
  metrics: { impressions: 0, clicks: 0, ctr: 0, position: null },
  estClicksGain: gain,
  estimate: { method: "", lines: [], otherLines: 0, otherClicks: 0, subtotal: gain, factor: 1, factorReason: null },
  effort: "medium", priority: gain, quickWin: gain >= 3, basis: "search-console",
});

test("ranking tasks on recently fixed pages wait on Google and sort last; on-page tasks stay live", () => {
  const fixed = new Map([["/neighbourhoods/rosedale", { at: "2026-11-05T21:31:42.406Z", proposalId: 40 }]]);
  const list = markAwaitingGoogle([
    opp("striking_distance:/neighbourhoods/rosedale", "striking_distance", ["/neighbourhoods/rosedale"], 4.5),
    opp("image_alt:/neighbourhoods/rosedale", "image_alt", ["/neighbourhoods/rosedale"], 0.2),
    opp("striking_distance:/neighbourhoods/scarboro", "striking_distance", ["/neighbourhoods/scarboro"], 0.9),
    opp("cannibalization:/blog/x::/neighbourhoods/rosedale", "cannibalization", ["/blog/x", "/neighbourhoods/rosedale"], 0.5),
  ], fixed);
  assert.deepEqual(list[0].awaitingGoogle, { at: "2026-11-05T21:31:42.406Z", proposalId: 40 });
  assert.equal(list[0].quickWin, false);
  assert.equal(list[1].awaitingGoogle, undefined, "a re-crawl shows alt text at once");
  assert.equal(list[2].awaitingGoogle, undefined);
  assert.ok(list[3].awaitingGoogle, "either page of a pair settles it");
  const sorted = sortOpportunities(list.slice());
  assert.deepEqual(sorted.map((o) => o.id), [
    "striking_distance:/neighbourhoods/scarboro",
    "image_alt:/neighbourhoods/rosedale",
    "striking_distance:/neighbourhoods/rosedale",
    "cannibalization:/blog/x::/neighbourhoods/rosedale",
  ]);
});

// ---- cluster links ----

const clusters = [
  { id: "neighbourhoods", label: "Neighbourhoods", pillar: "/neighbourhoods", headKeyword: "calgary luxury neighbourhoods", prefixes: ["/neighbourhoods"] },
  { id: "condos", label: "Condos & Buildings", pillar: "/condos", headKeyword: "calgary luxury condos", prefixes: ["/condos"] },
  { id: "search", label: "Listing Search", pillar: "/mls", headKeyword: "calgary mls listings", prefixes: ["/mls"] },
  { id: "journal", label: "Journal", pillar: "/blog", headKeyword: "calgary luxury real estate advice", prefixes: ["/blog"] },
  { id: "springbank-hill", label: "Springbank Hill", pillar: "/neighbourhoods/springbank-hill", headKeyword: "springbank hill calgary", prefixes: [] },
];
const pg = (p: string, cluster: string, title = p, isPillar = false, status = 200) => ({ path: p, cluster, title, isPillar, status });
const pages = [
  pg("/neighbourhoods", "neighbourhoods", "Calgary Luxury Neighbourhoods", true),
  pg("/neighbourhoods/rosedale", "neighbourhoods"),
  pg("/neighbourhoods/springbank-hill", "springbank-hill", "Springbank Hill", true),
  pg("/blog/3-reasons-not-to-move-to-springbank-hill", "springbank-hill", "3 Reasons Not to Move to Springbank Hill — Rivers Real Estate"),
  pg("/blog/attic-rain-calgary", "neighbourhoods", "Attic Rain in Calgary Homes — Rivers Real Estate"),
  pg("/blog/aspen-woods-price-points", "neighbourhoods", "Aspen Woods Price Points — Rivers Real Estate"),
  pg("/blog/old-draft", "neighbourhoods", "Gone", false, 404),
  pg("/blog/market-notes", "journal", "Market Notes — Rivers Real Estate"),
  pg("/blog/house-for-sale-in-calgary", "search", "House for Sale in Calgary — Rivers Real Estate"),
];

test("child pages link up to their pillar with the head term", () => {
  assert.deepEqual(clusterLinksFor("/neighbourhoods/rosedale", clusters, pages).up, [
    { path: "/neighbourhoods", anchor: "Calgary luxury neighbourhoods", label: "Neighbourhoods" },
  ]);
  // Not in the report yet: the URL prefix still gives it its pillar.
  assert.equal(clusterLinksFor("/condos/the-royal", clusters, pages).up[0].path, "/condos");
  assert.equal(clusterLinksFor("/blog/house-for-sale-in-calgary", clusters, pages).up[0].anchor, "Calgary MLS listings");
});

test("a pillar inside another section links up to both; the journal and pillars themselves get none", () => {
  const sh = clusterLinksFor("/neighbourhoods/springbank-hill", clusters, pages);
  assert.deepEqual(sh.up.map((u) => u.path), ["/neighbourhoods"]);
  const post = clusterLinksFor("/blog/3-reasons-not-to-move-to-springbank-hill", clusters, pages);
  assert.deepEqual(post.up.map((u) => [u.path, u.anchor]), [["/neighbourhoods/springbank-hill", "Springbank Hill Calgary"]]);
  assert.deepEqual(clusterLinksFor("/blog/market-notes", clusters, pages).up, []);
  assert.deepEqual(clusterLinksFor("/neighbourhoods", clusters, pages).up, []);
});

test("pillars list the live journal posts in their cluster, titled without the site name", () => {
  assert.deepEqual(clusterLinksFor("/neighbourhoods", clusters, pages).guides, [
    { path: "/blog/aspen-woods-price-points", title: "Aspen Woods Price Points" },
    { path: "/blog/attic-rain-calgary", title: "Attic Rain in Calgary Homes" },
  ]);
  assert.deepEqual(clusterLinksFor("/neighbourhoods/springbank-hill/", clusters, pages).guides.map((g) => g.path), [
    "/blog/3-reasons-not-to-move-to-springbank-hill",
  ]);
  assert.deepEqual(clusterLinksFor("/blog", clusters, pages).guides, [], "the journal index lists every post already");
});

test("anchor casing keeps proper nouns and acronyms", () => {
  assert.equal(anchorFor("calgary luxury condos", "Condos & Buildings"), "Calgary luxury condos");
  assert.equal(anchorFor("calgary luxury realtor services", "Specialization (Work With)"), "Calgary luxury realtor services");
  assert.equal(anchorFor("springbank hill calgary", "Springbank Hill"), "Springbank Hill Calgary");
});

// ---- neighbourhood titles ----

test("neighbourhood titles lead with '<place> <town> real estate'", () => {
  assert.equal(neighbourhoodSeoTitle("Rosedale"), "Rosedale Calgary Real Estate & Homes for Sale - Luxury Homes Calgary");
  assert.equal(neighbourhoodSeoTitle("Bayside (Airdrie)"), "Bayside Airdrie Real Estate & Homes for Sale - Luxury Homes Calgary");
  assert.equal(neighbourhoodSeoTitle("Spring Creek (Canmore)"), "Spring Creek Canmore Real Estate & Homes for Sale - Luxury Homes Calgary");
  assert.equal(neighbourhoodSeoTitle("Chestermere (Lakefront)"), "Chestermere Lakefront Real Estate & Homes for Sale - Luxury Homes Calgary");
  assert.equal(neighbourhoodPlace("Bayside (Airdrie)").inCity, "Bayside, Airdrie");
  assert.match(neighbourhoodSeoDescription("Elbow Park"), /^Elbow Park Calgary real estate/);
  assert.ok(neighbourhoodSeoDescription("Elbow Park").length <= 160);
});

test("the derived focus keyword of the new title is the real-estate phrase", () => {
  const crawled = (title: string, p: string) => ({ title, h1: "", path: p }) as any;
  assert.equal(derivedKeyword(crawled(neighbourhoodSeoTitle("Rosedale"), "/neighbourhoods/rosedale")), "rosedale calgary real estate");
  assert.equal(derivedKeyword(crawled(neighbourhoodSeoTitle("Bayside (Airdrie)"), "/neighbourhoods/bayside")), "bayside airdrie real estate");
  assert.equal(derivedKeyword(crawled("Elbow Park Homes for Sale - Luxury Homes Calgary", "/neighbourhoods/elbow-park")), "elbow park homes sale");
});

test("a possessive in the title matches the slug-derived keyword", async () => {
  const { containsKeyword, normalize } = await import("../server/seo-keywords");
  assert.equal(normalize("Calgary’s Luxury Market"), "calgarys luxury market");
  assert.ok(containsKeyword(
    "Conditional vs Firm Offers in Calgary's Luxury Market",
    "conditional vs firm offers calgarys luxury market",
  ));
});

test("a title's colon ends the keyword, and plural alt text names a singular subject", async () => {
  const { mentionsSubject } = await import("../server/seo-keywords");
  const crawled = (title: string, p: string) => ({ title, h1: "", path: p }) as any;
  assert.equal(
    derivedKeyword(crawled("Britannia vs Elbow Park: Lots, Flood Risk and Price — Rivers Real Estate", "/blog/x")),
    "britannia vs elbow park",
  );
  assert.ok(mentionsSubject("A brick tower, one of the best luxury condos in Calgary", "best luxury condo buildings in calgary") === false,
    "a word the alt never says still fails");
  assert.ok(mentionsSubject("Luxury condo building lit at night in downtown Calgary", "luxury condo buildings calgary"));
});
