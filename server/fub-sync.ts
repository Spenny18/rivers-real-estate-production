// Pulls the Follow Up Boss account into the local CRM mirror.
//
// Runs hourly (see startCrmSyncCron) and on demand from /admin/crm. Each
// resource is synced independently: Deals returning 403 because the account
// doesn't include that add-on must not stop People from syncing.
//
// ---------------------------------------------------------------------------
// MAPPING UNDER UNCERTAINTY
//
// The FUB reference was unreachable from the environment this was written in,
// so the field names below are informed guesses, not verified ones. Three
// things keep that honest rather than fragile:
//
//   1. `pick()` accepts a list of candidate field names and takes the first
//      that is present, so a resource that calls it `created` rather than
//      `createdAt` still maps.
//   2. The untouched payload goes into `raw` on every row. Nothing the API
//      returned is ever discarded, so a column found to be mapped wrongly can
//      be recomputed from data already stored.
//   3. Each run records how often every normalized column came out null
//      (`nullRates`). A column that mapped to a field FUB doesn't use reads
//      100% null and is surfaced in the admin as a mapping warning — the
//      mistake announces itself instead of looking like an empty CRM.
//
// Run the probe on the Integrations card to see the real field names, then
// tighten the candidate lists here.

import { storage } from "./storage";
import { fubGetAll, fubConfigured, type PageResult } from "./fub-client";

// ---- Field helpers ---------------------------------------------------------

