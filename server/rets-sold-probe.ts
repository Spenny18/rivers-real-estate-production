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

export interface SoldProbeResult {
  configured: boolean;
  loggedIn: boolean;
  /** Every value StandardStatus accepts, straight from the feed's metadata. */
  statusLookups: StatusLookup[];
  /** Which of the candidate sale fields the Property class actually defines. */
  saleFieldsInMetadata: string[];
  attempts: SoldAttempt[];
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
 * Status values worth trying, most-likely first. The feed's own metadata is
 * read before this is used, so in practice the lookups list decides — these
 * are the fallback for a feed whose metadata is unhelpful.
 */
const CANDIDATE_STATUSES = ["S", "Closed", "Sold", "C", "SLD"];

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

  // Prefer status values the feed itself declares; fall back to the guesses.
  const declared = base.statusLookups
    .filter((l) => /sold|closed/i.test(`${l.value} ${l.longValue ?? ""} ${l.shortValue ?? ""}`))
    .map((l) => l.value);
  const toTry = Array.from(new Set([...declared, ...CANDIDATE_STATUSES]));

  // One narrow, recent window: enough to prove access without asking the feed
  // for years of history during a diagnostic.
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
  const select = [...SALE_FIELDS, "ListingId", "City", "PostalCode", "StandardStatus"].join(",");

  for (const status of toTry) {
    // Two shapes: with a close-date bound, and without. If the first fails but
    // the second works, the status is right and the date field is wrong, which
    // is a materially different fix.
    for (const q of [
      `(StandardStatus=|${status}),(CloseDate=${since}+)`,
      `(StandardStatus=|${status}),(PostalCode=T2*)`,
    ]) {
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
          rows: r.rows.length,
          fields: row ? Object.keys(row) : [],
          // Values, not just names, for the sale fields only — a close price
          // and date are what decide whether a market report is possible, and
          // one row of them is not a data leak.
          saleFields: row
            ? Object.fromEntries(
                SALE_FIELDS.map((f) => [f, row[f] != null ? String(row[f]) : null]),
              )
            : undefined,
        });
        // A query that returned a row has answered the question.
        if (r.rows.length > 0) {
          return { ...base, verdict: verdictFor(base.attempts) };
        }
      } catch (e: any) {
        base.attempts.push({
          query: q,
          ok: false,
          rows: 0,
          error: String(e?.message ?? e).slice(0, 200),
        });
      }
    }
  }

  return { ...base, verdict: verdictFor(base.attempts) };
}

function verdictFor(attempts: SoldAttempt[]): string {
  const withRows = attempts.find((a) => a.ok && a.rows > 0);
  if (withRows) {
    const price = withRows.saleFields?.ClosePrice;
    const date = withRows.saleFields?.CloseDate;
    if (price && date) {
      return `Sold data is available, with both a close price and a close date. The working query is ${withRows.query}`;
    }
    return (
      `Sold records come back for ${withRows.query}, but ` +
      `${!price ? "ClosePrice" : "CloseDate"} was empty on the sample — the sale figures may sit ` +
      `under a different field name, or be withheld by the licence.`
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
