// HTTP side of activity tracking. See server/tracking.ts for the model.
//
// Public:
//   POST /t/e            the site's beacon — page views and listing views
//   GET  /t/o/:id.gif    email open pixel
//   GET  /t/c/:id        email click redirect (destination HMAC-signed)
// Admin (requireAuth):
//   GET  /api/admin/tracking/activity?email=   one person's timeline
//   GET  /api/admin/tracking/recent?days=      who has been active lately
//
// The public endpoints live outside /api on purpose: the request logger in
// server/index.ts writes a line for every /api call, and a line per page view
// would bury everything else in Fly's logs. Short, generic paths also fare
// better with ad blockers than anything named "track" or "pixel".

import type { Express, Request, Response, NextFunction } from "express";
import {
  VISITOR_COOKIE,
  VISITOR_COOKIE_MAX_AGE_S,
  identifyVisitor,
  isBotUserAgent,
  isTrackingId,
  isValidEmail,
  isVisitorId,
  listActivityForEmail,
  listRecentlyActive,
  listTrackedEmailsFor,
  newVisitorId,
  recordClick,
  recordOpen,
  recordWebEvent,
  summarizeActivity,
  touchVisitor,
  verifyLink,
} from "./tracking";
import { accountEmailFromRequest } from "./account";
import { publicOrigin } from "./origin";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;
type RateLimit = (opts: { windowMs: number; max: number; key: string }) => Middleware;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

function visitorIdFrom(req: Request): string | null {
  const v = readCookie(req, VISITOR_COOKIE);
  return isVisitorId(v) ? v : null;
}

function setVisitorCookie(res: Response, vid: string) {
  const attrs = [
    `${VISITOR_COOKIE}=${vid}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_S}`,
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

/** The visitor's id, issuing a cookie for one if this browser has none yet. */
function ensureVisitorId(req: Request, res: Response): string {
  const existing = visitorIdFrom(req);
  if (existing) return existing;
  const vid = newVisitorId();
  setVisitorCookie(res, vid);
  return vid;
}

// A transparent 1x1 GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Public form endpoints that carry the submitter's email in `body.email`.
 *
 * Identification happens after the route has answered, and only when it
 * answered successfully — a rejected submission (bad email, rate limited,
 * honeypot) shouldn't tie a browser to whatever was typed.
 */
const IDENTIFYING_FORMS: Array<{ pattern: RegExp; via: string }> = [
  { pattern: /^\/api\/inquiry$/, via: "inquiry form" },
  { pattern: /^\/api\/public\/leads\/unlock$/, via: "listing unlock" },
  { pattern: /^\/api\/public\/valuation\/email$/, via: "home valuation" },
  { pattern: /^\/api\/home-value$/, via: "home value" },
  { pattern: /^\/api\/newsletter\/subscribe$/, via: "newsletter signup" },
  { pattern: /^\/api\/booking\/event-types\/[^/]+\/book$/, via: "booking" },
];

export function registerTrackingRoutes(app: Express, deps: { requireAuth: Middleware; rateLimit: RateLimit }) {
  const { requireAuth, rateLimit } = deps;

  // Must be registered before the form routes it watches.
  app.use((req, res, next) => {
    if (req.method !== "POST") return next();
    const form = IDENTIFYING_FORMS.find((f) => f.pattern.test(req.path));
    if (!form) return next();
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      const vid = visitorIdFrom(req);
      const email = req.body?.email;
      if (!vid || !isValidEmail(email)) return;
      try {
        identifyVisitor(vid, email, form.via);
      } catch (e: any) {
        console.error("[tracking] identify failed:", e?.message ?? e);
      }
    });
    next();
  });

  // ---- Website beacon ----------------------------------------------------------

  // Generous: a fast browse through search results is dozens of views a minute.
  const beaconLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, key: "tracking-beacon" });

  app.post("/t/e", beaconLimiter, (req, res) => {
    // Always 204: the beacon is fire-and-forget and the page never reads it.
    if (isBotUserAgent(req.get("user-agent"))) return res.status(204).end();
    const b = req.body ?? {};
    const kind = b.kind === "listing_view" ? "listing_view" : b.kind === "pageview" ? "pageview" : null;
    const path = typeof b.path === "string" ? b.path : "";
    // Admin pages are Spencer, not a lead.
    if (!kind || !path.startsWith("/") || path.startsWith("/admin")) return res.status(204).end();

    try {
      const vid = ensureVisitorId(req, res);
      touchVisitor(vid, { referrer: b.referrer, landing: path, userAgent: req.get("user-agent") });
      // A signed-in portal user is already known; no form needed.
      const accountEmail = accountEmailFromRequest(req);
      if (accountEmail) identifyVisitor(vid, accountEmail, "portal sign-in");
      recordWebEvent(vid, { kind, path, title: b.title, referrer: b.referrer, listing: b.listing });
    } catch (e: any) {
      console.error("[tracking] beacon failed:", e?.message ?? e);
    }
    res.status(204).end();
  });

  // ---- Email ------------------------------------------------------------------

  app.get("/t/o/:file", (req, res) => {
    const id = String(req.params.file ?? "").replace(/\.gif$/, "");
    if (isTrackingId(id)) {
      try {
        recordOpen(id, req.get("user-agent"));
      } catch (e: any) {
        console.error("[tracking] open failed:", e?.message ?? e);
      }
    }
    res.set({
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    });
    res.send(PIXEL);
  });

  app.get("/t/c/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const url = typeof req.query.u === "string" ? req.query.u : "";
    const sig = typeof req.query.s === "string" ? req.query.s : "";
    // An unsigned or tampered link goes home rather than anywhere it asks to.
    if (!isTrackingId(id) || !/^https?:\/\//i.test(url) || !verifyLink(id, url, sig)) {
      return res.redirect(302, publicOrigin());
    }
    // Link scanners (Outlook Safe Links, Mimecast, etc.) follow every link in
    // an email on delivery. They get redirected but not counted.
    if (!isBotUserAgent(req.get("user-agent"))) {
      try {
        const vid = ensureVisitorId(req, res);
        const email = recordClick(id, url, vid);
        if (email) identifyVisitor(vid, email, "email click");
      } catch (e: any) {
        console.error("[tracking] click failed:", e?.message ?? e);
      }
    }
    res.set("Cache-Control", "no-store");
    res.redirect(302, url);
  });

  // ---- Admin ------------------------------------------------------------------

  app.get("/api/admin/tracking/activity", requireAuth, (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!isValidEmail(email)) return res.status(400).json({ message: "A valid email is required." });
    const events = listActivityForEmail(email, 300);
    res.json({
      summary: summarizeActivity(email, events),
      events,
      emails: listTrackedEmailsFor(email, 50),
    });
  });

  app.get("/api/admin/tracking/recent", requireAuth, (req, res) => {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? "7"), 10) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    res.json(listRecentlyActive(since, 100));
  });
}
