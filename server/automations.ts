// Automations (action plans): a trigger, then a tree of steps — wait, text,
// email, tag, task, social-message task, start another plan, if/else — built
// on /admin/automations and run here.
//
// Shape. An automation's steps are a tree: a list of steps, where an if/else
// step carries a "yes" list and a "no" list and ends its own list (branches
// don't join back up). Every step has a stable id; a person's place in a plan
// is the id of the step they're on, so editing a running plan only moves
// people who are past a deleted step (they finish).
//
// Modes. A plan is off, in review (texts and emails wait on the Automations
// page for one-click approval) or automatic. New plans start in review.
//
// Who gets enrolled.
//   - new_lead: optionally only buyers or only sellers (leadTypeFor), and
//     optionally only some sources. Every lead the app creates (forms, bookings, lead emails) —
//     via onLeadCreated in contacts.ts — and every contact the Follow Up Boss
//     sync brings in that was created after the plan was switched on, so
//     leads that only reach FUB (ReferralExchange, the WordPress site) count.
//     Each contact fires once, ever (automation_fired), which also survives
//     contacts.ts folding the app's copy of a person into FUB's.
//   - tag_added: when a plan (or the admin) adds that tag.
//   - manual: added by hand on the Automations page.
//
// Safety. A person is in a plan at most once at a time. Their plan stops when
// they reply (text or email) if the plan says so. Automatic texts never go
// out between 9 pm and 8 am Calgary time — they wait for the morning. Every step taken is
// logged (automation_steps) and shown on the plan's activity.
//
// Tags and tasks added here are the app's own (contact_tags, and crm_activities
// rows with an "app-task" uid): the FUB sync rewrites FUB's own tags and tasks
// and would otherwise erase them.

import { randomBytes } from "node:crypto";
import { sqlite, storage } from "./storage";
import { AGENT } from "./brand";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    trigger TEXT NOT NULL DEFAULT '{"type":"manual"}',
    steps TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT 'off',          -- off | review | auto
    stop_on_reply INTEGER NOT NULL DEFAULT 1,
    enabled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- One person going through one plan.
  CREATE TABLE IF NOT EXISTS automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    automation_id INTEGER NOT NULL,
    contact_fub_id TEXT NOT NULL,
    lead_id INTEGER,
    -- active | approval | completed | stopped
    status TEXT NOT NULL,
    step_id TEXT,
    next_at TEXT,
    -- Set when the current step is a wait that has started.
    wait_until TEXT,
    context TEXT NOT NULL DEFAULT '{}',
    stopped_reason TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_automation_runs_due ON automation_runs(status, next_at);
  CREATE INDEX IF NOT EXISTS idx_automation_runs_contact ON automation_runs(contact_fub_id);

  -- Everything a run did, and messages waiting for approval.
  CREATE TABLE IF NOT EXISTS automation_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    step_id TEXT NOT NULL,
    type TEXT NOT NULL,
    -- done | failed | skipped | pending | approved | rejected
    status TEXT NOT NULL,
    detail TEXT,
    payload TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_automation_steps_run ON automation_steps(run_id);
  CREATE INDEX IF NOT EXISTS idx_automation_steps_status ON automation_steps(status);

  -- Contacts a new_lead trigger has already fired for.
  CREATE TABLE IF NOT EXISTS automation_fired (
    contact_fub_id TEXT PRIMARY KEY,
    fired_at TEXT NOT NULL
  );

  -- Tags the app adds; FUB's own tags stay in crm_contacts.tags.
  CREATE TABLE IF NOT EXISTS contact_tags (
    contact_fub_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (contact_fub_id, tag)
  );
