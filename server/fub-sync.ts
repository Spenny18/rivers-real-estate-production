// Pulls the Follow Up Boss account into the local CRM mirror.
//
// Runs hourly (see startCrmSyncCron) and on demand from /admin/crm. Each
// resource is synced independently: Deals returning 403 because the account
// doesn't include that add-on must not stop People from syncing.
//
// ---------------------------------------------------------------------------
// MAPPING
//
// The field names below are the ones a live Follow Up Boss account actually
// returns, read off /api/admin/crm/probe against the production key. They are
// no longer guesses — where a comment says a resource uses a particular field,
// that was observed.
//
// `pick()` still takes candidate lists, now for a different reason: the
// confirmed name goes first and the old guesses stay behind it, so a tenant on
// a different API revision degrades to the previous behaviour instead of
// mapping to null. The other two safeguards are unchanged: every row keeps the
// untouched payload in `raw`, and each run records per-column null rates so a
// column that stops mapping announces itself in the admin.
//
// Things the probe settled, each of which was mapped wrongly before:
//
//   * Deal stages are NOT /v1/stages. That endpoint returns the twelve PEOPLE
//     stages (Lead, Sphere, Trash, … — it even carries `peopleCount`). Deal
//     stages arrive nested inside /v1/pipelines as `stages`, and deals carry
//     `stageId`/`stageName` from that set. Building the board from /v1/stages
//     gave twelve columns that no deal could ever match.
//   * Tasks carry BOTH `completed` (a timestamp) and `isCompleted` (the
//     boolean). Reading the first non-empty of the two made every finished
//     task look open.
//   * Tasks spell the assignee `AssignedTo`, capitalised, unlike every other
//     resource.
//   * Calls have no `direction`; they have `isIncoming`. And their `name` is
//     the CONTACT's name, not a title for the call.
//   * Events have `occurred`, which is what the activity feed should sort on,
//     distinct from `created`.
//   * Appointments have no `personId` at all — they link through `invitees`.
//   * /v1/textMessages cannot be listed account-wide; it 400s without a
//     personId or thread. Texts are fetched per contact instead, on demand.

import { storage } from "./storage";
import { fubGetAll, fubConfigured, sinceIdCursor, type PageResult } from "./fub-client";

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

/**
 * People: id, created, updated, lastActivity, name, firstName, lastName,
 * stage (the name, as a string), stageId, source, assignedTo, tags, emails,
 * phones. Confirmed by probe; this one mapped correctly from the start.
 */
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

/** Pipelines: id, name, description, orderWeight, stages (the deal stages). */
function mapPipeline(p: any, syncedAt: string): Record<string, any> {
  return {
    fubId: String(idOf(p) ?? ""),
    name: nameOf(p),
    raw: jsonOf(p),
    syncedAt,
  };
}

/**
 * A deal stage, as carried inside a pipeline's `stages`.
 *
 * These are the ids deals reference. The separate /v1/stages endpoint returns
 * people stages from a different id space, which is why the board used to
 * render twelve columns that never matched a deal.
 */
function mapStage(s: any, pipelineFubId: string | null, syncedAt: string): Record<string, any> {
  return {
    fubId: String(idOf(s) ?? ""),
    pipelineFubId: idOf(pick(s, ["pipelineId", "pipeline"])) ?? pipelineFubId,
    name: nameOf(s),
    sortOrder: Number(pick(s, ["orderWeight", "order", "sortOrder", "position"]) ?? 0) || 0,
    raw: jsonOf(s),
    syncedAt,
  };
}

/**
 * Deals: id, name, status, price, createdAt, pipelineId, pipelineName,
 * stageId, stageName, projectedCloseDate, people.
 *
 * Note there is no `updated` field on this resource at all, so fubUpdatedAt
 * stays null and deals cannot sync incrementally on a timestamp. At 128 rows
 * that costs two pages an hour.
 */
