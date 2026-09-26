/**
 * Persistence for the SEO console's write side: title/description overrides,
 * redirects added from the console, and the log of Claude fix proposals.
 *
 * Kept apart from storage.ts because it is self-contained and because two of
 * these tables sit on the request hot path (every page render reads the
 * override map, every GET reads the redirect map). Both are held in memory and
 * rebuilt only when a write happens, so the hot path never touches SQLite.
 */
import { sqlite } from "./storage";

sqlite.exec(`
  -- Title / meta description set from the SEO console. Applied last in
  -- metaForPath (server) and SeoHead (client), so it wins over whatever the
  -- page's own code or CMS row would emit. NULL means "no override".
  CREATE TABLE IF NOT EXISTS seo_meta_overrides (
    path TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    updated_at TEXT NOT NULL
  );

  -- 301s added from the console (usually consolidating a cannibalizing page).
  -- Checked before the hand-maintained legacy map in server/redirects.ts.
  CREATE TABLE IF NOT EXISTS seo_redirects (
    from_path TEXT PRIMARY KEY,
    to_path TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );

  -- Every "Fix with Claude" run: what was asked, what Claude proposed, what
  -- was applied and the values it replaced (so it can be undone).
  CREATE TABLE IF NOT EXISTS seo_fix_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    rationale TEXT,
    changes TEXT NOT NULL DEFAULT '[]',
    dropped TEXT NOT NULL DEFAULT '[]',
    snapshot TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    applied_at TEXT
  );
`);

// Added after the table first shipped; ALTER is the only way to reach rows
// that already exist in production.
{
  const cols = (sqlite.prepare("PRAGMA table_info(seo_fix_proposals)").all() as Array<{ name: string }>)
    .map((c) => c.name);
  if (!cols.includes("planned")) {
    sqlite.exec("ALTER TABLE seo_fix_proposals ADD COLUMN planned TEXT NOT NULL DEFAULT '[]'");
  }
}

const now = () => new Date().toISOString();
const normPath = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

// ---------------------------------------------------------------------------
// Meta overrides
// ---------------------------------------------------------------------------

export interface MetaOverride {
  title: string | null;
  description: string | null;
}

let overrideCache: Record<string, MetaOverride> | null = null;

export function getMetaOverrides(): Record<string, MetaOverride> {
  if (overrideCache) return overrideCache;
  const rows = sqlite
    .prepare("SELECT path, title, description FROM seo_meta_overrides")
    .all() as Array<{ path: string; title: string | null; description: string | null }>;
  const map: Record<string, MetaOverride> = {};
  for (const r of rows) map[r.path] = { title: r.title, description: r.description };
  overrideCache = map;
  return map;
}

export function getMetaOverride(path: string): MetaOverride | null {
  return getMetaOverrides()[normPath(path)] ?? null;
}