`);

// ---- Types ------------------------------------------------------------------------------

export type LeadType = "buyer" | "seller" | "renter";

export type Trigger =
  | { type: "new_lead"; sources?: string[]; leadType?: "buyer" | "seller" }
  | { type: "tag_added"; tag: string }
  | { type: "manual" };

export type Mode = "off" | "review" | "auto";

export type Step =
  | { id: string; type: "wait"; amount: number; unit: "minutes" | "hours" | "days" }
  | { id: string; type: "send_text"; body: string }
  | { id: string; type: "send_email"; subject: string; body: string }
  | { id: string; type: "add_tag"; tag: string }
  | { id: string; type: "remove_tag"; tag: string }
  | { id: string; type: "create_task"; title: string; note?: string; dueInHours?: number }
  | { id: string; type: "social_task"; network: "facebook" | "instagram" | "linkedin"; message: string }
  | { id: string; type: "start_plan"; automationId: number }
  | {
      id: string;
      type: "condition";
      check: "has_phone" | "has_email" | "has_tag" | "replied" | "source_is";
      value?: string;
      yes: Step[];
      no: Step[];
    };

export type StepType = Step["type"];

export interface Automation {
  id: number;
  name: string;
  description: string | null;
  trigger: Trigger;
  steps: Step[];
  mode: Mode;
  stopOnReply: boolean;
  enabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toAutomation(r: any): Automation {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    trigger: JSON.parse(r.trigger),
    steps: JSON.parse(r.steps),
    mode: r.mode,
    stopOnReply: !!r.stop_on_reply,
    enabledAt: r.enabled_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function newStepId(): string {
  return `s_${randomBytes(5).toString("hex")}`;
}

// ---- Automations ----------------------------------------------------------------------------

export function listAutomations(): Automation[] {
  return (sqlite.prepare(`SELECT * FROM automations ORDER BY name COLLATE NOCASE`).all() as any[]).map(toAutomation);
}

export function getAutomation(id: number): Automation | null {
  const r = sqlite.prepare(`SELECT * FROM automations WHERE id = ?`).get(id);
  return r ? toAutomation(r) : null;
}

export function createAutomation(input: { name: string; description?: string | null; trigger?: Trigger; steps?: Step[] }): Automation {
  const now = new Date().toISOString();
  const r = sqlite
    .prepare(`INSERT INTO automations (name, description, trigger, steps, mode, created_at, updated_at) VALUES (?, ?, ?, ?, 'off', ?, ?)`)
    .run(input.name, input.description ?? null, JSON.stringify(input.trigger ?? { type: "manual" }), JSON.stringify(input.steps ?? []), now, now);
  return getAutomation(Number(r.lastInsertRowid))!;
}

export function updateAutomation(
  id: number,
  patch: Partial<{ name: string; description: string | null; trigger: Trigger; steps: Step[]; mode: Mode; stopOnReply: boolean }>,
): Automation | null {
  const existing = getAutomation(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const mode = patch.mode ?? existing.mode;
  // Switching a plan on starts its clock: only contacts created from now on
  // count as its new leads.
  const enabledAt = existing.mode === "off" && mode !== "off" ? now : mode === "off" ? null : existing.enabledAt;
  sqlite
    .prepare(
      `UPDATE automations SET name = ?, description = ?, trigger = ?, steps = ?, mode = ?, stop_on_reply = ?, enabled_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      patch.name ?? existing.name,
      patch.description !== undefined ? patch.description : existing.description,
      JSON.stringify(patch.trigger ?? existing.trigger),
      JSON.stringify(patch.steps ?? existing.steps),
      mode,
      (patch.stopOnReply ?? existing.stopOnReply) ? 1 : 0,
      enabledAt,
      now,
      id,
    );
  if (mode === "off" && existing.mode !== "off") {
    // Turned off: nobody keeps receiving messages from it.
    sqlite
      .prepare(`UPDATE automation_runs SET status = 'stopped', stopped_reason = 'Plan turned off', updated_at = ? WHERE automation_id = ? AND status IN ('active', 'approval')`)
      .run(now, id);
    sqlite
      .prepare(
        `UPDATE automation_steps SET status = 'rejected', detail = 'Plan turned off', decided_at = ? WHERE status = 'pending' AND run_id IN (SELECT id FROM automation_runs WHERE automation_id = ?)`,
      )
      .run(now, id);
  }
  return getAutomation(id);
}

export function deleteAutomation(id: number) {
  updateAutomation(id, { mode: "off" });
  sqlite.prepare(`DELETE FROM automations WHERE id = ?`).run(id);
}

// ---- The step tree ----------------------------------------------------------------------------

interface Located {
  step: Step;
  /** The step after this one in its list, if any. */
  next: Step | null;
}

/** Every step by id, with what follows it. */
export function indexSteps(steps: Step[], out = new Map<string, Located>()): Map<string, Located> {
  steps.forEach((s, i) => {
    out.set(s.id, { step: s, next: steps[i + 1] ?? null });
    if (s.type === "condition") {
      indexSteps(s.yes ?? [], out);
      indexSteps(s.no ?? [], out);
    }
  });
  return out;
}

