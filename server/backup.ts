// Nightly encrypted offsite backup.
//
// Why: signed contracts are legal records the brokerage must be able to
// produce for years, and before this file existed the SQLite database and
// every uploaded file lived on one Fly volume with no copy anywhere else.
//
// What it does, once a day (03:15 Calgary) and on demand from the admin:
//   1. Snapshots the live SQLite database with the online backup API (a
//      consistent copy even while the app is writing), gzips it, encrypts it
//      and uploads it as <prefix>/db/rivers-<timestamp>.sqlite.gz.enc.
//   2. Walks DOCUMENTS_ROOT and uploads every file it has not uploaded before
//      as <prefix>/documents/<key>.enc. Document files are never modified in
//      place (see documents-store.ts), so once is enough.
//   3. Deletes database snapshots older than BACKUP_KEEP_DAYS.
//
// The target is any S3-compatible bucket — Cloudflare R2, Backblaze B2 or
// AWS S3 — spoken to with hand-signed SigV4 requests over node:https, so
// there is no SDK to bundle. Everything is encrypted with AES-256-GCM
// before it leaves the machine; the bucket only ever sees ciphertext.
//
// Env:
//   BACKUP_S3_ENDPOINT      https://<account>.r2.cloudflarestorage.com
//   BACKUP_S3_BUCKET        bucket name
//   BACKUP_S3_ACCESS_KEY    access key id
//   BACKUP_S3_SECRET_KEY    secret
//   BACKUP_S3_REGION        "auto" for R2 (default), else the bucket's region
//   BACKUP_S3_PREFIX        key prefix, default "rivers"
//   BACKUP_ENCRYPTION_KEY   64 hex chars (32 bytes). Generate with
//                           `openssl rand -hex 32`. Losing it loses the
//                           backups — keep it somewhere other than Fly.
//   BACKUP_KEEP_DAYS        default 90
//
// Restore: script/restore-backup.ts. S3 + cipher code: backup-s3.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqlite } from "./storage";
import { DOCUMENTS_ROOT, documentPath, listDocumentKeys, sha256Hex } from "./documents-store";
import { backupConfig, encryptToFile, s3Delete, s3List, s3PutFile, type BackupConfig } from "./backup-s3";

// ---- Runs -----------------------------------------------------------------------

