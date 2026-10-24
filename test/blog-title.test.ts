import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripSiteName } from "../shared/blog-title";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-title-"));
process.env.DB_PATH = path.join(dir, "test.db");
const { storage } = await import("../server/storage");

test("strips a trailing site name, however many times and with any separator", () => {
  assert.equal(stripSiteName("Calgary's Richest Neighbourhoods Ranked — Rivers Real Estate"), "Calgary's Richest Neighbourhoods Ranked");
  assert.equal(stripSiteName("Alberta vs BC — Rivers Real Estate — Rivers Real Estate"), "Alberta vs BC");
  assert.equal(stripSiteName("Selling in Calgary | Rivers Real Estate"), "Selling in Calgary");
  assert.equal(stripSiteName("Selling in Calgary - rivers real estate "), "Selling in Calgary");
});

test("leaves titles that only mention the brand mid-sentence alone", () => {
  assert.equal(stripSiteName("Why Rivers Real Estate Prices Homes Differently"), "Why Rivers Real Estate Prices Homes Differently");
  assert.equal(stripSiteName("Rivers Real Estate"), "Rivers Real Estate");
});

test("upsertBlogPost stores the title without the site name", () => {
  storage.upsertBlogPost({
    slug: "blog-title-test",
    title: "Alberta vs BC Real Estate: No Land Tax — Rivers Real Estate",
    excerpt: "x",
    body: "x",
    category: "Market",
    heroImage: "/img/og-default.jpg",
  } as any);
  assert.equal(storage.getBlogBySlug("blog-title-test")!.title, "Alberta vs BC Real Estate: No Land Tax");
  storage.upsertBlogPost({ slug: "blog-title-test", title: "Updated | Rivers Real Estate" } as any);
  assert.equal(storage.getBlogBySlug("blog-title-test")!.title, "Updated");
});
