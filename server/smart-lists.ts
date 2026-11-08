// Smart lists: saved contact views, the app's version of Follow Up Boss's.
//
// A list is a name plus filters, evaluated live every time it's opened, so a
// contact drops into "No contact in 30 days" on day 31 without anyone moving
// them. Filters:
//
//   stages         stage is one of these
//   tagsAny        has at least one of these tags   (FUB's tags or the app's)
//   tagsNone       has none of these tags
//   sources        source is one of these
//   lastContact    last two-way contact older than N days / within N days / never
//   created        added older than N days / within N days
//   hasEmail, hasPhone, hasOpenTask, hasOverdueTask
//   q              name, email or phone contains
//
// "Last contact" is the latest call, text or email with the person, either
// direction: Follow Up Boss's mirrored calls, texts and emails, plus the
// app's own (business-line texts and calls, the Inbox, emails sent from the
// CRM). Website visits and automated mail (newsletters, listing alerts) don't
// count; they aren't contact.
//
// Tags are matched case-insensitively. Lists are the app's own; FUB's smart
// lists were captured by the config snapshot (crm_config) but their filter
// format doesn't map across, so their names are offered as a reminder of what
// to recreate.

import { z } from "zod";
import { sqlite } from "./storage";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS smart_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    filters TEXT NOT NULL DEFAULT '{}',
    sort TEXT NOT NULL DEFAULT 'last_contact_asc',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- Same as automations.ts; here too so tag filters work whichever loads first.
  CREATE TABLE IF NOT EXISTS contact_tags (
    contact_fub_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (contact_fub_id, tag)
  );
