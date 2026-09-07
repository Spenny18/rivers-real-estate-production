// Google Search Console integration — sitemap submission.
//
// Reuses the OAuth connection that already backs Calendar and Gmail (see
// server/google-calendar.ts); this is one added scope, not a second
// integration. Setup on top of the steps in that file:
//
//   1. https://console.cloud.google.com -> same project
//   2. APIs & Services -> Library -> enable "Google Search Console API"
//   3. OAuth consent screen -> add the scope below
//   4. Reconnect Google once from /admin/scheduling — a connection made
//      before this existed carries only the calendar/gmail scopes, and
//      Google rejects Search Console calls against it.
//
// The account must also be an owner or full user of the property in Search
// Console itself. A restricted user can read but cannot submit a sitemap,
// which is reported up front rather than as a 403 at submit time.

import { getValidAccessToken } from "./google-calendar";
import { storage } from "./storage";
import { publicOrigin } from "./origin";

const SC_API = "https://www.googleapis.com/webmasters/v3";

/** The scope this module needs, on top of the calendar and gmail ones. */
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters";

/** Permission levels that may submit a sitemap. */
const WRITE_LEVELS = new Set(["siteOwner", "siteFullUser"]);

export interface ScGuard {
  ok: boolean;
  reason?: string;
}

/**
 * Whether the stored Google connection can talk to Search Console.
 *
 * Mirrors gmail.ts's canSendEmail: check the granted scope up front so an
 * older connection surfaces as "reconnect Google" rather than a 403 from
 * somewhere deep in a background job.
 */
export function canUseSearchConsole(userId: number): ScGuard {
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) {
    return { ok: false, reason: "Google isn't connected. Connect it on the Scheduling page." };
  }
  if (!(integ.scope ?? "").includes(SEARCH_CONSOLE_SCOPE)) {
    return {
      ok: false,
      reason:
        "Your Google connection predates Search Console access. Reconnect Google on the " +
        "Scheduling page to grant it.",
    };
  }
  return { ok: true };
}

interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

/**
 * Find the Search Console property matching this deploy's public origin.
 *
 * Properties come in two shapes and we may hold either: a domain property
 * ("sc-domain:riversrealestate.ca", covers every scheme and subdomain) or a
 * URL-prefix property ("https://riversrealestate.ca/"). Match both rather
 * than assuming, because which one exists is a choice made in the Search
 * Console UI years ago, not something this code controls.
 */
export async function resolveSiteUrl(
  accessToken: string,
  origin = publicOrigin(),
): Promise<{ siteUrl: string; permissionLevel: string } | { error: string }> {
  const r = await fetch(`${SC_API}/sites`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    return { error: `Search Console sites.list failed: ${r.status} ${await r.text()}` };
  }
  const data: any = await r.json();
  const entries: SiteEntry[] = data.siteEntry ?? [];
  if (!entries.length) {
    return { error: "This Google account has no Search Console properties." };
  }

  // GSC_SITE_URL already names the property for server/seo-stats.ts, which
  // reads Search Analytics through a service account. Honour it here too so
  // the two modules can never disagree about which property this deploy
  // means — we still look it up in the list, because we need its permission
  // level and because a typo should say so rather than 404 at submit time.
  const configured = process.env.GSC_SITE_URL?.trim();
  if (configured) {
    const hit = entries.find((e) => e.siteUrl === configured);
    if (hit) return { siteUrl: hit.siteUrl, permissionLevel: hit.permissionLevel };
    return {
      error:
        `GSC_SITE_URL is set to "${configured}" but this Google account cannot see that ` +
        `property. Available: ${entries.map((e) => e.siteUrl).join(", ")}`,
    };
  }

  const host = new URL(origin).host; // e.g. riversrealestate.ca
  const bareHost = host.replace(/^www\./, "");

  // Prefer a domain property — it covers http/https and www/non-www, so it
  // stays correct if PUBLIC_ORIGIN ever changes scheme or subdomain.
  const domainMatch = entries.find(
    (e) => e.siteUrl === `sc-domain:${bareHost}` || e.siteUrl === `sc-domain:${host}`,
  );
  if (domainMatch) {
    return { siteUrl: domainMatch.siteUrl, permissionLevel: domainMatch.permissionLevel };
  }

  const prefixMatch = entries.find((e) => {
    if (!/^https?:\/\//i.test(e.siteUrl)) return false;
    try {
      return new URL(e.siteUrl).host === host;
    } catch {
      return false;
    }
  });
  if (prefixMatch) {
    return { siteUrl: prefixMatch.siteUrl, permissionLevel: prefixMatch.permissionLevel };
  }

  return {
    error:
      `No Search Console property matches ${origin}. Available: ` +
      entries.map((e) => e.siteUrl).join(", "),
  };
}

export interface SubmitResult {
  ok: boolean;
  submitted?: string;
  siteUrl?: string;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

/** Read the searchConsole bookkeeping blob off the integration metadata. */
function readMeta(userId: number): Record<string, any> {
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ) return {};
  try {
    const m = typeof integ.metadata === "string" ? JSON.parse(integ.metadata) : integ.metadata;
    return (m as any)?.searchConsole ?? {};
  } catch {
    return {};
  }
}

/** Merge into the searchConsole blob without disturbing calendarId etc. */
function writeMeta(userId: number, patch: Record<string, any>): void {
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ) return;
  let base: any = {};
  try {
    base = typeof integ.metadata === "string" ? JSON.parse(integ.metadata) : integ.metadata ?? {};
  } catch {
    base = {};
  }
  base.searchConsole = { ...(base.searchConsole ?? {}), ...patch };
  storage.upsertUserIntegration({
    userId: integ.userId,
    provider: "google",
    accountEmail: integ.accountEmail ?? undefined,
    accessToken: integ.accessToken,
    refreshToken: integ.refreshToken ?? undefined,
    expiresAt: integ.expiresAt ?? undefined,
    scope: integ.scope ?? undefined,
    metadata: JSON.stringify(base),
    active: integ.active,
  } as any);
}

