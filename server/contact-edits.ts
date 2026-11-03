// Editing contacts that came from Follow Up Boss, with the app as the master copy.
//
// Most contacts are FUB's: the hourly sync (fub-sync.ts) writes every person's
// name, email, phone, stage, source and tags over the local row. Until now
// that made them read-only here, because any edit would be undone within the
// hour. To leave FUB, the app has to be where contacts are kept up to date.
//
// How an edit survives the sync. Editing a FUB contact writes the new values
// to its row and records each field that actually changed in contact_overrides.
// The sync passes every incoming person through applyContactOverrides before
// saving, which puts those fields back. Fields that were never edited here keep
// following FUB, so changes made in FUB during the overlap still arrive.
// Overrides are kept for good: once a field is edited in the app, the app owns it.
//
// Keeping FUB in step. While FUB still runs, each edit is also sent to it
// (PUT /people/{id}) with just the edited fields, so the two match and FUB's
// action plans see the new stage. That push is best-effort: when it fails the
// edit still stands here, and the error is kept on the override so the contact
// shows it; the next edit retries. Once FUB is cancelled the push simply fails
// quietly and nothing else changes.
//
// Contacts the app created ("app-" ids) are edited in place (contacts.ts) and
// need none of this: the sync never writes them.

import { sqlite, storage } from "./storage";
import { cleanEmail, isNativeContact, splitName, updateNativeContact, type NewContact } from "./contacts";
import { fubConfigured, fubPut } from "./fub-client";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS contact_overrides (
    contact_fub_id TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT,
    edited_at TEXT NOT NULL,
    pushed_at TEXT,
    push_error TEXT,
    PRIMARY KEY (contact_fub_id, field)
  );
`);

/** The fields that can be edited, in the order a form shows them. */
export const EDITABLE_FIELDS = ["name", "email", "phone", "stage", "source", "tags"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export type ContactEdit = Partial<Pick<NewContact, "name" | "email" | "phone" | "stage" | "source" | "tags">>;

interface OverrideRow {
  field: EditableField;
  value: string | null;
  edited_at: string;
  pushed_at: string | null;
  push_error: string | null;
}

function overridesFor(id: string): OverrideRow[] {
  return sqlite
    .prepare(`SELECT field, value, edited_at, pushed_at, push_error FROM contact_overrides WHERE contact_fub_id = ?`)
    .all(id) as OverrideRow[];
}

/** What the contact's view shows about its local edits. */
export function contactEditState(id: string) {
  const rows = overridesFor(id);
  const errors = rows.filter((r) => r.push_error);
  return {
    editedFields: rows.map((r) => r.field),
    lastEditedAt: rows.reduce<string | null>((m, r) => (!m || r.edited_at > m ? r.edited_at : m), null),
    // Only meaningful while FUB is connected.
    fubPushError: fubConfigured() && errors.length ? errors[0].push_error : null,
  };
}

function normalise(field: EditableField, v: unknown): string | null {
  if (field === "tags") {
    const list = Array.isArray(v) ? v : [];
    return JSON.stringify(Array.from(new Set(list.map((t) => String(t).trim()).filter(Boolean))));
  }
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
  if (field === "email") return cleanEmail(s) ?? (s || null);
  if (field === "stage") return s || "Lead";
  return s || null;
}

function currentValue(c: Record<string, any>, field: EditableField): string | null {
  if (field === "tags") {
    try {
      return normalise("tags", JSON.parse(c.tags ?? "[]"));
    } catch {
      return "[]";
    }
  }
  return normalise(field, c[field]);
}

/** Write one field's value onto a contact row (or a sync-mapped row). */
function setField(row: Record<string, any>, field: EditableField, value: string | null) {
  row[field] = value;
  if (field === "name") {
    const { first, last } = splitName(value ?? "");
    row.firstName = first;
    row.lastName = last;
  }
}

/**
 * Edit any contact. Returns the fields that changed (empty when nothing did),
 * or null when there's no such contact.
 */
export function editContact(id: string, patch: ContactEdit): { changed: EditableField[] } | null {
  const existing = storage.getCrmContact(id) as Record<string, any> | undefined;
  if (!existing) return null;
  if (isNativeContact(id)) {
    const before = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, currentValue(existing, f)]));
    const after = updateNativeContact(id, patch) as Record<string, any> | null;
    return { changed: after ? EDITABLE_FIELDS.filter((f) => currentValue(after, f) !== before[f]) : [] };
  }

  // Only the fields that actually differ: a form sends every field, and
  // locking the untouched ones would stop FUB's changes to them arriving.
  const changed: Array<[EditableField, string | null]> = [];
  for (const f of EDITABLE_FIELDS) {
    if (!(f in patch) || (patch as any)[f] === undefined) continue;
    if (f === "name" && !String(patch.name ?? "").trim()) continue;
    const next = normalise(f, (patch as any)[f]);
    if (next !== currentValue(existing, f)) changed.push([f, next]);
  }
  if (changed.length === 0) return { changed: [] };

  const now = new Date().toISOString();
  const row: Record<string, any> = {};
  for (const [f, v] of changed) setField(row, f, v);
  const cols: Record<string, string> = {
    name: "name",
    firstName: "first_name",
    lastName: "last_name",
    email: "email",
    phone: "phone",
    stage: "stage",
    source: "source",
    tags: "tags",
  };
  const keys = Object.keys(row);
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(`UPDATE crm_contacts SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")}, fub_updated_at = ? WHERE fub_id = ?`)
      .run(...keys.map((k) => row[k]), now, id);
    const upsert = sqlite.prepare(
      `INSERT INTO contact_overrides (contact_fub_id, field, value, edited_at, pushed_at, push_error) VALUES (?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(contact_fub_id, field) DO UPDATE SET value = excluded.value, edited_at = excluded.edited_at, pushed_at = NULL, push_error = NULL`,
    );
    for (const [f, v] of changed) upsert.run(id, f, v, now);
  });
  tx();

  // Keep FUB in step while it runs; never block the edit on it.
  if (fubConfigured()) {
    pushContactToFub(id).catch((e) => console.warn(`[contact-edits] push to FUB failed for ${id}:`, e?.message ?? e));
  }
  return { changed: changed.map(([f]) => f) };
}