function mapDeal(d: any, syncedAt: string): Record<string, any> {
  return {
    fubId: String(idOf(d) ?? ""),
    name: str(pick(d, ["name", "title", "description"])),
    value: num(pick(d, ["price", "value", "amount", "dealValue"])),
    stageFubId: idOf(pick(d, ["stageId"])) ?? idOf(pick(d, ["stage", "dealStage"])),
    stageName: str(pick(d, ["stageName"])) ?? nameOf(pick(d, ["stage", "dealStage"])),
    pipelineFubId: idOf(pick(d, ["pipelineId", "pipeline"])),
    status: str(pick(d, ["status", "state"])),
    // The contact is in `people`, an array — there is no personId here.
    contactFubId:
      idOf(pick(d, ["personId", "person", "contactId", "contact"])) ??
      (Array.isArray(d?.people) ? idOf(d.people[0]) : null),
    closedDate: iso(pick(d, ["closedDate", "closeDate", "projectedCloseDate"])),
    fubCreatedAt: iso(pick(d, ["createdAt", "created"])),
    fubUpdatedAt: iso(pick(d, ["updated", "updatedAt"])),
    raw: jsonOf(d),
    syncedAt,
  };
}

/**
 * Events, calls, texts, tasks and appointments all land in crm_activities.
 * `kind` keeps them apart; the uid namespaces FUB's per-resource ids.
 *
 * They get one mapper each rather than one generic mapper with exceptions:
 * the five payloads share almost no field names, and the generic version
 * mis-mapped four of the five (see the header). Every mapper fills the same
 * shape, so the timeline can still interleave them.
 */
function activityBase(a: any, kind: string, syncedAt: string): Record<string, any> {
  const fubId = idOf(a);
  return {
    uid: `${kind}:${fubId ?? `${syncedAt}-${Math.random().toString(36).slice(2, 8)}`}`,
    kind,
    fubId,
    contactFubId: null,
    title: null,
    body: null,
    direction: null,
    outcome: null,
    durationSeconds: null,
    occurredAt: null,
    dueAt: null,
    completed: false,
    assignedTo: null,
    raw: jsonOf(a),
    syncedAt,
  };
}

/** Trim and cap free text bound for the `body` column. */
function body(v: any): string | null {
  const s = str(v);
  return s ? s.slice(0, 4000) : null;
}

/** Events: id, occurred, created, personId, message, description, type, source. */
function mapEvent(e: any, syncedAt: string): Record<string, any> {
  return {
    ...activityBase(e, "event", syncedAt),
    contactFubId: idOf(pick(e, ["personId", "person", "contactId"])),
    title: str(pick(e, ["type", "subject", "title"])),
    // `occurred` is when it happened; `created` is when FUB recorded it. The
    // feed sorts on this, so prefer the former.
    occurredAt: iso(pick(e, ["occurred", "created", "createdAt", "date"])),
    body: body(pick(e, ["message", "description", "pageTitle", "note"])),
    outcome: str(pick(e, ["source"])),
  };
}

/** Calls: id, personId, note, outcome, isIncoming, duration, startedAt, userName. */
function mapCall(c: any, syncedAt: string): Record<string, any> {
  const duration = num(pick(c, ["duration", "durationSeconds", "callDuration"]));
  const incoming = pick(c, ["isIncoming", "inbound"]);
  return {
    ...activityBase(c, "call", syncedAt),
    contactFubId: idOf(pick(c, ["personId", "person", "contactId"])),
    // A call's `name`/`firstName`/`lastName` are the CONTACT's, not a subject
    // line — using them titled every call with the person it was already
    // filed under.
    title: "Call",
    body: body(pick(c, ["note", "notes", "summary"])),
    direction:
      incoming === undefined
        ? str(pick(c, ["direction"]))
        : bool(incoming)
          ? "inbound"
          : "outbound",
    outcome: str(pick(c, ["outcome", "result", "disposition"])),
    durationSeconds: duration != null ? Math.round(duration) : null,
    occurredAt: iso(pick(c, ["startedAt", "created", "createdAt"])),
    assignedTo: nameOf(pick(c, ["userName", "user", "assignedTo"])),
  };
}

