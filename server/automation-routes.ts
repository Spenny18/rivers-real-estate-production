// Automations on /admin/automations (server/automations.ts).
//
//   GET    /api/admin/automations                 plans, with counts, plus what's waiting for approval
//   POST   /api/admin/automations                 { name, template? } a new plan (off)
//   GET    /api/admin/automations/:id             one plan, its people and their activity
//   PATCH  /api/admin/automations/:id             { name?, description?, trigger?, steps?, mode?, stopOnReply? }
//   DELETE /api/admin/automations/:id
//   POST   /api/admin/automations/:id/enroll      { contactFubId } add someone by hand
//   POST   /api/admin/automation-runs/:id/stop    stop one person's plan
//   GET    /api/admin/automation-runs/:id/steps   what one person's plan did
//   POST   /api/admin/automation-approvals/:id    { decision: send|skip|stop, body?, subject? }
//   GET    /api/admin/automation-tasks            open tasks the plans created
//   POST   /api/admin/automation-tasks/complete   { uid, done }
//   GET    /api/admin/automation-meta             sources, tags and merge fields for the builder

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sqlite, storage } from "./storage";
import {
  completeAppTask,
  createAutomation,
  decide,
  deleteAutomation,
  enroll,
  getAutomation,
  listAppTasks,
  listAutomations,
  listPending,
  newStepId,
  runsFor,
  stepsForRun,
  stopRun,
  updateAutomation,
  validateSteps,
  type Step,
} from "./automations";
import { LEAD_SOURCES } from "./lead-intake";
import { smsConfigured } from "./sms";
import { canSendEmail } from "./gmail";
import { agentUserId } from "./gmail-inbox";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ id: z.string(), type: z.literal("wait"), amount: z.number().min(0).max(10000), unit: z.enum(["minutes", "hours", "days"]) }),
    z.object({ id: z.string(), type: z.literal("send_text"), body: z.string().max(1600) }),
    z.object({ id: z.string(), type: z.literal("send_email"), subject: z.string().max(300), body: z.string().max(20000) }),
    z.object({ id: z.string(), type: z.literal("add_tag"), tag: z.string().max(60) }),
    z.object({ id: z.string(), type: z.literal("remove_tag"), tag: z.string().max(60) }),
    z.object({ id: z.string(), type: z.literal("create_task"), title: z.string().max(300), note: z.string().max(4000).optional(), dueInHours: z.number().min(0).max(24 * 365).optional() }),
    z.object({ id: z.string(), type: z.literal("social_task"), network: z.enum(["facebook", "instagram", "linkedin"]), message: z.string().max(2000) }),
    z.object({ id: z.string(), type: z.literal("start_plan"), automationId: z.number().int() }),
    z.object({
      id: z.string(),
      type: z.literal("condition"),
      check: z.enum(["has_phone", "has_email", "has_tag", "replied", "source_is"]),
      value: z.string().max(120).optional(),
      yes: z.array(stepSchema),
      no: z.array(stepSchema),
    }),
  ]) as any,
);

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("new_lead"), sources: z.array(z.string().max(120)).max(30).optional() }),
  z.object({ type: z.literal("tag_added"), tag: z.string().trim().min(1, "Pick a tag").max(60) }),
  z.object({ type: z.literal("manual") }),
]);

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  trigger: triggerSchema.optional(),
  steps: z.array(stepSchema).max(200).optional(),
  mode: z.enum(["off", "review", "auto"]).optional(),
  stopOnReply: z.boolean().optional(),
});

/** A starting point that mirrors Follow Up Boss's "Buyer New Lead" plan. */
function buyerNewLeadTemplate(): Step[] {
  const id = newStepId;
  return [
    {
      id: id(),
      type: "send_text",
      body: "Hi {first_name}, it's {agent_first_name} with Rivers Real Estate. Thanks for reaching out about {property}. When's a good time to chat, or would you like to see it in person?",
    },
    {
      id: id(),
      type: "send_email",
      subject: "Your inquiry about {property}",
      body:
        "Hi {first_name},\n\nThanks for your interest in {property}. I'd be happy to send you more details, comparable sales, or set up a private showing.\n\nWhat would be most helpful?\n\n{agent_name}\n{agent_phone}",
    },
    { id: id(), type: "create_task", title: "Call {name}", note: "New lead from {source}", dueInHours: 1 },
    { id: id(), type: "wait", amount: 1, unit: "days" },
    {
      id: id(),
      type: "condition",
      check: "replied",
      yes: [{ id: id(), type: "add_tag", tag: "Engaged" }],
      no: [
        { id: id(), type: "send_text", body: "Hi {first_name}, just following up on {property}. Happy to answer any questions or book a time to see it." },
        { id: id(), type: "wait", amount: 3, unit: "days" },
        {
          id: id(),
          type: "send_email",
          subject: "Still looking?",
          body: "Hi {first_name},\n\nAre you still searching? If you tell me what matters most in your next home, I'll send you listings that fit, often before they hit Realtor.ca.\n\n{agent_name}",
        },
        { id: id(), type: "wait", amount: 7, unit: "days" },
        { id: id(), type: "create_task", title: "Check in with {name}", note: "No reply to the new-lead plan after 11 days", dueInHours: 0 },
      ],
    },
  ];
}

