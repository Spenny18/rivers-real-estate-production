// Find out whether — and how — this RETS feed will hand over sold listings.
//
// The active sync queries `(StandardStatus=|A)`. Sold data needs a different
// status value, and possibly different fields, and three things about it are
// unknown from here:
//
//   1. What the feed calls sold. RESO's StandardStatus enumerates "Closed",
//      but boards commonly expose "Sold", and the lookup VALUE sent in DMQL2
//      is often a short code ("S") rather than the human label.
//   2. Whether ClosePrice and CloseDate are selectable. Without a sale price
//      there is no market report; without a close date there is no way to
//      bucket sales into months.
//   3. Whether the licence permits any of it. Sold data is commonly gated
//      separately from IDX, and the feed answers that with a 401 or an empty
//      result rather than an explanation.
//
// Guessing at all three and writing a sync against the guess is exactly how
// the Follow Up Boss mapping went wrong earlier: seven fields mapped to names
// that resource did not use, discovered only once real data arrived. So this
// asks the feed first and reports what it says.
//
// It is strictly read-only: metadata lookups, and searches capped at a single
// row. Nothing is written to the database.

import { RetsClient, RetsAuthError } from "./rets-client";

export interface StatusLookup {
  value: string;
  longValue?: string;
  shortValue?: string;
}

export interface SoldAttempt {
  query: string;
  ok: boolean;
  rows: number;
  /** Field names present on the returned row, when there was one. */
  fields?: string[];
  /** The sale-relevant fields, called out because they are the point. */
  saleFields?: Record<string, string | null>;
  error?: string;
}

/**
 * How many sold rows the feed holds behind a close-date bound. This is what
 * decides whether the 13-month and 10-year charts can be backfilled in one
 * pass or have to accumulate month by month from today.
 */
export interface SoldHistoryWindow {
  monthsBack: number;
  since: string;
  query: string;
  /** Rows the feed reports for the window, or null when the query failed. */
  total: number | null;
  error?: string;
}

export interface SoldProbeResult {
  configured: boolean;
  loggedIn: boolean;
  /** Every value StandardStatus accepts, straight from the feed's metadata. */
  statusLookups: StatusLookup[];
  /** Which of the candidate sale fields the Property class actually defines. */
  saleFieldsInMetadata: string[];
  attempts: SoldAttempt[];
  /** Filled in once a working sold query is found. */
  history: SoldHistoryWindow[];
  verdict: string;
  error?: string;
}

/** Fields a market report needs, beyond what the active sync already selects. */
const SALE_FIELDS = [
  "ClosePrice",
  "CloseDate",
  "OriginalListPrice",
  "DaysOnMarket",
  "CumulativeDaysOnMarket",
  "PurchaseContractDate",
  "ListPrice",
];

/**
 * Status values worth trying, most-likely first. Only used when the feed's
 * metadata declines to say what it calls sold — when it does say, guessing
 * alongside it just produces a column of "Invalid Query Syntax" rejections
 * that read as a licence problem when they are nothing of the kind.
 */
const CANDIDATE_STATUSES = ["S", "Closed", "Sold", "C", "SLD"];

/**
 * The first run of this probe against Pillar 9 was misread because of two
 * things fixed here:
 *
 *   - Dates went out as `20260614`. DMQL2 dates are ISO (`2026-06-14`), so
 *     every date-bounded query was a syntax error regardless of status.
 *   - The select list asked for every candidate sale field, and the one
 *     query with a valid status and no date failed with "Invalid Select
 *     Field(s)" naming the three this board doesn't define. That error means
 *     the sold query itself was accepted — the server had parsed it and moved
 *     on to validating columns — but the verdict counted it as a rejection.
 *
 * So the select is now built from what the metadata declares, and a
 * select-field complaint is reported as what it is.
 */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** First of the month, `monthsBack` months ago, as an ISO date. */
function isoMonthsBack(monthsBack: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return d.toISOString().slice(0, 10);
}

/** Calgary proper: the postal prefix the active sync already scopes to. */
const CALGARY_POSTAL = "T2*";

/** Windows to size for backfill: a year of charts, then two, five and ten. */
const HISTORY_WINDOWS = [13, 25, 61, 121];

