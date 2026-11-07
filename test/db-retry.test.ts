import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { isBusyError, withBusyRetry } from "../server/db-retry";

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-retry-"));
  return path.join(dir, "t.db");
}

test("a write blocked by another connection's lock succeeds once the lock is released", async () => {
  const file = tempDbPath();
  const app = new Database(file, { timeout: 50 });
  app.pragma("journal_mode = WAL");
  app.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");

  // Stands in for Litestream: a second connection holding the write lock.
  const other = new Database(file);
  other.exec("BEGIN IMMEDIATE");
  setTimeout(() => other.exec("COMMIT"), 120);

  const write = app.transaction(() => {
    app.prepare("INSERT INTO t (id) VALUES (1)").run();
    return 1;
  });
  assert.throws(() => write(), (e) => isBusyError(e));

  const n = await withBusyRetry(() => write(), { attempts: 5, delayMs: 50, label: "test" });
  assert.equal(n, 1);
  assert.equal((app.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c, 1);
  app.close();
  other.close();
});

test("gives up after the last attempt and rethrows the busy error", async () => {
  let calls = 0;
  const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  await assert.rejects(
    withBusyRetry(() => { calls++; throw busy; }, { attempts: 3, delayMs: 1 }),
    (e) => e === busy,
  );
  assert.equal(calls, 3);
});

test("other errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(withBusyRetry(() => { calls++; throw new Error("UNIQUE constraint failed"); }, { delayMs: 1 }));
  assert.equal(calls, 1);
});