export function registerAutomationRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  app.get("/api/admin/automations", requireAuth, (_req, res) => {
    const counts = sqlite
      .prepare(`SELECT automation_id AS id, status, COUNT(*) AS n FROM automation_runs GROUP BY automation_id, status`)
      .all() as Array<{ id: number; status: string; n: number }>;
    res.json({
      automations: listAutomations().map((a) => ({
        ...a,
        counts: Object.fromEntries(counts.filter((c) => c.id === a.id).map((c) => [c.status, c.n])),
      })),
      pending: listPending(),
    });
  });

  app.get("/api/admin/automation-meta", requireAuth, (_req, res) => {
    const sources = sqlite
      .prepare(`SELECT source, COUNT(*) AS n FROM crm_contacts WHERE source IS NOT NULL AND source != '' GROUP BY source ORDER BY n DESC LIMIT 60`)
      .all() as Array<{ source: string; n: number }>;
    const tagRows = sqlite.prepare(`SELECT tags FROM crm_contacts WHERE tags IS NOT NULL AND tags != '[]' LIMIT 5000`).all() as Array<{ tags: string }>;
    const tags = new Set<string>();
    for (const r of tagRows) {
      try {
        for (const t of JSON.parse(r.tags)) if (typeof t === "string") tags.add(t);
      } catch {
        /* skip */
      }
    }
    for (const r of sqlite.prepare(`SELECT DISTINCT tag FROM contact_tags`).all() as Array<{ tag: string }>) tags.add(r.tag);
    const userId = agentUserId();
    const texting = smsConfigured();
    const email = userId ? canSendEmail(userId) : { ok: false, reason: "No agent user" };
    res.json({
      sources: Array.from(new Set([...LEAD_SOURCES.map((s) => s.label), ...sources.map((s) => s.source)])),
      tags: Array.from(tags).sort((a, b) => a.localeCompare(b)).slice(0, 300),
      channels: {
        text: texting.ok ? { ok: true } : { ok: false, reason: `Texting isn't set up (missing ${texting.missing.join(", ")})` },
        email,
      },
      fields: ["first_name", "name", "property", "source", "agent_name", "agent_first_name", "agent_phone"],
    });
  });

  app.post("/api/admin/automations", requireAuth, (req, res) => {
    const name = String(req.body?.name ?? "").trim() || "New action plan";
    const template = req.body?.template === "buyer_new_lead";
    const a = createAutomation({
      name,
      description: template ? "Replaces Follow Up Boss's Buyer New Lead plan." : null,
      trigger: template ? { type: "new_lead" } : { type: "manual" },
      steps: template ? buyerNewLeadTemplate() : [],
    });
    res.json(a);
  });

  app.get("/api/admin/automations/:id", requireAuth, (req, res) => {
    const a = getAutomation(Number(req.params.id));
    if (!a) return res.status(404).json({ message: "Not found" });
    res.json({ automation: a, runs: runsFor({ automationId: a.id, limit: 200 }), problems: validateSteps(a.steps, a.id) });
  });

  app.patch("/api/admin/automations/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const existing = getAutomation(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Please check the plan." });
    const b = parsed.data;
    const steps = b.steps ?? existing.steps;
    const mode = b.mode ?? existing.mode;
    if (mode !== "off") {
      const problems = validateSteps(steps, id);
      if (problems.length) return res.status(400).json({ message: problems[0], problems });
      if (steps.length === 0) return res.status(400).json({ message: "Add at least one step before switching the plan on." });
    }
    res.json(updateAutomation(id, b));
  });

  app.delete("/api/admin/automations/:id", requireAuth, (req, res) => {
    deleteAutomation(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post("/api/admin/automations/:id/enroll", requireAuth, (req, res) => {
    const a = getAutomation(Number(req.params.id));
    if (!a) return res.status(404).json({ message: "Not found" });
    if (a.mode === "off") return res.status(400).json({ message: "Switch the plan on first." });
    const contactId = String(req.body?.contactFubId ?? "");
    if (!storage.getCrmContact(contactId)) return res.status(404).json({ message: "Contact not found" });
    const runId = enroll(a, contactId, { reason: "added by hand" });
    if (!runId) return res.status(409).json({ message: "They're already in this plan." });
    res.json({ runId });
  });

  app.post("/api/admin/automation-runs/:id/stop", requireAuth, (req, res) => {
    stopRun(Number(req.params.id), "Stopped by hand");
    res.json({ ok: true });
  });

  app.get("/api/admin/automation-runs/:id/steps", requireAuth, (req, res) => {
    res.json(stepsForRun(Number(req.params.id)));
  });

  app.post("/api/admin/automation-approvals/:id", requireAuth, async (req, res) => {
    const decision = req.body?.decision;
    if (!["send", "skip", "stop"].includes(decision)) return res.status(400).json({ message: "Bad decision" });
    const r = await decide(Number(req.params.id), decision, {
      body: typeof req.body?.body === "string" ? req.body.body : undefined,
      subject: typeof req.body?.subject === "string" ? req.body.subject : undefined,
    });
    if (!r.ok) return res.status(409).json({ message: r.error });
    res.json({ ok: true });
  });

  app.get("/api/admin/automation-tasks", requireAuth, (_req, res) => {
    res.json(listAppTasks());
  });

  app.post("/api/admin/automation-tasks/complete", requireAuth, (req, res) => {
    const ok = completeAppTask(String(req.body?.uid ?? ""), req.body?.done !== false);
    if (!ok) return res.status(404).json({ message: "Not found" });
    res.json({ ok: true });
  });
}
