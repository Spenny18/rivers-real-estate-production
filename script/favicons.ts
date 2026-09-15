// Render the favicon raster set from client/public/favicon.svg.
//
//   npx tsx script/favicons.ts
//
// Produces favicon-96x96 / 192x192 / 512x512, apple-touch-icon (180px) and
// favicon.ico (a 48px PNG in an ICO container — what every current browser
// and Google's crawler read). Run it whenever favicon.svg changes.

import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const PUB = path.resolve("client/public");
const svg = fs.readFileSync(path.join(PUB, "favicon.svg"), "utf8");

function png(size: number): Buffer {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "#000000" });
  return Buffer.from(r.render().asPng());
}

/** ICO container holding one PNG image. */
function ico(pngData: Buffer, size: number): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngData.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset of the image data
  return Buffer.concat([header, entry, pngData]);
}

for (const [file, size] of [
  ["favicon-96x96.png", 96],
  ["favicon-192x192.png", 192],
  ["favicon-512x512.png", 512],
  ["apple-touch-icon.png", 180],
] as const) {
  fs.writeFileSync(path.join(PUB, file), png(size));
  console.log(`${file} · ${size}px`);
}
fs.writeFileSync(path.join(PUB, "favicon.ico"), ico(png(48), 48));
console.log("favicon.ico · 48px PNG");