`);

const days = z.number().int().min(0).max(36500);
const words = z.array(z.string().trim().min(1).max(80)).max(50);

export const filtersSchema = z
  .object({
    stages: words.optional(),
    tagsAny: words.optional(),
    tagsNone: words.optional(),
    sources: words.optional(),
    lastContact: z.object({ op: z.enum(["older", "within", "never"]), days: days.optional() }).optional(),
    created: z.object({ op: z.enum(["older", "within"]), days }).optional(),
    hasEmail: z.boolean().optional(),
    hasPhone: z.boolean().optional(),
    hasOpenTask: z.boolean().optional(),
    hasOverdueTask: z.boolean().optional(),
    q: z.string().trim().max(120).optional(),
  })
  .strict();
export type SmartListFilters = z.infer<typeof filtersSchema>;

export const SORTS = {
  last_contact_asc: "Longest since contact",
  last_contact_desc: "Most recently contacted",
  created_desc: "Newest first",
  name: "Name",
} as const;
export type SmartListSort = keyof typeof SORTS;

export const listSchema = z.object({
  name: z.string().trim().min(1, "Give the list a name").max(80),
  filters: filtersSchema,
  sort: z.enum(Object.keys(SORTS) as [SmartListSort, ...SmartListSort[]]).default("last_contact_asc"),
});

function tableExists(name: string): boolean {
  return !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

let indexed = false;
/** Indexes for the per-contact lookups, once the tables they're on exist. */
function ensureIndexes() {
  if (indexed) return;
  if (tableExists("sms_messages")) sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_sms_messages_contact ON sms_messages(contact_fub_id, created_at)`);
  if (tableExists("tracked_emails")) sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_tracked_emails_contact ON tracked_emails(contact_fub_id, sent_at)`);
  indexed = true;
}

/** Every contact's latest two-way contact, as a subquery: (contact_id, at). */
function lastContactSql(): string {
  ensureIndexes();
  const parts = [
    `SELECT contact_fub_id AS cid, MAX(occurred_at) AS at FROM crm_activities WHERE kind IN ('call','text','email') AND contact_fub_id IS NOT NULL GROUP BY contact_fub_id`,
  ];
  if (tableExists("sms_messages")) {
    parts.push(`SELECT contact_fub_id, MAX(created_at) FROM sms_messages WHERE kind = 'client' AND contact_fub_id IS NOT NULL GROUP BY contact_fub_id`);
  }
  if (tableExists("call_log")) {
    parts.push(`SELECT contact_fub_id, MAX(started_at) FROM call_log WHERE contact_fub_id IS NOT NULL AND status IN ('answered','completed','voicemail') GROUP BY contact_fub_id`);
  }
  if (tableExists("inbox_emails")) {
    parts.push(`SELECT contact_fub_id, MAX(occurred_at) FROM inbox_emails GROUP BY contact_fub_id`);
  }
  if (tableExists("tracked_emails")) {
    parts.push(`SELECT contact_fub_id, MAX(sent_at) FROM tracked_emails WHERE kind = 'crm' AND contact_fub_id IS NOT NULL GROUP BY contact_fub_id`);
  }
  return `SELECT cid, MAX(at) AS at FROM (${parts.join(" UNION ALL ")}) GROUP BY cid`;
}

/** A contact's tags, FUB's and the app's, lower-cased: usable inside EXISTS. */
const TAGS_OF = `(SELECT lower(trim(value)) AS t FROM json_each(CASE WHEN json_valid(c.tags) THEN c.tags ELSE '[]' END)
                  UNION SELECT lower(trim(tag)) FROM contact_tags WHERE contact_fub_id = c.fub_id)`;

function placeholders(n: number) {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** The WHERE clause and its values for a set of filters. */
export function whereFor(f: SmartListFilters, now = new Date()): { sql: string; vals: unknown[] } {
  const where: string[] = [];
  const vals: unknown[] = [];
  const ago = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();
  if (f.stages?.length) {
    where.push(`lower(coalesce(c.stage, '')) IN (${placeholders(f.stages.length)})`);
    vals.push(...f.stages.map((s) => s.toLowerCase()));
  }
  if (f.sources?.length) {
    where.push(`lower(coalesce(c.source, '')) IN (${placeholders(f.sources.length)})`);
    vals.push(...f.sources.map((s) => s.toLowerCase()));
  }
  if (f.tagsAny?.length) {
    where.push(`EXISTS (SELECT 1 FROM ${TAGS_OF} WHERE t IN (${placeholders(f.tagsAny.length)}))`);
    vals.push(...f.tagsAny.map((t) => t.toLowerCase()));
  }
  if (f.tagsNone?.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM ${TAGS_OF} WHERE t IN (${placeholders(f.tagsNone.length)}))`);
    vals.push(...f.tagsNone.map((t) => t.toLowerCase()));
  }
  if (f.lastContact) {
    if (f.lastContact.op === "never") where.push(`lc.at IS NULL`);
    else if (f.lastContact.op === "older") {
      where.push(`(lc.at IS NULL OR lc.at < ?)`);
      vals.push(ago(f.lastContact.days ?? 30));
    } else {
      where.push(`lc.at >= ?`);
      vals.push(ago(f.lastContact.days ?? 30));
    }
  }
  if (f.created) {
    where.push(f.created.op === "older" ? `coalesce(c.fub_created_at, '') < ?` : `c.fub_created_at >= ?`);
    vals.push(ago(f.created.days));
  }
  if (f.hasEmail !== undefined) where.push(f.hasEmail ? `coalesce(c.email, '') != ''` : `coalesce(c.email, '') = ''`);
  if (f.hasPhone !== undefined) where.push(f.hasPhone ? `coalesce(c.phone, '') != ''` : `coalesce(c.phone, '') = ''`);
  if (f.hasOpenTask !== undefined) {
    where.push(`${f.hasOpenTask ? "" : "NOT "}EXISTS (SELECT 1 FROM crm_activities t WHERE t.contact_fub_id = c.fub_id AND t.kind = 'task' AND t.completed = 0)`);
  }
  if (f.hasOverdueTask) {
    where.push(`EXISTS (SELECT 1 FROM crm_activities t WHERE t.contact_fub_id = c.fub_id AND t.kind = 'task' AND t.completed = 0 AND t.due_at < ?)`);
    vals.push(now.toISOString());
  }
  if (f.q) {
    const like = `%${f.q.toLowerCase()}%`;
    const digits = f.q.replace(/\D/g, "");
    where.push(
      `(lower(coalesce(c.name,'')) LIKE ? OR lower(coalesce(c.email,'')) LIKE ?${digits.length >= 3 ? ` OR replace(replace(replace(replace(replace(coalesce(c.phone,''),' ',''),'-',''),'(',''),')',''),'+','') LIKE ?` : ""})`,
    );
    vals.push(like, like, ...(digits.length >= 3 ? [`%${digits}%`] : []));
  }
  return { sql: where.length ? where.join(" AND ") : "1", vals };
}

/** A contact's tags, FUB's and the app's, as written: a JSON array, for display. */
const ALL_TAGS_JSON = `(SELECT json_group_array(t) FROM (
    SELECT trim(value) AS t FROM json_each(CASE WHEN json_valid(c.tags) THEN c.tags ELSE '[]' END) WHERE trim(value) != ''
    UNION SELECT trim(tag) FROM contact_tags WHERE contact_fub_id = c.fub_id))`;

/**
 * Everyone matching a set of filters, with no page limit: who a bulk action
 * (tagging, a monthly report) applies to. Only what those need.
 */