/** Tasks: id, personId, name, type, isCompleted, completed, dueDate, AssignedTo. */
function mapTask(t: any, syncedAt: string): Record<string, any> {
  return {
    ...activityBase(t, "task", syncedAt),
    contactFubId: idOf(pick(t, ["personId", "person", "contactId"])),
    // `name` is the task ("Send CMA"); `type` is its category. The generic
    // mapper preferred `type` and labelled every task with its category.
    title: str(pick(t, ["name", "title", "subject"])) ?? str(pick(t, ["type"])),
    outcome: str(pick(t, ["type"])),
    occurredAt: iso(pick(t, ["created", "createdAt"])),
    dueAt: iso(pick(t, ["dueDateTime", "dueDate", "dueAt", "due"])),
    // `completed` is a TIMESTAMP here, not a flag — truthy as a string on a
    // finished task and absent on an open one, which the old boolean coercion
    // read as false either way. `isCompleted` is the actual boolean; the
    // timestamp is a sound fallback precisely because it is only ever set.
    completed: t?.isCompleted !== undefined ? bool(t.isCompleted) : !!str(pick(t, ["completed"])),
    // Capitalised on this resource alone.
    assignedTo: nameOf(pick(t, ["AssignedTo", "assignedTo", "assignedUser", "user"])),
  };
}

/** Appointments: id, title, description, start, end, invitees, type, outcome. */
function mapAppointment(a: any, syncedAt: string): Record<string, any> {
  const start = iso(pick(a, ["start", "startTime"]));
  const end = Date.parse(str(pick(a, ["end", "endTime"])) ?? "");
  const startMs = Date.parse(start ?? "");
  return {
    ...activityBase(a, "appointment", syncedAt),
    // No personId on this resource — the contact is in `invitees`.
    contactFubId: inviteePersonId(a?.invitees),
    title: str(pick(a, ["title", "name", "subject"])) ?? nameOf(pick(a, ["type"])),
    body: body(pick(a, ["description", "location", "note"])),
    outcome: nameOf(pick(a, ["outcome"])),
    durationSeconds:
      Number.isFinite(end) && Number.isFinite(startMs) && end > startMs
        ? Math.round((end - startMs) / 1000)
        : null,
    occurredAt: start,
    dueAt: start,
    // An appointment is done once its start time has passed; FUB has no flag.
    completed: Number.isFinite(startMs) ? startMs < Date.now() : false,
  };
}

/**
 * The contact an appointment is with.
 *
 * `invitees` mixes the agent and the client, and the exact member names could
 * not be confirmed from the probe (it reports field names, not values). So
 * this prefers an explicit personId, then an entry that identifies itself as a
 * person, and only then the first id present. A wrong guess leaves the
 * appointment unlinked and shows up as a null rate rather than filing it under
 * the wrong contact — and `raw` keeps the invitee list either way.
 */
function inviteePersonId(invitees: any): string | null {
  if (!Array.isArray(invitees) || invitees.length === 0) return null;
  for (const key of ["personId", "person_id"]) {
    for (const inv of invitees) {
      const v = idOf(pick(inv, [key]));
      if (v) return v;
    }
  }
  const person = invitees.find(
    (i: any) => i && typeof i === "object" && /person|contact|lead/i.test(String(i.type ?? "")),
  );
  return person ? idOf(person) : null;
}

/**
 * Text messages, fetched per contact — see syncTextsForContact. The shape is
 * the one resource the probe could not report, because listing the collection
 * needs a personId, so this stays candidate-based throughout.
 */
