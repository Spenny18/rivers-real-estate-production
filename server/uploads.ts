// Where admin-uploaded and server-generated files live.
//
// In production this is the persistent volume mounted at /data, so files
// survive redeploys. In development it falls back to a folder under
// client/public/ so the dev server can serve them too. Everything under it is
// served at /uploads/... by routes.ts.

import fs from "node:fs";
import path from "node:path";

export const UPLOADS_ROOT =
  process.env.UPLOADS_ROOT ||
  (process.env.NODE_ENV === "production" ? "/data/uploads" : path.resolve(process.cwd(), "client/public/uploads"));

export function ensureUploadsDir(sub: string): string {
  const dir = path.join(UPLOADS_ROOT, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