export function listMembers(f: SmartListFilters, now = new Date()): Array<{ fubId: string; name: string | null; email: string | null }> {
  const { sql, vals } = whereFor(f, now);
  // The last-contact join only when a filter reads it.
  const join = f.lastContact ? `LEFT JOIN (${lastContactSql()}) lc ON lc.cid = c.fub_id` : "";
  return sqlite
    .prepare(`SELECT c.fub_id AS fubId, c.name, c.email FROM crm_contacts c ${join} WHERE ${sql}`)
    .all(...vals) as Array<{ fubId: string; name: string | null; email: string | null }>;
}

const ORDER: Record<SmartListSort, string> = {
  last_contact_asc: "lc.at IS NOT NULL, lc.at ASC, c.fub_created_at DESC",
  last_contact_desc: "lc.at IS NULL, lc.at DESC",
  created_desc: "c.fub_created_at DESC",
  name: "lower(coalesce(c.name, '')) ASC",
};

export interface SmartListContact {
  fubId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  source: string | null;
  tags: string | null;
  fubCreatedAt: string | null;
  lastActivityAt: string | null;
  lastContactAt: string | null;
}

/** The contacts matching a set of filters, and how many there are in all. */
export function runFilters(
  f: SmartListFilters,
  sort: SmartListSort = "last_contact_asc",
  opts: { limit?: number; offset?: number; now?: Date } = {},
): { total: number; contacts: SmartListContact[] } {
  const { sql, vals } = whereFor(f, opts.now);
  const from = `FROM crm_contacts c LEFT JOIN (${lastContactSql()}) lc ON lc.cid = c.fub_id WHERE ${sql}`;
  const total = (sqlite.prepare(`SELECT COUNT(*) AS n ${from}`).get(...vals) as { n: number }).n;
  const contacts = sqlite
    .prepare(
      `SELECT c.fub_id AS fubId, c.name, c.email, c.phone, c.stage, c.source, ${ALL_TAGS_JSON} AS tags, c.fub_created_at AS fubCreatedAt,
              c.last_activity_at AS lastActivityAt, lc.at AS lastContactAt
       ${from} ORDER BY ${ORDER[sort] ?? ORDER.last_contact_asc} LIMIT ? OFFSET ?`,
    )
    .all(...vals, Math.min(opts.limit ?? 200, 1000), opts.offset ?? 0) as SmartListContact[];
  return { total, contacts };
}

// ---- Saved lists ------------------------------------------------------------------------

export interface SmartList {
  id: number;
  name: string;
  filters: SmartListFilters;
  sort: SmartListSort;
  position: number;
}

function rowToList(r: any): SmartList {
  let filters: SmartListFilters = {};
  try {
    const parsed = filtersSchema.safeParse(JSON.parse(r.filters));
    if (parsed.success) filters = parsed.data;
  } catch {
    /* keep {} */
  }
  return { id: r.id, name: r.name, filters, sort: (r.sort in SORTS ? r.sort : "last_contact_asc") as SmartListSort, position: r.position };
}

export function listSmartLists(): SmartList[] {
  return (sqlite.prepare(`SELECT * FROM smart_lists ORDER BY position, id`).all() as any[]).map(rowToList);
}

export function getSmartList(id: number): SmartList | null {
  const r = sqlite.prepare(`SELECT * FROM smart_lists WHERE id = ?`).get(id);
  return r ? rowToList(r) : null;
}

