// Bulk texts: one message, with merge fields, to many contacts from the
// business line. Built on /admin/bulk-text.
//
//   1. Pick people: by stage, tag, source and recent activity, then untick or
//      add individuals. Contacts with no textable number, who replied STOP
//      (server/sms.ts), or who share a number with someone earlier in the list
//      are skipped.
//   2. Write it (or start from a text template) and preview it filled in.
//   3. Send: each person's copy is filled in up front. Anyone whose copy has
//      an empty field ("Hi ,") is held, not sent. The rest go out one every
//      few seconds, so carriers don't treat the line as a spammer, and only
//      between 8 am and 9 pm Calgary time (the automations' quiet hours);
//      a send that runs into the evening carries on in the morning.
//
// Each text is a normal client text: it shows in that person's Inbox thread
// and their replies come back there.

import { sqlite } from "./storage";
import { isOptedOut, optedOutNumbers, sendSms, smsConfig, toE164 } from "./sms";
import { renderMergeChecked, unknownFields } from "./merge-fields";
import { nextTextableTime } from "./automations";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS bulk_texts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    status TEXT NOT NULL,             -- sending | done | cancelled
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bulk_text_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bulk_id INTEGER NOT NULL,
    contact_fub_id TEXT NOT NULL,
    name TEXT,
    phone TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,             -- queued | sending | sent | failed | held | skipped
    detail TEXT,
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bulk_text_recipients ON bulk_text_recipients(bulk_id, status, id);
`);

/** Gap between texts. ~900 an hour: well inside what carriers accept from one number. */
export const SEND_GAP_MS = 4000;
export const MAX_RECIPIENTS = 1000;

// ---- Who ------------------------------------------------------------------------------------

export interface AudienceFilter {
  stages?: string[];
  tags?: string[];
  sources?: string[];
  /** Only people with activity (or added) within this many days. */
  activeWithinDays?: number | null;
  /** Hand-picked people, added whatever the filters say. */
  include?: string[];
}

export type Eligibility = "ok" | "no_phone" | "opted_out" | "duplicate";

export interface AudienceMember {
  id: string;
  name: string;
  phone: string | null;
  stage: string | null;
  source: string | null;
  eligibility: Eligibility;
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  stage: string | null;
  source: string | null;
  tags: string;
  activity: string | null;
}

function allContacts(): ContactRow[] {
  return sqlite
    .prepare(
      `SELECT fub_id AS id, name, phone, stage, source, tags,
              MAX(COALESCE(last_activity_at, ''), COALESCE(fub_updated_at, ''), COALESCE(fub_created_at, '')) AS activity
         FROM crm_contacts`,
    )
    .all() as ContactRow[];
}

function tagsByContact(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of sqlite.prepare(`SELECT contact_fub_id AS id, tag FROM contact_tags`).all() as Array<{ id: string; tag: string }>) {
    out.set(r.id, [...(out.get(r.id) ?? []), r.tag]);
  }
  return out;
}

function tagsOf(c: ContactRow, app: Map<string, string[]>): string[] {
  let fub: string[] = [];
  try {
    fub = JSON.parse(c.tags || "[]");
  } catch {
    /* malformed: none */
  }
  return [...fub, ...(app.get(c.id) ?? [])];
}

const last10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);
const lower = (xs: string[] | undefined) => new Set((xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));

/** The stages, tags and sources there are to filter by, with how many textable people have each. */
export function audienceOptions() {
  const app = tagsByContact();
  const stages = new Map<string, number>();
  const tags = new Map<string, number>();
  const sources = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string | null) => k && m.set(k, (m.get(k) ?? 0) + 1);
  for (const c of allContacts()) {
    if (!toE164(c.phone)) continue;
    bump(stages, c.stage);
    bump(sources, c.source);
    for (const t of Array.from(new Set(tagsOf(c, app)))) bump(tags, t);
  }
  const list = (m: Map<string, number>) =>
    Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { stages: list(stages), tags: list(tags), sources: list(sources) };
}

/**
 * Everyone the filters pick (stage OR stage…, AND tag OR tag…, AND source…),
 * plus anyone added by hand, each marked whether they can be texted.
 * With no filter and nobody added, nobody: "everyone" has to be chosen on purpose.
 */
export function resolveAudience(filter: AudienceFilter): AudienceMember[] {
  const stages = lower(filter.stages);
  const tags = lower(filter.tags);
  const sources = lower(filter.sources);
  const include = new Set(filter.include ?? []);
  const filtered = stages.size > 0 || tags.size > 0 || sources.size > 0 || !!filter.activeWithinDays;
  const since = filter.activeWithinDays ? new Date(Date.now() - filter.activeWithinDays * 86400_000).toISOString() : null;
  const app = tags.size ? tagsByContact() : new Map<string, string[]>();
  const optedOut = optedOutNumbers();
  const own = new Set([last10(smsConfig().from), last10(smsConfig().agentCell)].filter((x) => x.length === 10));

  const picked: ContactRow[] = [];
  for (const c of allContacts()) {
    const matches =
      filtered &&
      (!stages.size || stages.has((c.stage ?? "").toLowerCase())) &&
      (!sources.size || sources.has((c.source ?? "").toLowerCase())) &&
      (!tags.size || tagsOf(c, app).some((t) => tags.has(t.toLowerCase()))) &&
      (!since || (c.activity ?? "") >= since);
    if (matches || include.has(c.id)) picked.push(c);
  }
  picked.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  const seen = new Set<string>();
  return picked.map((c) => {
    const e164 = toE164(c.phone);
    const k = last10(e164);
    let eligibility: Eligibility = "ok";
    if (!e164 || own.has(k)) eligibility = "no_phone";
    else if (optedOut.has(k)) eligibility = "opted_out";
    else if (seen.has(k)) eligibility = "duplicate";
    if (e164) seen.add(k);
    return { id: c.id, name: c.name || "(no name)", phone: c.phone, stage: c.stage, source: c.source, eligibility };
  });
}

// ---- What -----------------------------------------------------------------------------------

/** How many texts a message is billed as: 160 plain characters, or 70 with emoji/accents. */
export function segments(text: string): number {
  // The GSM-7 alphabet, roughly: anything outside it switches the whole message to UCS-2.
  const gsm = /^[\n\r A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(text);
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return text.length <= one ? 1 : Math.ceil(text.length / many);
}

export interface Preview {
  unknownFields: string[];
  samples: Array<{ id: string; name: string; text: string; blank: string[] }>;
  held: Array<{ id: string; name: string; blank: string[] }>;
  sendable: number;
  maxSegments: number;
}

/** The message filled in for the first few people, and who would be held for an empty field. */
export function previewBulk(body: string, contactIds: string[]): Preview {
  const unknown = unknownFields(body);
  const names = nameMap(contactIds);
  const samples: Preview["samples"] = [];
  const held: Preview["held"] = [];
  let maxSegments = segments(body);
  for (const id of contactIds) {
    const r = renderMergeChecked(body, id);
    const name = names.get(id) ?? "(no name)";
    if (samples.length < 3) samples.push({ id, name, text: r.text, blank: r.blank });
    if (r.blank.length) held.push({ id, name, blank: r.blank });
    maxSegments = Math.max(maxSegments, segments(r.text));
  }
  return { unknownFields: unknown, samples, held, sendable: contactIds.length - held.length, maxSegments };
}

function nameMap(ids: string[]): Map<string, string> {
  const want = new Set(ids);
  const out = new Map<string, string>();
  for (const r of sqlite.prepare(`SELECT fub_id AS id, name FROM crm_contacts`).all() as Array<{ id: string; name: string | null }>) {
    if (want.has(r.id)) out.set(r.id, r.name || "(no name)");
  }
  return out;
}

// ---- Sending ----------------------------------------------------------------------------------

export interface BulkText {
  id: number;
  body: string;
  status: "sending" | "done" | "cancelled";
  createdAt: string;
  finishedAt: string | null;
  counts: Record<"queued" | "sent" | "failed" | "held" | "skipped", number>;
  total: number;
  /** When it's waiting out quiet hours: the time it picks up again. */
  resumesAt: string | null;
}

function toBulk(r: any): BulkText {
  const counts = { queued: 0, sent: 0, failed: 0, held: 0, skipped: 0 };
  for (const c of sqlite.prepare(`SELECT status, COUNT(*) AS n FROM bulk_text_recipients WHERE bulk_id = ? GROUP BY status`).all(r.id) as Array<{
    status: string;
    n: number;
  }>) {
    const k = c.status === "sending" ? "queued" : c.status;
    if (k in counts) counts[k as keyof typeof counts] += c.n;
  }
  const next = nextTextableTime();
  return {
    id: r.id,
    body: r.body,
    status: r.status,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    resumesAt: r.status === "sending" && counts.queued > 0 && next.getTime() > Date.now() ? next.toISOString() : null,
  };
}

export function listBulkTexts(limit = 30): BulkText[] {
  return (sqlite.prepare(`SELECT * FROM bulk_texts ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(toBulk);
}

