// Website and email activity tracking — the app's own replacement for the
// Follow Up Boss pixel and FUB's email open/click tracking.
//
// Two halves feed one timeline:
//
//   Website. Every visitor gets a first-party cookie (lhc_vid) the first time
//   the client beacon reaches /api/t/e. Page views and listing views are
//   recorded against that id while it is anonymous. The moment the same
//   browser hands over an email — a form submit, a portal sign-in, or a click
//   through a tracked email — the visitor is tied to that address and every
//   anonymous event it already logged is attributed to them retroactively.
//   That is the whole value of the thing: seeing that someone looked at nine
//   listings in Aspen Woods the week before they filled in the contact form.
//
//   Email. An outbound email is "instrumented" before it is sent: it gets a
//   row in tracked_emails, a 1x1 open pixel, and every http(s) link is
//   rewritten through /t/c/:id, which logs the click and redirects. Each
//   rewritten link carries an HMAC of its destination, so /t/c cannot be used
//   as an open redirect to send people somewhere the email never linked to.
//
// Everything lands in web_events keyed by email address, which is the one
// identifier shared by leads, CRM contacts, portal accounts and newsletter
// subscribers. Nothing here knows about HTTP; see tracking-routes.ts.
//
// Two limits worth knowing when reading the numbers:
//   - Opens are soft. Apple Mail Privacy Protection fetches every image on
//     delivery, so an Apple Mail user "opens" everything; Gmail proxies images
//     and caches them, so repeat opens are undercounted. Clicks are the
//     signal that means a person did something.
//   - A forwarded email identifies whoever clicked as the original recipient.
//     FUB has the same weakness; it is inherent to link-based identification.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sqlite } from "./storage";
import { publicOrigin } from "./origin";

sqlite.exec(`
  -- One row per browser. email is null until the visitor identifies.
  CREATE TABLE IF NOT EXISTS web_visitors (
    vid TEXT PRIMARY KEY,
    email TEXT,
    identified_at TEXT,
    identified_via TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    first_referrer TEXT,
    first_landing TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_web_visitors_email ON web_visitors(email);

  -- The timeline. kind: pageview | listing_view | identify | email_open | email_click.
  -- email is copied onto the row (and backfilled on identify) so a contact's
  -- history is one indexed lookup rather than a join through visitors.
  CREATE TABLE IF NOT EXISTS web_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vid TEXT,
    email TEXT,
    kind TEXT NOT NULL,
    path TEXT,
    title TEXT,
    referrer TEXT,
    mls_number TEXT,
    tracked_email_id TEXT,
    props TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_web_events_email ON web_events(email, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_web_events_vid ON web_events(vid, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_web_events_time ON web_events(occurred_at DESC);

  -- One row per instrumented outbound email, per recipient.
  CREATE TABLE IF NOT EXISTS tracked_emails (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    subject TEXT,
    channel TEXT NOT NULL,                 -- gmail | resend | newsletter
    kind TEXT NOT NULL,                    -- crm | lead_alert | newsletter | valuation | ...
    contact_fub_id TEXT,
    sent_at TEXT NOT NULL,
    open_count INTEGER NOT NULL DEFAULT 0,
    first_opened_at TEXT,
    last_opened_at TEXT,
    click_count INTEGER NOT NULL DEFAULT 0,
    first_clicked_at TEXT,
    last_clicked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tracked_emails_email ON tracked_emails(email, sent_at DESC);
`);

function nowIso(): string {
  return new Date().toISOString();
}

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

// ---- Visitors -----------------------------------------------------------------------

export const VISITOR_COOKIE = "lhc_vid";
export const VISITOR_COOKIE_MAX_AGE_S = 2 * 365 * 86400;

export function newVisitorId(): string {
  return randomBytes(16).toString("base64url");
}

/** Only ids this module could have issued; anything else is treated as no cookie. */
export function isVisitorId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v);
}

/**
 * Crawlers, link unfurlers and uptime checks. They would otherwise be most of
 * the page views — the site is crawled far more than it is read.
 */
const BOT_UA = /bot|crawl|spider|slurp|preview|fetch|monitor|headless|lighthouse|pingdom|uptime|curl|wget|python|axios|node-fetch|go-http|java\/|facebookexternalhit|embedly|quora|whatsapp/i;

export function isBotUserAgent(ua: string | undefined): boolean {
  return !ua || BOT_UA.test(ua);
}