/** First present, non-empty value among candidate keys. */
function pick(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function str(v: any): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function num(v: any): number | null {
  if (v === undefined || v === null || v === "") return null;
  // FUB may send money as "125000.00" or as a number.
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function bool(v: any): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/** Normalise anything date-ish to an ISO string, or null. */
function iso(v: any): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * FUB nests contact details as arrays of objects — emails: [{value, type}].
 * Take the one flagged primary, else the first, and tolerate a bare string.
 */
function primaryOf(list: any, valueKeys = ["value", "address", "number"]): string | null {
  if (!list) return null;
  if (typeof list === "string") return list;
  if (!Array.isArray(list) || list.length === 0) return null;
  const primary = list.find((x: any) => x && (x.isPrimary || x.primary)) ?? list[0];
  if (typeof primary === "string") return primary;
  return str(pick(primary, valueKeys));
}

function jsonOf(v: any): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

/** Name of a nested object that might instead be a bare string or an id. */
function nameOf(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") return str(pick(v, ["name", "title", "label"]));
  return null;
}

function idOf(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") return str(pick(v, ["id", "fubId", "_id"]));
  return null;
}

// ---- Mapping-health --------------------------------------------------------

/**
 * Fraction of rows where each column came out null, rounded to 2dp.
 * Columns that are legitimately sparse are excluded by the caller.
 */
function nullRates(rows: Array<Record<string, any>>, fields: string[]): Record<string, number> {
  if (rows.length === 0) return {};
  const out: Record<string, number> = {};
  for (const f of fields) {
    const nulls = rows.filter((r) => r[f] === null || r[f] === undefined).length;
    out[f] = Math.round((nulls / rows.length) * 100) / 100;
  }
  return out;
}

// ---- Per-resource mappers --------------------------------------------------

function mapContact(p: any, syncedAt: string): Record<string, any> {
  const first = str(pick(p, ["firstName", "first_name", "givenName"]));
  const last = str(pick(p, ["lastName", "last_name", "familyName"]));
  return {
    fubId: String(idOf(p) ?? ""),
    // An explicit name field if there is one, else first + last, else null.
    name:
      str(pick(p, ["name", "fullName", "displayName"])) ??
      ([first, last].filter(Boolean).join(" ") || null),
    firstName: first,
    lastName: last,
    email: primaryOf(pick(p, ["emails", "email"])),
    phone: primaryOf(pick(p, ["phones", "phone"])),
    stage: nameOf(pick(p, ["stage", "stageName"])),
    source: nameOf(pick(p, ["source", "sourceName", "leadSource"])),
    assignedTo: nameOf(pick(p, ["assignedTo", "assignedUser", "assignedUserName", "owner"])),
    tags: jsonOf(Array.isArray(p?.tags) ? p.tags : []),
    fubCreatedAt: iso(pick(p, ["created", "createdAt", "dateCreated"])),
    fubUpdatedAt: iso(pick(p, ["updated", "updatedAt", "dateUpdated", "lastActivity"])),
    lastActivityAt: iso(pick(p, ["lastActivity", "lastActivityAt", "lastCommunication"])),
    raw: jsonOf(p),
    syncedAt,
  };
}

function mapPipeline(p: any, syncedAt: string): Record<string, any> {
  return {
    fubId: String(idOf(p) ?? ""),
    name: nameOf(p),
    raw: jsonOf(p),
    syncedAt,
  };
}

function mapStage(s: any, syncedAt: string): Record<string, any> {
  return {
    fubId: String(idOf(s) ?? ""),
    pipelineFubId: idOf(pick(s, ["pipelineId", "pipeline"])),
    name: nameOf(s),
    sortOrder: Number(pick(s, ["order", "sortOrder", "position"]) ?? 0) || 0,
    raw: jsonOf(s),
    syncedAt,
  };
}

function mapDeal(d: any, syncedAt: string): Record<string, any> {
  const stage = pick(d, ["stage", "dealStage"]);
  return {
    fubId: String(idOf(d) ?? ""),
    name: str(pick(d, ["name", "title", "description"])),
    value: num(pick(d, ["price", "value", "amount", "dealValue"])),
    stageFubId: idOf(stage) ?? idOf(pick(d, ["stageId"])),
    stageName: nameOf(stage) ?? str(pick(d, ["stageName"])),
    pipelineFubId: idOf(pick(d, ["pipelineId", "pipeline"])),
    status: str(pick(d, ["status", "state"])),
    contactFubId:
      idOf(pick(d, ["personId", "person", "contactId", "contact"])) ??
      (Array.isArray(d?.people) ? idOf(d.people[0]) : null),
    closedDate: iso(pick(d, ["closedDate", "closeDate", "projectedCloseDate"])),
    fubCreatedAt: iso(pick(d, ["created", "createdAt"])),
    fubUpdatedAt: iso(pick(d, ["updated", "updatedAt"])),
    raw: jsonOf(d),
    syncedAt,
  };
}

/**
 * Events, calls, texts, tasks and appointments all land in crm_activities.
 * `kind` keeps them apart; the uid namespaces FUB's per-resource ids.
 */
function mapActivity(a: any, kind: string, syncedAt: string): Record<string, any> {
  const fubId = idOf(a);
  const occurred = iso(
    pick(a, ["created", "createdAt", "occurredAt", "date", "sentAt", "startTime", "start"]),
  );
  const due = iso(pick(a, ["dueDate", "dueAt", "due", "startTime", "start"]));

  let title = str(pick(a, ["type", "subject", "name", "title"]));
  let body = str(pick(a, ["message", "body", "description", "note", "text"]));
  if (kind === "call") {
    title = title ?? "Call";
    body = body ?? str(pick(a, ["notes", "summary"]));
  } else if (kind === "text") {
    title = title ?? "Text message";
  }

  return {
    uid: `${kind}:${fubId ?? `${occurred ?? syncedAt}-${Math.random().toString(36).slice(2, 8)}`}`,
    kind,
    fubId,
    contactFubId: idOf(pick(a, ["personId", "person", "contactId", "contact"])),
    title,
    body: body ? body.slice(0, 4000) : null,
    direction: str(pick(a, ["direction", "isIncoming", "inbound"])),
    outcome: str(pick(a, ["outcome", "result", "status", "disposition"])),
    durationSeconds:
      num(pick(a, ["duration", "durationSeconds", "callDuration"])) != null
        ? Math.round(num(pick(a, ["duration", "durationSeconds", "callDuration"]))!)
        : null,
    occurredAt: occurred,
    dueAt: kind === "task" || kind === "appointment" ? due : null,
    completed: bool(pick(a, ["completed", "isCompleted", "done"])),
    assignedTo: nameOf(pick(a, ["assignedTo", "assignedUser", "user", "owner"])),
    raw: jsonOf(a),
    syncedAt,
  };
}

// ---- Sync driver -----------------------------------------------------------

export interface ResourceSpec {
  resource: string;
  path: string;
  /** Key the records array is expected under. */
  collectionKey: string;
  /** Columns whose null-rate is worth watching for mapping drift. */
  watchFields: string[];
  /** Query param name for an incremental "changed since" filter, if any. */
  incrementalParam?: string;
  optional?: boolean;
  note?: string;
}

export const RESOURCE_SPECS: ResourceSpec[] = [
  {
    resource: "pipelines",
    path: "/pipelines",
    collectionKey: "pipelines",
    watchFields: ["name"],
  },
  {
    resource: "stages",
    path: "/stages",
    collectionKey: "stages",
    watchFields: ["name"],
  },
  {
    resource: "people",
    path: "/people",
    collectionKey: "people",
    watchFields: ["name", "email", "stage", "fubUpdatedAt"],
    incrementalParam: "updatedAfter",
  },
  {
    resource: "deals",
    path: "/deals",
    collectionKey: "deals",
    watchFields: ["name", "value", "stageFubId"],
    optional: true,
    note: "Deals is a Follow Up Boss add-on. A 403 here means the plan doesn't include it.",
  },
  {
    resource: "events",
    path: "/events",
    collectionKey: "events",
    watchFields: ["contactFubId", "occurredAt"],
  },
  {
    resource: "calls",
    path: "/calls",
    collectionKey: "calls",
    watchFields: ["contactFubId", "occurredAt"],
    optional: true,
  },
  {
    resource: "textMessages",
    path: "/textMessages",
    collectionKey: "textMessages",
    watchFields: ["contactFubId", "occurredAt"],
    optional: true,
  },
  {
    resource: "tasks",
    path: "/tasks",
    collectionKey: "tasks",
    watchFields: ["title", "dueAt"],
    optional: true,
  },
  {
    resource: "appointments",
    path: "/appointments",
    collectionKey: "appointments",
    watchFields: ["title", "dueAt"],
    optional: true,
  },
];

const ACTIVITY_KIND: Record<string, string> = {
  events: "event",
  calls: "call",
  textMessages: "text",
  tasks: "task",
  appointments: "appointment",
};

export interface SyncResult {
  resource: string;
  status: "ok" | "partial" | "error" | "skipped";
  fetched: number;
  inserted: number;
  updated: number;
  error?: string;
  httpStatus?: number;
}

/** Sync one resource, recording a crm_sync_runs row either way. */
export async function syncResource(
  spec: ResourceSpec,
  opts: { trigger?: "cron" | "manual"; full?: boolean } = {},
): Promise<SyncResult> {
  const trigger = opts.trigger ?? "cron";
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  if (!fubConfigured()) {
    return {
      resource: spec.resource,
      status: "skipped",
      fetched: 0,
      inserted: 0,
      updated: 0,
      error: "FUB_API_KEY not set",
    };
  }

  const run = storage.createCrmSyncRun({
    resource: spec.resource,
    status: "error", // pessimistic until proven otherwise
    startedAt,
    trigger,
  } as any);

  // Incremental where the endpoint supports it: ask only for what changed
  // since the last good run, minus an hour of overlap so nothing is missed
  // at the boundary.
  const params: Record<string, string | number | undefined> = {};
  let cursor: string | null = null;
  if (spec.incrementalParam && !opts.full) {
    const last = storage.lastCrmCursor(spec.resource);
    if (last) {
      const since = new Date(Date.parse(last) - 60 * 60_000).toISOString();
      params[spec.incrementalParam] = since;
    }
  }

  let page: PageResult;
  try {
    page = await fubGetAll(spec.path, spec.collectionKey, { params });
  } catch (e: any) {
    storage.finishCrmSyncRun(run.id, {
      status: "error",
      error: String(e?.message ?? e).slice(0, 500),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    } as any);
    return {
      resource: spec.resource,
      status: "error",
      fetched: 0,
      inserted: 0,
      updated: 0,
      error: String(e?.message ?? e),
    };
  }

  const syncedAt = new Date().toISOString();
  const kind = ACTIVITY_KIND[spec.resource];
  let mapped: Array<Record<string, any>>;
  if (kind) {
    mapped = page.records.map((r) => mapActivity(r, kind, syncedAt));
  } else if (spec.resource === "people") {
    mapped = page.records.map((r) => mapContact(r, syncedAt));
  } else if (spec.resource === "deals") {
    mapped = page.records.map((r) => mapDeal(r, syncedAt));
  } else if (spec.resource === "pipelines") {
    mapped = page.records.map((r) => mapPipeline(r, syncedAt));
  } else {
    mapped = page.records.map((r) => mapStage(r, syncedAt));
  }
  // A record with no id can't be upserted or de-duplicated.
  mapped = mapped.filter((m) => (m.fubId ?? m.uid) && m.fubId !== "");

  let inserted = 0;
  let updated = 0;
  if (mapped.length > 0) {
    const r = kind
      ? storage.upsertCrmActivities(mapped)
      : spec.resource === "people"
        ? storage.upsertCrmContacts(mapped)
        : spec.resource === "deals"
          ? storage.upsertCrmDeals(mapped)
          : spec.resource === "pipelines"
            ? storage.upsertCrmPipelines(mapped)
            : storage.upsertCrmStages(mapped);
    inserted = r.inserted;
    updated = r.updated;
  }

  // High-water mark for the next incremental run: the newest updated
  // timestamp actually seen, not "now" — so a clock skew can't skip records.
  if (spec.incrementalParam) {
    const stamps = mapped
      .map((m) => m.fubUpdatedAt ?? m.occurredAt)
      .filter((s): s is string => typeof s === "string");
    cursor = stamps.length > 0 ? stamps.sort().slice(-1)[0] : storage.lastCrmCursor(spec.resource);
  }

  // A run that hit a safety cutoff is "partial", never "ok". Reporting it as
  // complete is worse than reporting nothing: a resource with no incremental
  // filter would re-fetch the same first N every hour, so the remainder would
  // never mirror, and the status panel would insist everything was fine.
  const status: SyncResult["status"] = !page.ok
    ? mapped.length > 0
      ? "partial"
      : "error"
    : page.truncated
      ? "partial"
      : "ok";
  storage.finishCrmSyncRun(run.id, {
    status,
    fetched: page.records.length,
    inserted,
    updated,
    pages: page.pages,
    httpStatus: page.status ?? null,
    error: page.error
      ? String(page.error).slice(0, 500)
      : page.truncated
        ? `Stopped at a safety cutoff after ${page.records.length} records — the API had more. Raise maxRecords for this resource, or give it an incremental filter.`
        : null,
    truncated: !!page.truncated,
    nullRates: JSON.stringify(nullRates(mapped, spec.watchFields)),
    cursor,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
  } as any);

  return {
    resource: spec.resource,
    status,
    fetched: page.records.length,
    inserted,
    updated,
    error: page.error,
    httpStatus: page.status,
  };
}

/**
 * Sync every resource, in order.
 *
 * Pipelines and stages come first so deals can be rendered against a stage
 * board on the very first run. One resource failing never stops the rest —
 * an account without the Deals add-on should still get its people and
 * activity.
 */
export async function syncAll(
  opts: {
    trigger?: "cron" | "manual";
    full?: boolean;
    only?: string[];
    /** Called before each resource starts and after each one finishes. */
    onProgress?: (p: { current: string | null; results: SyncResult[] }) => void;
  } = {},
): Promise<SyncResult[]> {
  const specs = plannedSpecs(opts.only);

  const results: SyncResult[] = [];
  for (const spec of specs) {
    opts.onProgress?.({ current: spec.resource, results });
    try {
      results.push(await syncResource(spec, opts));
    } catch (e: any) {
      console.error(`[crm-sync] ${spec.resource} threw:`, e?.message);
      results.push({
        resource: spec.resource,
        status: "error",
        fetched: 0,
        inserted: 0,
        updated: 0,
        error: String(e?.message ?? e),
      });
    }
    opts.onProgress?.({ current: null, results });
  }
  try {
    storage.pruneCrmSyncRuns();
  } catch {
    /* pruning is housekeeping; never fail a sync over it */
  }
  return results;
}

function plannedSpecs(only?: string[]): ResourceSpec[] {
  return only?.length ? RESOURCE_SPECS.filter((s) => only.includes(s.resource)) : RESOURCE_SPECS;
}

// ---- Background job --------------------------------------------------------
//
// A full sync walks nine endpoints and pages each one, so it routinely runs
// for minutes. It must not be the body of an HTTP request: Fly's proxy closes
// an idle connection at around 60 seconds, so a request that waits for the
// whole thing shows the browser a network failure while the server carries on
// and finishes perfectly well — the one failure mode guaranteed to make a
// working sync look broken.
//
// So the route starts a job and returns immediately, and the page polls this
// state. The lock is the other half: cron and the button share it, so hitting
// Sync now during an hourly cycle joins that run rather than starting a second
// concurrent pass over the same rows.

export interface SyncJob {
  id: number;
  trigger: "cron" | "manual";
  full: boolean;
  startedAt: string;
  finishedAt: string | null;
  running: boolean;
  /** Every resource this run will touch, in the order it will touch them. */
  planned: string[];
  /** The resource being fetched right now; null between resources or at the end. */
  current: string | null;
  /** Results so far — grows as the run progresses. */
  results: SyncResult[];
  /** Only set if the run itself threw, as opposed to one resource failing. */
  error: string | null;
}

let job: SyncJob | null = null;
let jobDone: Promise<SyncJob> = Promise.resolve(null as any);
let jobSeq = 0;

/** The current run if one is in flight, else the last one that finished. */
export function currentSyncJob(): SyncJob | null {
  return job;
}

/**
 * Start a sync in the background.
 *
 * Returns `started: false` with the in-flight job when one is already running
 * — the caller should show that job's progress rather than report a failure.
 * `done` resolves with the finished job either way, so a caller that does want
 * to wait (the cron, for its log line) can, without the HTTP path doing so.
 */
export function startSyncJob(opts: {
  trigger?: "cron" | "manual";
  full?: boolean;
  only?: string[];
}): { started: boolean; job: SyncJob; done: Promise<SyncJob> } {
  if (job?.running) return { started: false, job, done: jobDone };

  const next: SyncJob = {
    id: ++jobSeq,
    trigger: opts.trigger ?? "manual",
    full: !!opts.full,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    running: true,
    planned: plannedSpecs(opts.only).map((s) => s.resource),
    current: null,
    results: [],
    error: null,
  };
  job = next;

  // Deliberately not awaited here: this returns to the HTTP handler at once.
  jobDone = syncAll({
    ...opts,
    onProgress: ({ current, results }) => {
      next.current = current;
      next.results = [...results];
    },
  })
    .then((results) => {
      next.results = results;
    })
    .catch((e: any) => {
      next.error = String(e?.message ?? e).slice(0, 500);
      console.error("[crm-sync] job failed:", e);
    })
    .then(() => {
      next.current = null;
      next.running = false;
      next.finishedAt = new Date().toISOString();
      return next;
    });

  return { started: true, job: next, done: jobDone };
}

// ---- Cron ------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

export function startCrmSyncCron(): void {
  if (timer) return;
  if (!fubConfigured()) {
    console.log("[crm-sync] disabled (FUB_API_KEY not set)");
    return;
  }
  const runCycle = () => {
    // Through the same job lock as the manual button, so an hour boundary
    // landing mid-sync doesn't start a second pass over the same rows.
    const { started, job: j, done } = startSyncJob({ trigger: "cron" });
    if (!started) {
      console.log(`[crm-sync] cycle skipped — a ${j.trigger} sync is still running`);
      return;
    }
    done
      .then((finished) => {
        const rs = finished.results;
        const ok = rs.filter((r) => r.status === "ok").length;
        const failed = rs.filter((r) => r.status === "error");
        console.log(
          `[crm-sync] cycle done — ${ok}/${rs.length} ok, ` +
            `${rs.reduce((s, r) => s + r.inserted, 0)} new, ` +
            `${rs.reduce((s, r) => s + r.updated, 0)} updated` +
            (failed.length ? ` — failed: ${failed.map((f) => f.resource).join(", ")}` : ""),
        );
      })
      .catch((e) => console.error("[crm-sync] uncaught:", e));
  };
  // 60s after boot so the MLS sync and seed get a clear run first.
  setTimeout(runCycle, 60_000);
  timer = setInterval(runCycle, 60 * 60 * 1000);
  console.log("[crm-sync] scheduled hourly");
}

export function stopCrmSyncCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