function retsConfigured(): boolean {
  return !!(process.env.RETS_LOGIN_URL && process.env.RETS_USERNAME && process.env.RETS_PASSWORD);
}

/** Pull the StandardStatus lookup table out of the feed's metadata. */
async function readStatusLookups(client: RetsClient): Promise<StatusLookup[]> {
  const out: StatusLookup[] = [];
  try {
    const md: any = await client.getMetadata({ type: "METADATA-LOOKUP_TYPE", id: "Property:StandardStatus" });
    // The shape varies by server; walk it defensively rather than assuming a
    // path, and take anything that looks like a lookup row.
    const stack = [md];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      const value = node.Value ?? node.value;
      if (value !== undefined && value !== null && String(value).length <= 40) {
        out.push({
          value: String(value),
          longValue: node.LongValue != null ? String(node.LongValue) : undefined,
          shortValue: node.ShortValue != null ? String(node.ShortValue) : undefined,
        });
      }
      stack.push(...Object.values(node));
    }
  } catch {
    /* Metadata is a nicety; the search attempts below are the real evidence. */
  }
  // De-duplicate, preserving order.
  const seen = new Set<string>();
  return out.filter((l) => (seen.has(l.value) ? false : (seen.add(l.value), true)));
}

/** Which of the sale fields the Property class actually defines. */
async function readSaleFields(client: RetsClient): Promise<string[]> {
  try {
    const md: any = await client.getMetadata({ type: "METADATA-TABLE", id: "Property:Property" });
    const blob = JSON.stringify(md);
    return SALE_FIELDS.filter((f) => new RegExp(`"${f}"`).test(blob));
  } catch {
    return [];
  }
}

export async function probeSoldListings(): Promise<SoldProbeResult> {
  const base: SoldProbeResult = {
    configured: retsConfigured(),
    loggedIn: false,
    statusLookups: [],
    saleFieldsInMetadata: [],
    attempts: [],
    history: [],
    verdict: "",
  };
  if (!base.configured) {
    return { ...base, verdict: "RETS credentials are not set on this deploy." };
  }

  const client = new RetsClient({
    loginUrl: process.env.RETS_LOGIN_URL!,
    username: process.env.RETS_USERNAME!,
    password: process.env.RETS_PASSWORD!,
    userAgent: process.env.RETS_USER_AGENT ?? "RiversRealEstate/1.0",
    uaPassword: process.env.RETS_UA_PASSWORD || undefined,
  });

  try {
    await client.login();
    base.loggedIn = true;
  } catch (e: any) {
    return {
      ...base,
      verdict:
        e instanceof RetsAuthError
          ? `Could not log in to the feed: ${e.message}`
          : `Login failed: ${String(e?.message ?? e).slice(0, 200)}`,
      error: String(e?.message ?? e).slice(0, 300),
    };
  }

  base.statusLookups = await readStatusLookups(client);
  base.saleFieldsInMetadata = await readSaleFields(client);

  // Prefer status values the feed itself declares. Only when its metadata says
  // nothing do the guesses get a turn.
  const declared = base.statusLookups
    .filter((l) => /sold|closed/i.test(`${l.value} ${l.longValue ?? ""} ${l.shortValue ?? ""}`))
    .map((l) => l.value);
  const toTry = declared.length > 0 ? declared : CANDIDATE_STATUSES;

  // Only ask for columns the feed defines. If the metadata read failed, fall
  // back to the two fields without which there is no market report.
  const saleSelect =
    base.saleFieldsInMetadata.length > 0
      ? base.saleFieldsInMetadata
      : ["ClosePrice", "CloseDate"];
  const select = [...saleSelect, "ListingId", "City", "PostalCode", "StandardStatus"].join(",");

  // One narrow, recent window: enough to prove access without asking the feed
  // for years of history during a diagnostic.
  const since = isoDaysAgo(90);

  let working: { status: string; dateBound: boolean } | null = null;

  for (const status of toTry) {
    // Two shapes: with a close-date bound, and without. If the first fails but
    // the second works, the status is right and the date field is wrong, which
    // is a materially different fix.
    for (const [q, dateBound] of [
      [`(StandardStatus=|${status}),(CloseDate=${since}+)`, true],
      [`(StandardStatus=|${status}),(PostalCode=${CALGARY_POSTAL})`, false],
    ] as const) {
      try {
        const r = await client.search({
          resource: "Property",
          class: "Property",
          query: q,
          select,
          limit: 1,
          offset: 0,
        });
        const row = r.rows[0];
        base.attempts.push({
          query: q,
          ok: true,
          rows: r.total > 0 ? r.total : r.rows.length,
          fields: row ? Object.keys(row) : [],
          // Values, not just names, for the sale fields only — a close price
          // and date are what decide whether a market report is possible, and
          // one row of them is not a data leak.
          saleFields: row
            ? Object.fromEntries(
                saleSelect.map((f) => [f, row[f] != null ? String(row[f]) : null]),
              )
            : undefined,
        });
        if (r.rows.length > 0 && !working) working = { status, dateBound };
      } catch (e: any) {
        base.attempts.push({
          query: q,
          ok: false,
          rows: 0,
          error: String(e?.message ?? e).slice(0, 200),
        });
      }
    }
    if (working) break;
  }

  // With a working status, size the history. Count-only in effect: Limit=1
  // keeps the payload to one row while COUNT reports the whole window.
  if (working?.dateBound) {
    for (const monthsBack of HISTORY_WINDOWS) {
      const from = isoMonthsBack(monthsBack);
      const q = `(StandardStatus=|${working.status}),(PostalCode=${CALGARY_POSTAL}),(CloseDate=${from}+)`;
      try {
        const r = await client.search({
          resource: "Property",
          class: "Property",
          query: q,
          select: "ListingId,CloseDate",
          limit: 1,
          offset: 0,
        });
        base.history.push({ monthsBack, since: from, query: q, total: r.total });
      } catch (e: any) {
        base.history.push({
          monthsBack,
          since: from,
          query: q,
          total: null,
          error: String(e?.message ?? e).slice(0, 200),
        });
      }
    }
  }

  return { ...base, verdict: verdictFor(base.attempts, base.history) };
}

