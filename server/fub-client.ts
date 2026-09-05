// Follow Up Boss REST client — the read side.
//
// server/follow-up-boss.ts already pushes new inquiries in via POST /v1/events.
// This module is the other direction: paging whole collections back out so the
// CRM mirror in /admin/crm can be built from them.
//
// Auth is HTTP Basic with the API key as the username and an EMPTY password.
// That is Follow Up Boss's published convention, not a mistake — the same
// scheme follow-up-boss.ts has been using in production.
//
// Required env:
//   FUB_API_KEY      from FUB > Admin > API
//   FUB_SYSTEM       (opt) X-System header, default "RiversRealEstate"
//   FUB_SYSTEM_KEY   (opt) paired X-System-Key, if the tenant enforces it
//
// ---------------------------------------------------------------------------
// A NOTE ON SHAPES
//
// This was written without access to docs.followupboss.com (blocked by the
// build environment's egress proxy), so the *envelope* handling below is
// deliberately permissive rather than pinned to one documented layout:
// `extractCollection` finds the array wherever it sits, and `nextPageParams`
// understands cursor, next-link and offset styles. That way a wrong guess
// costs a fallback branch, not a failed sync.
//
// `probe()` exists to close the gap for real: run it against a live key and it
// reports the actual envelope, keys and field names, so the mapping in
// fub-sync.ts can be corrected from evidence instead of assumption.

const BASE = "https://api.followupboss.com/v1";

export interface FubResponse<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  /** Seconds the server asked us to wait, from Retry-After on a 429. */
  retryAfter?: number;
}

export function fubConfigured(): boolean {
  return !!process.env.FUB_API_KEY?.trim();
}

function authHeaders(): Record<string, string> {
  const apiKey = process.env.FUB_API_KEY ?? "";
  const headers: Record<string, string> = {
    // API key as username, blank password.
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const sysName = process.env.FUB_SYSTEM ?? "RiversRealEstate";
  if (sysName) headers["X-System"] = sysName;
  if (process.env.FUB_SYSTEM_KEY) headers["X-System-Key"] = process.env.FUB_SYSTEM_KEY;
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One GET, with retry on 429 and 5xx.
 *
 * Follow Up Boss rate-limits per key. Rather than hardcode a budget that may
 * be wrong, this honours `Retry-After` when the server sends one and falls
 * back to exponential backoff when it doesn't.
 */
export async function fubGet<T = any>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<FubResponse<T>> {
  if (!fubConfigured()) {
    return { ok: false, status: 0, error: "FUB_API_KEY not set" };
  }
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}${
    qs.toString() ? `?${qs}` : ""
  }`;

  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: authHeaders(),
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        lastError = `HTTP ${res.status}`;
        if (attempt < retries) {
          // Retry-After when given, else 1s/2s/4s.
          await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        return { ok: false, status: res.status, error: lastError, retryAfter };
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // 401/403 are terminal — a wrong key or a missing add-on (Deals lives
        // behind a plan gate) will never succeed on retry.
        return { ok: false, status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}` };
      }

      const data = (await res.json().catch(() => null)) as T;
      return { ok: true, status: res.status, data: data ?? (undefined as any) };
    } catch (e: any) {
      lastError = e?.name === "AbortError" ? "timeout" : e?.message ?? "fetch failed";
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return { ok: false, status: 0, error: lastError };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, error: lastError || "exhausted retries" };
}

// ---- Envelope handling -----------------------------------------------------

/** Metadata keys a paged response might carry, whatever the envelope shape. */
const META_KEYS = ["_metadata", "metadata", "meta"];

export function extractMeta(body: any): Record<string, any> {
  if (!body || typeof body !== "object") return {};
  for (const k of META_KEYS) {
    if (body[k] && typeof body[k] === "object") return body[k];
  }
  return {};
}

/**
 * Pull the records array out of a response body.
 *
 * Prefers the collection named after the resource (`people`, `deals`, …),
 * then any other array-valued property that isn't metadata, then the body
 * itself if the endpoint returned a bare array. Returns [] rather than
 * throwing, so one odd endpoint can't abort a whole sync.
 */
export function extractCollection(body: any, preferredKey?: string): any[] {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (typeof body !== "object") return [];

  if (preferredKey && Array.isArray(body[preferredKey])) return body[preferredKey];

  for (const [k, v] of Object.entries(body)) {
    if (META_KEYS.includes(k)) continue;
    if (Array.isArray(v)) return v as any[];
  }
  return [];
}