export function createSmartList(input: z.input<typeof listSchema>): SmartList {
  const l = listSchema.parse(input);
  const now = new Date().toISOString();
  const pos = (sqlite.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM smart_lists`).get() as { p: number }).p;
  const id = Number(
    sqlite
      .prepare(`INSERT INTO smart_lists (name, filters, sort, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(l.name, JSON.stringify(l.filters), l.sort, pos, now, now).lastInsertRowid,
  );
  return getSmartList(id)!;
}

export function updateSmartList(id: number, input: z.input<typeof listSchema>): SmartList | null {
  const l = listSchema.parse(input);
  const ok =
    sqlite
      .prepare(`UPDATE smart_lists SET name = ?, filters = ?, sort = ?, updated_at = ? WHERE id = ?`)
      .run(l.name, JSON.stringify(l.filters), l.sort, new Date().toISOString(), id).changes > 0;
  return ok ? getSmartList(id) : null;
}

export function deleteSmartList(id: number): boolean {
  return sqlite.prepare(`DELETE FROM smart_lists WHERE id = ?`).run(id).changes > 0;
}

/** Put the lists in this order (ids not given keep their place after). */
export function reorderSmartLists(ids: number[]) {
  const set = sqlite.prepare(`UPDATE smart_lists SET position = ? WHERE id = ?`);
  sqlite.transaction(() => ids.forEach((id, i) => set.run(i, id)))();
}

/** Each saved list with how many contacts are in it now. */
export function smartListsWithCounts(): Array<SmartList & { count: number }> {
  return listSmartLists().map((l) => ({ ...l, count: runFilters(l.filters, l.sort, { limit: 0 }).total }));
}

// ---- Starter lists and filter choices ------------------------------------------------------------

/** What's in the data to filter on: stages, tags and sources, most used first. */
export function filterOptions() {
  const stages = sqlite
    .prepare(`SELECT stage AS value, COUNT(*) AS count FROM crm_contacts WHERE coalesce(stage,'') != '' GROUP BY lower(stage) ORDER BY count DESC`)
    .all() as Array<{ value: string; count: number }>;
  const sources = sqlite
    .prepare(`SELECT source AS value, COUNT(*) AS count FROM crm_contacts WHERE coalesce(source,'') != '' GROUP BY lower(source) ORDER BY count DESC LIMIT 100`)
    .all() as Array<{ value: string; count: number }>;
  const tags = sqlite
    .prepare(
      `SELECT value, COUNT(DISTINCT cid) AS count FROM (
         SELECT trim(j.value) AS value, c.fub_id AS cid FROM crm_contacts c, json_each(CASE WHEN json_valid(c.tags) THEN c.tags ELSE '[]' END) j
         UNION ALL SELECT trim(tag), contact_fub_id FROM contact_tags
       ) WHERE value != '' GROUP BY lower(value) ORDER BY count DESC LIMIT 200`,
    )
    .all() as Array<{ value: string; count: number }>;
  let fubSmartLists: string[] = [];
  try {
    const row = sqlite.prepare(`SELECT json FROM crm_config WHERE resource = 'smartLists'`).get() as { json: string } | undefined;
    const payload = row ? JSON.parse(row.json) : null;
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.smartlists) ? payload.smartlists : [];
    fubSmartLists = items.map((x: any) => String(x?.name ?? "")).filter(Boolean).slice(0, 50);
  } catch {
    /* no snapshot */
  }
  return { stages, sources, tags, sorts: SORTS, fubSmartLists };
}

/** A few useful lists to start from, made once when there are none. */
export function seedStarterLists(): number {
  // Once ever: deleting every list shouldn't bring the starters back.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS smart_lists_seeded (at TEXT NOT NULL)`);
  if (sqlite.prepare(`SELECT 1 FROM smart_lists_seeded`).get()) return 0;
  sqlite.prepare(`INSERT INTO smart_lists_seeded (at) VALUES (?)`).run(new Date().toISOString());
  if ((sqlite.prepare(`SELECT COUNT(*) AS n FROM smart_lists`).get() as { n: number }).n > 0) return 0;
  const present = new Set(filterOptions().stages.map((s) => s.value.toLowerCase()));
  // The names that exist here, once each: stages match ignoring case.
  const has = (...names: string[]) => {
    const seen = new Set<string>();
    return names.filter((n) => present.has(n.toLowerCase()) && !seen.has(n.toLowerCase()) && !!seen.add(n.toLowerCase()));
  };
  const starters: Array<z.input<typeof listSchema>> = [
    { name: "New leads, last 7 days", filters: { created: { op: "within", days: 7 } }, sort: "created_desc" },
    { name: "Leads not contacted yet", filters: { stages: has("Lead", "New Lead"), lastContact: { op: "never" } }, sort: "created_desc" },
    { name: "Hot, no contact in 7 days", filters: { stages: has("Hot", "Hot Prospect", "Hot Lead"), lastContact: { op: "older", days: 7 } } },
    { name: "Active clients, no contact in 14 days", filters: { stages: has("Active Client", "Active client"), lastContact: { op: "older", days: 14 } } },
    { name: "Nurture, no contact in 30 days", filters: { stages: has("Nurture"), lastContact: { op: "older", days: 30 } } },
    { name: "Past clients and sphere, no contact in 90 days", filters: { stages: has("Past Client", "Past client", "Sphere", "Closed"), lastContact: { op: "older", days: 90 } } },
    { name: "Overdue tasks", filters: { hasOverdueTask: true } },
  ];
  let made = 0;
  for (const s of starters) {
    // A stage-based list only when the stage exists here.
    if (s.filters.stages && s.filters.stages.length === 0) continue;
    createSmartList(s);
    made++;
  }
  return made;
}
