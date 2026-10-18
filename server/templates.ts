// Text and email templates: reusable messages, with merge fields
// ({contact_first_name} …, server/merge-fields.ts) filled in when sent.
// Managed on /admin/templates; picked in the Inbox composer.
//
// Follow Up Boss's templates can be imported (and re-imported: updated in
// place by their FUB id). FUB writes merge fields as %contact_first_name% with
// the same names this app uses, so they convert as-is. FUB email templates
// are designed HTML; they're kept as `html` and also turned into plain text —
// wording, paragraphs and links — since the composer writes plain text.

import { sqlite } from "./storage";
import { fubConfigured, fubGetAll } from "./fub-client";
import { unknownFields } from "./merge-fields";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS message_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,              -- email | text
    name TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    html TEXT,                       -- the original design, for FUB email templates
    source TEXT NOT NULL DEFAULT 'app',
    fub_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_fub ON message_templates(kind, fub_id) WHERE fub_id IS NOT NULL;
`);

export type TemplateKind = "email" | "text";

export interface MessageTemplate {
  id: number;
  kind: TemplateKind;
  name: string;
  subject: string | null;
  body: string;
  hasHtml: boolean;
  source: "app" | "fub";
  /** Merge fields used that don't exist (they'd stop a send until fixed). */
  unknownFields: string[];
  updatedAt: string;
}

function toTemplate(r: any): MessageTemplate {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    subject: r.subject,
    body: r.body,
    hasHtml: !!r.html,
    source: r.source,
    unknownFields: unknownFields(`${r.subject ?? ""} ${r.body}`),
    updatedAt: r.updated_at,
  };
}

export function listTemplates(kind?: TemplateKind): MessageTemplate[] {
  const rows = kind
    ? sqlite.prepare(`SELECT * FROM message_templates WHERE kind = ? ORDER BY name COLLATE NOCASE`).all(kind)
    : sqlite.prepare(`SELECT * FROM message_templates ORDER BY kind, name COLLATE NOCASE`).all();
  return (rows as any[]).map(toTemplate);
}

export function getTemplate(id: number): MessageTemplate | null {
  const r = sqlite.prepare(`SELECT * FROM message_templates WHERE id = ?`).get(id);
  return r ? toTemplate(r) : null;
}

export function createTemplate(input: { kind: TemplateKind; name: string; subject?: string | null; body: string }): MessageTemplate {
  const now = new Date().toISOString();
  const r = sqlite
    .prepare(`INSERT INTO message_templates (kind, name, subject, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'app', ?, ?)`)
    .run(input.kind, input.name.trim(), input.kind === "email" ? input.subject?.trim() ?? "" : null, input.body, now, now);
  return getTemplate(Number(r.lastInsertRowid))!;
}

export function updateTemplate(id: number, patch: { name?: string; subject?: string | null; body?: string }): MessageTemplate | null {
  const t = getTemplate(id);
  if (!t) return null;
  sqlite
    .prepare(`UPDATE message_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?`)
    .run(
      patch.name?.trim() || t.name,
      t.kind === "email" ? (patch.subject !== undefined ? patch.subject?.trim() ?? "" : t.subject) : null,
      patch.body ?? t.body,
      new Date().toISOString(),
      id,
    );
  return getTemplate(id);
}

export function deleteTemplate(id: number): boolean {
  return sqlite.prepare(`DELETE FROM message_templates WHERE id = ?`).run(id).changes > 0;
}

// ---- From Follow Up Boss ------------------------------------------------------------------

/** %contact_first_name% → {contact_first_name}. */
export function fubToMergeFields(text: string): string {
  return text.replace(/%([a-z][a-z0-9_]*)%/gi, (_m, k: string) => `{${k.toLowerCase()}}`);
}

/** A designed email as plain text: paragraphs, line breaks, list items, and links as "label (url)". */
export function htmlToTemplateText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!/^https?:/i.test(href) || !label) return label;
      return label === href || label.includes(href) ? href : `${label} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
    .replace(/&mdash;|&#8212;/g, "—")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function importFubTemplates(): Promise<{ email: number; text: number; withUnknownFields: number; error?: string }> {
  if (!fubConfigured()) return { email: 0, text: 0, withUnknownFields: 0, error: "Follow Up Boss isn't connected (FUB_API_KEY)." };
  const now = new Date().toISOString();
  const upsert = sqlite.prepare(
    `INSERT INTO message_templates (kind, name, subject, body, html, source, fub_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'fub', ?, ?, ?)
     ON CONFLICT(kind, fub_id) WHERE fub_id IS NOT NULL DO UPDATE SET
       name = excluded.name, subject = excluded.subject, body = excluded.body, html = excluded.html, updated_at = excluded.updated_at`,
  );
  let email = 0;
  let text = 0;
  const emails = await fubGetAll("/templates", "templates", { maxRecords: 2000 });
  if (!emails.ok) return { email, text, withUnknownFields: 0, error: `Couldn't read Follow Up Boss's email templates (${emails.status ?? "?"}).` };
  const texts = await fubGetAll("/textMessageTemplates", "textmessagetemplates", { maxRecords: 2000 });
  sqlite.transaction(() => {
    for (const t of emails.records) {
      if (!t?.id || !t?.name) continue;
      const html = String(t.body ?? "");
      upsert.run("email", String(t.name), fubToMergeFields(String(t.subject ?? "")), fubToMergeFields(htmlToTemplateText(html)), fubToMergeFields(html), String(t.id), now, now);
      email++;
    }
    for (const t of texts.ok ? texts.records : []) {
      if (!t?.id || !t?.name) continue;
      upsert.run("text", String(t.name), null, fubToMergeFields(String(t.message ?? t.body ?? "")), null, String(t.id), now, now);
      text++;
    }
  })();
  const withUnknownFields = listTemplates().filter((t) => t.source === "fub" && t.unknownFields.length).length;
  return { email, text, withUnknownFields, ...(texts.ok ? {} : { error: "Text templates couldn't be read; email templates were imported." }) };
}
