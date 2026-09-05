// Admin API for the CRM mirror — everything /admin/crm reads and triggers.
//
// All of it is behind requireAuth: this is Spencer's whole contact database,
// not public data. Nothing here is exposed on a public route.

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { fubConfigured, probe, testConnection } from "./fub-client";
import {
  RESOURCE_SPECS,
  SYNCED_RESOURCES,
  currentSyncJob,
  startSyncJob,
  startTextBackfillJob,
  syncTextsForContact,
} from "./fub-sync";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function qs(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// ---- Response projection ---------------------------------------------------
//
// Never return the storage row itself. Each row carries the untouched FUB
// payload in `raw` — kept so a wrong field mapping can be re-derived — which
// the client has no use for and which contains contact fields beyond what this
// UI shows. It would also end up in the application log, because the request
// logger in server/index.ts stringifies every JSON API response: a single CRM
// page load would write a hundred full contact records into Fly's logs.
//
// So these DTOs are the wire format, and `raw` never leaves the database.

function dtoContact(c: any) {
  return {
    fubId: c.fubId,
    name: c.name,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    stage: c.stage,
    source: c.source,
    assignedTo: c.assignedTo,
    tags: c.tags,
    fubCreatedAt: c.fubCreatedAt,
    fubUpdatedAt: c.fubUpdatedAt,
    lastActivityAt: c.lastActivityAt,
  };
}

function dtoDeal(d: any) {
  return {
    fubId: d.fubId,
    name: d.name,
    value: d.value,
    stageFubId: d.stageFubId,
    stageName: d.stageName,
    pipelineFubId: d.pipelineFubId,
    status: d.status,
    contactFubId: d.contactFubId,
    closedDate: d.closedDate,
    fubUpdatedAt: d.fubUpdatedAt,
  };
}

function dtoActivity(a: any) {
  return {
    id: a.id,
    kind: a.kind,
    contactFubId: a.contactFubId,
    title: a.title,
    body: a.body,
    direction: a.direction,
    outcome: a.outcome,
    durationSeconds: a.durationSeconds,
    occurredAt: a.occurredAt,
    dueAt: a.dueAt,
    completed: a.completed,
    assignedTo: a.assignedTo,
  };
}

/** Sync runs minus the raw error blob, which can be a whole API response. */
function dtoSyncRun(r: any) {
  return {
    id: r.id,
    resource: r.resource,
    status: r.status,
    fetched: r.fetched,
    inserted: r.inserted,
    updated: r.updated,
    pages: r.pages,
    httpStatus: r.httpStatus,
    error: r.error ? String(r.error).slice(0, 300) : null,
    truncated: r.truncated ?? false,
    nullRates: r.nullRates,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    trigger: r.trigger,
  };
}

/**
 * The pipeline board's columns.
 *
 * Built from two sources deliberately. The synced stage list gives order and
 * keeps a stage with no deals visible as an empty column, which is most of the
 * point of a board. The deals themselves are the backstop: each one carries
 * its own stageId AND stageName, so any stage the synced list is missing is
 * still rendered rather than silently swallowing its deals.
 *
 * That second half is what makes this robust to the mistake it replaces. The
 * board previously came from /v1/stages alone, which returns people stages —
 * a different id space entirely — so every column was empty while the deal
 * count above it read 128. Deriving from the deals cannot desync that way,
 * because the ids being grouped are the ids being matched.
 */
function dealStageBoard(
  stages: Array<{ fubId: string; name: string | null; sortOrder: number }>,
  deals: Array<{ stageFubId: string | null; stageName: string | null; value: number | null }>,
): Array<{ fubId: string; name: string | null; count: number; value: number }> {
  const columns = new Map<string, { fubId: string; name: string | null; sortOrder: number }>();
  for (const s of stages) columns.set(s.fubId, s);
  for (const d of deals) {
    if (!d.stageFubId || columns.has(d.stageFubId)) continue;
    columns.set(d.stageFubId, {
      fubId: d.stageFubId,
      name: d.stageName,
      // Unknown to the synced order; park these after the known stages
      // rather than interleaving them at position zero.
      sortOrder: Number.MAX_SAFE_INTEGER,
    });
  }
  return Array.from(columns.values())
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.name ?? "").localeCompare(b.name ?? ""))
    .map((s) => {
      const inStage = deals.filter((d) => d.stageFubId === s.fubId);
      return {
        fubId: s.fubId,
        name: s.name,
        count: inStage.length,
        value: inStage.reduce((sum, d) => sum + (d.value ?? 0), 0),
      };
    });
}

/**
 * Columns reading 100% null across a run almost certainly mapped to a field
 * name Follow Up Boss doesn't use. Surfaced so an empty column is diagnosed
 * as a mapping bug rather than mistaken for an empty CRM.
 */