/** Google ignores a resubmission of an unchanged sitemap, so don't spam it. */
const MIN_RESUBMIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Submit the sitemap index to Search Console.
 *
 * Debounced to once a day unless forced: a Fly machine can restart several
 * times in an afternoon and resubmitting the same document on each boot buys
 * nothing. `force` is what the admin's manual button uses.
 */
export async function submitSitemap(
  userId: number,
  opts: { force?: boolean } = {},
): Promise<SubmitResult> {
  const guard = canUseSearchConsole(userId);
  if (!guard.ok) return { ok: false, reason: guard.reason };

  if (!opts.force) {
    const last = readMeta(userId).lastSubmittedAt;
    if (last && Date.now() - new Date(last).getTime() < MIN_RESUBMIT_INTERVAL_MS) {
      return { ok: true, skipped: true, reason: `Already submitted at ${last}` };
    }
  }

  const token = await getValidAccessToken(userId);
  if (!token) return { ok: false, error: "Could not obtain a Google access token." };

  const origin = publicOrigin();
  const resolved = await resolveSiteUrl(token, origin);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  if (!WRITE_LEVELS.has(resolved.permissionLevel)) {
    return {
      ok: false,
      error:
        `Google account has ${resolved.permissionLevel} on ${resolved.siteUrl}; ` +
        `submitting a sitemap needs siteOwner or siteFullUser.`,
    };
  }

  const sitemapUrl = `${origin}/sitemap.xml`;
  const path = `${SC_API}/sites/${encodeURIComponent(resolved.siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
  const r = await fetch(path, { method: "PUT", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const body = await r.text();
    return { ok: false, error: `Sitemap submit failed: ${r.status} ${body}` };
  }

  writeMeta(userId, {
    lastSubmittedAt: new Date().toISOString(),
    siteUrl: resolved.siteUrl,
    sitemapUrl,
  });
  return { ok: true, submitted: sitemapUrl, siteUrl: resolved.siteUrl };
}

export interface SitemapStatus {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  warnings?: number;
  errors?: number;
}

/** What Search Console currently thinks of our submitted sitemaps. */
export async function listSitemaps(
  userId: number,
): Promise<{ ok: boolean; siteUrl?: string; sitemaps?: SitemapStatus[]; reason?: string; error?: string }> {
  const guard = canUseSearchConsole(userId);
  if (!guard.ok) return { ok: false, reason: guard.reason };

  const token = await getValidAccessToken(userId);
  if (!token) return { ok: false, error: "Could not obtain a Google access token." };

  const resolved = await resolveSiteUrl(token);
  if ("error" in resolved) return { ok: false, error: resolved.error };

  const r = await fetch(`${SC_API}/sites/${encodeURIComponent(resolved.siteUrl)}/sitemaps`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return { ok: false, error: `sitemaps.list failed: ${r.status} ${await r.text()}` };
  const data: any = await r.json();
  const sitemaps: SitemapStatus[] = (data.sitemap ?? []).map((s: any) => ({
    path: s.path,
    lastSubmitted: s.lastSubmitted,
    lastDownloaded: s.lastDownloaded,
    isPending: s.isPending,
    // Counts arrive as strings (int64 over JSON).
    warnings: s.warnings != null ? Number(s.warnings) : undefined,
    errors: s.errors != null ? Number(s.errors) : undefined,
  }));
  return { ok: true, siteUrl: resolved.siteUrl, sitemaps };
}

/** Bookkeeping for the admin status card, with no API call. */
export function lastSubmission(userId: number): { lastSubmittedAt?: string; siteUrl?: string } {
  const m = readMeta(userId);
  return { lastSubmittedAt: m.lastSubmittedAt, siteUrl: m.siteUrl };
}

/**
 * Post-deploy hook: submit the sitemap once the app is up.
 *
 * Runs only in production and only when a Google connection with the scope
 * exists — on a dev box or before Spencer reconnects, this is a no-op that
 * logs why. Failures never throw: a Search Console hiccup must not affect
 * serving.
 */
export function scheduleSitemapSubmit(): void {
  if (process.env.NODE_ENV !== "production") {
    console.log("[search-console] sitemap auto-submit disabled (not production)");
    return;
  }
  if (process.env.SEARCH_CONSOLE_AUTOSUBMIT === "0") {
    console.log("[search-console] sitemap auto-submit disabled (SEARCH_CONSOLE_AUTOSUBMIT=0)");
    return;
  }
  // 60s after boot: let the MLS sync and seeding settle, and make sure the
  // sitemap routes are actually serving before pointing Google at them.
  setTimeout(() => {
    const integ = storage.findActiveIntegration("google");
    if (!integ) {
      console.log("[search-console] no Google connection — skipping sitemap submit");
      return;
    }
    submitSitemap(integ.userId)
      .then((r) => {
        if (r.skipped) console.log(`[search-console] sitemap submit skipped — ${r.reason}`);
        else if (r.ok) console.log(`[search-console] submitted ${r.submitted} to ${r.siteUrl}`);
        else console.warn(`[search-console] sitemap submit not done: ${r.error ?? r.reason}`);
      })
      .catch((e) => console.error("[search-console] sitemap submit threw:", e?.message ?? e));
  }, 60_000).unref?.();
  console.log("[search-console] sitemap auto-submit scheduled");
}
