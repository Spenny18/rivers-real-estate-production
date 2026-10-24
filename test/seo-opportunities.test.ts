import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// seo-opportunities imports seo-keywords, which opens the database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-opps-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.PUBLIC_ORIGIN = "https://riversrealestate.ca";

const { buildOpportunities, expectedCtr, liftEstimate, gainOf, categoryOf } = await import("../server/seo-opportunities");
type PageAnalysis = import("../server/seo-keywords").PageAnalysis;

const ORIGIN = "https://riversrealestate.ca";

function page(over: Partial<PageAnalysis> & { path: string }): PageAnalysis {
  return {
    status: 200,
    title: "Aspen Woods Homes for Sale | Luxury Homes Calgary",
    description: "",
    h1: "Aspen Woods",
    wordCount: 900,
    cluster: "neighbourhoods",
    clusterLabel: "Neighbourhoods",
    intent: "commercial",
    isPillar: false,
    focusKeyword: "aspen woods homes sale",
    focusSource: "derived",
    score: 80,
    grade: "strong",
    components: [],
    inboundLinks: ["/neighbourhoods", "/blog/a", "/blog/b"],
    linkedFromNav: false,
    outboundLinks: [],
    externalDomains: ["calgary.ca"],
    sisterDomainLinks: [],
    schemaTypes: ["BreadcrumbList"],
    conflicts: [],
    recommendedInboundFrom: [],
    suggestedKeyword: null,
    suggestionReason: null,
    keywordRank: null,
    images: { total: 1, missingAlt: 0, featured: { src: "/x.jpg", alt: "Aspen Woods homes", hasKeyword: true } },
    issues: [],
    ...over,
  };
}

test("each task's click estimate equals its own working: lines summed × factor", () => {
  const opps = buildOpportunities({
    pages: [page({ path: "/blog/condo-fees", cluster: "journal", intent: "informational" })],
    gscRows: [
      { page: `${ORIGIN}/blog/condo-fees`, query: "calgary condo fees", clicks: 2, impressions: 900, position: 4 },
      { page: `${ORIGIN}/blog/condo-fees`, query: "condo fees alberta", clicks: 1, impressions: 300, position: 9 },
    ],
    ga4: new Map(),
    days: 90,
  });
  assert.ok(opps.length > 0);
  for (const o of opps) {
    const e = o.estimate;
    const listed = e.lines.reduce((s, l) => s + l.clicks, 0) + e.otherClicks;
    assert.ok(Math.abs(listed - e.subtotal) < 0.2, `${o.id}: lines add up to the subtotal`);
    assert.ok(Math.abs(e.subtotal * e.factor - o.estClicksGain) < 0.1, `${o.id}: gain = subtotal × factor`);
    for (const l of e.lines) {
      const expected = l.monthlyImpressions * Math.max(0, l.ctrTarget - l.ctrNow);
      assert.ok(Math.abs(expected - l.clicks) < 0.2, `${o.id}: line "${l.label}" is impressions × CTR gap`);
    }
  }
  const ctr = opps.find((o) => o.type === "ctr_gap")!;
  // 900 impressions over 90 days = 300 a month; at position 4 the target is
  // 80% of 7.5% = 6%, and it earns 2/900 today.
  const line = ctr.estimate.lines.find((l) => l.label === "calgary condo fees")!;
  assert.equal(line.monthlyImpressions, 300);
  assert.ok(Math.abs(line.ctrTarget - expectedCtr(4) * 0.8) < 1e-4);
  assert.ok(Math.abs(line.clicks - 300 * (0.06 - 2 / 900)) < 0.1);
});

test("the list comes back most clicks first", () => {
  const opps = buildOpportunities({
    pages: [
      page({ path: "/blog/a", cluster: "journal", externalDomains: [], wordCount: 200 }),
      page({ path: "/blog/b", cluster: "journal" }),
    ],
    gscRows: [
      { page: `${ORIGIN}/blog/a`, query: "a query", clicks: 0, impressions: 120, position: 12 },
      { page: `${ORIGIN}/blog/b`, query: "b query", clicks: 1, impressions: 2000, position: 3 },
    ],
    ga4: new Map(),
    days: 90,
  });
  for (let i = 1; i < opps.length; i++) {
    assert.ok(opps[i - 1].estClicksGain >= opps[i].estClicksGain, "descending by estimated clicks");
  }
});