export interface VisitorRow {
  vid: string;
  email: string | null;
  identifiedAt: string | null;
  identifiedVia: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  firstReferrer: string | null;
  firstLanding: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

const VISITOR_COLS = `vid, email, identified_at AS identifiedAt, identified_via AS identifiedVia,
  first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, first_referrer AS firstReferrer,
  first_landing AS firstLanding, utm_source AS utmSource, utm_medium AS utmMedium, utm_campaign AS utmCampaign`;

export function getVisitor(vid: string): VisitorRow | undefined {
  return sqlite.prepare(`SELECT ${VISITOR_COLS} FROM web_visitors WHERE vid = ?`).get(vid) as VisitorRow | undefined;
}

/**
 * Create the visitor on first sight, or bump last_seen. First-touch fields
 * (referrer, landing page, UTMs) are written once and never overwritten —
 * that is what makes them answer "where did this person come from".
 */
export function touchVisitor(
  vid: string,
  first: { referrer?: string | null; landing?: string | null; userAgent?: string | null } = {},
): void {
  const now = nowIso();
  let utm: Record<string, string | null> = { source: null, medium: null, campaign: null };
  if (first.landing) {
    try {
      const u = new URL(first.landing, "https://x.invalid");
      utm = {
        source: clip(u.searchParams.get("utm_source"), 120),
        medium: clip(u.searchParams.get("utm_medium"), 120),
        campaign: clip(u.searchParams.get("utm_campaign"), 120),
      };
    } catch {
      /* a malformed landing path just means no UTMs */
    }
  }
  sqlite
    .prepare(
      `INSERT INTO web_visitors (vid, first_seen_at, last_seen_at, first_referrer, first_landing,
         utm_source, utm_medium, utm_campaign, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vid) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .run(
      vid,
      now,
      now,
      clip(first.referrer, 500),
      clip(first.landing, 500),
      utm.source,
      utm.medium,
      utm.campaign,
      clip(first.userAgent, 300),
    );
}

/**
 * Tie a browser to an email address, and hand every anonymous event it has
 * already logged to that person.
 *
 * Re-identifying as someone else (a shared family computer) moves the visitor
 * forward but leaves events already attributed to the first person alone.
 */
export function identifyVisitor(vid: string, rawEmail: string, via: string): void {
  if (!isVisitorId(vid) || !isValidEmail(rawEmail)) return;
  const email = normEmail(rawEmail);
  const now = nowIso();
  const existing = getVisitor(vid);
  if (!existing) touchVisitor(vid);
  if (existing?.email === email) return;

  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(`UPDATE web_visitors SET email = ?, identified_at = ?, identified_via = ? WHERE vid = ?`)
      .run(email, now, via.slice(0, 60), vid);
    sqlite.prepare(`UPDATE web_events SET email = ? WHERE vid = ? AND email IS NULL`).run(email, vid);
    sqlite
      .prepare(`INSERT INTO web_events (vid, email, kind, props, occurred_at) VALUES (?, ?, 'identify', ?, ?)`)
      .run(vid, email, JSON.stringify({ via: via.slice(0, 60) }), now);
  });
  tx();
}

// ---- Website events -----------------------------------------------------------------

export interface ListingProps {
  mlsNumber?: string | null;
  address?: string | null;
  price?: number | null;
  beds?: number | null;
  baths?: number | null;
  neighbourhood?: string | null;
}

export interface WebEventInput {
  kind: "pageview" | "listing_view";
  path: string;
  title?: string | null;
  referrer?: string | null;
  listing?: ListingProps | null;
}

/** Sanitise listing props from the client: known keys, bounded sizes, right types. */
function cleanListing(l: unknown): ListingProps | null {
  if (!l || typeof l !== "object") return null;
  const o = l as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    mlsNumber: clip(o.mlsNumber, 40),
    address: clip(o.address, 200),
    price: num(o.price),
    beds: num(o.beds),
    baths: num(o.baths),
    neighbourhood: clip(o.neighbourhood, 120),
  };
}

export function recordWebEvent(vid: string, input: WebEventInput): void {
  const visitor = getVisitor(vid);
  const listing = input.kind === "listing_view" ? cleanListing(input.listing) : null;
  sqlite
    .prepare(
      `INSERT INTO web_events (vid, email, kind, path, title, referrer, mls_number, props, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      vid,
      visitor?.email ?? null,
      input.kind,
      clip(input.path, 500),
      clip(input.title, 300),
      clip(input.referrer, 500),
      listing?.mlsNumber ?? null,
      JSON.stringify(listing ? { listing } : {}),
      nowIso(),
    );
}

// ---- Email instrumentation ----------------------------------------------------------

/**
 * The key that signs click-redirect destinations.
 *
 * TRACKING_SECRET from the environment wins. Otherwise one is generated and
 * kept in app_secrets, the same way the session secret is when it is unset,
 * so links in emails already sent keep working across restarts and deploys.
 */
let cachedSecret: string | null = null;
function linkSecret(): string {
  if (process.env.TRACKING_SECRET) return process.env.TRACKING_SECRET;
  if (cachedSecret) return cachedSecret;
  const row = sqlite.prepare("SELECT value FROM app_secrets WHERE key = 'tracking_link_secret'").get() as
    | { value: string }
    | undefined;
  if (row?.value) return (cachedSecret = row.value);
  const fresh = randomBytes(32).toString("base64url");
  sqlite
    .prepare("INSERT OR IGNORE INTO app_secrets (key, value, created_at) VALUES ('tracking_link_secret', ?, ?)")
    .run(fresh, nowIso());
  const stored = sqlite.prepare("SELECT value FROM app_secrets WHERE key = 'tracking_link_secret'").get() as {
    value: string;
  };
  return (cachedSecret = stored.value);
}

export function signLink(trackingId: string, url: string): string {
  return createHmac("sha256", linkSecret()).update(`${trackingId}\n${url}`).digest("base64url").slice(0, 22);
}

export function verifyLink(trackingId: string, url: string, sig: string): boolean {
  const expected = Buffer.from(signLink(trackingId, url));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function isTrackingId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v);
}

export interface TrackOptions {
  /** What sort of email this is: crm, lead_alert, newsletter, valuation, ... */
  kind: string;
  channel: "gmail" | "resend" | "newsletter";
  contactFubId?: string | null;
}

export function createTrackedEmail(to: string, subject: string, opts: TrackOptions): string {
  const id = randomBytes(16).toString("base64url");
  sqlite
    .prepare(
      `INSERT INTO tracked_emails (id, email, subject, channel, kind, contact_fub_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, normEmail(to), subject.slice(0, 300), opts.channel, opts.kind.slice(0, 40), opts.contactFubId ?? null, nowIso());
  return id;
}

export function openPixelUrl(trackingId: string): string {
  return `${publicOrigin()}/t/o/${trackingId}.gif`;
}

export function trackedLinkUrl(trackingId: string, url: string): string {
  return `${publicOrigin()}/t/c/${trackingId}?u=${encodeURIComponent(url)}&s=${signLink(trackingId, url)}`;
}

/**
 * Links left alone: unsubscribe links (a click on one must never be gated
 * behind our redirect, and CASL wants them to just work), and anything that
 * is already one of ours.
 */
function shouldWrap(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/unsubscribe/i.test(url)) return false;
  if (url.includes("/t/c/") || url.includes("/t/o/")) return false;
  return true;
}

function decodeHtmlAttr(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function encodeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Rewrite every eligible href and append the open pixel. */
export function instrumentHtml(html: string, trackingId: string): string {
  const rewritten = html.replace(/href=(["'])(.*?)\1/gi, (whole, quote: string, raw: string) => {
    const url = decodeHtmlAttr(raw);
    if (!shouldWrap(url)) return whole;
    return `href=${quote}${encodeHtmlAttr(trackedLinkUrl(trackingId, url))}${quote}`;
  });
  const pixel = `<img src="${openPixelUrl(trackingId)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;
  return /<\/body>/i.test(rewritten) ? rewritten.replace(/<\/body>/i, `${pixel}</body>`) : rewritten + pixel;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * An HTML twin for a plain-text email, so a 1:1 message from the CRM can carry
 * a pixel at all. Deliberately plain — it should look like the text version
 * typed in a mail client, not like a template. URLs become (tracked) links.
 */
export function plainTextToTrackedHtml(text: string, trackingId: string): string {
  const linked = escapeHtml(text).replace(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g, (escapedUrl) => {
    const url = decodeHtmlAttr(escapedUrl);
    const href = shouldWrap(url) ? trackedLinkUrl(trackingId, url) : url;
    return `<a href="${encodeHtmlAttr(href)}">${escapedUrl}</a>`;
  });
  const body = linked.replace(/\r?\n/g, "<br>\n");
  return instrumentHtml(
    `<!doctype html><html><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">${body}</div></body></html>`,
    trackingId,
  );
}

// ---- Opens and clicks ---------------------------------------------------------------

interface TrackedEmailRow {
  id: string;
  email: string;
  subject: string | null;
  kind: string;
  sentAt: string;
  lastOpenedAt: string | null;
}

function getTrackedEmail(id: string): TrackedEmailRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, email, subject, kind, sent_at AS sentAt, last_opened_at AS lastOpenedAt FROM tracked_emails WHERE id = ?`,
    )
    .get(id) as TrackedEmailRow | undefined;
}

/** Repeat opens within this window are counted but not added to the timeline again. */
const OPEN_TIMELINE_GAP_MS = 30 * 60 * 1000;
/** An open this soon after sending is almost always a mail server or privacy proxy prefetching images. */
const MACHINE_OPEN_MS = 60 * 1000;

export function recordOpen(trackingId: string, userAgent: string | undefined): void {
  const row = getTrackedEmail(trackingId);
  if (!row) return;
  const now = new Date();
  const iso = now.toISOString();
  const showInTimeline = !row.lastOpenedAt || now.getTime() - Date.parse(row.lastOpenedAt) > OPEN_TIMELINE_GAP_MS;
  const likelyAutomated = now.getTime() - Date.parse(row.sentAt) < MACHINE_OPEN_MS;

  sqlite
    .prepare(
      `UPDATE tracked_emails SET open_count = open_count + 1,
         first_opened_at = COALESCE(first_opened_at, ?), last_opened_at = ? WHERE id = ?`,
    )
    .run(iso, iso, trackingId);
  if (showInTimeline) {
    sqlite
      .prepare(
        `INSERT INTO web_events (email, kind, title, tracked_email_id, props, occurred_at)
         VALUES (?, 'email_open', ?, ?, ?, ?)`,
      )
      .run(
        row.email,
        row.subject,
        trackingId,
        JSON.stringify({ emailKind: row.kind, likelyAutomated, userAgent: clip(userAgent, 200) }),
        iso,
      );
  }
}

/** Log a click and return the email address it identifies, for the redirect to tie to the browser. */
export function recordClick(trackingId: string, url: string, vid: string | null): string | null {
  const row = getTrackedEmail(trackingId);
  if (!row) return null;
  const iso = nowIso();
  sqlite
    .prepare(
      `UPDATE tracked_emails SET click_count = click_count + 1,
         first_clicked_at = COALESCE(first_clicked_at, ?), last_clicked_at = ?,
         -- A click proves the email was opened even when images were blocked.
         first_opened_at = COALESCE(first_opened_at, ?)
       WHERE id = ?`,
    )
    .run(iso, iso, iso, trackingId);
  sqlite
    .prepare(
      `INSERT INTO web_events (vid, email, kind, title, path, tracked_email_id, props, occurred_at)
       VALUES (?, ?, 'email_click', ?, ?, ?, ?, ?)`,
    )
    .run(vid, row.email, row.subject, clip(url, 500), trackingId, JSON.stringify({ emailKind: row.kind }), iso);
  return row.email;
}

// ---- Reading it back ----------------------------------------------------------------

export interface ActivityEvent {
  id: number;
  kind: string;
  path: string | null;
  title: string | null;
  referrer: string | null;
  mlsNumber: string | null;
  props: Record<string, unknown>;
  occurredAt: string;
  email: string | null;
}

function parseEvent(r: any): ActivityEvent {
  let props: Record<string, unknown> = {};
  try {
    props = JSON.parse(r.props);
  } catch {
    /* leave empty */
  }
  return {
    id: r.id,
    kind: r.kind,
    path: r.path,
    title: r.title,
    referrer: r.referrer,
    mlsNumber: r.mls_number,
    props,
    occurredAt: r.occurred_at,
    email: r.email,
  };
}

export function listActivityForEmail(email: string, limit = 300): ActivityEvent[] {
  return (
    sqlite
      .prepare(`SELECT * FROM web_events WHERE email = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`)
      .all(normEmail(email), limit) as any[]
  ).map(parseEvent);
}

export interface EmailEngagement {
  id: string;
  subject: string | null;
  kind: string;
  channel: string;
  sentAt: string;
  openCount: number;
  firstOpenedAt: string | null;
  clickCount: number;
  firstClickedAt: string | null;
}

export function listTrackedEmailsFor(email: string, limit = 50): EmailEngagement[] {
  return sqlite
    .prepare(
      `SELECT id, subject, kind, channel, sent_at AS sentAt, open_count AS openCount,
         first_opened_at AS firstOpenedAt, click_count AS clickCount, first_clicked_at AS firstClickedAt
       FROM tracked_emails WHERE email = ? ORDER BY sent_at DESC LIMIT ?`,
    )
    .all(normEmail(email), limit) as EmailEngagement[];
}

export interface ActivitySummary {
  visits: number;
  pageviews: number;
  listingViews: number;
  lastSeenAt: string | null;
  firstSeenAt: string | null;
  firstReferrer: string | null;
  firstLanding: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  emailsSent: number;
  emailsOpened: number;
  emailsClicked: number;
  topNeighbourhoods: Array<{ name: string; count: number }>;
}

/** A page view more than this long after the previous one starts a new visit. */
const VISIT_GAP_MS = 30 * 60 * 1000;

export function summarizeActivity(email: string, events: ActivityEvent[]): ActivitySummary {
  const e = normEmail(email);
  const web = events.filter((x) => x.kind === "pageview" || x.kind === "listing_view");
  const times = web.map((x) => Date.parse(x.occurredAt)).sort((a, b) => a - b);
  let visits = 0;
  for (let i = 0; i < times.length; i++) if (i === 0 || times[i] - times[i - 1] > VISIT_GAP_MS) visits++;

  const hoods = new Map<string, number>();
  for (const x of events) {
    const n = (x.props as any)?.listing?.neighbourhood;
    if (x.kind === "listing_view" && typeof n === "string" && n) hoods.set(n, (hoods.get(n) ?? 0) + 1);
  }

  const firstVisitor = sqlite
    .prepare(
      `SELECT first_referrer AS firstReferrer, first_landing AS firstLanding, utm_source AS utmSource,
         utm_campaign AS utmCampaign, first_seen_at AS firstSeenAt
       FROM web_visitors WHERE email = ? ORDER BY first_seen_at ASC LIMIT 1`,
    )
    .get(e) as any;
  const mail = sqlite
    .prepare(
      `SELECT COUNT(*) AS sent, SUM(first_opened_at IS NOT NULL) AS opened, SUM(click_count > 0) AS clicked
       FROM tracked_emails WHERE email = ?`,
    )
    .get(e) as any;

  return {
    visits,
    pageviews: web.filter((x) => x.kind === "pageview").length,
    listingViews: web.filter((x) => x.kind === "listing_view").length,
    lastSeenAt: web[0]?.occurredAt ?? null,
    firstSeenAt: firstVisitor?.firstSeenAt ?? null,
    firstReferrer: firstVisitor?.firstReferrer ?? null,
    firstLanding: firstVisitor?.firstLanding ?? null,
    utmSource: firstVisitor?.utmSource ?? null,
    utmCampaign: firstVisitor?.utmCampaign ?? null,
    emailsSent: mail?.sent ?? 0,
    emailsOpened: mail?.opened ?? 0,
    emailsClicked: mail?.clicked ?? 0,
    topNeighbourhoods: Array.from(hoods.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

export interface HotVisitor {
  email: string;
  lastAt: string;
  events: number;
  listingViews: number;
  emailClicks: number;
  contactFubId: string | null;
  name: string | null;
}

/**
 * Who has been active lately — FUB's "back on the site" list. Identified people
 * only; anonymous traffic is GA4's job.
 */
export function listRecentlyActive(sinceIso: string, limit = 50): HotVisitor[] {
  return sqlite
    .prepare(
      `SELECT e.email AS email, MAX(e.occurred_at) AS lastAt, COUNT(*) AS events,
         SUM(e.kind = 'listing_view') AS listingViews, SUM(e.kind = 'email_click') AS emailClicks,
         (SELECT c.fub_id FROM crm_contacts c WHERE lower(c.email) = e.email LIMIT 1) AS contactFubId,
         (SELECT c.name FROM crm_contacts c WHERE lower(c.email) = e.email LIMIT 1) AS name
       FROM web_events e
       WHERE e.email IS NOT NULL AND e.occurred_at >= ?
         AND e.kind IN ('pageview', 'listing_view', 'email_click')
       GROUP BY e.email
       ORDER BY lastAt DESC
       LIMIT ?`,
    )
    .all(sinceIso, limit) as HotVisitor[];
}
