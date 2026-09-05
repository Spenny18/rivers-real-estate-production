// Admin API for the CRM mirror — everything /admin/crm reads and triggers.
//
// All of it is behind requireAuth: this is Spencer's whole contact database,
// not public data. Nothing here is exposed on a public route.

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { fubConfigured, probe, testConnection } from "./fub-client";
import { RESOURCE_SPECS, syncAll } from "./fub-sync";

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
 * Columns reading 100% null across a run almost certainly mapped to a field
 * name Follow Up Boss doesn't use. Surfaced so an empty column is diagnosed
 * as a mapping bug rather than mistaken for an empty CRM.
 */
function mappingWarnings(): Array<{ resource: string; fields: string[] }> {
  const out: Array<{ resource: string; fields: string[] }> = [];
  for (const run of storage.latestCrmSyncRuns()) {
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
        stages: stages.map((s) => {
          const inStage = deals.filter((d) => d.stageFubId === s.fubId);
          return {
            fubId: s.fubId,
            name: s.name,
            count: inStage.length,
            value: inStage.reduce((sum, d) => sum + (d.value ?? 0), 0),
          };
        }),
      },
      activity: {
        calls: storage.listCrmActivities({ kind: "call", limit: 1000 }).length,
        texts: storage.listCrmActivities({ kind: "text", limit: 1000 }).length,
        events: storage.listCrmActivities({ kind: "event", limit: 1000 }).length,
      },
      openTasks: storage.listCrmOpenTasks(10).map(dtoActivity),
      syncRuns: storage.latestCrmSyncRuns().map(dtoSyncRun),
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
  app.get("/api/admin/crm/contacts/:fubId", requireAuth, (req, res) => {
    const fubId = String((req.params as any).fubId ?? "");
    const contact = storage.getCrmContact(fubId);
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    res.json({
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
   * Run a sync now. `full=1` ignores the incremental cursor and re-pulls
   * everything; `only=people,deals` limits which resources run.
   */
  app.post("/api/admin/crm/sync", requireAuth, async (req, res) => {
    if (!fubConfigured()) {
      return res.status(400).json({ message: "FUB_API_KEY not set on server" });
    }
    const only =
      typeof req.body?.only === "string"
        ? req.body.only.split(",").map((s: string) => s.trim()).filter(Boolean)
        : Array.isArray(req.body?.only)
          ? req.body.only
          : undefined;
    try {
      const results = await syncAll({
        trigger: "manual",
        full: !!req.body?.full,
        only,
      });
      res.json({ ok: true, results });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Sync failed" });
    }
  });

  app.get("/api/admin/crm/sync-runs", requireAuth, (_req, res) => {
    res.json(storage.latestCrmSyncRuns().map(dtoSyncRun));
  });
}
