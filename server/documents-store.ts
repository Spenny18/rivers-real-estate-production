// Where contracts and signatures live on disk.
//
// Deliberately NOT under UPLOADS_ROOT: everything under /uploads is served
// by express.static with no authentication, and a signed purchase contract
// must never be one guessable URL away. Files here are only ever read back
// by server/deal-routes.ts, which checks the admin session or the signer's
// token first.
//
// Layout (relative to DOCUMENTS_ROOT):
//   deals/<dealId>/<documentId>/original.pdf     as uploaded, never modified
//   deals/<dealId>/<documentId>/signed.pdf       stamped + certificate
//   deals/<dealId>/<documentId>/sig-<signerId>.png
//   deals/<dealId>/<documentId>/ini-<signerId>.png
//
// Nothing is rewritten in place; the backup job (server/backup.ts) relies on
// that to copy each file offsite exactly once.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const DOCUMENTS_ROOT =
  process.env.DOCUMENTS_ROOT ||
  (process.env.NODE_ENV === "production"
    ? "/data/documents"
    : path.resolve(process.cwd(), "data/documents"));

export function ensureDocumentsRoot(): void {
  if (!fs.existsSync(DOCUMENTS_ROOT)) fs.mkdirSync(DOCUMENTS_ROOT, { recursive: true });
}

/** Absolute path for a storage key; refuses anything that escapes the root. */
export function documentPath(key: string): string {
  const abs = path.resolve(DOCUMENTS_ROOT, key);
  const root = path.resolve(DOCUMENTS_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Refusing document path outside root: ${key}`);
  }
  return abs;
}

export function writeDocument(key: string, bytes: Buffer | Uint8Array): string {
  const abs = documentPath(key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Write to a sibling temp file and rename so a crash mid-write never
  // leaves a truncated PDF under the real name.
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, abs);
  return abs;
}

export function readDocument(key: string): Buffer {
  return fs.readFileSync(documentPath(key));
}

export function documentExists(key: string): boolean {
  try {
    return fs.statSync(documentPath(key)).size > 0;
  } catch {
    return false;
  }
}

export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function documentKey(dealId: number, documentId: number, file: string): string {
  return path.posix.join("deals", String(dealId), String(documentId), file);
}

/** Every file under the root, as keys relative to it. */
export function listDocumentKeys(): string[] {
  ensureDocumentsRoot();
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
        out.push(path.relative(DOCUMENTS_ROOT, abs).split(path.sep).join("/"));
      }
    }
  };
  walk(DOCUMENTS_ROOT);
  return out;
}
