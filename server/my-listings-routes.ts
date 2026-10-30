// Admin API for Spencer's own Pillar 9 listings (my-listings.ts) and the
// marketing assets built from them (listing-assets.ts). Everything is behind
// requireAuth.
//
//   GET    /api/admin/my-listings                    listings + last sync + agent ID
//   POST   /api/admin/my-listings/sync               sync now (waits for it)
//   GET    /api/admin/my-listings/:id                one listing, its link, saved copy
//   GET    /api/admin/my-listings/:id/photo/:idx     a listing photo
//   GET    /api/admin/my-listings/:id/graphic        PNG: ?format=&occasion=&photo=&detail=&soldPrice=1&download=1
//   GET    /api/admin/my-listings/:id/feature-sheet  PDF: ?occasion=&soldPrice=1&download=1
//   POST   /api/admin/my-listings/:id/copy           write copy with Claude {kind, occasion, detail?, notes?, showSoldPrice?}
//   PATCH  /api/admin/my-listings/assets/:assetId    edit saved copy {content}
//   DELETE /api/admin/my-listings/assets/:assetId

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { agentMlsId, getMyListing, lastMyListingsSync, listMyListings, myListingsSyncRunning, retsConfigured, syncMyListings } from "./my-listings";
import {
  COPY_KINDS,
  FORMATS,
  OCCASIONS,
  copyReady,
  defaultOccasion,
  deleteAsset,
  generateCopy,
  listAssets,
  publicListingUrl,
  renderFeatureSheet,
  renderGraphic,
  streetLine,
  updateAsset,
  type CopyKind,
  type GraphicFormat,
  type Occasion,
} from "./listing-assets";
import { fetchListingPhoto } from "./rets-photos";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const occasionSchema = z.enum(Object.keys(OCCASIONS) as [Occasion, ...Occasion[]]);

function slugFile(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "listing";
}

export function registerMyListingsRoutes(app: Express, { requireAuth }: { requireAuth: Middleware }) {
  app.get("/api/admin/my-listings", requireAuth, (_req, res) => {
    res.json({
      agentId: agentMlsId(),
      connected: retsConfigured(),
      syncing: myListingsSyncRunning(),
      lastSync: lastMyListingsSync(),
      listings: listMyListings(),
    });
  });

  app.post("/api/admin/my-listings/sync", requireAuth, async (_req, res) => {
    const run = await syncMyListings();
    res.status(run.status === "success" ? 200 : 502).json(run);
  });

  app.get("/api/admin/my-listings/:id", requireAuth, (req, res) => {
    const l = getMyListing(String(req.params.id));
    if (!l) return res.status(404).json({ message: "Listing not found" });
    res.json({
      listing: l,
      publicUrl: publicListingUrl(l.id),
      defaultOccasion: defaultOccasion(l),
      assets: listAssets(l.id),
      copy: copyReady(),
      occasions: OCCASIONS,
      formats: Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.label])),
      copyKinds: COPY_KINDS,
    });
  });

  app.get("/api/admin/my-listings/:id/photo/:idx", requireAuth, async (req, res) => {
    const l = getMyListing(String(req.params.id));
    const idx = parseInt(String(req.params.idx), 10);
    if (!l) return res.status(404).json({ message: "Listing not found" });
    if (!Number.isFinite(idx) || idx < 0 || idx >= l.photoCount) return res.status(404).json({ message: "No such photo" });
    try {
      const p = await fetchListingPhoto(l.id, idx, l.listingKey);
      if (!p) return res.status(404).json({ message: "Photo not available" });
      res.setHeader("Content-Type", p.contentType);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.end(p.body);
    } catch (e: any) {
      res.status(502).json({ message: e?.message ?? "Photo backend unavailable" });
    }
  });

  app.get("/api/admin/my-listings/:id/graphic", requireAuth, async (req, res) => {
    const l = getMyListing(String(req.params.id));
    if (!l) return res.status(404).json({ message: "Listing not found" });
    const format = (String(req.query.format ?? "square") as GraphicFormat);
    if (!(format in FORMATS)) return res.status(400).json({ message: "Unknown format" });
    const occ = occasionSchema.safeParse(req.query.occasion ?? defaultOccasion(l));
    if (!occ.success) return res.status(400).json({ message: "Unknown occasion" });
    const photo = Math.max(0, parseInt(String(req.query.photo ?? "0"), 10) || 0);
    const detail = typeof req.query.detail === "string" ? req.query.detail.slice(0, 80) : undefined;
    try {
      const png = await renderGraphic(l, format, { occasion: occ.data, detail, photo, showSoldPrice: req.query.soldPrice === "1" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, no-store");
      if (req.query.download === "1") {
        res.setHeader("Content-Disposition", `attachment; filename="${slugFile(streetLine(l))}-${occ.data}-${format}.png"`);
      }
      res.end(png);
    } catch (e: any) {
      console.error("[listing-assets] graphic failed:", e);
      res.status(500).json({ message: e?.message ?? "Could not draw the graphic" });
    }
  });

  app.get("/api/admin/my-listings/:id/feature-sheet", requireAuth, async (req, res) => {
    const l = getMyListing(String(req.params.id));
    if (!l) return res.status(404).json({ message: "Listing not found" });
    const occ = occasionSchema.safeParse(req.query.occasion ?? defaultOccasion(l));
    if (!occ.success) return res.status(400).json({ message: "Unknown occasion" });
    try {
      const pdf = await renderFeatureSheet(l, { occasion: occ.data, showSoldPrice: req.query.soldPrice === "1" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader(
        "Content-Disposition",
        `${req.query.download === "1" ? "attachment" : "inline"}; filename="${slugFile(streetLine(l))}-feature-sheet.pdf"`,
      );
      res.end(pdf);
    } catch (e: any) {
      console.error("[listing-assets] feature sheet failed:", e);
      res.status(500).json({ message: e?.message ?? "Could not build the feature sheet" });
    }
  });

  const copyBody = z.object({
    kind: z.enum(Object.keys(COPY_KINDS) as [CopyKind, ...CopyKind[]]),
    occasion: occasionSchema,
    detail: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    showSoldPrice: z.boolean().optional(),
  });

  app.post("/api/admin/my-listings/:id/copy", requireAuth, async (req, res) => {
    const l = getMyListing(String(req.params.id));
    if (!l) return res.status(404).json({ message: "Listing not found" });
    const body = copyBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ message: body.error.issues[0]?.message ?? "Invalid request" });
    const ready = copyReady();
    if (!ready.ok) return res.status(503).json({ message: ready.reason });
    try {
      res.json(await generateCopy(l, body.data.kind, body.data));
    } catch (e: any) {
      console.error("[listing-assets] copy failed:", e?.message ?? e);
      res.status(502).json({ message: e?.message ?? "Could not write the copy" });
    }
  });

  app.patch("/api/admin/my-listings/assets/:assetId", requireAuth, (req, res) => {
    const id = parseInt(String(req.params.assetId), 10);
    const content = req.body?.content;
    if (!Number.isFinite(id) || typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ message: "Content required" });
    }
    const a = updateAsset(id, content);
    if (!a) return res.status(404).json({ message: "Not found" });
    res.json(a);
  });

  app.delete("/api/admin/my-listings/assets/:assetId", requireAuth, (req, res) => {
    const id = parseInt(String(req.params.assetId), 10);
    if (!Number.isFinite(id) || !deleteAsset(id)) return res.status(404).json({ message: "Not found" });
    res.json({ ok: true });
  });
}