/**
 * Put the app's edits back onto people the sync just mapped from FUB, before
 * they're saved. Rows without edits pass through untouched.
 */
export function applyContactOverrides<T extends Record<string, any>>(rows: T[]): T[] {
  if (rows.length === 0) return rows;
  const all = sqlite.prepare(`SELECT contact_fub_id AS id, field, value FROM contact_overrides`).all() as Array<{
    id: string;
    field: EditableField;
    value: string | null;
  }>;
  if (all.length === 0) return rows;
  const byId = new Map<string, Array<{ field: EditableField; value: string | null }>>();
  for (const o of all) {
    if (!byId.has(o.id)) byId.set(o.id, []);
    byId.get(o.id)!.push(o);
  }
  return rows.map((r) => {
    const edits = byId.get(String(r.fubId));
    if (!edits) return r;
    const out: Record<string, any> = { ...r };
    for (const e of edits) setField(out, e.field, e.value);
    return out as T;
  });
}

// ---- Follow Up Boss write-back -------------------------------------------------------

/** FUB's own list of a contact's emails or phones, from the mirrored payload. */
function fubList(raw: any, key: "emails" | "phones"): Array<{ value: string; type?: string; isPrimary?: boolean | number }> {
  const list = Array.isArray(raw?.[key]) ? raw[key] : [];
  return list.filter((x: any) => x && typeof x.value === "string" && x.value.trim());
}

/** The new primary first, every other entry FUB has kept after it. */
function withPrimary(list: Array<{ value: string; type?: string }>, value: string, same: (a: string, b: string) => boolean) {
  const rest = list.filter((x) => !same(x.value, value)).map((x) => ({ value: x.value, type: x.type, isPrimary: false }));
  const prior = list.find((x) => same(x.value, value));
  return [{ value, type: prior?.type, isPrimary: true }, ...rest];
}

const digits = (v: string) => v.replace(/\D/g, "").slice(-10);

/** The PUT body for a contact's edited fields. Exported for tests. */
export function fubPersonBody(c: Record<string, any>, fields: EditableField[]): Record<string, any> {
  let raw: any = {};
  try {
    raw = JSON.parse(c.raw ?? "{}");
  } catch {
    /* keep {} */
  }
  const body: Record<string, any> = {};
  for (const f of fields) {
    if (f === "name") {
      const { first, last } = splitName(c.name ?? "");
      body.firstName = first ?? "";
      body.lastName = last ?? "";
    } else if (f === "email" && c.email) {
      body.emails = withPrimary(fubList(raw, "emails"), c.email, (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase());
    } else if (f === "phone" && c.phone) {
      body.phones = withPrimary(fubList(raw, "phones"), c.phone, (a, b) => digits(a) === digits(b));
    } else if (f === "stage") {
      body.stage = c.stage ?? "Lead";
    } else if (f === "source") {
      body.source = c.source ?? "";
    } else if (f === "tags") {
      try {
        body.tags = JSON.parse(c.tags ?? "[]");
      } catch {
        body.tags = [];
      }
    }
  }
  return body;
}

/** Send a contact's not-yet-sent edits to Follow Up Boss. */
export async function pushContactToFub(id: string): Promise<{ ok: boolean; error?: string }> {
  if (isNativeContact(id) || !fubConfigured()) return { ok: false, error: "not a Follow Up Boss contact" };
  const c = storage.getCrmContact(id) as Record<string, any> | undefined;
  const pending = overridesFor(id).filter((o) => !o.pushed_at);
  if (!c || pending.length === 0) return { ok: true };
  const body = fubPersonBody(c, pending.map((o) => o.field));
  if (Object.keys(body).length === 0) return { ok: true };
  const r = await fubPut(`/people/${encodeURIComponent(id)}`, body);
  const mark = sqlite.prepare(
    `UPDATE contact_overrides SET pushed_at = ?, push_error = ? WHERE contact_fub_id = ? AND field = ? AND edited_at = ?`,
  );
  const now = new Date().toISOString();
  for (const o of pending) mark.run(r.ok ? now : null, r.ok ? null : (r.error ?? `HTTP ${r.status}`).slice(0, 300), id, o.field, o.edited_at);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Resend edits FUB hasn't accepted yet: run after each people sync, so a
 * failed push (FUB down, a rate limit) doesn't wait for the next edit.
 */
let lastRetryAt = 0;
export async function retryPendingPushes(limit = 25, opts: { force?: boolean } = {}): Promise<number> {
  if (!fubConfigured()) return 0;
  // The sync calls this for every page of people; once every half hour is plenty.
  if (!opts.force && Date.now() - lastRetryAt < 30 * 60_000) return 0;
  lastRetryAt = Date.now();
  const ids = sqlite
    .prepare(`SELECT DISTINCT contact_fub_id AS id FROM contact_overrides WHERE pushed_at IS NULL ORDER BY edited_at LIMIT ?`)
    .all(limit) as Array<{ id: string }>;
  let sent = 0;
  for (const { id } of ids) {
    if ((await pushContactToFub(id)).ok) sent++;
  }
  return sent;
}
