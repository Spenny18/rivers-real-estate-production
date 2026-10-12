// Keeps the SQLite WAL from growing without bound, and watches free space on
// the database volume.
//
// On 2026-10-11 the 1 GB volume filled up and corrupted the database: the DB
// was 369 MB but its WAL had grown to 410 MB, because WAL mode only checkpoints
// on commit and never shrinks the file afterwards. A long MLS history sync
// writes far more than the default autocheckpoint can absorb. The fix:
//   - journal_size_limit: after each checkpoint the WAL is truncated back to
//     at most 64 MB instead of staying at its high-water mark;
//   - a TRUNCATE checkpoint every 10 minutes, so the WAL is folded back into
//     the database even after a burst;
//   - a disk check on the same tick, logged loudly well before the volume
//     fills (fly logs / monitoring is where this shows up).

import fs from "node:fs";
import nodePath from "node:path";
import { sqlite } from "./storage";

const WAL_LIMIT_BYTES = 64 * 1024 * 1024;
const TICK_MS = 10 * 60 * 1000;
const WARN_PCT = 80;
const CRIT_PCT = 90;

sqlite.pragma(`journal_size_limit = ${WAL_LIMIT_BYTES}`);

let timer: NodeJS.Timeout | null = null;

function dbPath(): string {
  return process.env.DB_PATH || "data.db";
}

/** Fold the WAL back into the database and truncate it. Cheap when idle. */
export function checkpointWal(): { busy: number; log: number; checkpointed: number } | null {
  try {
    const r = sqlite.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
    return r?.[0] ?? null;
  } catch (e: any) {
    console.error("[db-maintenance] checkpoint failed:", e?.message ?? e);
    return null;
  }
}

/** Percent used and bytes free on the volume holding the database. */
export function dbVolumeUsage(): { usedPct: number; freeBytes: number; totalBytes: number } | null {
  try {
    const s = fs.statfsSync(nodePath.dirname(nodePath.resolve(dbPath())));
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (!total) return null;
    return { usedPct: Math.round(((total - free) / total) * 1000) / 10, freeBytes: free, totalBytes: total };
  } catch {
    return null;
  }
}

function walBytes(): number {
  try {
    return fs.statSync(dbPath() + "-wal").size;
  } catch {
    return 0;
  }
}

function mb(n: number): string {
  return `${Math.round(n / 1024 / 1024)} MB`;
}

export function runDbMaintenance(): void {
  const before = walBytes();
  const r = checkpointWal();
  // busy=1 means a reader held the WAL open; it will be retried next tick.
  if (before > WAL_LIMIT_BYTES || r?.busy) {
    console.log(`[db-maintenance] WAL ${mb(before)} → ${mb(walBytes())}${r?.busy ? " (busy, retry next tick)" : ""}`);
  }
  const u = dbVolumeUsage();
  if (!u) return;
  const line = `${u.usedPct}% used, ${mb(u.freeBytes)} free of ${mb(u.totalBytes)}`;
  if (u.usedPct >= CRIT_PCT) {
    console.error(`[db-maintenance] DISK CRITICAL on database volume: ${line}. A full disk corrupts SQLite — free space or extend the volume now.`);
  } else if (u.usedPct >= WARN_PCT) {
    console.warn(`[db-maintenance] disk warning on database volume: ${line}.`);
  }
}

export function startDbMaintenance(): void {
  if (timer) return;
  runDbMaintenance();
  timer = setInterval(runDbMaintenance, TICK_MS);
  console.log(`[db-maintenance] WAL capped at ${mb(WAL_LIMIT_BYTES)}; checkpoint + disk check every 10 min`);
}