export interface BackupRun {
  id: number;
  kind: string;
  status: string;
  dbBytes: number | null;
  dbKey: string | null;
  filesUploaded: number;
  filesBytes: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function rowToRun(r: any): BackupRun {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    dbBytes: r.db_bytes,
    dbKey: r.db_key,
    filesUploaded: r.files_uploaded,
    filesBytes: r.files_bytes,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function recentBackupRuns(limit = 10): BackupRun[] {
  return (sqlite.prepare("SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(rowToRun);
}

export function pendingDocumentFiles(): number {
  const done = new Set((sqlite.prepare("SELECT path FROM backup_files").all() as any[]).map((r) => r.path));
  return listDocumentKeys().filter((k) => !done.has(k)).length;
}

let running: Promise<BackupRun> | null = null;

/**
 * Run a backup. `kind` "full" is the database plus new documents; "documents"
 * only copies new document files (used right after a contract completes, so
 * the signed copy is offsite within a minute rather than by morning).
 */
export function runBackup(kind: "full" | "documents"): Promise<BackupRun> {
  if (running) return running;
  running = doRun(kind).finally(() => {
    running = null;
  });
  return running;
}

async function doRun(kind: "full" | "documents"): Promise<BackupRun> {
  const startedAt = new Date().toISOString();
  const { config, missing } = backupConfig();
  const insert = sqlite.prepare(
    "INSERT INTO backup_runs (kind, status, started_at, files_uploaded, files_bytes) VALUES (?, 'running', ?, 0, 0)",
  );
  const runId = Number(insert.run(kind, startedAt).lastInsertRowid);
  const finish = (patch: Partial<{ status: string; db_bytes: number; db_key: string; files_uploaded: number; files_bytes: number; error: string }>) => {
    const cols = Object.keys(patch);
    sqlite
      .prepare(`UPDATE backup_runs SET ${cols.map((c) => `${c} = ?`).join(", ")}, finished_at = ? WHERE id = ?`)
      .run(...cols.map((c) => (patch as any)[c]), new Date().toISOString(), runId);
    return rowToRun(sqlite.prepare("SELECT * FROM backup_runs WHERE id = ?").get(runId));
  };

  if (!config) {
    const error = `Backup not configured — missing ${missing.join(", ")}`;
    console.warn(`[backup] ${error}`);
    return finish({ status: "error", error });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rre-backup-"));
  let dbBytes: number | undefined;
  let dbKey: string | undefined;
  let filesUploaded = 0;
  let filesBytes = 0;
  try {
    if (kind === "full") {
      const snapshot = path.join(tmpDir, "db.sqlite");
      await sqlite.backup(snapshot);
      const enc = path.join(tmpDir, "db.enc");
      const { sha256, bytes } = await encryptToFile(fs.createReadStream(snapshot), enc, config.key, { gzip: true });
      fs.unlinkSync(snapshot);
      dbKey = `${config.prefix}/db/rivers-${startedAt.replace(/[:.]/g, "-")}.sqlite.gz.enc`;
      await s3PutFile(config, dbKey, enc, sha256);
      fs.unlinkSync(enc);
      dbBytes = bytes;
      console.log(`[backup] database snapshot uploaded (${(bytes / 1024 / 1024).toFixed(1)} MB) → ${dbKey}`);
    }

    // Documents: only what has not been copied before.
    const done = new Set((sqlite.prepare("SELECT path FROM backup_files").all() as any[]).map((r) => r.path));
    const record = sqlite.prepare(
      "INSERT OR REPLACE INTO backup_files (path, sha256, bytes, object_key, uploaded_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const key of listDocumentKeys()) {
      if (done.has(key)) continue;
      const abs = documentPath(key);
      const plainSha = sha256Hex(fs.readFileSync(abs));
      const enc = path.join(tmpDir, "doc.enc");
      const { sha256, bytes } = await encryptToFile(fs.createReadStream(abs), enc, config.key);
      const objectKey = `${config.prefix}/documents/${key}.enc`;
      await s3PutFile(config, objectKey, enc, sha256);
      fs.unlinkSync(enc);
      record.run(key, plainSha, bytes, objectKey, new Date().toISOString());
      filesUploaded += 1;
      filesBytes += bytes;
    }
    if (filesUploaded) console.log(`[backup] ${filesUploaded} document file(s) uploaded`);

    if (kind === "full") {
      try {
        await pruneOldSnapshots(config);
      } catch (e: any) {
        console.warn("[backup] prune failed:", e?.message ?? e);
      }
    }

    return finish({
      status: "ok",
      ...(dbBytes !== undefined ? { db_bytes: dbBytes, db_key: dbKey! } : {}),
      files_uploaded: filesUploaded,
      files_bytes: filesBytes,
    });
  } catch (e: any) {
    const error = String(e?.message ?? e);
    console.error("[backup] failed:", error);
    return finish({
      status: "error",
      error,
      ...(dbBytes !== undefined ? { db_bytes: dbBytes, db_key: dbKey! } : {}),
      files_uploaded: filesUploaded,
      files_bytes: filesBytes,
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function pruneOldSnapshots(cfg: BackupConfig): Promise<void> {
  const cutoff = Date.now() - cfg.keepDays * 86400 * 1000;
  const objects = await s3List(cfg, `${cfg.prefix}/db/`);
  // Never prune down to nothing, whatever the dates say.
  if (objects.length <= 3) return;
  const sorted = objects.slice().sort((a, b) => a.lastModified.localeCompare(b.lastModified));
  const keep = new Set(sorted.slice(-3).map((o) => o.key));
  for (const o of sorted) {
    if (keep.has(o.key)) continue;
    if (new Date(o.lastModified).getTime() < cutoff) {
      await s3Delete(cfg, o.key);
      console.log(`[backup] pruned ${o.key}`);
    }
  }
}

// ---- Scheduling -------------------------------------------------------------------

// 09:15 UTC = 03:15 MDT / 02:15 MST — after the nightly MLS sync, before anyone
// is at a desk.
const DAILY_HOUR_UTC = 9;
const DAILY_MINUTE_UTC = 15;

let dailyTimer: NodeJS.Timeout | null = null;
let docTimer: NodeJS.Timeout | null = null;

function msUntilNextRun(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_HOUR_UTC, DAILY_MINUTE_UTC, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startBackupCron(): void {
  if (dailyTimer) return;
  const { config, missing } = backupConfig();
  if (!config) {
    console.warn(`[backup] not scheduled — set ${missing.join(", ")} to enable offsite backups`);
    return;
  }
  const schedule = () => {
    dailyTimer = setTimeout(() => {
      runBackup("full").catch((e) => console.error("[backup] uncaught:", e));
      schedule();
    }, msUntilNextRun());
  };
  schedule();
  console.log(`[backup] scheduled daily at ${String(DAILY_HOUR_UTC).padStart(2, "0")}:${String(DAILY_MINUTE_UTC).padStart(2, "0")} UTC → ${config.endpoint}/${config.bucket}`);
}

/**
 * Copy new document files offsite soon (debounced). Called after uploads and
 * after a document completes. A no-op when backups are not configured.
 */
export function queueDocumentsBackup(delayMs = 20_000): void {
  if (!backupConfig().config) return;
  if (docTimer) clearTimeout(docTimer);
  docTimer = setTimeout(() => {
    docTimer = null;
    runBackup("documents").catch((e) => console.error("[backup] uncaught:", e));
  }, delayMs);
}

export function backupStatus() {
  const { config, missing } = backupConfig();
  const runs = recentBackupRuns(10);
  const lastOk = runs.find((r) => r.status === "ok" && r.kind === "full") ?? null;
  return {
    configured: !!config,
    missing,
    target: config ? `${config.endpoint}/${config.bucket}/${config.prefix}` : null,
    keepDays: config?.keepDays ?? null,
    documentsRoot: DOCUMENTS_ROOT,
    pendingFiles: pendingDocumentFiles(),
    running: running !== null,
    lastOk,
    runs,
  };
}
