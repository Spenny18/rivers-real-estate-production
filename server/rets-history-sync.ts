// Sold and off-market listings from Pillar 9.
//
// The active sync (rets-sync.ts) asks the feed for StandardStatus A and marks
// whatever disappears as Removed, so until now a sale was indistinguishable
// from an expiry and no sale price was ever recorded. The probe in
// rets-sold-probe.ts established, against the live feed, that:
//
//   - S is the sold status; X, W and T are Expired, Withdrawn and Terminated.
//   - ClosePrice, CloseDate and DaysOnMarket are selectable.
//   - A CloseDate bound is accepted, and the feed holds roughly two years of
//     sold history (the count stopped growing between the 25- and 61-month
//     windows), so a backfill of ~25 months is the whole of what exists.
//
// Two modes:
//
//   backfill    Walk month windows from `months` ago to today, per status,
//               and upsert everything. Run once, or again if history is lost.
//   incremental Re-fetch the last 45 days per status. Sales close and get
//               reported with a lag, and statuses change after the fact, so a
//               generous overlap re-read costs a few thousand rows and keeps
//               the table right; upserts make it idempotent.
//
// Windows are bounded on both ends so a month is a few hundred to a couple of
// thousand rows, well inside what offset paging handles. Paging is driven by
// the COUNT the feed returns rather than "fewer rows than asked for", because a
// server that silently caps a page would otherwise end the walk early.
//
// The feed was not probed for the exact date-range grammar it accepts on a
// timestamp field, so the query shape is negotiated: the first shape the feed
// accepts for a field is remembered for the rest of the process.

import { RetsClient, RetsAuthError } from "./rets-client";
import { storage } from "./storage";
import type { InsertMlsHistory } from "@shared/schema";

export const OFF_MARKET_STATUSES = ["S", "X", "W", "T"] as const;
export type OffMarketStatus = (typeof OFF_MARKET_STATUSES)[number];

/** Everything the stats engine reads. All of these are known-selectable. */
const SELECT_FIELDS = [
  "ListingId",
  "StandardStatus",
  "ListPrice",
  "ClosePrice",
  "CloseDate",
  "ListingContractDate",
  "DaysOnMarket",
  "PropertyType",
  "PropertySubType",
  "City",
  "PostalCode",
  "SubdivisionName",
  "District",
  "UnparsedAddress",
  "Latitude",
  "Longitude",
  "BedroomsTotal",
  "BathroomsTotalInteger",
  "LivingAreaSF",
  "YearBuilt",
  "StatusChangeTimestamp",
  "ModificationTimestamp",
  "MlsStatus",
].join(",");

const PAGE_SIZE = 500;
const INCREMENTAL_DAYS = 45;
export const DEFAULT_BACKFILL_MONTHS = 25;

// ---- Progress, visible to the admin while a run is going --------------------

export interface HistoryProgress {
  running: boolean;
  mode: "backfill" | "incremental" | null;
  startedAt: string | null;
  finishedAt: string | null;
  windows: number;
  windowsDone: number;
  currentWindow: string | null;
  fetched: number;
  upserted: number;
  errors: string[];
  lastError: string | null;
}

const progress: HistoryProgress = {
  running: false,
  mode: null,
  startedAt: null,
  finishedAt: null,
  windows: 0,
  windowsDone: 0,
  currentWindow: null,
  fetched: 0,
  upserted: 0,
  errors: [],
  lastError: null,
};

export function getHistoryProgress(): HistoryProgress {
  return { ...progress, errors: [...progress.errors] };
}

// ---- Row normalisation ------------------------------------------------------

