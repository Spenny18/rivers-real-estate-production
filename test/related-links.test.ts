import { test } from "node:test";
import assert from "node:assert/strict";
import { linksForPost, nearbyCondos, nearbyNeighbourhoods, postsNaming, rotation } from "../server/related-links";

const post = (slug: string, title: string, publishedAt: string, category = "Neighbourhoods", excerpt = "") => ({
  slug, title, category, excerpt, publishedAt, heroImage: `/img/${slug}.jpg`, heroImageAlt: null,
});

const posts = [
  post("aspen-woods-guide", "Aspen Woods Real Estate: Price Points and Architecture", "2026-01-05"),
  post("aspen-woods-schools", "Schools in Aspen Woods for Growing Families", "2026-02-10"),
  post("condo-fees", "Calgary Condo Fees: What They Cover", "2026-03-01", "Condos"),
  post("mission-condos", "Mission Condos Along the Elbow River", "2026-04-12", "Condos"),
  post("our-mission", "Our mission as your Calgary realtor", "2026-05-20", "Selling"),
  post("market-2026", "Calgary Market Outlook 2026", "2026-06-30", "Market"),
];
const hoods = [
  { slug: "aspen-woods", name: "Aspen Woods", zone: "West" },
  { slug: "mission", name: "Mission", zone: "Inner City" },
  { slug: "elbow-park", name: "Elbow Park", zone: "Inner City" },
  { slug: "britannia", name: "Britannia", zone: "Inner City" },
  { slug: "springbank-hill", name: "Springbank Hill", zone: "West" },
];
const condos = [
  { slug: "the-river", name: "The River", neighbourhoodSlug: "mission", neighbourhood: "Mission" },
  { slug: "park-point", name: "Park Point", neighbourhoodSlug: "beltline", neighbourhood: "Beltline" },
  { slug: "arriva", name: "Arriva", neighbourhoodSlug: "beltline", neighbourhood: "Beltline" },
  { slug: "verve", name: "Verve", neighbourhoodSlug: "beltline", neighbourhood: "Beltline" },
];

test("a rotation picks each item exactly k times", () => {
  const items = ["a", "b", "c", "d", "e"];
  const counts = new Map<string, number>();
  items.forEach((_, i) => rotation(items, i, 3).forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1)));
  assert.deepEqual([...counts.values()], [3, 3, 3, 3, 3]);
  assert.ok(!rotation(items, 0, 3).includes("a"), "never itself");
});

test("every post gets a previous and a next link in, and never links to itself", () => {
  const inbound = new Map<string, number>();
  for (const p of posts) {
    const l = linksForPost(p.slug, posts, hoods, condos);
    const targets = [l.newer, l.older, ...l.more].filter(Boolean).map((x) => x!.slug);
    assert.ok(!targets.includes(p.slug));
    assert.equal(new Set(targets).size, targets.length, "no duplicates");
    for (const t of [l.newer, l.older]) if (t) inbound.set(t.slug, (inbound.get(t.slug) ?? 0) + 1);
  }
  for (const p of posts) assert.equal(inbound.get(p.slug), 2, `${p.slug} gets two chronological links`);
});

test("more from the journal prefers posts on the same subject", () => {
  const l = linksForPost("market-2026", [...posts, post("aspen-woods-prices", "Aspen Woods Prices in 2026", "2025-12-01")], hoods, condos);
  const all = linksForPost("aspen-woods-guide", [...posts, post("aspen-woods-prices", "Aspen Woods Prices in 2026", "2025-12-01")], hoods, condos);
  const linked = [all.newer, all.older, ...all.more].map((x) => x?.slug);
  assert.ok(linked.includes("aspen-woods-schools") && linked.includes("aspen-woods-prices"));
  assert.ok(l.more.length <= 3);
});

test("a post links to the places it names, case-sensitively", () => {
  const mission = linksForPost("mission-condos", posts, hoods, condos);
  assert.deepEqual(mission.places.map((p) => p.slug), ["mission"]);
  const ours = linksForPost("our-mission", posts, hoods, condos);
  assert.deepEqual(ours.places, [], "“our mission” isn't the Mission community");
  const aw = linksForPost("aspen-woods-schools", posts, hoods, condos);
  assert.deepEqual(aw.places.map((p) => p.slug), ["aspen-woods"]);
});

test("a neighbourhood lists the posts that name it, title matches first", () => {
  const got = postsNaming("Aspen Woods", [...posts, post("west-side", "West Side Living", "2026-07-01", "Neighbourhoods", "Why Aspen Woods keeps winning")]);
  assert.deepEqual(got.map((p) => p.slug), ["aspen-woods-schools", "aspen-woods-guide", "west-side"]);
});

test("every neighbourhood and building is linked from exactly k others", () => {
  for (const [list, fn, k] of [
    [hoods, nearbyNeighbourhoods, 4],
    [condos, nearbyCondos, 3],
  ] as const) {
    const counts = new Map<string, number>();
    for (const x of list) {
      const out = (fn as any)(x.slug, list) as Array<{ slug: string }>;
      assert.ok(!out.some((o) => o.slug === x.slug));
      out.forEach((o) => counts.set(o.slug, (counts.get(o.slug) ?? 0) + 1));
    }
    for (const x of list) assert.equal(counts.get(x.slug), Math.min(k, list.length - 1));
  }
  // Same zone comes first.
  assert.deepEqual(nearbyNeighbourhoods("britannia", hoods, 2).map((h) => h.slug), ["elbow-park", "mission"]);
});

test("all-caps titles still match the places they name", () => {
  const caps = [...posts, post("britannia-guide", "BRITANNIA CALGARY ULTIMATE NEIGHBOURHOOD GUIDE 2024", "2024-03-01")];
  assert.deepEqual(linksForPost("britannia-guide", caps, hoods, condos).places.map((p) => p.slug), ["britannia"]);
  assert.deepEqual(linksForPost("our-mission", caps, hoods, condos).places, [], "mixed-case text stays case-sensitive");
});
