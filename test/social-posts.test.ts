import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-posts-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.UPLOADS_ROOT = path.join(dir, "uploads");
process.env.PUBLIC_ORIGIN = "https://riversrealestate.ca";
process.env.LISTING_ASSETS_FAKE = "1";

const { socialPayload, absoluteUrl, socialPostView } = await import("../server/social-posts");
const { storage } = await import("../server/storage");
const { normalizeMyListing, upsertMyListing, getMyListing } = await import("../server/my-listings");
const { defaultCarousel, publishCarouselImages, carouselCaption } = await import("../server/listing-carousel");
const { saveAsset } = await import("../server/listing-assets");

test("site paths become full URLs for the auto-poster", () => {
  assert.equal(absoluteUrl("/uploads/a.jpg"), "https://riversrealestate.ca/uploads/a.jpg");
  assert.equal(absoluteUrl("https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
  assert.equal(absoluteUrl(null), null);
});

test("a post with several images goes to Instagram as a carousel", () => {
  const post = storage.createSocialPost({
    userId: 1,
    caption: "Open house this weekend",
    imageUrl: "/uploads/carousels/A1/x-01.jpg",
    mediaUrls: ["/uploads/carousels/A1/x-01.jpg", "/uploads/carousels/A1/x-02.jpg", "/uploads/carousels/A1/x-03.jpg"],
    channels: ["instagram", "gbp"],
    variants: { gbp: { imageUrl: "/uploads/gbp.jpg" } },
    status: "draft",
  } as any);
  assert.deepEqual(socialPostView(post).mediaUrls.length, 3);
  const p = socialPayload(post);
  assert.deepEqual(p.platforms, ["instagram", "gbp"]);
  assert.equal(p.posts.instagram.postType, "carousel");
  assert.deepEqual(p.posts.instagram.media[1], { image_url: "https://riversrealestate.ca/uploads/carousels/A1/x-02.jpg", media_type: "IMAGE" });
  assert.equal(p.posts.instagram.imageUrl, "https://riversrealestate.ca/uploads/carousels/A1/x-01.jpg");
  // A platform's own image replaces the carousel there.
  assert.equal(p.posts.gbp.postType, "photo");
  assert.equal(p.posts.gbp.imageUrl, "https://riversrealestate.ca/uploads/gbp.jpg");
  assert.equal(p.mediaUrls.length, 3);
});

test("a single-image post stays a photo post", () => {
  const post = storage.createSocialPost({ userId: 1, caption: "Hi", imageUrl: "https://x.test/a.jpg", channels: ["instagram"], status: "draft" } as any);
  const p = socialPayload(post);
  assert.equal(p.posts.instagram.postType, "photo");
  assert.deepEqual(p.posts.instagram.mediaUrls, ["https://x.test/a.jpg"]);
});

test("carousel slides publish as public JPEGs, and the caption comes from the listing's copy", async () => {
  upsertMyListing(
    normalizeMyListing(
      { ListingId: "A5", ListingKeyNumeric: "5", StandardStatus: "Active", ListPrice: "900000", UnparsedAddress: "1 Main Street SW", City: "Calgary", SubdivisionName: "ALTADORE", BedroomsTotal: "3", BathroomsTotalInteger: "2", PhotosCount: "6", PublicRemarks: "A bright home near the river. It has a big yard." },
      "list",
    )!,
  );
  const l = getMyListing("A5")!;
  const spec = defaultCarousel(l, { occasion: "just-listed" });
  const urls = await publishCarouselImages(l, spec);
  assert.equal(urls.length, spec.slides.length);
  for (const u of urls) {
    assert.match(u, /^\/uploads\/carousels\/A5\/[a-z0-9]+-\d\d\.jpg$/);
    const file = path.join(process.env.UPLOADS_ROOT!, u.replace(/^\/uploads\//, ""));
    const head = fs.readFileSync(file).subarray(0, 3);
    assert.deepEqual([...head], [0xff, 0xd8, 0xff], "a JPEG");
  }
  assert.match(carouselCaption(l, "just-listed"), /Synterra Realty/);
  saveAsset({ listingId: "A5", kind: "instagram", occasion: "just-listed", content: "Written caption", model: "fake" });
  assert.equal(carouselCaption(l, "just-listed"), "Written caption");
});