function text(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function int(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "2026-06-25", "2026-06-25T14:03:00", "2026-06-25 14:03:00" → "2026-06-25". */
function day(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/**
 * The feed is queried by code (S, X, W, T) but COMPACT-DECODED replies carry
 * the lookup's long value ("Sold", "Expired", …). The first production
 * backfill fetched 144,000 rows and kept none of them because this only
 * accepted the codes. Both spellings are accepted now.
 */
const STATUS_CODES: Record<string, OffMarketStatus> = {
  S: "S", SOLD: "S", CLOSED: "S",
  X: "X", EXPIRED: "X",
  W: "W", WITHDRAWN: "W",
  T: "T", TERMINATED: "T", CANCELLED: "T", CANCELED: "T",
};

export function statusCode(raw: unknown): OffMarketStatus | null {
  const s = text(raw);
  return s ? STATUS_CODES[s.toUpperCase()] ?? null : null;
}

export function normalizeHistoryRow(row: Record<string, string>): InsertMlsHistory | null {
  const id = text(row.ListingId);
  const status = statusCode(row.StandardStatus) ?? statusCode(row.MlsStatus);
  if (!id || !status) return null;

  const closeDate = status === "S" ? day(row.CloseDate) : null;
  const statusChangedAt = text(row.StatusChangeTimestamp);
  const offMarketDate =
    closeDate ?? day(statusChangedAt) ?? day(row.ModificationTimestamp);

  return {
    id,
    status,
    listPrice: int(row.ListPrice),
    closePrice: status === "S" ? int(row.ClosePrice) : null,
    closeDate,
    listDate: day(row.ListingContractDate),
    offMarketDate,
    daysOnMarket: int(row.DaysOnMarket),
    propertyType: text(row.PropertyType),
    propertySubType: text(row.PropertySubType),
    city: text(row.City),
    postalCode: text(row.PostalCode),
    subdivision: text(row.SubdivisionName),
    district: text(row.District),
    fullAddress: text(row.UnparsedAddress),
    lat: num(row.Latitude),
    lng: num(row.Longitude),
    beds: int(row.BedroomsTotal),
    baths: num(row.BathroomsTotalInteger),
    sqft: int(row.LivingAreaSF),
    yearBuilt: int(row.YearBuilt),
    statusChangedAt,
    modifiedAt: text(row.ModificationTimestamp),
    syncedAt: new Date().toISOString(),
  };
}

// ---- Windows ----------------------------------------------------------------

export interface Window {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Calendar-month windows covering `months` months up to and including today. */
export function monthWindows(months: number, now = new Date()): Window[] {
  const out: Window[] = [];
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  for (let i = 0; i < months; i++) {
    const start = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const to = end > now ? now : end;
    out.push({ from: iso(start), to: iso(to) });
    if (to === now) break;
  }
  return out;
}

export function recentWindow(days: number, now = new Date()): Window {
  return { from: iso(new Date(now.getTime() - days * 86_400_000)), to: iso(now) };
}

// ---- Query shape negotiation ------------------------------------------------

/** The field that dates a listing's exit for each status. */
function dateField(status: OffMarketStatus): string {
  return status === "S" ? "CloseDate" : "StatusChangeTimestamp";
}

/**
 * Candidate DMQL2 shapes for a bounded window, most precise first. A plain
 * date field wants dates; a timestamp field may want full timestamps, may
 * accept dates, or may only take a lower bound.
 */
function shapesFor(field: string, w: Window): string[] {
  if (field === "CloseDate") {
    return [`(${field}=${w.from}-${w.to})`, `(${field}=${w.from}+)`];
  }
  return [
    `(${field}=${w.from}T00:00:00-${w.to}T23:59:59)`,
    `(${field}=${w.from}-${w.to})`,
    `(${field}=${w.from}T00:00:00+)`,
  ];
}

/** Index of the shape each field has been seen to accept, for this process. */
const acceptedShape = new Map<string, number>();

/**
 * Pillar 9 caps concurrent queries per login ("20210: Too many outstanding
 * queries"), and the hourly active sync runs alongside this one. Back off
 * and retry rather than fail the window.
 */
async function searchWithRetry(client: RetsClient, opts: Parameters<RetsClient["search"]>[0]) {
  const waits = [20_000, 45_000, 90_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.search(opts);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const transient = /20210|Too many outstanding|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(msg);
      if (!transient || attempt >= waits.length) throw e;
      console.warn(`[mls-history] ${msg.slice(0, 80)} — retrying in ${waits[attempt] / 1000}s`);
      await new Promise((r) => setTimeout(r, waits[attempt]));
    }
  }
}

/** True once the feed has been seen to accept only the open-ended shape. */
function lowerBoundOnly(field: string): boolean {
  const i = acceptedShape.get(field);
  if (i == null) return false;
  return i === shapesFor(field, { from: "2000-01-01", to: "2000-01-31" }).length - 1;
}

function isSyntaxRejection(e: unknown): boolean {
  return /20206|Invalid Query Syntax|20203/i.test(String((e as any)?.message ?? e));
}

// ---- The sync ---------------------------------------------------------------

let running = false;

export function isHistorySyncRunning(): boolean {
  return running;
}

export interface HistorySyncResult {
  status: "success" | "error" | "skipped" | "busy";
  fetched: number;
  upserted: number;
  errorMessage?: string;
}

export async function runHistorySync(opts: {
  mode: "backfill" | "incremental";
  months?: number;
  /** Injected for tests; production constructs from env. */
  client?: RetsClient;
}): Promise<HistorySyncResult> {
  if (process.env.RETS_SYNC_ENABLED !== "true" && !opts.client) {
    return { status: "skipped", fetched: 0, upserted: 0 };
  }
  if (running) return { status: "busy", fetched: 0, upserted: 0, errorMessage: "A history sync is already running." };
  running = true;

  const months = Math.max(1, Math.min(120, opts.months ?? DEFAULT_BACKFILL_MONTHS));
  const windows = opts.mode === "backfill" ? monthWindows(months) : [recentWindow(INCREMENTAL_DAYS)];

  Object.assign(progress, {
    running: true,
    mode: opts.mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    windows: windows.length * OFF_MARKET_STATUSES.length,
    windowsDone: 0,
    currentWindow: null,
    fetched: 0,
    upserted: 0,
    errors: [],
    lastError: null,
  });

  const run = storage.startSyncRun({
    source: opts.mode === "backfill" ? "pillar9-history-backfill" : "pillar9-history",
  });
  console.log(`[mls-history] ${opts.mode} run #${run.id} — ${windows.length} window(s)`);

  const client =
    opts.client ??
    new RetsClient({
      loginUrl: process.env.RETS_LOGIN_URL!,
      username: process.env.RETS_USERNAME!,
      password: process.env.RETS_PASSWORD!,
      userAgent: process.env.RETS_USER_AGENT ?? "RiversRealEstate/1.0",
      uaPassword: process.env.RETS_UA_PASSWORD || undefined,
    });

  let fetched = 0;
  let upserted = 0;

  try {
    await client.login();

    for (const status of OFF_MARKET_STATUSES) {
      const field = dateField(status);
      for (const w of windows) {
        progress.currentWindow = `${status} ${w.from}..${w.to}`;
        try {
          const r = await fetchWindow(client, status, field, w);
          fetched += r.fetched;
          upserted += r.upserted;
          progress.fetched = fetched;
          progress.upserted = upserted;
          // If the only shape the feed accepts for this field is a lower bound,
          // the first window — the oldest — has already fetched everything
          // after it. Walking the remaining windows would re-fetch the same
          // rows twenty-four more times.
          if (lowerBoundOnly(field)) {
            progress.windowsDone += windows.length - windows.indexOf(w) - 1;
            break;
          }
        } catch (e: any) {
          const msg = `${status} ${w.from}..${w.to}: ${String(e?.message ?? e).slice(0, 200)}`;
          progress.errors.push(msg);
          progress.lastError = msg;
          console.error(`[mls-history] window failed — ${msg}`);
          if (e instanceof RetsAuthError) throw e;
        } finally {
          progress.windowsDone++;
        }
      }
    }

    const status = progress.errors.length === 0 ? "success" : "error";
    const errorMessage =
      progress.errors.length > 0
        ? `${progress.errors.length} window(s) failed; last: ${progress.lastError}`
        : undefined;
    storage.finishSyncRun(run.id, { status, fetched, upserted, removed: 0, errorMessage });
    console.log(`[mls-history] run #${run.id} ${status}: fetched=${fetched} upserted=${upserted}`);
    return { status, fetched, upserted, errorMessage };
  } catch (err: any) {
    const message = err instanceof RetsAuthError ? `RETS auth failed: ${err.message}` : err?.message || String(err);
    console.error(`[mls-history] run #${run.id} failed:`, message);
    storage.finishSyncRun(run.id, { status: "error", fetched, upserted, removed: 0, errorMessage: message });
    progress.lastError = message;
    return { status: "error", fetched, upserted, errorMessage: message };
  } finally {
    running = false;
    progress.running = false;
    progress.currentWindow = null;
    progress.finishedAt = new Date().toISOString();
    try {
      await client.logout();
    } catch {}
  }
}

/** One status, one window: negotiate the shape, then page through the COUNT. */
async function fetchWindow(
  client: RetsClient,
  status: OffMarketStatus,
  field: string,
  w: Window,
): Promise<{ fetched: number; upserted: number }> {
  const shapes = shapesFor(field, w);
  const start = acceptedShape.get(field) ?? 0;

  let fetched = 0;
  let upserted = 0;

  for (let i = start; i < shapes.length; i++) {
    const query = `(StandardStatus=|${status}),${shapes[i]}`;
    let offset = 0;
    let total: number | null = null;
    try {
      while (true) {
        const r = await searchWithRetry(client, {
          resource: "Property",
          class: "Property",
          query,
          select: SELECT_FIELDS,
          limit: PAGE_SIZE,
          offset,
        });
        // The shape is accepted the moment a search returns rather than throws.
        acceptedShape.set(field, i);
        if (total == null) total = r.total > 0 ? r.total : null;

        const rows: InsertMlsHistory[] = [];
        for (const raw of r.rows) {
          const row = normalizeHistoryRow(raw);
          if (row) rows.push(row);
        }
        fetched += r.rows.length;
        upserted += storage.upsertMlsHistory(rows);

        offset += r.rows.length;
        if (r.rows.length === 0) break;
        if (total != null ? offset >= total : r.rows.length < PAGE_SIZE) break;
        // A lower-bound-only shape has no upper bound, so a runaway walk is
        // possible in principle. Two years of Alberta sales is ~100k rows;
        // stop well past that.
        if (offset > 250_000) break;
      }
      return { fetched, upserted };
    } catch (e) {
      // Only a grammar rejection means "try the next shape". Anything else
      // (auth, network, a mid-walk failure) is a real error for this window.
      if (isSyntaxRejection(e) && offset === 0 && i + 1 < shapes.length) continue;
      throw e;
    }
  }
  throw new Error(`no accepted query shape for ${field}`);
}

// ---- Cron -------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

export function startHistorySyncCron() {
  if (process.env.RETS_SYNC_ENABLED !== "true") {
    console.log("[mls-history] disabled (RETS_SYNC_ENABLED != true)");
    return;
  }
  if (timer) return;
  const intervalHours = Math.max(1, Number(process.env.RETS_HISTORY_SYNC_INTERVAL_HOURS ?? "6"));
  console.log(`[mls-history] scheduled every ${intervalHours}h`);

  // First run 90s after boot, after the active sync has had its head start.
  // An empty table gets the backfill rather than a 45-day slice, so a fresh
  // deploy fills itself without anyone having to press anything. So does a
  // backfill a redeploy cut off mid-walk: the run row it left behind still
  // says "running", which nothing else can leave behind, so that is the
  // signal to start over rather than settle for a half-filled table.
  setTimeout(() => {
    const summary = storage.mlsHistorySummary();
    const interrupted = storage.reconcileInterruptedHistoryRuns();
    const mode = summary.rows === 0 || interrupted > 0 ? "backfill" : "incremental";
    if (interrupted > 0) console.log(`[mls-history] ${interrupted} run(s) were cut off by a restart — backfilling again`);
    runHistorySync({ mode }).catch((err) => console.error("[mls-history] uncaught:", err));
  }, 90_000);
  timer = setInterval(() => {
    runHistorySync({ mode: "incremental" }).catch((err) => console.error("[mls-history] uncaught:", err));
  }, intervalHours * 60 * 60 * 1000);
}