/** Problems that would stop a plan being switched on. Empty when it's fine. */
export function validateSteps(steps: Step[], selfId?: number): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (list: Step[]) => {
    list.forEach((s, i) => {
      if (!s.id || seen.has(s.id)) problems.push("Two steps share an id. Reload the page and try again.");
      seen.add(s.id);
      if (s.type === "condition" && i !== list.length - 1) problems.push("An if/else must be the last step in its branch.");
      if (s.type === "wait" && !(s.amount > 0)) problems.push("A wait step needs a length.");
      if (s.type === "send_text" && !s.body?.trim()) problems.push("A text step has no message.");
      if (s.type === "send_email" && (!s.subject?.trim() || !s.body?.trim())) problems.push("An email step needs a subject and a message.");
      if ((s.type === "add_tag" || s.type === "remove_tag") && !s.tag?.trim()) problems.push("A tag step has no tag.");
      if (s.type === "create_task" && !s.title?.trim()) problems.push("A task step has no title.");
      if (s.type === "social_task" && !s.message?.trim()) problems.push("A social message step has no message.");
      if (s.type === "start_plan" && (!s.automationId || s.automationId === selfId)) problems.push("A 'start plan' step needs another plan.");
      if (s.type === "condition") {
        if ((s.check === "has_tag" || s.check === "source_is") && !s.value?.trim()) problems.push("An if/else step needs a value to check.");
        walk(s.yes ?? []);
        walk(s.no ?? []);
      }
    });
  };
  walk(steps);
  return Array.from(new Set(problems));
}

// ---- Contacts: tags, replies, merge fields -------------------------------------------------------

export function appTags(contactId: string): string[] {
  return (sqlite.prepare(`SELECT tag FROM contact_tags WHERE contact_fub_id = ? ORDER BY tag`).all(contactId) as Array<{ tag: string }>).map((r) => r.tag);
}

/** FUB's tags and the app's, together. */
export function allTags(contactId: string): string[] {
  const c = storage.getCrmContact(contactId);
  let fub: string[] = [];
  try {
    fub = JSON.parse(c?.tags ?? "[]");
  } catch {
    /* malformed: treat as none */
  }
  return Array.from(new Set([...fub, ...appTags(contactId)]));
}

function hasTag(contactId: string, tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return allTags(contactId).some((x) => x.toLowerCase() === t);
}

export function addTag(contactId: string, tag: string, opts: { fromRunId?: number } = {}) {
  const t = tag.trim();
  if (!t || hasTag(contactId, t)) return;
  sqlite.prepare(`INSERT OR IGNORE INTO contact_tags (contact_fub_id, tag, created_at) VALUES (?, ?, ?)`).run(contactId, t, new Date().toISOString());
  for (const a of listAutomations()) {
    if (a.mode !== "off" && a.trigger.type === "tag_added" && a.trigger.tag.trim().toLowerCase() === t.toLowerCase()) {
      enroll(a, contactId, { reason: `tag "${t}" added`, fromRunId: opts.fromRunId });
    }
  }
}

export function removeTag(contactId: string, tag: string) {
  sqlite.prepare(`DELETE FROM contact_tags WHERE contact_fub_id = ? AND lower(tag) = lower(?)`).run(contactId, tag.trim());
}

/** Whether the person has texted or emailed since a moment. */
export function repliedSince(contactId: string, since: string): boolean {
  const q = (sql: string) => !!sqlite.prepare(sql).get(contactId, since);
  const exists = (t: string) => !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  return (
    (exists("sms_messages") && q(`SELECT 1 FROM sms_messages WHERE contact_fub_id = ? AND direction = 'inbound' AND created_at > ? LIMIT 1`)) ||
    (exists("inbox_emails") && q(`SELECT 1 FROM inbox_emails WHERE contact_fub_id = ? AND direction = 'inbound' AND occurred_at > ? LIMIT 1`)) ||
    q(`SELECT 1 FROM crm_activities WHERE contact_fub_id = ? AND kind = 'text' AND direction = 'inbound' AND occurred_at > ? LIMIT 1`)
  );
}

export interface RunContext {
  property?: string | null;
  source?: string | null;
  leadType?: LeadType;
}

/**
 * Buyer, seller or renter, from what the lead said and where it came from.
 * Lead emails say outright (lead-intake.ts writes "(seller lead via REW.ca)"
 * into the message); otherwise a selling, valuation or home-value source means
 * a seller. Everything else — listing inquiries, portals, referrals,
 * general questions — is treated as a buyer, which is what most leads are.
 */
export function leadTypeFor(source: string | null | undefined, message?: string | null): LeadType {
  const said = message?.match(/\((buyer|seller|renter) lead via /i)?.[1]?.toLowerCase();
  if (said) return said as LeadType;
  if (/sell|valuation|home[ _-]?eval|home value|community report/i.test(source ?? "")) return "seller";
  return "buyer";
}

/** {first_name}, {name}, {property}, {source}, {agent_name}, {agent_phone} in a message. */
export function render(template: string, contactId: string, ctx: RunContext): string {
  const c = storage.getCrmContact(contactId);
  const first = c?.firstName || c?.name?.split(/\s+/)[0] || "there";
  const values: Record<string, string> = {
    first_name: first,
    name: c?.name || first,
    property: ctx.property || "the property",
    source: ctx.source || c?.source || "",
    agent_name: AGENT.name,
    agent_first_name: AGENT.name.split(/\s+/)[0],
    agent_phone: AGENT.phone ?? "",
  };
  return template.replace(/\{\s*([a-z_]+)\s*\}/gi, (m, k: string) => values[k.toLowerCase()] ?? m);
}

// ---- Quiet hours --------------------------------------------------------------------------------

const TZ = "America/Edmonton";
const QUIET_START = 21; // 9 pm
const QUIET_END = 8; // 8 am

function calgaryHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", hour12: false }).format(d)) % 24;
}