function mappingWarnings(): Array<{ resource: string; fields: string[] }> {
  const out: Array<{ resource: string; fields: string[] }> = [];
  for (const run of storage.latestCrmSyncRuns(SYNCED_RESOURCES)) {
    if (run.status === "skipped" || run.fetched === 0) continue;
    try {
      const rates = JSON.parse(run.nullRates) as Record<string, number>;
      const bad = Object.entries(rates)
        .filter(([, rate]) => rate >= 1)
        .map(([field]) => field);
      if (bad.length > 0) out.push({ resource: run.resource, fields: bad });
    } catch {
      /* malformed json is not worth failing the page over */
    }
  }
  return out;
}

export function registerCrmRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  /** Headline numbers plus connection and sync health. */
  app.get("/api/admin/crm/overview", requireAuth, (_req, res) => {
    const deals = storage.listCrmDeals({ limit: 5000 });
    const stages = storage.listCrmStages();
    const open = deals.filter(
      (d) => !d.status || !/won|lost|closed/i.test(d.status),
    );
    const won = deals.filter((d) => d.status && /won/i.test(d.status));

    const now = Date.now();
    const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
    const contacts = storage.listCrmContacts({ limit: 5000 });

    res.json({
      configured: fubConfigured(),
      contacts: {
        total: storage.countCrmContacts(),
        newThisWeek: contacts.filter((c) => (c.fubCreatedAt ?? "") >= weekAgo).length,
        byStage: Object.entries(
          contacts.reduce<Record<string, number>>((acc, c) => {
            const k = c.stage ?? "Unstaged";
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {}),
        )
          .map(([stage, count]) => ({ stage, count }))
          .sort((a, b) => b.count - a.count),
      },
      deals: {
        total: deals.length,
        open: open.length,
        openValue: open.reduce((s, d) => s + (d.value ?? 0), 0),
        wonValue: won.reduce((s, d) => s + (d.value ?? 0), 0),
        stages: dealStageBoard(stages, deals),
      },
      activity: {
        calls: storage.listCrmActivities({ kind: "call", limit: 1000 }).length,
        texts: storage.listCrmActivities({ kind: "text", limit: 1000 }).length,
        events: storage.listCrmActivities({ kind: "event", limit: 1000 }).length,
      },
      openTasks: storage.listCrmOpenTasks(10).map(dtoActivity),
      syncRuns: storage.latestCrmSyncRuns(SYNCED_RESOURCES).map(dtoSyncRun),
      mappingWarnings: mappingWarnings(),
      resources: RESOURCE_SPECS.map((s) => ({
        resource: s.resource,
        optional: !!s.optional,
        note: s.note ?? null,
      })),
    });
  });

  // Search and stage filtering happen in the query, not in the browser — the
  // client only ever holds a page of rows, so filtering there would silently
  // search just that page.
  app.get("/api/admin/crm/contacts", requireAuth, (req, res) => {
    res.json(
      storage
        .listCrmContacts({
          q: qs(req, "q"),
          stage: qs(req, "stage"),
          limit: Math.min(toInt(req.query.limit, 200), 500),
        })
        .map(dtoContact),
    );
  });

  /** One contact with their full interleaved history. */
  app.get("/api/admin/crm/contacts/:fubId", requireAuth, async (req, res) => {
    const fubId = String((req.params as any).fubId ?? "");
    const contact = storage.getCrmContact(fubId);
    if (!contact) return res.status(404).json({ message: "Contact not found" });

    // Texts are the one resource with no account-wide listing — Follow Up Boss
    // requires a personId — so they are pulled here, for this contact, while
    // their history is being assembled. One request against an endpoint that
    // has already returned a page in this session; awaited so the texts appear
    // in the same response rather than on a second click.
    //
    // Never fatal: this drawer's calls, events and deals come from the mirror
    // and render fine without it.
    let texts: { ok: boolean; fetched: number; error?: string } = { ok: true, fetched: 0 };
    if (fubConfigured()) {
      try {
        texts = await syncTextsForContact(fubId);
      } catch (e: any) {
        texts = { ok: false, fetched: 0, error: String(e?.message ?? e).slice(0, 200) };
      }
    }

    res.json({
      texts,
      contact: dtoContact(contact),
      activities: storage.listCrmActivities({ contactFubId: fubId, limit: 200 }).map(dtoActivity),
      // Filtered in the query rather than after a global limit — otherwise a
      // contact whose deals fall outside the newest N account-wide shows an
      // empty drawer despite having mirrored deals.
      deals: storage.listCrmDeals({ contactFubId: fubId, limit: 200 }).map(dtoDeal),
    });
  });

  app.get("/api/admin/crm/deals", requireAuth, (req, res) => {
    res.json(
      storage
        .listCrmDeals({
          stageFubId: qs(req, "stage"),
          contactFubId: qs(req, "contact"),
          limit: Math.min(toInt(req.query.limit, 500), 2000),
        })
        .map(dtoDeal),
    );
  });

  app.get("/api/admin/crm/activities", requireAuth, (req, res) => {
    res.json(
      storage
        .listCrmActivities({
          kind: qs(req, "kind"),
          contactFubId: qs(req, "contact"),
          limit: Math.min(toInt(req.query.limit, 200), 1000),
        })
        .map(dtoActivity),
    );
  });

  app.get("/api/admin/crm/tasks", requireAuth, (_req, res) => {
    res.json(storage.listCrmOpenTasks(100).map(dtoActivity));
  });

  /** Credential check for the connection card. */
  app.get("/api/admin/crm/test", requireAuth, async (_req, res) => {
    if (!fubConfigured()) {
      return res.json({ ok: false, configured: false, error: "FUB_API_KEY not set on server" });
    }
    const r = await testConnection();
    res.json({ ...r, configured: true });
  });

  /**
   * Report what the API actually returns, per resource.
   *
   * The mapping in fub-sync.ts was written without access to the Follow Up
   * Boss reference, so this is how a guess becomes a fact: field names, not
   * field values — a diagnostic shouldn't spray contact data around.
   */
  app.get("/api/admin/crm/probe", requireAuth, async (_req, res) => {
    if (!fubConfigured()) {
      return res.status(400).json({ message: "FUB_API_KEY not set on server" });
    }
    res.json(await probe());
  });

  /**
   * Start a sync. `full` ignores the incremental cursor and re-pulls
   * everything; `only: ["people","deals"]` limits which resources run.
   *
   * Returns as soon as the job is running rather than waiting for it. A full
   * pass walks nine paged endpoints and takes minutes, while Fly's proxy drops
   * an idle connection after about a minute — so waiting here would show the
   * browser a failure for a sync that was going to succeed. The client polls
   * /sync-job for progress instead.
   */
  app.post("/api/admin/crm/sync", requireAuth, (req, res) => {
    if (!fubConfigured()) {
      return res.status(400).json({ message: "FUB_API_KEY not set on server" });
    }
    const only =
      typeof req.body?.only === "string"
        ? req.body.only.split(",").map((s: string) => s.trim()).filter(Boolean)
        : Array.isArray(req.body?.only)
          ? req.body.only.map((s: unknown) => String(s))
          : undefined;

    const { started, job } = startSyncJob({
      trigger: "manual",
      full: !!req.body?.full,
      only,
    });
    // 202 either way: a sync is running when this returns, which is what was
    // asked for. `started: false` only says it was already under way — an
    // hourly cycle, or a double-click — and the caller should watch that one.
    res.status(202).json({ started, job });
  });

  /** Live progress of the running sync, or the last one that finished. */
  app.get("/api/admin/crm/sync-job", requireAuth, (_req, res) => {
    res.json({ job: currentSyncJob() });
  });

  /**
   * Walk every contact once and pull their texts.
   *
   * Follow Up Boss has no account-wide text listing, so the scheduled sync
   * cannot mirror texts and the CRM fetches them per contact on demand. That
   * leaves every contact nobody has clicked with no texts stored anywhere but
   * Follow Up Boss — fine for a dashboard, useless as an export. This closes
   * that gap in one deliberate pass, and resumes where it left off.
   */
  app.post("/api/admin/crm/backfill-texts", requireAuth, (req, res) => {
    if (!fubConfigured()) {
      return res.status(400).json({ message: "FUB_API_KEY not set on server" });
    }
    const { started, job } = startTextBackfillJob({ restart: !!req.body?.restart });
    res.status(202).json({ started, job });
  });

  /**
   * How much call audio there is to bring across, and roughly how big.
   *
   * Reads what is already mirrored — no requests to Follow Up Boss — so it is
   * safe to call from a page load.
   */
  app.get("/api/admin/crm/recordings", requireAuth, (_req, res) => {
    const inv = storage.crmRecordingInventory();
    res.json({
      ...inv,
      // The reason this endpoint exists rather than a number in a doc.
      note:
        "Recording audio is hosted by Follow Up Boss and the stored URLs stop " +
        "resolving when the account closes. Downloading is a one-time job that " +
        "has to happen before cancelling.",
    });
  });

  app.get("/api/admin/crm/sync-runs", requireAuth, (_req, res) => {
    res.json(storage.latestCrmSyncRuns(SYNCED_RESOURCES).map(dtoSyncRun));
  });
}
