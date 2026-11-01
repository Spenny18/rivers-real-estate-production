import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-carousel-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.LISTING_ASSETS_FAKE = "1";

const { normalizeMyListing, upsertMyListing, getMyListing } = await import("../server/my-listings");
const { rasterise, listAssets } = await import("../server/listing-assets");
const {
  carouselSchema,
  defaultCarousel,
  deleteCarousel,
  getCarousel,
  keyNumbers,
  saveCarousel,
  shortPrice,
  slideSvg,
  tidySlides,
  wrapText,
  writeCarousel,
  zipFiles,
  SLIDE_W,
  SLIDE_H,
} = await import("../server/listing-carousel");

const row = {
  ListingId: "A2336281",
  ListingKeyNumeric: "654321",
  StandardStatus: "Active",
  ListPrice: "1399000",
  UnparsedAddress: "720 52 avenue SW",
  City: "Calgary",
  SubdivisionName: "WINDSOR PARK",
  BedroomsTotal: "6",
  BathroomsTotalInteger: "6",
  LivingAreaSF: "3250",
  YearBuilt: "2026",
  PhotosCount: "30",
  PublicRemarks:
    "Brand new three-storey home with a legal carriage house suite. The kitchen has a double waterfall quartz island. The third floor is an entire primary retreat with a balcony. The lower level has a theatre room with a wet bar.",
};
upsertMyListing(normalizeMyListing(row, "list")!);
upsertMyListing(normalizeMyListing({ ...row, ListingId: "A9", StandardStatus: "Sold", ClosePrice: "1350000", CloseDate: "2026-06-01" }, "list")!);

test("the plain carousel opens on a cover, closes on the call to action, and every slide draws", () => {
  const l = getMyListing("A2336281")!;
  const spec = defaultCarousel(l, { occasion: "open-house", detail: "Sat & Sun · Nov 7–8 · 2–4 PM" });
  assert.ok(carouselSchema.safeParse(spec).success);
  assert.equal(spec.slides[0].layout, "cover");
  assert.equal(spec.slides[0].headline, "Open House");
  assert.equal(spec.slides.at(-1)!.layout, "cta");
  assert.deepEqual(spec.slides.at(-1)!.points, ["Sat & Sun · Nov 7–8 · 2–4 PM"]);
  spec.slides.forEach((s, i) => {
    const svg = slideSvg(l, spec, i, s.photos.map(() => null));
    assert.match(svg, new RegExp(`width="${SLIDE_W}" height="${SLIDE_H}"`));
    assert.match(svg, /Synterra Realty|SYNTERRA REALTY/i, `slide ${i + 1} names the brokerage`);
    assert.match(svg, new RegExp(`0${i + 1} / 0${spec.slides.length}`));
    assert.equal(rasterise(svg, 270).subarray(1, 4).toString(), "PNG");
  });
});

test("every layout draws, text is escaped, and photos are placed", () => {
  const l = getMyListing("A2336281")!;
  const layouts = ["cover", "overview", "dark-list", "dark-columns", "dark-tags", "pair", "light", "cta"] as const;
  const spec = {
    occasion: "just-listed" as const,
    slides: layouts.map((layout) => ({
      layout,
      eyebrow: "Living & <Dining>",
      headline: "A kitchen built to gather around.",
      body: "One sentence.\nSecond line",
      points: ["6 | Bedrooms", "Upstairs | Three bedrooms"],
      photos: [0, 1],
    })),
  };
  const dot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  spec.slides.forEach((_, i) => {
    const svg = slideSvg(l, spec, i, [dot, dot]);
    assert.doesNotMatch(svg, /<Dining>/);
    assert.ok(rasterise(svg, 200).length > 100);
  });
  assert.match(slideSvg(l, spec, 5, [dot, dot]), /<image[\s\S]*<image/);
});

test("key numbers keep a sold price off unless it is wanted", () => {
  const sold = getMyListing("A9")!;
  assert.ok(!keyNumbers(sold, { occasion: "just-sold" }).some((p) => p.includes("Sold For")));
  assert.ok(keyNumbers(sold, { occasion: "just-sold", showSoldPrice: true }).includes("$1.35M | Sold For"));
  assert.doesNotMatch(defaultCarousel(sold, { occasion: "just-sold" }).slides.at(-1)!.body, /1,350,000/);
  assert.equal(shortPrice(1399000), "$1.399M");
  assert.equal(shortPrice(2000000), "$2M");
  assert.equal(shortPrice(649900), "$650K");
});

test("wrapText honours line breaks and the line budget", () => {
  assert.deepEqual(wrapText("Join us\nthis weekend.", { size: 40 }, 2000, 2).lines, ["Join us", "this weekend."]);
  const r = wrapText("one two three four five six seven eight nine ten", { size: 40 }, 200, 2);
  assert.equal(r.lines.length, 2);
  assert.ok(r.cut);
  assert.match(r.lines[1], /…$/);
});

test("written slides are kept inside the renderer's limits", () => {
  const out = tidySlides(
    [
      { layout: "cover", eyebrow: "x", headline: "y", body: "", points: [], photos: [0, 99, -1, 3] },
      { layout: "nonsense", headline: "dropped" },
    ],
    10,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].photos, [0, 3]);
});

test("a carousel saves, reloads and resets; writing it also saves its caption", async () => {
  const l = getMyListing("A2336281")!;
  const spec = defaultCarousel(l, { occasion: "just-listed" });
  spec.slides[0].headline = "Just Listed in Windsor Park";
  saveCarousel(l.id, spec);
  assert.equal(getCarousel(l.id)!.spec.slides[0].headline, "Just Listed in Windsor Park");
  assert.ok(deleteCarousel(l.id));
  assert.equal(getCarousel(l.id), null);

  const r = await writeCarousel(l, { occasion: "open-house", detail: "Sat 2–4 PM" });
  assert.equal(getCarousel(l.id)!.model, "fake");
  assert.equal(listAssets(l.id)[0].id, r.caption.id);
  assert.equal(r.caption.kind, "instagram");
});

test("the zip holds every file intact", () => {
  const a = Buffer.from("first file");
  const b = Buffer.from("second");
  const zip = zipFiles([
    { name: "a.png", data: a },
    { name: "b.png", data: b },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  // First entry's data follows its 30-byte header and name.
  assert.equal(zip.subarray(30 + 5, 30 + 5 + a.length).toString(), "first file");
  assert.equal(zip.readUInt32LE(14), zlib.crc32(a) >>> 0);
});