/** Now, or the next 8 am Calgary time if now is within quiet hours. */
export function nextTextableTime(now = new Date()): Date {
  const h = calgaryHour(now);
  if (h >= QUIET_END && h < QUIET_START) return now;
  // Step forward a quarter-hour at a time until it's 8 am there: DST-proof without date maths.
  const t = new Date(now);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(Math.ceil(t.getUTCMinutes() / 15) * 15);
  while (calgaryHour(t) < QUIET_END || calgaryHour(t) >= QUIET_START) t.setTime(t.getTime() + 15 * 60_000);
  return t;
}

// ---- Enrolling -------------------------------------------------------------------------------

interface RunRow {
  id: number;
  automation_id: number;
  contact_fub_id: string;
  lead_id: number | null;
  status: string;
  step_id: string | null;
  next_at: string | null;
  wait_until: string | null;
  context: string;
  started_at: string;
}

export function enroll(
  automation: Automation,
  contactId: string,
  opts: { leadId?: number | null; context?: RunContext; reason?: string; fromRunId?: number } = {},
): number | null {
  if (!storage.getCrmContact(contactId)) return null;
  const active = sqlite
    .prepare(`SELECT id FROM automation_runs WHERE automation_id = ? AND contact_fub_id = ? AND status IN ('active', 'approval')`)
    .get(automation.id, contactId);
  if (active) return null;
  const first = automation.steps[0];
  const now = new Date().toISOString();
  const r = sqlite
    .prepare(
      `INSERT INTO automation_runs (automation_id, contact_fub_id, lead_id, status, step_id, next_at, context, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      automation.id,
      contactId,
      opts.leadId ?? null,
      first ? "active" : "completed",
      first?.id ?? null,
      now,
      JSON.stringify(opts.context ?? {}),
      now,
      now,
    );
  const runId = Number(r.lastInsertRowid);
  logStep(runId, "start", "start", "done", opts.reason ? `Started: ${opts.reason}` : "Started");
  // Run the first steps straight away (a welcome text shouldn't wait for the next tick).
  setImmediate(() => void advanceRun(runId));
  return runId;
}

function logStep(runId: number, stepId: string, type: string, status: string, detail: string | null, payload?: unknown): number {
  const r = sqlite
    .prepare(`INSERT INTO automation_steps (run_id, step_id, type, status, detail, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, stepId, type, status, detail, payload === undefined ? null : JSON.stringify(payload), new Date().toISOString());
  return Number(r.lastInsertRowid);
}

/** A lead the app just created (forms, bookings, lead emails). Called from contacts.ts. */
export function onNewLead(lead: { id: number; source: string; message?: string | null }, contactId: string) {
  if (!markFired(contactId)) return;
  const property = lead.message?.match(/^About:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const leadType = leadTypeFor(lead.source, lead.message);
  fireNewLead(contactId, lead.source, { leadId: lead.id, context: { property, source: lead.source, leadType } });
}

/**
 * After a Follow Up Boss contacts sync: anyone FUB created since a new-lead
 * plan was switched on, who hasn't already fired (as an app lead, before
 * being folded into FUB's copy), starts it.
 */
export function onContactsSynced() {
  const plans = listAutomations().filter((a) => a.mode !== "off" && a.trigger.type === "new_lead" && a.enabledAt);
  if (plans.length === 0) return;
  const since = plans.map((a) => a.enabledAt!).sort()[0];
  const rows = sqlite
    .prepare(
      `SELECT fub_id AS id, source FROM crm_contacts
       WHERE fub_created_at >= ? AND fub_id NOT LIKE 'app-%'
         AND fub_id NOT IN (SELECT contact_fub_id FROM automation_fired)`,
    )
    .all(since) as Array<{ id: string; source: string | null }>;
  for (const r of rows) {
    if (!markFired(r.id)) continue;
    const created = (sqlite.prepare(`SELECT fub_created_at AS t FROM crm_contacts WHERE fub_id = ?`).get(r.id) as { t: string }).t;
    fireNewLead(r.id, r.source ?? "", { context: { source: r.source, leadType: leadTypeFor(r.source) } }, created);
  }
}

function markFired(contactId: string): boolean {
  return sqlite.prepare(`INSERT OR IGNORE INTO automation_fired (contact_fub_id, fired_at) VALUES (?, ?)`).run(contactId, new Date().toISOString()).changes > 0;
}

function sourceMatches(want: string[] | undefined, source: string): boolean {
  if (!want || want.length === 0) return true;
  const s = source.toLowerCase();
  return want.some((w) => {
    const x = w.trim().toLowerCase();
    return !!x && (s === x || s.includes(x));
  });
}

function fireNewLead(contactId: string, source: string, opts: { leadId?: number; context?: RunContext }, createdAt?: string) {
  for (const a of listAutomations()) {
    if (a.mode === "off" || a.trigger.type !== "new_lead") continue;
    if (createdAt && a.enabledAt && createdAt < a.enabledAt) continue;
    if (!sourceMatches(a.trigger.sources, source)) continue;
    const type = opts.context?.leadType;
    if (a.trigger.leadType && type !== a.trigger.leadType) continue;
    enroll(a, contactId, { ...opts, reason: `new ${type ?? ""} lead${source ? ` from ${source}` : ""}`.replace(/\s+/g, " ") });
  }
}

// ---- Running ---------------------------------------------------------------------------------

function getRun(id: number): RunRow | null {
  return (sqlite.prepare(`SELECT * FROM automation_runs WHERE id = ?`).get(id) as RunRow | undefined) ?? null;
}

function setRun(id: number, patch: Partial<Pick<RunRow, "status" | "step_id" | "next_at" | "wait_until">> & { stopped_reason?: string | null }) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push("updated_at = ?");
  vals.push(new Date().toISOString());
  sqlite.prepare(`UPDATE automation_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function stopRun(id: number, reason: string) {
  setRun(id, { status: "stopped", stopped_reason: reason, next_at: null });
  sqlite
    .prepare(`UPDATE automation_steps SET status = 'rejected', detail = ?, decided_at = ? WHERE run_id = ? AND status = 'pending'`)
    .run(reason, new Date().toISOString(), id);
}

/** Move to the step after `step` (or finish). */
function moveOn(run: RunRow, index: Map<string, Located>, stepId: string) {
  const next = index.get(stepId)?.next ?? null;
  if (next) setRun(run.id, { step_id: next.id, next_at: new Date().toISOString(), wait_until: null });
  else {
    setRun(run.id, { status: "completed", step_id: null, next_at: null, wait_until: null });
    logStep(run.id, "end", "end", "done", "Finished");
  }
}

function goTo(run: RunRow, step: Step | null) {
  if (step) setRun(run.id, { step_id: step.id, next_at: new Date().toISOString(), wait_until: null });
  else {
    setRun(run.id, { status: "completed", step_id: null, next_at: null, wait_until: null });
    logStep(run.id, "end", "end", "done", "Finished");
  }
}

const running = new Set<number>();

/** Take a run as far as it can go right now: through instant steps, up to a wait or an approval. */
export async function advanceRun(runId: number): Promise<void> {
  if (running.has(runId)) return;
  running.add(runId);
  try {
    for (let guard = 0; guard < 50; guard++) {
      const run = getRun(runId);
      if (!run || run.status !== "active" || !run.step_id) return;
      if (run.next_at && run.next_at > new Date().toISOString()) return;
      const automation = getAutomation(run.automation_id);
      if (!automation || automation.mode === "off") return stopRun(run.id, "Plan turned off or deleted");
      if (!storage.getCrmContact(run.contact_fub_id)) return stopRun(run.id, "Contact no longer exists");
      if (automation.stopOnReply && repliedSince(run.contact_fub_id, run.started_at)) return stopRun(run.id, "They replied");
      const index = indexSteps(automation.steps);
      const here = index.get(run.step_id);
      if (!here) {
        setRun(run.id, { status: "completed", step_id: null, next_at: null });
        logStep(run.id, run.step_id, "end", "skipped", "This step was removed from the plan; finished here");
        return;
      }
      const carryOn = await runStep(run, automation, here.step, index);
      if (!carryOn) return;
    }
  } finally {
    running.delete(runId);
  }
}

/** Do one step. Returns whether the run can go straight on to the next. */
async function runStep(run: RunRow, automation: Automation, step: Step, index: Map<string, Located>): Promise<boolean> {
  const contactId = run.contact_fub_id;
  const ctx: RunContext = JSON.parse(run.context || "{}");
  const contact = storage.getCrmContact(contactId)!;

  switch (step.type) {
    case "wait": {
      if (!run.wait_until) {
        const ms = step.amount * (step.unit === "minutes" ? 60_000 : step.unit === "hours" ? 3600_000 : 86400_000);
        const until = new Date(Date.now() + ms).toISOString();
        setRun(run.id, { wait_until: until, next_at: until });
        logStep(run.id, step.id, step.type, "done", `Waiting ${step.amount} ${step.unit}`);
        return false;
      }
      moveOn(run, index, step.id);
      return true;
    }

    case "send_text":
    case "send_email": {
      const isText = step.type === "send_text";
      const to = isText ? contact.phone : contact.email;
      if (!to?.trim()) {
        logStep(run.id, step.id, step.type, "skipped", isText ? "No phone number on file" : "No email address on file");
        moveOn(run, index, step.id);
        return true;
      }
      // Quiet hours hold automatic texts; one you approve goes when you say.
      if (isText && automation.mode === "auto") {
        const when = nextTextableTime();
        if (when.getTime() > Date.now() + 1000) {
          setRun(run.id, { next_at: when.toISOString() });
          return false;
        }
      }
      const payload = isText
        ? { to, body: render(step.body, contactId, ctx) }
        : { to, subject: render(step.subject, contactId, ctx), body: render(step.body, contactId, ctx) };
      if (automation.mode === "review") {
        logStep(run.id, step.id, step.type, "pending", "Waiting for your approval", payload);
        setRun(run.id, { status: "approval", next_at: null });
        return false;
      }
      await deliver(run, step, payload);
      moveOn(run, index, step.id);
      return true;
    }

    case "add_tag":
      addTag(contactId, step.tag, { fromRunId: run.id });
      logStep(run.id, step.id, step.type, "done", `Added tag "${step.tag}"`);
      moveOn(run, index, step.id);
      return true;

    case "remove_tag":
      removeTag(contactId, step.tag);
      logStep(run.id, step.id, step.type, "done", `Removed tag "${step.tag}"`);
      moveOn(run, index, step.id);
      return true;

    case "create_task":
      createTask(contactId, render(step.title, contactId, ctx), step.note ? render(step.note, contactId, ctx) : null, step.dueInHours ?? 0, automation.name);
      logStep(run.id, step.id, step.type, "done", `Task: ${step.title}`);
      moveOn(run, index, step.id);
      return true;

    case "social_task": {
      const label = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" }[step.network];
      const message = render(step.message, contactId, ctx);
      const name = contact.name ?? "";
      const find =
        step.network === "facebook"
          ? `https://www.facebook.com/search/people/?q=${encodeURIComponent(name)}`
          : step.network === "linkedin"
            ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}`
            : `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(name)}`;
      createTask(contactId, `Message ${name || "them"} on ${label}`, `${message}\n\nFind them: ${find}`, 0, automation.name);
      logStep(run.id, step.id, step.type, "done", `Task to message on ${label}`);
      moveOn(run, index, step.id);
      return true;
    }

    case "start_plan": {
      const other = getAutomation(step.automationId);
      if (other && other.mode !== "off") {
        enroll(other, contactId, { leadId: run.lead_id, context: ctx, reason: `started by "${automation.name}"`, fromRunId: run.id });
        logStep(run.id, step.id, step.type, "done", `Started "${other.name}"`);
      } else {
        logStep(run.id, step.id, step.type, "skipped", other ? `"${other.name}" is turned off` : "That plan no longer exists");
      }
      moveOn(run, index, step.id);
      return true;
    }

    case "condition": {
      const ok = checkCondition(step, contactId, run.started_at);
      logStep(run.id, step.id, step.type, "done", `${describeCheck(step)}: ${ok ? "yes" : "no"}`);
      goTo(run, (ok ? step.yes : step.no)?.[0] ?? null);
      return true;
    }
  }
}

function checkCondition(step: Extract<Step, { type: "condition" }>, contactId: string, startedAt: string): boolean {
  const c = storage.getCrmContact(contactId);
  switch (step.check) {
    case "has_phone":
      return !!c?.phone?.trim();
    case "has_email":
      return !!c?.email?.trim();
    case "has_tag":
      return hasTag(contactId, step.value ?? "");
    case "replied":
      return repliedSince(contactId, startedAt);
    case "source_is":
      return sourceMatches([step.value ?? ""], c?.source ?? "");
  }
}

export function describeCheck(step: Extract<Step, { type: "condition" }>): string {
  switch (step.check) {
    case "has_phone":
      return "Has a phone number";
    case "has_email":
      return "Has an email address";
    case "has_tag":
      return `Has tag "${step.value}"`;
    case "replied":
      return "Has replied";
    case "source_is":
      return `Source is ${step.value}`;
  }
}

async function deliver(run: RunRow, step: Step, payload: { to: string; body: string; subject?: string }): Promise<boolean> {
  if (step.type === "send_text") {
    const { sendSms } = await import("./sms");
    const r = await sendSms(payload.to, payload.body, { kind: "client", contactFubId: run.contact_fub_id });
    logStep(run.id, step.id, step.type, r.ok ? "done" : "failed", r.ok ? `Texted ${payload.to}` : `Text failed: ${r.error}`, payload);
    return r.ok;
  }
  const { sendGmail } = await import("./gmail");
  const { agentUserId } = await import("./gmail-inbox");
  const userId = agentUserId();
  // Tracked like any email to a contact, with listing links as property cards.
  const { trackedEmailHtml } = await import("./listing-card");
  const html = trackedEmailHtml(payload.body, payload.to, payload.subject ?? "", { kind: "automation", contactFubId: run.contact_fub_id });
  const r = userId
    ? await sendGmail(userId, { to: payload.to, subject: payload.subject ?? "", text: payload.body, html, signature: true })
    : { ok: false, error: "No agent user" };
  logStep(run.id, step.id, step.type, r.ok ? "done" : "failed", r.ok ? `Emailed ${payload.to}` : `Email failed: ${(r as any).error}`, payload);
  return r.ok;
}

// ---- Approvals ---------------------------------------------------------------------------------

export interface PendingApproval {
  stepRowId: number;
  runId: number;
  automationId: number;
  automationName: string;
  contactFubId: string;
  contactName: string | null;
  type: string;
  payload: { to: string; body: string; subject?: string };
  createdAt: string;
}

export function listPending(): PendingApproval[] {
  const rows = sqlite
    .prepare(
      `SELECT s.id, s.run_id, s.type, s.payload, s.created_at, r.automation_id, r.contact_fub_id, a.name AS automation_name, c.name AS contact_name
       FROM automation_steps s
       JOIN automation_runs r ON r.id = s.run_id
       LEFT JOIN automations a ON a.id = r.automation_id
       LEFT JOIN crm_contacts c ON c.fub_id = r.contact_fub_id
       WHERE s.status = 'pending'
       ORDER BY s.created_at`,
    )
    .all() as any[];
  return rows.map((r) => ({
    stepRowId: r.id,
    runId: r.run_id,
    automationId: r.automation_id,
    automationName: r.automation_name ?? "(deleted plan)",
    contactFubId: r.contact_fub_id,
    contactName: r.contact_name,
    type: r.type,
    payload: JSON.parse(r.payload ?? "{}"),
    createdAt: r.created_at,
  }));
}

/**
 * Decide on a message waiting for approval: send it (optionally edited), skip
 * it and carry on, or stop this person's plan.
 */
export async function decide(
  stepRowId: number,
  decision: "send" | "skip" | "stop",
  edited?: { body?: string; subject?: string },
): Promise<{ ok: boolean; error?: string }> {
  const s = sqlite.prepare(`SELECT * FROM automation_steps WHERE id = ? AND status = 'pending'`).get(stepRowId) as any;
  if (!s) return { ok: false, error: "That message was already handled." };
  const run = getRun(s.run_id);
  if (!run || run.status !== "approval") return { ok: false, error: "That plan is no longer running for this person." };
  const automation = getAutomation(run.automation_id);
  const now = new Date().toISOString();
  if (decision === "stop") {
    stopRun(run.id, "Stopped from approvals");
    return { ok: true };
  }
  const index = automation ? indexSteps(automation.steps) : new Map<string, Located>();
  const step = index.get(s.step_id)?.step;
  // Claim it first, so a double click can't send twice.
  const claimed = sqlite
    .prepare(`UPDATE automation_steps SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
    .run(decision === "send" ? "approved" : "rejected", now, stepRowId).changes;
  if (!claimed) return { ok: false, error: "That message was already handled." };
  if (decision === "send") {
    if (!step) return { ok: false, error: "That step was removed from the plan." };
    const payload = JSON.parse(s.payload ?? "{}");
    if (edited?.body?.trim()) payload.body = edited.body;
    if (edited?.subject?.trim()) payload.subject = edited.subject;
    sqlite.prepare(`UPDATE automation_steps SET payload = ? WHERE id = ?`).run(JSON.stringify(payload), stepRowId);
    const ok = await deliver(run, step, payload);
    if (!ok) {
      setRun(run.id, { status: "active" });
      moveOn(getRun(run.id)!, index, s.step_id);
      void advanceRun(run.id);
      return { ok: false, error: "Couldn't send it — see the plan's activity. The plan carried on." };
    }
  }
  setRun(run.id, { status: "active" });
  if (step) moveOn(getRun(run.id)!, index, s.step_id);
  else goTo(getRun(run.id)!, null);
  void advanceRun(run.id);
  return { ok: true };
}

