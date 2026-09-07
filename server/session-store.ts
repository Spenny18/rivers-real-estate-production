// SQLite-backed express-session store.
//
// express-session's default store keeps sessions in process memory. That is
// fine until the process restarts — and on Fly every deploy restarts it, so
// the admin was being signed out several times an afternoon, losing whatever
// was unsaved in the page editor at the time. The bearer tokens in routes.ts
// had the same problem for the same reason.
//
// Sessions live in the same SQLite file as everything else, on the mounted
// volume, so they survive a deploy. There is no external dependency here on
// purpose: the store interface is four methods, and the alternative was
// another package in the tree to do what a prepared statement already does.

import session from "express-session";
import { sqlite } from "./storage";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // matches the cookie maxAge

/** When does this session expire? Prefer the cookie's own answer. */
function expiryOf(sess: session.SessionData): number {
  const c: any = sess?.cookie;
  if (c?.expires) {
    const t = new Date(c.expires).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof c?.maxAge === "number") return Date.now() + c.maxAge;
  return Date.now() + DEFAULT_TTL_MS;
}

export class SqliteSessionStore extends session.Store {
  private readonly getStmt = sqlite.prepare(
    "SELECT data, expires_at FROM admin_sessions WHERE sid = ?",
  );
  private readonly setStmt = sqlite.prepare(
    `INSERT INTO admin_sessions (sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
  );
  private readonly touchStmt = sqlite.prepare(
    "UPDATE admin_sessions SET expires_at = ? WHERE sid = ?",
  );
  private readonly delStmt = sqlite.prepare("DELETE FROM admin_sessions WHERE sid = ?");
  private readonly pruneStmt = sqlite.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?");
  private timer?: NodeJS.Timeout;

  constructor(opts: { pruneIntervalMs?: number } = {}) {
    super();
    this.prune();
    const every = opts.pruneIntervalMs ?? 60 * 60 * 1000;
    // unref so a pending prune never holds the process open.
    this.timer = setInterval(() => this.prune(), every);
    this.timer.unref?.();
  }

  /** Drop expired rows. Cheap, and keeps the table from growing without end. */
  prune(): void {
    try {
      this.pruneStmt.run(new Date().toISOString());
    } catch (e: any) {
      console.error("[session-store] prune failed:", e?.message ?? e);
    }
  }

  get(
    sid: string,
    cb: (err: any, session?: session.SessionData | null) => void,
  ): void {
    try {
      const row = this.getStmt.get(sid) as { data: string; expires_at: string } | undefined;
      if (!row) return cb(null, null);
      // An expired row is "no session" — and delete it while we are here, so
      // a stale cookie stops costing a read on every request.
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        this.delStmt.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data) as session.SessionData);
    } catch (e) {
      // A row that will not parse is corrupt, not fatal: treat it as absent
      // so the user simply logs in again rather than meeting a 500.
      console.error("[session-store] get failed:", (e as any)?.message ?? e);
      cb(null, null);
    }
  }

  set(sid: string, sess: session.SessionData, cb?: (err?: any) => void): void {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), new Date(expiryOf(sess)).toISOString());
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  /** Called on every request for an active session; only the expiry moves. */
  touch(sid: string, sess: session.SessionData, cb?: (err?: any) => void): void {
    try {
      this.touchStmt.run(new Date(expiryOf(sess)).toISOString(), sid);
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  destroy(sid: string, cb?: (err?: any) => void): void {
    try {
      this.delStmt.run(sid);
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  length(cb: (err: any, length?: number) => void): void {
    try {
      const r = sqlite.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get() as { n: number };
      cb(null, r.n);
    } catch (e) {
      cb(e);
    }
  }

  clear(cb?: (err?: any) => void): void {
    try {
      sqlite.prepare("DELETE FROM admin_sessions").run();
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }
}

/**
 * A session secret that survives a restart.
 *
 * SESSION_SECRET from the environment always wins — a Fly secret is the right
 * home for this, and it is the only version that stays stable if the volume is
 * ever rebuilt. But when it is absent the previous behaviour was to generate a
 * fresh random secret per process, which invalidates every cookie on restart:
 * that alone would have undone the persistent store above. Persisting a
 * generated one keeps the fix working on a deploy that has not had the secret
 * set yet, without ever shipping a hardcoded fallback.
 */
export function persistentSessionSecret(generate: () => string): {
  secret: string;
  source: "env" | "stored" | "generated";
} {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return { secret: fromEnv, source: "env" };
  try {
    const row = sqlite
      .prepare("SELECT value FROM app_secrets WHERE key = 'session_secret'")
      .get() as { value: string } | undefined;
    if (row?.value) return { secret: row.value, source: "stored" };
    const fresh = generate();
    sqlite
      .prepare("INSERT INTO app_secrets (key, value, created_at) VALUES (?, ?, ?)")
      .run("session_secret", fresh, new Date().toISOString());
    return { secret: fresh, source: "generated" };
  } catch (e) {
    console.error("[session-store] could not persist a session secret:", (e as any)?.message ?? e);
    return { secret: generate(), source: "generated" };
  }
}