function mapText(t: any, personId: string, syncedAt: string): Record<string, any> {
  const incoming = pick(t, ["isIncoming", "inbound"]);
  return {
    ...activityBase(t, "text", syncedAt),
    contactFubId: idOf(pick(t, ["personId", "person", "contactId"])) ?? personId,
    title: "Text message",
    body: body(pick(t, ["message", "body", "text", "content"])),
    direction:
      incoming === undefined
        ? str(pick(t, ["direction"]))
        : bool(incoming)
          ? "inbound"
          : "outbound",
    occurredAt: iso(pick(t, ["sentAt", "created", "createdAt", "sent"])),
    assignedTo: nameOf(pick(t, ["userName", "user", "assignedTo"])),
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
  /**
   * Append-only: records are never revised after they are written, so the run
   * can resume from the highest id already mirrored instead of re-reading the
   * collection. Mutually exclusive with incrementalParam.
   */
  appendOnly?: boolean;
  /** Ceiling for one run. Only matters for a first, non-incremental pull. */
  maxRecords?: number;
  optional?: boolean;
  note?: string;
}

export const RESOURCE_SPECS: ResourceSpec[] = [
  {
    // Also the source of deal stages, which arrive nested here as `stages`.
    resource: "pipelines",
    path: "/pipelines",
    collectionKey: "pipelines",
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
    // The big one — tens of thousands of rows on an established account, and
    // an event is never rewritten once logged, so this resumes by id.
    resource: "events",
    path: "/events",
    collectionKey: "events",
    watchFields: ["contactFubId", "occurredAt"],
    appendOnly: true,
    maxRecords: 100_000,
  },
  {
    resource: "calls",
    path: "/calls",
    collectionKey: "calls",
    watchFields: ["contactFubId", "occurredAt"],
    appendOnly: true,
    maxRecords: 50_000,
    optional: true,
  },
  {
    // Not append-only: a task's whole point is being completed later.
    resource: "tasks",
    path: "/tasks",
    collectionKey: "tasks",
    watchFields: ["title", "dueAt"],
    maxRecords: 50_000,
    optional: true,
  },
  {
    // Rescheduled and given outcomes after the fact, so re-read in full.
    resource: "appointments",
    path: "/appointments",
    collectionKey: "appointments",
    watchFields: ["title", "dueAt"],
    optional: true,
  },
];

// textMessages is deliberately absent. GET /v1/textMessages rejects a bare
// listing outright — "personId, threadId, phone, toNumber, fromNumber,
// sharedInboxId, groupTextId, participants, or id list must be specified" —
// so there is no account-wide pull to schedule. Texts are fetched for one
// contact at a time by syncTextsForContact, when their history is opened.

type ActivityMapper = (r: any, syncedAt: string) => Record<string, any>;

/** The resources the scheduled sync covers. Drives what the Sync panel shows. */
export const SYNCED_RESOURCES = RESOURCE_SPECS.map((s) => s.resource);

/**
 * Resources whose run history is kept, which is deliberately wider than what
 * is displayed. The text backfill stores its resume point as the cursor on a
 * `textMessages` run row; pruning by the displayed set alone would delete that
 * row on the next sync and silently reset a half-finished 4,907-contact walk
 * back to the beginning.
 */
export const RETAINED_RESOURCES = [...SYNCED_RESOURCES, "textMessages"];

const ACTIVITY_MAPPERS: Record<string, ActivityMapper | undefined> = {
  events: mapEvent,
  calls: mapCall,
  tasks: mapTask,
  appointments: mapAppointment,
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

  // Ask only for what is new, two ways.
  //
  //   * A timestamp filter where the endpoint takes one, minus an hour of
  //     overlap so nothing falls through the boundary.
  //   * An id cursor for append-only resources, which is the only thing that
  //     makes /events tractable: thirty thousand rows is three hundred pages
  //     an hour otherwise, and every one of them a record already mirrored.
  //
  // Both are requests the API may refuse, so `usedIncremental` is remembered
  // and a 4xx on the first page retries the resource in full below.
  const params: Record<string, string | number | undefined> = {};
  let startCursor: string | undefined;
  let cursor: string | null = null;
  const lastCursor = opts.full ? null : storage.lastCrmCursor(spec.resource);

  if (spec.incrementalParam && lastCursor) {
    const since = new Date(Date.parse(lastCursor) - 60 * 60_000).toISOString();
    if (!Number.isNaN(Date.parse(since))) params[spec.incrementalParam] = since;
  } else if (spec.appendOnly && lastCursor && /^\d+$/.test(lastCursor)) {
    startCursor = sinceIdCursor(lastCursor);
  }
  const usedIncremental = !!params[spec.incrementalParam ?? ""] || !!startCursor;

  let page: PageResult;
  try {
    page = await fubGetAll(spec.path, spec.collectionKey, {
      params,
      startCursor,
      maxRecords: spec.maxRecords,
    });
    // A rejected incremental filter must not read as an outage. Retrying the
    // whole resource unfiltered costs one wasted request and self-corrects,
    // where reporting the 4xx would leave the resource stuck refusing to sync
    // every hour for as long as the cursor stayed in place.
    const status = page.status ?? 0;
    if (!page.ok && usedIncremental && status >= 400 && status < 500) {
      console.warn(
        `[crm-sync] ${spec.resource}: incremental request rejected (HTTP ${status}) — retrying in full`,
      );
      page = await fubGetAll(spec.path, spec.collectionKey, { maxRecords: spec.maxRecords });
    }
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
  const activityMapper = ACTIVITY_MAPPERS[spec.resource];
  let mapped: Array<Record<string, any>>;
  if (activityMapper) {
    mapped = page.records.map((r) => activityMapper(r, syncedAt));
  } else if (spec.resource === "people") {
    mapped = page.records.map((r) => mapContact(r, syncedAt));
  } else if (spec.resource === "deals") {
    mapped = page.records.map((r) => mapDeal(r, syncedAt));
  } else {
    mapped = page.records.map((r) => mapPipeline(r, syncedAt));
  }
  // A record with no id can't be upserted or de-duplicated.
  mapped = mapped.filter((m) => (m.fubId ?? m.uid) && m.fubId !== "");

  let inserted = 0;
  let updated = 0;
  if (mapped.length > 0) {
    const r = activityMapper
      ? storage.upsertCrmActivities(mapped)
      : spec.resource === "people"
        ? storage.upsertCrmContacts(mapped)
        : spec.resource === "deals"
          ? storage.upsertCrmDeals(mapped)
          : storage.upsertCrmPipelines(mapped);
    inserted = r.inserted;
    updated = r.updated;
  }

  // Deal stages ride along inside the pipelines payload, and are replaced
  // rather than upserted so a stage retired in Follow Up Boss stops rendering
  // as a permanently empty column — and so the twelve people stages an earlier
  // version wrote into this table are cleared out on the first run.
  if (spec.resource === "pipelines") {
    const stages: Array<Record<string, any>> = [];
    for (const p of page.records) {
      const pipelineId = idOf(p);
      const nested = Array.isArray(p?.stages) ? p.stages : [];
      for (const s of nested) {
        const row = mapStage(s, pipelineId, syncedAt);
        if (row.fubId) stages.push(row);
      }
    }
    if (page.ok) storage.replaceCrmStages(stages);
  }

  // High-water mark for the next run, in whichever currency this resource
  // resumes on. Both take it from the records actually seen, never from "now":
  // a clock skew or a page that failed late would otherwise advance the mark
  // past records this run never stored, and they would never be fetched again.
  //
  // A run that fetched nothing keeps the previous mark rather than clearing
  // it — that is the normal shape of an up-to-date incremental run.
  if (spec.incrementalParam) {
    const stamps = mapped
      .map((m) => m.fubUpdatedAt ?? m.occurredAt)
      .filter((s): s is string => typeof s === "string");
    cursor = stamps.length > 0 ? stamps.sort().slice(-1)[0] : lastCursor;
  } else if (spec.appendOnly) {
    const ids = mapped
      .map((m) => Number(m.fubId))
      .filter((n) => Number.isFinite(n) && n > 0);
    // Only advance on a clean run: stopping at a cutoff or an error mid-page
    // leaves a gap, and the highest id seen would skip straight over it.
    cursor =
      page.ok && !page.truncated && ids.length > 0 ? String(Math.max(...ids)) : lastCursor;
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
    // Always the full retained list, never `only` — a partial sync must not
    // retire the resources it happened to skip, and must not throw away the
    // text backfill's resume point.
    storage.pruneCrmSyncRuns(20, RETAINED_RESOURCES);
  } catch {
    /* pruning is housekeeping; never fail a sync over it */
  }
  return results;
}

function plannedSpecs(only?: string[]): ResourceSpec[] {
  return only?.length ? RESOURCE_SPECS.filter((s) => only.includes(s.resource)) : RESOURCE_SPECS;
}

// ---- Text messages, one contact at a time ----------------------------------

/**
 * Mirror a single contact's texts.
 *
 * Unlike every other resource this cannot be scheduled: GET /v1/textMessages
 * refuses a bare listing and demands a personId (or a thread, phone number or
 * id list) — so there is no account-wide collection to walk hourly. Fetching
 * per contact would be 4,900 requests an hour; fetching for the one contact
 * whose history is on screen is one request, and it lands in the same
 * crm_activities timeline as their calls and events.
 *
 * Failure is deliberately quiet. This runs while rendering a contact drawer
 * that already has their calls, events and deals from the mirror; a texting
 * endpoint being unavailable should cost the texts, not the drawer.
 */
export async function syncTextsForContact(
  personFubId: string,
): Promise<{ ok: boolean; fetched: number; error?: string }> {
  if (!fubConfigured()) return { ok: false, fetched: 0, error: "FUB_API_KEY not set" };

  const page = await fubGetAll("/textMessages", "textMessages", {
    params: { personId: personFubId },
    maxRecords: 2_000,
  });
  if (!page.ok && page.records.length === 0) {
    return { ok: false, fetched: 0, error: page.error ?? `HTTP ${page.status}` };
  }

  const syncedAt = new Date().toISOString();
  const mapped = page.records
    .map((r) => mapText(r, personFubId, syncedAt))
    .filter((m) => m.fubId);
  if (mapped.length > 0) storage.upsertCrmActivities(mapped);
  return { ok: page.ok, fetched: mapped.length };
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
  /**
   * Which long-running job this is. Both hold the same lock: they are the two
   * things that hammer the Follow Up Boss API for minutes at a time, and
   * running them together would just spend the rate limit twice as fast.
   */
  kind: "sync" | "text-backfill";
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
  /**
   * Item-level progress, for a job whose unit of work isn't a resource. The
   * backfill walks 4,907 contacts; "1 of 1 resources" would be a useless
   * progress bar for something that runs for half an hour.
   */
  progress: { done: number; total: number; label: string } | null;
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
    kind: "sync",
    trigger: opts.trigger ?? "manual",
    full: !!opts.full,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    running: true,
    planned: plannedSpecs(opts.only).map((s) => s.resource),
    current: null,
    results: [],
    progress: null,
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

// ---- Text backfill ---------------------------------------------------------
//
// The scheduled sync cannot mirror texts, because Follow Up Boss has no
// account-wide text listing — so the CRM fetches them for one contact at a
// time, when their history is opened. That is fine for a dashboard reading a
// live CRM, and completely inadequate as an export: a contact nobody has
// clicked has no texts stored anywhere but Follow Up Boss.
//
// This walks every contact once and closes that gap. It is a one-time job by
// intention, not a schedule — 4,907 contacts is 4,907 requests, which is a
// reasonable thing to do deliberately and an unreasonable thing to do hourly.
//
// It resumes. Progress is recorded as a cursor against a `textMessages` run
// row (a resource the scheduled sync doesn't cover, which is why that row is
// filtered out of the sync panel but deliberately kept by the pruner), so a
// crash, a deploy or a cancelled run picks up where it stopped instead of
// spending another half hour re-fetching what it already has.

export const TEXT_BACKFILL_RESOURCE = "textMessages";

export interface BackfillProgress {
  contactsDone: number;
  contactsTotal: number;
  textsFetched: number;
  failures: number;
}

export function startTextBackfillJob(opts: { restart?: boolean } = {}): {
  started: boolean;
  job: SyncJob;
  done: Promise<SyncJob>;
} {
  if (job?.running) return { started: false, job, done: jobDone };

  // includePartial, because an interrupted run is exactly when resuming
  // matters and such a run is recorded as `partial`.
  const resumeAfter = opts.restart
    ? null
    : storage.lastCrmCursor(TEXT_BACKFILL_RESOURCE, { includePartial: true });
  const ids = storage.listCrmContactIds(resumeAfter);

  const next: SyncJob = {
    id: ++jobSeq,
    kind: "text-backfill",
    trigger: "manual",
    full: !!opts.restart,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    running: true,
    planned: [TEXT_BACKFILL_RESOURCE],
    current: TEXT_BACKFILL_RESOURCE,
    results: [],
    progress: {
      done: 0,
      total: ids.length,
      label: resumeAfter ? `Resuming after contact ${resumeAfter}` : "Every contact",
    },
    error: null,
  };
  job = next;

  jobDone = runTextBackfill(ids, next, resumeAfter)
    .catch((e: any) => {
      next.error = String(e?.message ?? e).slice(0, 500);
      console.error("[crm-backfill] failed:", e);
    })
    .then(() => {
      next.current = null;
      next.running = false;
      next.finishedAt = new Date().toISOString();
      return next;
    });

  return { started: true, job: next, done: jobDone };
}

async function runTextBackfill(
  ids: string[],
  state: SyncJob,
  resumeAfter: string | null,
): Promise<void> {
  const t0 = Date.now();
  const run = storage.createCrmSyncRun({
    resource: TEXT_BACKFILL_RESOURCE,
    status: "error",
    startedAt: state.startedAt,
    trigger: "manual",
  } as any);

  let fetched = 0;
  let failures = 0;
  let lastDone: string | null = null;
  let aborted: string | null = null;

  for (const fubId of ids) {
    try {
      const r = await syncTextsForContact(fubId);
      if (r.ok) {
        fetched += r.fetched;
      } else {
        failures++;
        // A contact with no texts is not a failure, but a run where nothing
        // works at all is — usually a revoked key or a rate limit we are not
        // backing off from. Stopping keeps the cursor honest instead of
        // marching to the end recording thousands of empty successes.
        if (failures > 50 && fetched === 0) {
          aborted = `Gave up after ${failures} consecutive failures without a single text — check the API key.`;
          break;
        }
      }
    } catch (e: any) {
      failures++;
    }
    lastDone = fubId;
    if (state.progress) {
      state.progress.done++;
    }
    // Deliberately unhurried. This runs once and has all the time it needs;
    // tripping Follow Up Boss's rate limit would cost more than it saves.
    await new Promise((s) => setTimeout(s, 200));
  }

  // A run with nothing queued is finished, not partial: it means a previous
  // pass already reached the end. Getting this wrong mattered — the row would
  // land as `partial` with a null cursor, and because the resume now honours
  // partial rows, the *next* run would read that null and walk all 4,907
  // contacts from the top.
  const complete = !aborted && (ids.length === 0 || lastDone === ids[ids.length - 1]);
  storage.finishCrmSyncRun(run.id, {
    status: aborted ? "error" : complete ? "ok" : "partial",
    fetched,
    inserted: fetched,
    updated: 0,
    pages: ids.length,
    httpStatus: null,
    error: aborted,
    truncated: !complete,
    nullRates: "{}",
    // The last contact actually finished. Never regress: a run that processed
    // nobody keeps the previous mark rather than clearing it, so the resume
    // point only ever moves forward.
    cursor: lastDone ?? resumeAfter,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
  } as any);

  state.results = [
    {
      resource: TEXT_BACKFILL_RESOURCE,
      status: aborted ? "error" : complete ? "ok" : "partial",
      fetched,
      inserted: fetched,
      updated: 0,
      error: aborted ?? (failures > 0 ? `${failures} contacts could not be read` : undefined),
    },
  ];
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
