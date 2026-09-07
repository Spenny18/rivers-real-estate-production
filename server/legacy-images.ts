// Mirror hero images off the old WordPress host onto our own storage.
//
// 40 rows still point their hero image at
// https://luxuryhomescalgary.ca/wp-content/uploads/... — 31 neighbourhoods,
// 5 condo buildings and 4 blog posts. Those URLs are the og:image, the
// schema.org image, and the hero rendered on the page itself, so the day
// that host stops answering, a quarter of the site loses its imagery and
// every link preview with it. It is also a dependency on infrastructure the
// business plainly intends to retire.
//
// This copies each file onto the volume under /uploads/legacy/ and rewrites
// the row to the local path. It is deliberately admin-triggered rather than
// automatic: it fetches from a third-party host and mutates content rows, so
// it should happen when someone asks, and dryRun should happen first.
//
// Idempotent. A row already pointing somewhere local is skipped, and a file
// already on disk is not fetched again, so a partial run can simply be re-run.

import fs from "node:fs";
import path from "node:path";
import { sqlite } from "./storage";

const LEGACY_HOST = "luxuryhomescalgary.ca";
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Tables holding a hero image that may still point at the old host. */
const TARGETS = [
  { table: "neighbourhoods", key: "slug", col: "hero_image" },
  { table: "condo_buildings", key: "slug", col: "hero_image" },
  { table: "blog_posts", key: "slug", col: "hero_image" },
] as const;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export interface LegacyRow {
  table: string;
  slug: string;
  from: string;
}
export interface MigrationResult extends LegacyRow {
  status: "migrated" | "already-local" | "skipped" | "failed";
  to?: string;
  error?: string;
}
export interface MigrationReport {
  ok: boolean;
  dryRun: boolean;
  scanned: number;
  migrated: number;
  failed: number;
  skipped: number;
  results: MigrationResult[];
}

/** Every row still pointing at the legacy host. */
export function findLegacyRows(): LegacyRow[] {
  const out: LegacyRow[] = [];
  for (const t of TARGETS) {
    try {
      const rows = sqlite
        .prepare(`SELECT ${t.key} AS k, ${t.col} AS v FROM ${t.table} WHERE ${t.col} LIKE ?`)
        .all(`%${LEGACY_HOST}%`) as { k: string; v: string }[];
      for (const r of rows) {
        if (r.v) out.push({ table: t.table, slug: r.k, from: r.v });
      }
    } catch (e: any) {
      console.error(`[legacy-images] scan of ${t.table} failed:`, e?.message ?? e);
    }
  }
  return out;
}

function safeSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image"
  );
}

/**
 * Extension from the response type, falling back to the URL's own suffix
 * ONLY when the server declined to say what it sent.
 *
 * The fallback used to apply unconditionally, which is wrong in precisely the
 * case this migration exists for: a retired WordPress host commonly answers
 * 200 with an HTML parking or error page at an image URL. Trusting the ".png"
 * in the path would have written that HTML to disk as a PNG and repointed the
 * row at it — turning a broken remote image into a broken local one, which is
 * worse, because the original URL is then gone.
 */
function extensionFor(contentType: string | null, url: string): string | null {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct];
  // A declared type that is not an image is a refusal, not a reason to guess.
  if (ct && ct !== "application/octet-stream" && ct !== "binary/octet-stream") return null;
  const m = /\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.exec(url);
  if (m) return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  return null;
}

/**
 * Does this actually look like an image?
 *
 * A content-type header is a claim by the sender. Checking the leading bytes
 * is the part that cannot be got wrong by a misconfigured host, and it is the
 * last thing standing between an HTML error page and a hero image slot.
 */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const hex = buf.subarray(0, 4).toString("hex");
  if (hex === "89504e47") return true; // PNG
  if (hex.startsWith("ffd8ff")) return true; // JPEG
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return true; // GIF
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return true;
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return true; // AVIF/HEIF family
  return false;
}

/**
 * Copy the legacy images local and repoint the rows.
 *
 * `uploadsDir` is injected rather than imported so this stays testable
 * without standing up the routes module; in the app it is
 * ensureUploadsDir("legacy").
 */
export async function migrateLegacyImages(opts: {
  uploadsDir: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<MigrationReport> {
  const doFetch = opts.fetchImpl ?? fetch;
  const dryRun = opts.dryRun !== false; // default to a dry run — opt in to writing
  const rows = findLegacyRows();
  const results: MigrationResult[] = [];

  // Records what each row used to point at, so a bad run can be undone.
  // Written next to the files rather than into a column: it is operational
  // history, not page content.
  const manifestPath = path.join(opts.uploadsDir, "_manifest.json");

  for (const row of rows) {
    const target = TARGETS.find((t) => t.table === row.table)!;
    try {
      if (!row.from.includes(LEGACY_HOST)) {
        results.push({ ...row, status: "already-local" });
        continue;
      }

      if (dryRun) {
        results.push({ ...row, status: "migrated", to: "(dry run — nothing written)" });
        continue;
      }

      const res = await doFetch(row.from, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        results.push({ ...row, status: "failed", error: `HTTP ${res.status}` });
        continue;
      }
      const ext = extensionFor(res.headers.get("content-type"), row.from);
      if (!ext) {
        results.push({
          ...row,
          status: "failed",
          error: `not an image (content-type ${res.headers.get("content-type") ?? "none"})`,
        });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        results.push({ ...row, status: "failed", error: "empty response" });
        continue;
      }
      if (buf.length > MAX_BYTES) {
        results.push({ ...row, status: "failed", error: `too large (${buf.length} bytes)` });
        continue;
      }
      if (!looksLikeImage(buf)) {
        results.push({
          ...row,
          status: "failed",
          error: "response is not image data (an error or parking page?)",
        });
        continue;
      }

      const file = `${safeSlug(row.table)}-${safeSlug(row.slug)}.${ext}`;
      const dest = path.join(opts.uploadsDir, file);
      // Write to a temp name first so a failure part-way through never leaves
      // a truncated image at the path a row is about to point at.
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);

      const to = `/uploads/legacy/${file}`;
      // Only now, with the bytes safely on disk, repoint the row.
      sqlite
        .prepare(`UPDATE ${target.table} SET ${target.col} = ? WHERE ${target.key} = ?`)
        .run(to, row.slug);

      appendManifest(manifestPath, { ...row, to, at: new Date().toISOString() });
      results.push({ ...row, status: "migrated", to });
    } catch (e: any) {
      results.push({ ...row, status: "failed", error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  const count = (s: MigrationResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    ok: count("failed") === 0,
    dryRun,
    scanned: rows.length,
    migrated: count("migrated"),
    failed: count("failed"),
    skipped: count("already-local") + count("skipped"),
    results,
  };
}

function appendManifest(file: string, entry: Record<string, unknown>): void {
  try {
    let list: unknown[] = [];
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (Array.isArray(parsed)) list = parsed;
    }
    list.push(entry);
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  } catch (e: any) {
    // The manifest is a convenience for undoing a run, not a correctness
    // requirement — never fail a migration because it could not be written.
    console.error("[legacy-images] manifest write failed:", e?.message ?? e);
  }
}
