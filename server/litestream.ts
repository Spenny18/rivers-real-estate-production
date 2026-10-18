// Continuous backup: runs Litestream (litestream.yml) beside the server so
// every database change reaches R2 within seconds, instead of only the daily
// backup. If this server's machine or disk is lost, the database can be
// restored on a new machine to within seconds (script/litestream-restore.sh).
//
// Started from here, after the database is open, rather than wrapping the
// server: storage.ts swaps in a `.restore` file at boot, and Litestream must
// only start watching the database that's actually in use. And if Litestream
// fails, only the continuous copy pauses — the site keeps serving. It's
// restarted with a growing delay if it exits.
//
// Only runs in production with the backup bucket configured; LITESTREAM=off
// turns it off.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { sqlite } from "./storage";
import { backupConfig, s3List } from "./backup-s3";

const BINARY = "/usr/bin/litestream";
const CONFIG = "/etc/litestream.yml";

let child: ChildProcess | null = null;
let restarts = 0;
let startedAt: string | null = null;
let lastExit: { at: string; code: number | null; signal: string | null } | null = null;
let stopping = false;

export function litestreamEnabled(): { ok: boolean; reason?: string } {
  if (process.env.LITESTREAM === "off") return { ok: false, reason: "LITESTREAM=off" };
  if (process.env.NODE_ENV !== "production") return { ok: false, reason: "not production" };
  if (!backupConfig().config) return { ok: false, reason: "backup bucket not configured" };
  if (!fs.existsSync(BINARY) || !fs.existsSync(CONFIG)) return { ok: false, reason: "litestream not installed in this image" };
  return { ok: true };
}

function launch() {
  const cfg = backupConfig().config!;
  child = spawn(BINARY, ["replicate", "-config", CONFIG], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, LITESTREAM_PREFIX: cfg.prefix },
  });
  startedAt = new Date().toISOString();
  child.on("exit", (code, signal) => {
    lastExit = { at: new Date().toISOString(), code, signal };
    child = null;
    if (stopping) return;
    restarts += 1;
    // 10 s, 20 s, 40 s … capped at 10 minutes.
    const delay = Math.min(10_000 * 2 ** Math.min(restarts - 1, 6), 10 * 60_000);
    console.error(`[litestream] exited (code ${code}, signal ${signal}); restarting in ${Math.round(delay / 1000)} s`);
    setTimeout(launch, delay).unref();
  });
}

export function startLitestream() {
  const on = litestreamEnabled();
  if (!on.ok) {
    console.log(`[litestream] not started — ${on.reason}`);
    return;
  }
  // Litestream does the checkpointing: an automatic checkpoint from the app
  // between Litestream's own can make it miss a change and fall back to a full
  // snapshot (litestream.io/tips). The 10-minute TRUNCATE checkpoint in
  // db-maintenance.ts still runs, so the WAL can't grow unbounded if
  // Litestream stops.
  sqlite.pragma("wal_autocheckpoint = 0");
  launch();
  console.log("[litestream] continuous backup started");
  // On shutdown, let Litestream push the last few seconds of changes, then
  // exit. A listener here replaces Node's default exit-on-signal, so this has
  // to exit itself — within Fly's 5-second kill timeout.
  const stop = (signal: NodeJS.Signals) => {
    stopping = true;
    const done = () => process.exit(signal === "SIGINT" ? 130 : 0);
    if (!child) return done();
    child.once("exit", done);
    child.kill("SIGTERM");
    setTimeout(done, 4_000).unref();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

export function litestreamProcess() {
  return { running: !!child, startedAt, restarts, lastExit };
}

/**
 * How recently Litestream wrote to R2, from the newest file under its folder.
 * Cached for five minutes so the public health endpoint can't be used to run
 * up R2 requests.
 */
let freshnessCache: { at: number; value: { newest: string | null; ageMinutes: number | null; error?: string } } | null = null;

export async function litestreamFreshness() {
  if (freshnessCache && Date.now() - freshnessCache.at < 5 * 60_000) return freshnessCache.value;
  const cfg = backupConfig().config;
  let value: { newest: string | null; ageMinutes: number | null; error?: string };
  if (!cfg) value = { newest: null, ageMinutes: null, error: "backup bucket not configured" };
  else {
    try {
      const objects = await s3List(cfg, `${cfg.prefix}/litestream/`);
      const newest = objects.map((o) => o.lastModified).sort().pop() ?? null;
      value = { newest, ageMinutes: newest ? Math.round((Date.now() - Date.parse(newest)) / 60_000) : null };
    } catch (e: any) {
      value = { newest: null, ageMinutes: null, error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  freshnessCache = { at: Date.now(), value };
  return value;
}