/**
 * Work out how to ask for the next page, or null when there isn't one.
 *
 * Handles the three styles a JSON API of this vintage plausibly uses — an
 * explicit next cursor, a next URL to parse params out of, or plain
 * offset/limit arithmetic — because which one FUB uses could not be checked
 * from this environment.
 */
export function nextPageParams(
  body: any,
  current: { offset: number; limit: number },
  received: number,
): Record<string, string | number> | null {
  const meta = extractMeta(body);

  // 1. An explicit cursor.
  const cursor = meta.next ?? meta.nextCursor ?? meta.cursor;
  if (typeof cursor === "string" && cursor && !/^https?:\/\//i.test(cursor)) {
    return { next: cursor, limit: current.limit };
  }

  // 2. A next link — lift its query params so we don't have to guess names.
  const link = meta.nextLink ?? meta.next_url ?? (typeof cursor === "string" ? cursor : null);
  if (typeof link === "string" && /^https?:\/\//i.test(link)) {
    try {
      const u = new URL(link);
      const out: Record<string, string> = {};
      u.searchParams.forEach((v, k) => (out[k] = v));
      return Object.keys(out).length > 0 ? out : null;
    } catch {
      /* fall through to offset arithmetic */
    }
  }

  // 3. Offset/limit. Stop on a short page, or once total is reached.
  if (received < current.limit) return null;
  const total = Number(meta.total ?? meta.totalCount ?? NaN);
  const nextOffset = current.offset + received;
  if (Number.isFinite(total) && nextOffset >= total) return null;
  return { offset: nextOffset, limit: current.limit };
}

/**
 * Build the `next` cursor for "everything after record N".
 *
 * Follow Up Boss's paging cursors are base64 JSON: the nextLink on a live
 * response reads `next=eyJzaW5jZUlkIjo1OTk0fQ`, which decodes to
 * {"sinceId":5994} — the id after the last record on that page. Collection
 * endpoints page ascending by id, so minting the same cursor from the highest
 * id already mirrored asks for exactly the records that arrived since.
 *
 * That is read off observed responses, not documentation, so every caller
 * treats it as a request that may be rejected: syncResource retries the whole
 * resource without it on a 4xx rather than letting a rejected cursor look like
 * an outage.
 */
export function sinceIdCursor(lastId: string | number): string {
  return Buffer.from(JSON.stringify({ sinceId: Number(lastId) })).toString("base64url");
}

export interface PageOptions {
  /** Extra query params, e.g. an incremental `updatedAfter` filter. */
  params?: Record<string, string | number | undefined>;
  /**
   * Start from this `next` cursor instead of offset 0. Offset is then omitted
   * entirely — sending both invites the API to honour the wrong one.
   */
  startCursor?: string;
  /** Page size. FUB caps this; 100 is the conventional maximum. */
  limit?: number;
  /**
   * Hard ceiling on records collected in one call. The page cap is derived
   * from this rather than set independently — the two disagreeing is how a
   * "25,000 record limit" silently became 10,000.
   */
  maxRecords?: number;
  /** Extra page headroom on top of maxRecords/limit, for a paging bug. */
  maxPages?: number;
  /** Courtesy pause between pages, to stay clear of the rate limit. */
  pauseMs?: number;
}

export interface PageResult {
  ok: boolean;
  records: any[];
  pages: number;
  status?: number;
  error?: string;
  /**
   * True when a safety cutoff stopped paging while the API still had more.
   * Callers must not treat a truncated run as a complete one: for a resource
   * with no incremental filter, re-fetching the same first N every hour would
   * mean the remainder never mirrors at all.
   */
  truncated?: boolean;
  /** The first body seen, kept so callers can report the real shape. */
  sampleBody?: any;
}

