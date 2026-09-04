// Server-side fetchers for Google Search Console (Search Analytics) and
// Google Analytics 4 (Data API). Wraps service-account JWT auth + REST
// calls + 1h in-memory cache so the admin analytics dashboard can show
// traffic + search data without the user leaving /admin.
//
// Requires three Fly secrets:
//   GOOGLE_SERVICE_ACCOUNT_JSON  — full contents of the GCP key JSON file
//   GSC_SITE_URL                 — sc-domain:riversrealestate.ca
//   GA4_PROPERTY_ID              — numeric, from GA4 Admin → Property Details
//
// The service account must be granted:
//   - "Restricted" on the GSC property
//   - "Viewer" on the GA4 property
// Both grants are done in the respective property's UI, not in GCP IAM.

import { JWT } from "google-auth-library";

import { publicOrigin } from "./origin";
const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3";
const GA4_API = "https://analyticsdata.googleapis.com/v1beta";

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

interface AuthClientResult {
  client: JWT | null;
  error?: string;
}

let cachedAuthResult: AuthClientResult | null = null;
function getAuthClient(): AuthClientResult {
  if (cachedAuthResult) return cachedAuthResult;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw === undefined) {
    cachedAuthResult = {
      client: null,
      error:
        "GOOGLE_SERVICE_ACCOUNT_JSON env var is not set on this machine. Did `fly deploy` pick up the new secret?",
    };
    return cachedAuthResult;
  }
  if (raw.trim().length === 0) {
    cachedAuthResult = {
      client: null,
      error:
        "GOOGLE_SERVICE_ACCOUNT_JSON env var is empty. Re-set it with `fly secrets set GOOGLE_SERVICE_ACCOUNT_JSON=\"$(cat /path/to/key.json)\" -a luxury-homes-calgary` and make sure the path resolves.",
    };
    return cachedAuthResult;
  }
  let parsed: { client_email?: string; private_key?: string; type?: string };
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    cachedAuthResult = {
      client: null,
      error: `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (likely shell quoting mangled the newlines in private_key). Parse error: ${err?.message ?? err}. The env var is ${raw.length} chars and starts with: ${JSON.stringify(raw.slice(0, 40))}`,
    };
    return cachedAuthResult;
  }
  const missing: string[] = [];
  if (!parsed.client_email) missing.push("client_email");
  if (!parsed.private_key) missing.push("private_key");
  if (missing.length > 0) {
    cachedAuthResult = {
      client: null,
      error: `GOOGLE_SERVICE_ACCOUNT_JSON is JSON but missing required field(s): ${missing.join(", ")}. Keys present: ${Object.keys(parsed).join(", ")}.`,
    };
    return cachedAuthResult;
  }
  cachedAuthResult = {
    client: new JWT({
      email: parsed.client_email,
      key: parsed.private_key,
      scopes: SCOPES,
    }),
  };
  return cachedAuthResult;
}

interface AccessTokenResult {
  token: string | null;
  error?: string;
}

async function getAccessToken(): Promise<AccessTokenResult> {
  const auth = getAuthClient();
  if (!auth.client) return { token: null, error: auth.error };
  try {
    const t = await auth.client.getAccessToken();
    if (!t.token)
      return {
        token: null,
        error:
          "Service-account JWT exchange returned no token. The credentials may be revoked, the key may be malformed, or Google rejected the request.",
      };
    return { token: t.token };
  } catch (err: any) {
    return {
      token: null,
      error: `Failed to mint access token via service-account JWT: ${err?.message ?? err}`,
    };
  }
}

// ---------- Cache --------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 60 * 60 * 1000;

async function cached<T>(key: string, build: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }
  const value = await build();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// ---------- Date helpers -------------------------------------------------

function isoDayAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// ---------- Public payload shape (kept stable for the client) -----------

export interface SeoStatsPayload {
  days: number;
  range: { startDate: string; endDate: string };
  gsc: {
    ok: boolean;
    message?: string;
    summary?: {
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    };
    topQueries?: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
    topPages?: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
  };
  ga4: {
    ok: boolean;
    message?: string;
    summary?: {
      users: number;
      sessions: number;
      pageviews: number;
      avgEngagementSeconds: number;
    };
    topPages?: { path: string; pageviews: number; users: number }[];
    sources?: { source: string; sessions: number; users: number }[];
  };
}

// ---------- GSC fetchers -------------------------------------------------