/** Send every message of one plan that's waiting for approval — used when it switches to automatic. */
export async function sendAllPending(automationId: number): Promise<{ sent: number; failed: number }> {
  const ids = listPending()
    .filter((p) => p.automationId === automationId)
    .map((p) => p.stepRowId);
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    const r = await decide(id, "send");
    if (r.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

// ---- Tasks ---------------------------------------------------------------------------------

export function createTask(contactId: string, title: string, note: string | null, dueInHours: number, from: string) {
  const now = new Date();
  storage.upsertCrmActivities([
    {
      uid: `task:app-task-${randomBytes(6).toString("hex")}`,
      kind: "task",
      fubId: null,
      contactFubId: contactId,
      title: title.slice(0, 300),
      body: note?.slice(0, 4000) ?? null,
      direction: null,
      outcome: null,
      durationSeconds: null,
      occurredAt: now.toISOString(),
      dueAt: new Date(now.getTime() + dueInHours * 3600_000).toISOString(),
      completed: false,
      assignedTo: AGENT.name,
      raw: JSON.stringify({ origin: "automation", from }),
      syncedAt: now.toISOString(),
    },
  ]);
}

export function listAppTasks(includeDone = false) {
  return sqlite
    .prepare(
      `SELECT a.uid, a.title, a.body, a.due_at AS dueAt, a.completed, a.contact_fub_id AS contactFubId, c.name AS contactName, c.phone, c.email
       FROM crm_activities a LEFT JOIN crm_contacts c ON c.fub_id = a.contact_fub_id
       WHERE a.kind = 'task' AND a.uid LIKE 'task:app-task-%' ${includeDone ? "" : "AND a.completed = 0"}
       ORDER BY a.due_at LIMIT 200`,
    )
    .all();
}

export function completeAppTask(uid: string, done: boolean): boolean {
  if (!uid.startsWith("task:app-task-")) return false;
  return sqlite.prepare(`UPDATE crm_activities SET completed = ? WHERE uid = ?`).run(done ? 1 : 0, uid).changes > 0;
}

// ---- Reading runs ------------------------------------------------------------------------------

export function runsFor(opts: { automationId?: number; contactId?: string; limit?: number }) {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.automationId) {
    where.push("r.automation_id = ?");
    vals.push(opts.automationId);
  }
  if (opts.contactId) {
    where.push("r.contact_fub_id = ?");
    vals.push(opts.contactId);
  }
  return sqlite
    .prepare(
      `SELECT r.id, r.automation_id AS automationId, COALESCE(a.name, 'Deleted plan') AS automationName, r.contact_fub_id AS contactFubId,
              c.name AS contactName, c.source AS contactSource,
              r.status, r.step_id AS stepId, r.next_at AS nextAt, r.stopped_reason AS stoppedReason, r.started_at AS startedAt, r.updated_at AS updatedAt,
              (SELECT s.detail FROM automation_steps s WHERE s.run_id = r.id AND s.type NOT IN ('start', 'end') ORDER BY s.id DESC LIMIT 1) AS lastDetail,
              (SELECT s.created_at FROM automation_steps s WHERE s.run_id = r.id AND s.type NOT IN ('start', 'end') ORDER BY s.id DESC LIMIT 1) AS lastAt
       FROM automation_runs r LEFT JOIN automations a ON a.id = r.automation_id LEFT JOIN crm_contacts c ON c.fub_id = r.contact_fub_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.started_at DESC LIMIT ?`,
    )
    .all(...vals, opts.limit ?? 100);
}

export function stepsForRun(runId: number) {
  return sqlite
    .prepare(`SELECT id, step_id AS stepId, type, status, detail, payload, created_at AS createdAt FROM automation_steps WHERE run_id = ? ORDER BY id`)
    .all(runId);
}

// ---- The clock -------------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

export async function tick() {
  const due = sqlite
    .prepare(`SELECT id FROM automation_runs WHERE status = 'active' AND (next_at IS NULL OR next_at <= ?) ORDER BY next_at LIMIT 200`)
    .all(new Date().toISOString()) as Array<{ id: number }>;
  for (const r of due) {
    try {
      await advanceRun(r.id);
    } catch (e: any) {
      console.error("[automations] run", r.id, "failed:", e?.message ?? e);
    }
  }
}

export function startAutomationsCron() {
  if (timer) return;
  timer = setInterval(() => void tick(), 30_000);
  setTimeout(() => void tick(), 20_000);
  console.log("[automations] scheduled (every 30 s)");
}
