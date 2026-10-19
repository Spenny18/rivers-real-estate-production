// Files attached to an email Spencer is writing (Inbox and CRM composers).
//
// The composer uploads each file as soon as it's picked
// (POST /api/admin/email-attachments, raw bytes) and gets an id back; the
// send then names those ids. Uploads are held in memory only, never on the
// data volume (it's small, and filled up once: see the Oct 2026 incident),
// and dropped after a couple of hours or once sent.
//
// Gmail caps a message at 25 MB of attachments, so that's the limit here too.

import { randomBytes } from "node:crypto";

export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const TTL_MS = 2 * 3600_000;
/** All pending uploads together; well under the machine's memory. */
const MAX_HELD_BYTES = 200 * 1024 * 1024;

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  data: Buffer;
  at: number;
}

const held = new Map<string, Attachment>();

function sweep(now = Date.now()) {
  for (const [id, a] of Array.from(held)) if (now - a.at > TTL_MS) held.delete(id);
}

/** A filename safe for a MIME header: no path, no quotes or line breaks. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\x00-\x1f"\\]/g, "").trim().slice(0, 180);
  return clean || "attachment";
}

export function holdAttachment(filename: string, contentType: string, data: Buffer): { id: string } | { error: string } {
  sweep();
  if (!data.length) return { error: "That file is empty." };
  if (data.length > MAX_TOTAL_BYTES) return { error: "That file is over Gmail's 25 MB limit." };
  const total = Array.from(held.values()).reduce((n, a) => n + a.data.length, 0);
  if (total + data.length > MAX_HELD_BYTES) return { error: "Too many files waiting to be sent. Send or remove some first." };
  const id = randomBytes(12).toString("hex");
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType : "application/octet-stream";
  held.set(id, { id, filename: cleanFilename(filename), contentType: type, data, at: Date.now() });
  return { id };
}

/** The uploads for a send, or what's wrong (gone after a restart, too big together). */
export function takeAttachments(ids: unknown): { files: Attachment[] } | { error: string } {
  sweep();
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  const files: Attachment[] = [];
  for (const id of list) {
    const a = held.get(id);
    if (!a) return { error: "An attachment expired or the app restarted. Remove it and attach it again." };
    files.push(a);
  }
  if (files.reduce((n, a) => n + a.data.length, 0) > MAX_TOTAL_BYTES) return { error: "The attachments add up to more than Gmail's 25 MB limit." };
  return { files };
}

export function releaseAttachments(files: Attachment[]) {
  for (const f of files) held.delete(f.id);
}

export function dropAttachment(id: string): boolean {
  return held.delete(id);
}
