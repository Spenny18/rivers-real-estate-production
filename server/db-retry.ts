// Retries a database write that lost the write lock to another process.
//
// The app is the only writer in its own process, but Litestream (a separate
// process, server/litestream.ts) takes the write lock to checkpoint the WAL.
// After a big MLS sync page that checkpoint can hold the lock longer than the
// 5-second busy timeout, and the write fails with SQLITE_BUSY ("database is
// locked"). That used to end the whole sync run. Waiting here is async, so the
// site keeps serving while the checkpoint finishes — unlike a longer
// busy_timeout, which would block the event loop for every request.

export function isBusyError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
  return /database is locked/i.test(String((e as { message?: unknown } | null)?.message ?? ""));
}

export async function withBusyRetry<T>(
  fn: () => T,
  opts: { attempts?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 5);
  const delayMs = opts.delayMs ?? 2_000;
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e) || i >= attempts) throw e;
      const wait = delayMs * i;
      console.warn(`[db] ${opts.label ?? "write"}: database is locked, retry ${i}/${attempts - 1} in ${Math.round(wait / 1000)} s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