function verdictFor(attempts: SoldAttempt[], history: SoldHistoryWindow[]): string {
  const withRows = attempts.find((a) => a.ok && a.rows > 0);
  if (withRows) {
    const price = withRows.saleFields?.ClosePrice;
    const date = withRows.saleFields?.CloseDate;
    if (!price || !date) {
      return (
        `Sold records come back for ${withRows.query}, but ` +
        `${!price ? "ClosePrice" : "CloseDate"} was empty on the sample — the sale figures may sit ` +
        `under a different field name, or be withheld by the licence.`
      );
    }
    const sized = history.filter((h) => h.total != null);
    const deepest = sized.length ? sized[sized.length - 1] : null;
    const dated = attempts.find((a) => a.ok && a.rows > 0 && /CloseDate=/.test(a.query));
    const reach = deepest
      ? ` A close-date bound works, and the feed reports ${deepest.total} Calgary sales in the last ${deepest.monthsBack} months, so history can be backfilled.`
      : dated
        ? " A close-date bound works, but sizing the history failed — see below."
        : " A close-date bound was rejected, so history will have to accumulate from today.";
    return `Sold data is available, with both a close price and a close date. The working query is ${withRows.query}.${reach}`;
  }
  // A select-field complaint means the query itself was accepted and only the
  // column list was wrong. That is not a licence problem.
  const selectOnly = attempts.find((a) => !a.ok && /Invalid Select Field/i.test(a.error ?? ""));
  if (selectOnly) {
    return (
      `The feed accepted ${selectOnly.query} and only objected to the column list (${selectOnly.error}). ` +
      "Sold data is in the licence; the select needs trimming to the fields the metadata declares."
    );
  }
  if (attempts.some((a) => a.ok)) {
    return (
      "The feed accepted the queries but returned no sold rows. Either the licence excludes " +
      "sold data, or this board uses a status value not tried here — the lookup list above " +
      "shows what it will accept."
    );
  }
  return "Every sold query was rejected. The licence most likely does not include sold data.";
}