async function gscQuery(
  token: string,
  siteUrl: string,
  body: Record<string, unknown>,
): Promise<any> {
  const url = `${GSC_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GSC ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchGscBlock(
  token: string,
  siteUrl: string,
  days: number,
): Promise<SeoStatsPayload["gsc"]> {
  const startDate = isoDayAgo(days);
  const endDate = isoDayAgo(1); // GSC data lags ~2 days; yesterday is the freshest
  const base = { startDate, endDate };
  const [summary, queries, pages] = await Promise.all([
    gscQuery(token, siteUrl, { ...base, dimensions: [] }),
    gscQuery(token, siteUrl, { ...base, dimensions: ["query"], rowLimit: 15 }),
    gscQuery(token, siteUrl, { ...base, dimensions: ["page"], rowLimit: 15 }),
  ]);
  const summaryRow = summary.rows?.[0] ?? {
    clicks: 0,
    impressions: 0,
    ctr: 0,
    position: 0,
  };
  return {
    ok: true,
    summary: {
      clicks: Math.round(summaryRow.clicks ?? 0),
      impressions: Math.round(summaryRow.impressions ?? 0),
      ctr: summaryRow.ctr ?? 0,
      position: summaryRow.position ?? 0,
    },
    topQueries: (queries.rows ?? []).map((r: any) => ({
      query: r.keys?.[0] ?? "",
      clicks: Math.round(r.clicks ?? 0),
      impressions: Math.round(r.impressions ?? 0),
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    })),
    topPages: (pages.rows ?? []).map((r: any) => ({
      page: r.keys?.[0] ?? "",
      clicks: Math.round(r.clicks ?? 0),
      impressions: Math.round(r.impressions ?? 0),
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    })),
  };
}

// ---------- GA4 fetchers -------------------------------------------------

async function ga4Report(
  token: string,
  propertyId: string,
  body: Record<string, unknown>,
): Promise<any> {
  const url = `${GA4_API}/properties/${propertyId}:runReport`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GA4 ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchGa4Block(
  token: string,
  propertyId: string,
  days: number,
): Promise<SeoStatsPayload["ga4"]> {
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];
  const [summary, topPages, sources] = await Promise.all([
    ga4Report(token, propertyId, {
      dateRanges,
      metrics: [
        { name: "totalUsers" },
        { name: "sessions" },
        { name: "screenPageViews" },
        { name: "userEngagementDuration" },
      ],
    }),
    ga4Report(token, propertyId, {
      dateRanges,
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 15,
    }),
    ga4Report(token, propertyId, {
      dateRanges,
      dimensions: [{ name: "sessionSource" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 10,
    }),
  ]);
  const sum = summary.rows?.[0]?.metricValues ?? [];
  const num = (i: number) => Number(sum[i]?.value ?? 0);
  const users = num(0);
  const sessions = num(1);
  const pageviews = num(2);
  const engagementSeconds = num(3);
  return {
    ok: true,
    summary: {
      users,
      sessions,
      pageviews,
      avgEngagementSeconds: users > 0 ? Math.round(engagementSeconds / users) : 0,
    },
    topPages: (topPages.rows ?? []).map((r: any) => ({
      path: r.dimensionValues?.[0]?.value ?? "",
      pageviews: Number(r.metricValues?.[0]?.value ?? 0),
      users: Number(r.metricValues?.[1]?.value ?? 0),
    })),
    sources: (sources.rows ?? []).map((r: any) => ({
      source: r.dimensionValues?.[0]?.value ?? "(unknown)",
      sessions: Number(r.metricValues?.[0]?.value ?? 0),
      users: Number(r.metricValues?.[1]?.value ?? 0),
    })),
  };
}

// ---------- Public entry point ------------------------------------------

export async function fetchSeoStats(days: number): Promise<SeoStatsPayload> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  const range = { startDate: isoDayAgo(safeDays), endDate: isoDayAgo(1) };

  const { token, error: tokenError } = await getAccessToken();
  const siteUrl = process.env.GSC_SITE_URL;
  const propertyId = process.env.GA4_PROPERTY_ID;

  // Fall through to a "configured but partial" response so the UI can show
  // each card's specific failure state instead of a generic empty dashboard.
  const payload: SeoStatsPayload = {
    days: safeDays,
    range,
    gsc: { ok: false, message: "Not configured" },
    ga4: { ok: false, message: "Not configured" },
  };

  if (!token) {
    const msg = tokenError ?? "Authentication failed for an unknown reason.";
    payload.gsc.message = payload.ga4.message = msg;
    console.warn("[seo-stats] auth failed:", msg);
    return payload;
  }

  // Both blocks run in parallel; each fails independently.
  const [gscRes, ga4Res] = await Promise.allSettled([
    siteUrl
      ? cached(`gsc:${siteUrl}:${safeDays}`, () => fetchGscBlock(token, siteUrl, safeDays))
      : Promise.reject(new Error("GSC_SITE_URL not set")),
    propertyId
      ? cached(`ga4:${propertyId}:${safeDays}`, () => fetchGa4Block(token, propertyId, safeDays))
      : Promise.reject(new Error("GA4_PROPERTY_ID not set")),
  ]);

  if (gscRes.status === "fulfilled") {
    payload.gsc = gscRes.value;
  } else {
    payload.gsc = { ok: false, message: gscRes.reason?.message ?? String(gscRes.reason) };
    console.warn("[seo-stats] GSC fetch failed:", gscRes.reason?.message ?? gscRes.reason);
  }
  if (ga4Res.status === "fulfilled") {
    payload.ga4 = ga4Res.value;
  } else {
    payload.ga4 = { ok: false, message: ga4Res.reason?.message ?? String(ga4Res.reason) };
    console.warn("[seo-stats] GA4 fetch failed:", ga4Res.reason?.message ?? ga4Res.reason);
  }
  return payload;
}

// ---------- Re-exports for the SEO keyword console ----------------------
// The keyword console needs the ["page","query"] dimension pairing, which the
// dashboard payload above does not expose (it fetches page and query as
// separate dimensions). Rather than duplicate the auth + fetch plumbing, hand
// the primitives out and let server/seo-keywords.ts compose its own request.

/** Access token for Search Console, or null when Google is not configured. */
export async function getAccessTokenForSeo(): Promise<string | null> {
  const { token } = await getAccessToken();
  return token ?? null;
}

/** The configured Search Console property (e.g. sc-domain:riversrealestate.ca). */
export function gscSiteUrl(): string {
  return process.env.GSC_SITE_URL || `sc-domain:${publicOrigin().replace(/^https?:\/\//, "")}`;
}

/** Raw searchAnalytics.query passthrough. */
export async function gscQueryRaw(
  token: string,
  siteUrl: string,
  body: Record<string, unknown>,
): Promise<any> {
  return gscQuery(token, siteUrl, body);
}
