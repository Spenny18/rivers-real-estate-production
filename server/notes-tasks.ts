// Notes and tasks, kept in the app, so neither needs Follow Up Boss.
//
// Both live in crm_activities beside the rest of a contact's history, with
// uids the FUB sync never writes ("note:app:…", "task:app-task-…"), so the
// sync can't overwrite or remove them.
//
//   Notes   written on a contact; edited or deleted only if written here.
//           Not sent to FUB: its sync would bring each one back as a second
//           copy, and FUB is on its way out.
//   Tasks   a title, a due time, optionally a contact and a note. The app's
//           own can be edited, completed and deleted. FUB's tasks (mirrored)
//           can be completed here too: that's recorded in task_completions,
//           which the sync re-applies so FUB can't reopen them, and sent to
//           FUB (PUT /tasks/{id}) while it runs.

import { randomBytes } from "node:crypto";
import { sqlite, storage } from "./storage";
import { AGENT } from "./brand";
import { fubConfigured, fubPut } from "./fub-client";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS task_completions (
    uid TEXT PRIMARY KEY,
    completed INTEGER NOT NULL,
    at TEXT NOT NULL,
    pushed_at TEXT,
    push_error TEXT
  );
`);

export const isAppNote = (uid: string) => uid.startsWith("note:app:");
export const isAppTask = (uid: string) => uid.startsWith("task:app-task-");

function activity(uid: string) {
  return sqlite.prepare(`SELECT * FROM crm_activities WHERE uid = ?`).get(uid) as Record<string, any> | undefined;
}

function touchContact(contactId: string | null, at: string) {
  if (!contactId) return;
  sqlite.prepare(`UPDATE crm_contacts SET last_activity_at = ? WHERE fub_id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)`).run(at, contactId, at);
}

// ---- Notes --------------------------------------------------------------------------

export function addNote(contactId: string, body: string): string {
  const now = new Date().toISOString();
  const uid = `note:app:${contactId}:${randomBytes(5).toString("hex")}`;
  storage.upsertCrmActivities([
    {
      uid,
      kind: "note",
      fubId: null,
      contactFubId: contactId,
      title: "Note",
      body: body.trim().slice(0, 10_000),
      direction: null,
      outcome: null,
      durationSeconds: null,
      occurredAt: now,
      dueAt: null,
      completed: false,
      assignedTo: AGENT.name,
      raw: JSON.stringify({ origin: "app" }),
      syncedAt: now,
    },
  ]);
  touchContact(contactId, now);
  return uid;
}

export function editNote(uid: string, body: string): boolean {
  if (!isAppNote(uid)) return false;
  return sqlite.prepare(`UPDATE crm_activities SET body = ? WHERE uid = ? AND kind = 'note'`).run(body.trim().slice(0, 10_000), uid).changes > 0;
}

export function deleteNote(uid: string): boolean {
  if (!isAppNote(uid)) return false;
  return sqlite.prepare(`DELETE FROM crm_activities WHERE uid = ? AND kind = 'note'`).run(uid).changes > 0;
}

// ---- Tasks --------------------------------------------------------------------------

export interface TaskInput {
  title: string;
  dueAt: string;
  contactId?: string | null;
  note?: string | null;
}

export function addTask(t: TaskInput): string {
  const now = new Date().toISOString();
  const uid = `task:app-task-${randomBytes(6).toString("hex")}`;
  storage.upsertCrmActivities([
    {
      uid,
      kind: "task",
      fubId: null,
      contactFubId: t.contactId || null,
      title: t.title.trim().slice(0, 300),
      body: t.note?.trim().slice(0, 4000) || null,
      direction: null,
      outcome: null,
      durationSeconds: null,
      occurredAt: now,
      dueAt: new Date(t.dueAt).toISOString(),
      completed: false,
      assignedTo: AGENT.name,
      raw: JSON.stringify({ origin: "manual" }),
      syncedAt: now,
    },
  ]);
  return uid;
}

export function editTask(uid: string, patch: Partial<Pick<TaskInput, "title" | "dueAt" | "note">>): boolean {
  if (!isAppTask(uid) || !activity(uid)) return false;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined && patch.title.trim()) {
    sets.push("title = ?");
    vals.push(patch.title.trim().slice(0, 300));
  }
  if (patch.dueAt !== undefined) {
    sets.push("due_at = ?");
    vals.push(new Date(patch.dueAt).toISOString());
  }
  if (patch.note !== undefined) {
    sets.push("body = ?");
    vals.push(patch.note?.trim().slice(0, 4000) || null);
  }
  if (sets.length === 0) return true;
  return sqlite.prepare(`UPDATE crm_activities SET ${sets.join(", ")} WHERE uid = ?`).run(...vals, uid).changes > 0;
}

export function deleteTask(uid: string): boolean {
  if (!isAppTask(uid)) return false;
  return sqlite.prepare(`DELETE FROM crm_activities WHERE uid = ? AND kind = 'task'`).run(uid).changes > 0;
}

/** Complete or reopen any task, the app's or FUB's. */
export function setTaskDone(uid: string, done: boolean): boolean {
  const a = activity(uid);
  if (!a || a.kind !== "task") return false;
  sqlite.prepare(`UPDATE crm_activities SET completed = ? WHERE uid = ?`).run(done ? 1 : 0, uid);
  if (isAppTask(uid)) return true;
  // FUB's: remember it, so the sync doesn't reopen it, and tell FUB.
  sqlite
    .prepare(
      `INSERT INTO task_completions (uid, completed, at) VALUES (?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET completed = excluded.completed, at = excluded.at, pushed_at = NULL, push_error = NULL`,
    )
    .run(uid, done ? 1 : 0, new Date().toISOString());
  if (fubConfigured() && a.fub_id) {
    fubPut(`/tasks/${encodeURIComponent(a.fub_id)}`, { isCompleted: done })
      .then((r) =>
        sqlite
          .prepare(`UPDATE task_completions SET pushed_at = ?, push_error = ? WHERE uid = ?`)
          .run(r.ok ? new Date().toISOString() : null, r.ok ? null : (r.error ?? `HTTP ${r.status}`).slice(0, 300), uid),
      )
      .catch((e) => console.warn(`[tasks] couldn't update FUB task ${a.fub_id}:`, e?.message ?? e));
  }
  return true;
}