export function getBulkText(id: number) {
  const r = sqlite.prepare(`SELECT * FROM bulk_texts WHERE id = ?`).get(id);
  if (!r) return null;
  const recipients = sqlite
    .prepare(
      `SELECT id, contact_fub_id AS contactId, name, phone, body, status, detail, sent_at AS sentAt
         FROM bulk_text_recipients WHERE bulk_id = ? ORDER BY id`,
    )
    .all(id);
  return { ...toBulk(r), recipients };
}

/**
 * Start a bulk text. Everyone is checked again here (the page could be stale):
 * people who can't be texted are recorded as skipped, empty-field copies held.
 */
export function startBulkText(body: string, contactIds: string[]): { bulk: BulkText } | { error: string } {
  const text = body.trim();
  if (!text) return { error: "The message is empty." };
  const unknown = unknownFields(text);
  if (unknown.length) return { error: `${unknown.map((f) => `{${f}}`).join(", ")} isn't a merge field. Fix it before sending.` };
  const ids = Array.from(new Set(contactIds));
  if (!ids.length) return { error: "Nobody is selected." };
  if (ids.length > MAX_RECIPIENTS) return { error: `That's ${ids.length} people; one bulk text can go to at most ${MAX_RECIPIENTS}.` };

  const audience = new Map(resolveAudience({ include: ids }).map((m) => [m.id, m]));
  const now = new Date().toISOString();
  const bulkId = Number(
    sqlite.prepare(`INSERT INTO bulk_texts (body, status, created_at) VALUES (?, 'sending', ?)`).run(text, now).lastInsertRowid,
  );
  const add = sqlite.prepare(
    `INSERT INTO bulk_text_recipients (bulk_id, contact_fub_id, name, phone, body, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const why: Record<Exclude<Eligibility, "ok">, string> = {
    no_phone: "No textable number",
    opted_out: "Replied STOP",
    duplicate: "Same number as someone else in this send",
  };
  sqlite.transaction(() => {
    for (const id of ids) {
      const m = audience.get(id);
      if (!m) continue;
      if (m.eligibility !== "ok") {
        add.run(bulkId, id, m.name, m.phone ?? "", "", "skipped", why[m.eligibility]);
        continue;
      }
      const r = renderMergeChecked(text, id);
      if (r.blank.length) add.run(bulkId, id, m.name, m.phone, r.text, "held", `Empty: ${r.blank.map((f) => `{${f}}`).join(", ")}`);
      else add.run(bulkId, id, m.name, m.phone, r.text, "queued", null);
    }
  })();
  finishIfDone(bulkId);
  kick();
  return { bulk: toBulk(sqlite.prepare(`SELECT * FROM bulk_texts WHERE id = ?`).get(bulkId)) };
}

export function cancelBulkText(id: number): boolean {
  const r = sqlite.prepare(`UPDATE bulk_texts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'sending'`).run(new Date().toISOString(), id);
  if (!r.changes) return false;
  sqlite.prepare(`UPDATE bulk_text_recipients SET status = 'skipped', detail = 'Cancelled' WHERE bulk_id = ? AND status = 'queued'`).run(id);
  return true;
}

function finishIfDone(bulkId: number) {
  const left = sqlite.prepare(`SELECT 1 FROM bulk_text_recipients WHERE bulk_id = ? AND status IN ('queued', 'sending') LIMIT 1`).get(bulkId);
  if (!left) sqlite.prepare(`UPDATE bulk_texts SET status = 'done', finished_at = ? WHERE id = ? AND status = 'sending'`).run(new Date().toISOString(), bulkId);
}

let busy = false;

/** Send the next waiting text, if any and if it's daytime. Returns whether one was attempted. */
export async function sendNext(now = new Date()): Promise<boolean> {
  if (busy) return false;
  if (nextTextableTime(now).getTime() > now.getTime()) return false;
  busy = true;
  try {
    const next = sqlite
      .prepare(
        `SELECT r.id, r.bulk_id AS bulkId, r.contact_fub_id AS contactId, r.phone, r.body
           FROM bulk_text_recipients r JOIN bulk_texts b ON b.id = r.bulk_id
          WHERE b.status = 'sending' AND r.status = 'queued' ORDER BY r.bulk_id, r.id LIMIT 1`,
      )
      .get() as { id: number; bulkId: number; contactId: string; phone: string; body: string } | undefined;
    if (!next) return false;
    // Claimed before sending, so a crash mid-send can't send it twice.
    sqlite.prepare(`UPDATE bulk_text_recipients SET status = 'sending' WHERE id = ?`).run(next.id);
    const set = sqlite.prepare(`UPDATE bulk_text_recipients SET status = ?, detail = ?, sent_at = ? WHERE id = ?`);
    if (isOptedOut(next.phone)) {
      set.run("skipped", "Replied STOP", null, next.id);
    } else {
      const r = await sendSms(next.phone, next.body, { kind: "client", contactFubId: next.contactId });
      set.run(r.ok ? "sent" : "failed", r.ok ? null : r.error ?? "Send failed", new Date().toISOString(), next.id);
    }
    finishIfDone(next.bulkId);
    return true;
  } finally {
    busy = false;
  }
}

let timer: NodeJS.Timeout | null = null;

function kick() {
  if (timer) return;
  void sendNext().catch((e) => console.error("[bulk-texts]", e));
}

export function startBulkTextSender() {
  // A text that was mid-send when the app stopped: Twilio may or may not have
  // it, so it's marked rather than sent again.
  sqlite
    .prepare(`UPDATE bulk_text_recipients SET status = 'failed', detail = 'App restarted while sending; check their thread before resending' WHERE status = 'sending'`)
    .run();
  if (timer) return;
  timer = setInterval(() => void sendNext().catch((e) => console.error("[bulk-texts]", e)), SEND_GAP_MS);
  timer.unref?.();
}