test("a post that earns nothing and is thin is flagged as dead weight, and nothing else", () => {
  const old = new Date(Date.now() - 400 * 864e5).toISOString();
  const opps = buildOpportunities({
    pages: [
      page({
        path: "/blog/old-thin-post", cluster: "journal", wordCount: 180, publishedAt: old,
        inboundLinks: [], externalDomains: [], issues: ["Orphan — no editorial links point here", "Thin — 180 words"],
      }),
      page({ path: "/blog/live" }),
    ],
    gscRows: [{ page: `${ORIGIN}/blog/live`, query: "x", clicks: 3, impressions: 100, position: 5 }],
    ga4: new Map(),
    days: 90,
  });
  const forPost = opps.filter((o) => o.paths[0] === "/blog/old-thin-post");
  assert.deepEqual(forPost.map((o) => o.type), ["prune"]);
  assert.equal(forPost[0].category, "delete_merge");
  assert.equal(forPost[0].estClicksGain, 0);
});

test("a brand-new post is not called dead weight", () => {
  const opps = buildOpportunities({
    pages: [page({ path: "/blog/new", wordCount: 180, publishedAt: new Date().toISOString(), inboundLinks: [] })],
    gscRows: [{ page: `${ORIGIN}/blog/other`, query: "x", clicks: 3, impressions: 100, position: 5 }],
    ga4: new Map(),
    days: 90,
  });
  assert.ok(!opps.some((o) => o.type === "prune"));
});

test("orphans, external links and alt text are their own tasks; templates roll up into one", () => {
  const opps = buildOpportunities({
    pages: [
      page({ path: "/blog/orphan", inboundLinks: [], issues: ["Orphan — no editorial links point here"] }),
      page({ path: "/blog/no-cites", externalDomains: [] }),
      page({
        path: "/blog/alt",
        images: { total: 1, missingAlt: 0, featured: { src: "/x.jpg", alt: "Post title", hasKeyword: false, source: "fallback" } },
      }),
      page({ path: "/neighbourhoods/aspen-woods", externalDomains: [] }),
      page({ path: "/neighbourhoods/elbow-park", externalDomains: [] }),
    ],
    gscRows: [],
    ga4: new Map(),
    days: 90,
  });
  const byId = new Map(opps.map((o) => [o.id, o]));
  assert.equal(byId.get("orphan:/blog/orphan")?.category, "orphans");
  assert.equal(byId.get("external_links:/blog/no-cites")?.category, "external_links");
  assert.equal(byId.get("image_alt:/blog/alt")?.category, "image_alt");
  const tpl = byId.get("external_links:template:neighbourhood");
  assert.ok(tpl, "neighbourhood pages roll up into one template task");
  assert.equal(tpl!.paths.length, 2);
  assert.ok(!byId.has("external_links:/neighbourhoods/aspen-woods"));
});

test("a position lift earns the CTR of the new position", () => {
  const e = liftEstimate({
    rows: [{ page: "", query: "q", clicks: 0, impressions: 300, position: 6 }],
    perMonth: 1,
    lift: 2,
    method: "",
  });
  assert.ok(Math.abs(e.lines[0].ctrTarget - expectedCtr(4)) < 1e-4);
  assert.ok(Math.abs(gainOf(e) - 300 * expectedCtr(4)) < 0.1);
});

test("architecture subtypes map to the work they need", () => {
  assert.equal(categoryOf("architecture", "deep_page"), "orphans");
  assert.equal(categoryOf("architecture", "uplinks"), "internal_links");
  assert.equal(categoryOf("architecture", "cluster_candidate"), "structure");
});