/** Page through a collection endpoint until it runs out. */
export async function fubGetAll(
  path: string,
  collectionKey: string,
  opts: PageOptions = {},
): Promise<PageResult> {
  const limit = opts.limit ?? 100;
  const maxRecords = opts.maxRecords ?? 25_000;
  // Enough pages to actually reach maxRecords, plus a little headroom for a
  // short page, rather than an independent number that silently wins.
  const maxPages = opts.maxPages ?? Math.ceil(maxRecords / limit) + 5;
  const pauseMs = opts.pauseMs ?? 250;

  const records: any[] = [];
  let params: Record<string, string | number | undefined> = opts.startCursor
    ? { ...(opts.params ?? {}), next: opts.startCursor, limit }
    : { ...(opts.params ?? {}), offset: 0, limit };
  let sampleBody: any;
  let pages = 0;
  let truncated = false;

  for (; pages < maxPages; pages++) {
    const r = await fubGet(path, params);
    if (!r.ok) {
      // Partial data is still worth keeping — the caller records the error
      // and what it managed to collect before hitting it.
      return {
        ok: false,
        records,
        pages,
        status: r.status,
        error: r.error,
        sampleBody,
      };
    }
    if (pages === 0) sampleBody = r.data;

    const batch = extractCollection(r.data, collectionKey);
    records.push(...batch);

    // A page with no records is the end, whatever the envelope says. Follow Up
    // Boss puts a `next` cursor in _metadata on every response, so trusting the
    // cursor alone would walk the full page budget fetching nothing — which is
    // exactly what an incremental run that is already up to date returns.
    if (batch.length === 0) break;

    const next = nextPageParams(r.data, {
      offset: Number(params.offset ?? 0),
      limit,
    }, batch.length);

    // Record cutoff. Trim to the stated ceiling rather than overshooting to
    // the page boundary, so maxRecords means what it says; `truncated` is only
    // true if the API actually had more beyond it.
    if (records.length >= maxRecords) {
      truncated = !!next || records.length > maxRecords;
      records.length = maxRecords;
      break;
    }
    if (!next) break;

    params = { ...(opts.params ?? {}), ...next };
    if (pauseMs > 0) await sleep(pauseMs);
  }

  // Ran out of pages with the API still offering more.
  if (pages >= maxPages) truncated = true;

  return { ok: true, records, pages: Math.min(pages + 1, maxPages), truncated, sampleBody };
}

// ---- Probe -----------------------------------------------------------------

export interface ProbeResource {
  resource: string;
  path: string;
  ok: boolean;
  status: number;
  /** How many records the first page returned. */
  count?: number;
  /** Top-level keys of the response envelope. */
  envelopeKeys?: string[];
  /** Whatever metadata object came back, verbatim. */
  metadata?: Record<string, any>;
  /** Field names present on the first record. */
  recordKeys?: string[];
  error?: string;
  /** Human note — e.g. that Deals needs a plan that includes it. */
  note?: string;
}

/**
 * Ask the live API what it actually returns.
 *
 * Fetches exactly one small page per resource and reports the envelope, the
 * metadata and the field names — enough to confirm or correct the mapping in
 * fub-sync.ts without shipping another guess. Deliberately never returns
 * record *values*: field names are what's needed, and contact data shouldn't
 * be splashed through an admin diagnostic.
 */
export async function probe(): Promise<{
  configured: boolean;
  resources: ProbeResource[];
}> {
  if (!fubConfigured()) return { configured: false, resources: [] };

  const targets: Array<{ resource: string; path: string; note?: string }> = [
    { resource: "people", path: "/people" },
    { resource: "deals", path: "/deals", note: "Deals is a plan add-on; 403 here means it isn't enabled." },
    { resource: "pipelines", path: "/pipelines" },
    { resource: "stages", path: "/stages" },
    { resource: "events", path: "/events" },
    { resource: "tasks", path: "/tasks" },
    { resource: "appointments", path: "/appointments" },
    { resource: "calls", path: "/calls", note: "FUB's calling runs on Twilio underneath." },
    { resource: "textMessages", path: "/textMessages" },
    { resource: "users", path: "/users" },
  ];

  const resources: ProbeResource[] = [];
  for (const t of targets) {
    const r = await fubGet(t.path, { limit: 1, offset: 0 });
    if (!r.ok) {
      resources.push({
        resource: t.resource,
        path: t.path,
        ok: false,
        status: r.status,
        error: (r.error ?? "").slice(0, 300),
        note: t.note,
      });
    } else {
      const body = r.data;
      const rows = extractCollection(body, t.resource);
      resources.push({
        resource: t.resource,
        path: t.path,
        ok: true,
        status: r.status,
        count: rows.length,
        envelopeKeys: body && typeof body === "object" && !Array.isArray(body)
          ? Object.keys(body)
          : ["<array>"],
        metadata: extractMeta(body),
        recordKeys: rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]) : [],
        note: t.note,
      });
    }
    await sleep(200);
  }
  return { configured: true, resources };
}

/** Cheap credential check for the admin's connection card. */
export async function testConnection(): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  accountHint?: string;
}> {
  const r = await fubGet("/people", { limit: 1 });
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error:
        r.status === 401
          ? "Follow Up Boss rejected the API key."
          : r.status === 403
            ? "The key is valid but lacks permission for this resource."
            : r.error,
    };
  }
  const meta = extractMeta(r.data);
  const total = meta.total ?? meta.totalCount;
  return {
    ok: true,
    status: r.status,
    accountHint: total != null ? `${total} people visible to this key` : undefined,
  };
}