/** Re-apply completions made here after the sync rewrites FUB's tasks. */
export function applyTaskCompletions(): number {
  return sqlite
    .prepare(
      `UPDATE crm_activities SET completed = (SELECT t.completed FROM task_completions t WHERE t.uid = crm_activities.uid)
       WHERE uid IN (SELECT uid FROM task_completions)`,
    )
    .run().changes;
}

export interface TaskRow {
  uid: string;
  title: string | null;
  body: string | null;
  dueAt: string | null;
  completed: number;
  contactFubId: string | null;
  contactName: string | null;
  origin: "app" | "fub";
}

/** Tasks, soonest due first; open ones unless asked for done ones. */
export function listTasks(opts: { contactId?: string; status?: "open" | "done" | "all"; limit?: number } = {}): TaskRow[] {
  const where = ["a.kind = 'task'"];
  const vals: unknown[] = [];
  const status = opts.status ?? "open";
  if (status === "open") where.push("a.completed = 0");
  if (status === "done") where.push("a.completed = 1");
  if (opts.contactId) {
    where.push("a.contact_fub_id = ?");
    vals.push(opts.contactId);
  }
  const rows = sqlite
    .prepare(
      `SELECT a.uid, a.title, a.body, a.due_at AS dueAt, a.completed, a.contact_fub_id AS contactFubId, c.name AS contactName
       FROM crm_activities a LEFT JOIN crm_contacts c ON c.fub_id = a.contact_fub_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${status === "done" ? "a.due_at DESC" : "a.due_at IS NULL, a.due_at"} LIMIT ?`,
    )
    .all(...vals, Math.min(opts.limit ?? 300, 1000)) as Array<Omit<TaskRow, "origin">>;
  return rows.map((r) => ({ ...r, origin: isAppTask(r.uid) ? "app" : "fub" }));
}

/** Overdue and due-today counts, for the dashboard. Calgary's day. */
export function taskCounts(now = new Date()): { overdue: number; today: number; open: number } {
  const end = new Date(now.toLocaleString("en-US", { timeZone: "America/Edmonton" }));
  end.setHours(23, 59, 59, 999);
  const endOfDay = new Date(now.getTime() + (end.getTime() - new Date(now.toLocaleString("en-US", { timeZone: "America/Edmonton" })).getTime()));
  const q = (extra: string, ...v: unknown[]) =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM crm_activities WHERE kind = 'task' AND completed = 0 ${extra}`).get(...v) as { n: number }).n;
  return {
    overdue: q("AND due_at IS NOT NULL AND due_at < ?", now.toISOString()),
    today: q("AND due_at IS NOT NULL AND due_at >= ? AND due_at <= ?", now.toISOString(), endOfDay.toISOString()),
    open: q(""),
  };
}