/** Write (or clear, when both fields are null) the override for a path. */
export function setMetaOverride(path: string, o: MetaOverride): void {
  const p = normPath(path);
  const title = o.title?.trim() || null;
  const description = o.description?.trim() || null;
  if (!title && !description) {
    sqlite.prepare("DELETE FROM seo_meta_overrides WHERE path = ?").run(p);
  } else {
    sqlite
      .prepare(
        `INSERT INTO seo_meta_overrides (path, title, description, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           updated_at = excluded.updated_at`,
      )
      .run(p, title, description, now());
  }
  overrideCache = null;
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

let redirectCache: Map<string, string> | null = null;

function redirectMap(): Map<string, string> {
  if (redirectCache) return redirectCache;
  const rows = sqlite
    .prepare("SELECT from_path, to_path FROM seo_redirects")
    .all() as Array<{ from_path: string; to_path: string }>;
  redirectCache = new Map(rows.map((r) => [r.from_path, r.to_path]));
  return redirectCache;
}

/** Console-added 301 target for a (lower-cased, slash-trimmed) path. */
export function consoleRedirectFor(path: string): string | null {
  return redirectMap().get(normPath(path.toLowerCase())) ?? null;
}

export function listConsoleRedirects(): Array<{ from: string; to: string }> {
  return Array.from(redirectMap(), ([from, to]) => ({ from, to }));
}

/**
 * Add a 301. Refuses self-redirects, and refuses anything that would make a
 * chain or a loop — a redirect *to* a path that itself redirects, or *from* a
 * path that other redirects point at. Chains cost crawl budget and loops take
 * the page down, so both are rejected rather than stored.
 */
export function addConsoleRedirect(from: string, to: string, note?: string): void {
  const f = normPath(from.toLowerCase());
  const t = normPath(to);
  if (!f.startsWith("/") || !t.startsWith("/")) throw new Error("Redirect paths must be site-relative");
  if (f === "/") throw new Error("The homepage cannot be redirected");
  if (f === t.toLowerCase()) throw new Error("A page cannot redirect to itself");
  const map = redirectMap();
  if (map.has(t.toLowerCase())) throw new Error(`${t} already redirects to ${map.get(t.toLowerCase())} — that would make a chain`);
  for (const [src, dst] of Array.from(map)) {
    if (dst.toLowerCase() === f && src !== f) {
      throw new Error(`${src} already redirects to ${f} — point it at ${t} first`);
    }
  }
  sqlite
    .prepare(
      `INSERT INTO seo_redirects (from_path, to_path, note, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(from_path) DO UPDATE SET to_path = excluded.to_path, note = excluded.note`,
    )
    .run(f, t, note ?? null, now());
  redirectCache = null;
}

export function removeConsoleRedirect(from: string): void {
  sqlite.prepare("DELETE FROM seo_redirects WHERE from_path = ?").run(normPath(from.toLowerCase()));
  redirectCache = null;
}

// ---------------------------------------------------------------------------
// Fix proposals
// ---------------------------------------------------------------------------

export type FixStatus =
  | "generating" | "ready" | "failed" | "applied" | "partially_applied" | "undone" | "dismissed";

export interface FixProposalRow {
  id: number;
  kind: string;
  subject: any;
  status: FixStatus;
  summary: string | null;
  rationale: string | null;
  changes: any[];
  dropped: any[];
  snapshot: any[];
  /** Cluster plans: follow-up pages Claude recommends writing (not applied). */
  planned: any[];
  error: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

const parse = (s: string | null, fallback: any) => {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

function rowToProposal(r: any): FixProposalRow {
  return {
    id: r.id,
    kind: r.kind,
    subject: parse(r.subject, {}),
    status: r.status,
    summary: r.summary,
    rationale: r.rationale,
    changes: parse(r.changes, []),
    dropped: parse(r.dropped, []),
    snapshot: parse(r.snapshot, []),
    planned: parse(r.planned, []),
    error: r.error,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    appliedAt: r.applied_at,
  };
}

export function createFixProposal(kind: string, subject: unknown): FixProposalRow {
  const t = now();
  const res = sqlite
    .prepare(
      `INSERT INTO seo_fix_proposals (kind, subject, status, created_at, updated_at)
       VALUES (?, ?, 'generating', ?, ?)`,
    )
    .run(kind, JSON.stringify(subject), t, t);
  return getFixProposal(Number(res.lastInsertRowid))!;
}

export function getFixProposal(id: number): FixProposalRow | null {
  const r = sqlite.prepare("SELECT * FROM seo_fix_proposals WHERE id = ?").get(id);
  return r ? rowToProposal(r) : null;
}

export function listFixProposals(limit = 50): FixProposalRow[] {
  return (sqlite
    .prepare("SELECT * FROM seo_fix_proposals ORDER BY id DESC LIMIT ?")
    .all(limit) as any[]).map(rowToProposal);
}

export function updateFixProposal(
  id: number,
  patch: Partial<Pick<FixProposalRow,
    "status" | "summary" | "rationale" | "changes" | "dropped" | "snapshot" | "planned" | "error" | "model" | "appliedAt">>,
): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { cols.push(`${col} = ?`); vals.push(v); };
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.summary !== undefined) set("summary", patch.summary);
  if (patch.rationale !== undefined) set("rationale", patch.rationale);
  if (patch.changes !== undefined) set("changes", JSON.stringify(patch.changes));
  if (patch.dropped !== undefined) set("dropped", JSON.stringify(patch.dropped));
  if (patch.snapshot !== undefined) set("snapshot", JSON.stringify(patch.snapshot));
  if (patch.planned !== undefined) set("planned", JSON.stringify(patch.planned));
  if (patch.error !== undefined) set("error", patch.error);
  if (patch.model !== undefined) set("model", patch.model);
  if (patch.appliedAt !== undefined) set("applied_at", patch.appliedAt);
  set("updated_at", now());
  vals.push(id);
  sqlite.prepare(`UPDATE seo_fix_proposals SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
}

/**
 * A proposal left "generating" by a restart will never finish — the Claude
 * call lived in the old process. Mark those failed at boot so the UI stops
 * polling them.
 */
export function failAbandonedProposals(): void {
  sqlite
    .prepare(
      `UPDATE seo_fix_proposals SET status = 'failed', error = 'Interrupted by a server restart — run it again.', updated_at = ?
       WHERE status = 'generating'`,
    )
    .run(now());
}

// ---------------------------------------------------------------------------
// Topic clusters
// ---------------------------------------------------------------------------
// The cluster map (pillar page + head term + which pages belong) used to be a
// constant in seo-keywords.ts. It lives here so clusters can be adopted,
// edited and planned from the console. The constant is still the factory
// default: an empty table is seeded from it on first read, so nothing changes
// until someone edits a cluster.

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS seo_clusters (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    pillar TEXT NOT NULL,
    head_keyword TEXT NOT NULL,
    intent TEXT NOT NULL,
    prefixes TEXT NOT NULL DEFAULT '[]',
    vocabulary TEXT NOT NULL DEFAULT '[]',
    members TEXT NOT NULL DEFAULT '[]',
    factory INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

export interface StoredCluster {
  id: string;
  label: string;
  pillar: string;
  headKeyword: string;
  intent: "transactional" | "commercial" | "informational" | "navigational";
  prefixes: string[];
  vocabulary: string[];
  /** Explicit member pages — how a cluster built from scattered blog posts
   *  claims them, since they share no URL prefix. */
  members: string[];
  /** Seeded from the code default: editable, never deletable. */
  factory: boolean;
  sort: number;
}

const INTENTS = new Set(["transactional", "commercial", "informational", "navigational"]);
let clusterCache: StoredCluster[] | null = null;

function rowToCluster(r: any): StoredCluster {
  return {
    id: r.id,
    label: r.label,
    pillar: r.pillar,
    headKeyword: r.head_keyword,
    intent: INTENTS.has(r.intent) ? r.intent : "informational",
    prefixes: parse(r.prefixes, []),
    vocabulary: parse(r.vocabulary, []),
    members: parse(r.members, []),
    factory: Boolean(r.factory),
    sort: r.sort,
  };
}

/** All clusters, seeding the table from `defaults` the first time. */
export function getStoredClusters(
  defaults: Array<Omit<StoredCluster, "members" | "factory" | "sort"> & { members?: string[] }>,
): StoredCluster[] {
  if (clusterCache) return clusterCache;
  let rows = sqlite.prepare("SELECT * FROM seo_clusters ORDER BY sort, id").all() as any[];
  if (!rows.length) {
    const ins = sqlite.prepare(
      `INSERT OR IGNORE INTO seo_clusters
         (id, label, pillar, head_keyword, intent, prefixes, vocabulary, members, factory, sort, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const t = now();
    defaults.forEach((d, i) =>
      ins.run(d.id, d.label, d.pillar, d.headKeyword, d.intent, JSON.stringify(d.prefixes),
        JSON.stringify(d.vocabulary), JSON.stringify(d.members ?? []), i, t));
    rows = sqlite.prepare("SELECT * FROM seo_clusters ORDER BY sort, id").all() as any[];
  }
  clusterCache = rows.map(rowToCluster);
  return clusterCache;
}

export function getStoredCluster(id: string): StoredCluster | null {
  const r = sqlite.prepare("SELECT * FROM seo_clusters WHERE id = ?").get(id);
  return r ? rowToCluster(r) : null;
}

export function slugifyClusterId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "cluster";
}

/** Insert or update a cluster. Returns the stored row. */
export function upsertCluster(c: Omit<StoredCluster, "factory" | "sort"> & { sort?: number }): StoredCluster {
  const existing = getStoredCluster(c.id);
  const sort = c.sort ?? existing?.sort
    ?? ((sqlite.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM seo_clusters").get() as any).n as number);
  const clean = (xs: string[]) => Array.from(new Set(xs.map((x) => String(x).trim()).filter(Boolean)));
  sqlite
    .prepare(
      `INSERT INTO seo_clusters
         (id, label, pillar, head_keyword, intent, prefixes, vocabulary, members, factory, sort, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label, pillar = excluded.pillar, head_keyword = excluded.head_keyword,
         intent = excluded.intent, prefixes = excluded.prefixes, vocabulary = excluded.vocabulary,
         members = excluded.members, sort = excluded.sort, updated_at = excluded.updated_at`,
    )
    .run(
      c.id, c.label.trim(), normPath(c.pillar.trim()), c.headKeyword.trim().toLowerCase(),
      INTENTS.has(c.intent) ? c.intent : "informational",
      JSON.stringify(clean(c.prefixes)), JSON.stringify(clean(c.vocabulary).map((v) => v.toLowerCase())),
      JSON.stringify(clean(c.members).map(normPath)), sort, now(),
    );
  clusterCache = null;
  return getStoredCluster(c.id)!;
}

/** Delete a cluster. Factory clusters are refused — edit them instead. */
export function deleteCluster(id: string, opts: { allowFactory?: boolean } = {}): void {
  const c = getStoredCluster(id);
  if (!c) return;
  if (c.factory && !opts.allowFactory) throw new Error("Built-in clusters can be edited but not deleted");
  sqlite.prepare("DELETE FROM seo_clusters WHERE id = ?").run(id);
  clusterCache = null;
}
