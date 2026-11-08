// Contact tags, kept by the app, as Follow Up Boss does them: free-form labels
// on a contact, added and removed one contact at a time or in bulk across a
// smart list, renamed or deleted everywhere at once, and filtered on by smart
// lists.
//
// Where a tag lives. A contact's tags are the union of two stores:
//   - crm_contacts.tags: Follow Up Boss's tags, mirrored by the sync (and the
//     tags a contact created in the app started with);
//   - contact_tags: tags added in the app (automations.ts).
// Everything new goes into contact_tags, which the FUB sync never touches, so
// tags keep working once FUB is gone. Removing or renaming a tag that came
// from FUB rewrites crm_contacts.tags through contact-edits.ts, which records
// the edit so the sync can't put the old tag back while FUB still runs.
//
// Adding a tag goes through automations.addTag, so "tag added" automations
// fire as they would for a single contact.
//
// Tags compare case-insensitively ("buyer" and "Buyer" are one tag); the
// spelling first used is kept.

import { sqlite, storage } from "./storage";
import { addTag, allTags } from "./automations";
import { editContact } from "./contact-edits";

export const MAX_TAG_LENGTH = 60;

export function cleanTag(t: unknown): string {
  return String(t ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TAG_LENGTH);
}

function fubTags(contactId: string): string[] {
  try {
    const t = JSON.parse(storage.getCrmContact(contactId)?.tags ?? "[]");
    return Array.isArray(t) ? t.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/** A contact's tags, both stores, in a stable order. */
export function contactTags(contactId: string): string[] {
  return allTags(contactId).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** Every tag in use, with how many contacts have it, most used first. */
export function listTags(): Array<{ tag: string; count: number }> {
  return sqlite
    .prepare(
      `SELECT MIN(value) AS tag, COUNT(DISTINCT cid) AS count FROM (
         SELECT trim(j.value) AS value, c.fub_id AS cid FROM crm_contacts c, json_each(CASE WHEN json_valid(c.tags) THEN c.tags ELSE '[]' END) j
         UNION ALL SELECT trim(tag), contact_fub_id FROM contact_tags
       ) WHERE value != '' GROUP BY lower(value) ORDER BY count DESC, lower(value)`,
    )
    .all() as Array<{ tag: string; count: number }>;
}

/** The spelling a tag already has somewhere, so a new "buyer" joins "Buyer". */
function canonical(tag: string): string {
  const hit = listTags().find((t) => t.tag.toLowerCase() === tag.toLowerCase());
  return hit?.tag ?? tag;
}

/** Add tags to contacts. Returns how many contact-tag pairs were new. */
export function tagContacts(contactIds: string[], tags: string[]): number {
  const wanted = Array.from(new Set(tags.map(cleanTag).filter(Boolean))).map(canonical);
  let added = 0;
  // One transaction: a list of a few thousand saves in one commit.
  sqlite.transaction(() => {
    for (const id of Array.from(new Set(contactIds))) {
      if (!storage.getCrmContact(id)) continue;
      const have = new Set(allTags(id).map((t) => t.toLowerCase()));
      for (const t of wanted) {
        if (have.has(t.toLowerCase())) continue;
        addTag(id, t);
        have.add(t.toLowerCase());
        added++;
      }
    }
  })();
  return added;
}

/** Take tags off contacts, from both stores. Returns how many pairs were removed. */
export function untagContacts(contactIds: string[], tags: string[]): number {
  const drop = new Set(tags.map(cleanTag).filter(Boolean).map((t) => t.toLowerCase()));
  if (drop.size === 0) return 0;
  const delApp = sqlite.prepare(`DELETE FROM contact_tags WHERE contact_fub_id = ? AND lower(trim(tag)) = ?`);
  let removed = 0;
  sqlite.transaction(() => {
    for (const id of Array.from(new Set(contactIds))) {
      if (!storage.getCrmContact(id)) continue;
      const before = new Set(allTags(id).map((t) => t.toLowerCase()));
      for (const t of Array.from(drop)) delApp.run(id, t);
      const fub = fubTags(id);
      const kept = fub.filter((t) => !drop.has(t.trim().toLowerCase()));
      if (kept.length !== fub.length) editContact(id, { tags: kept }, { push: false });
      const after = new Set(allTags(id).map((t) => t.toLowerCase()));
      removed += Array.from(before).filter((t) => !after.has(t)).length;
    }
  })();
  return removed;
}

/** Contacts that have a tag, in either store. */
function contactsWithTag(tag: string): string[] {
  const t = tag.toLowerCase();
  return (
    sqlite
      .prepare(
        `SELECT DISTINCT cid FROM (
           SELECT c.fub_id AS cid, lower(trim(j.value)) AS v FROM crm_contacts c, json_each(CASE WHEN json_valid(c.tags) THEN c.tags ELSE '[]' END) j
           UNION ALL SELECT contact_fub_id, lower(trim(tag)) FROM contact_tags
         ) WHERE v = ?`,
      )
      .all(t) as Array<{ cid: string }>
  ).map((r) => r.cid);
}

/**
 * Rename a tag on every contact that has it. Renaming onto an existing tag
 * merges the two. Doesn't fire "tag added" automations: nothing new was
 * tagged. Returns how many contacts changed.
 */
export function renameTag(from: string, to: string): number {
  const f = cleanTag(from);
  const t = cleanTag(to);
  if (!f || !t || f === t) return 0;
  const target = f.toLowerCase() === t.toLowerCase() ? t : canonical(t);
  const ids = contactsWithTag(f);
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    for (const id of ids) {
      const appRows = sqlite
        .prepare(`SELECT tag FROM contact_tags WHERE contact_fub_id = ? AND lower(trim(tag)) = ?`)
        .all(id, f.toLowerCase()) as Array<{ tag: string }>;
      if (appRows.length) {
        sqlite.prepare(`DELETE FROM contact_tags WHERE contact_fub_id = ? AND lower(trim(tag)) = ?`).run(id, f.toLowerCase());
        sqlite.prepare(`INSERT OR IGNORE INTO contact_tags (contact_fub_id, tag, created_at) VALUES (?, ?, ?)`).run(id, target, now);
      }
      const fub = fubTags(id);
      if (fub.some((x) => x.trim().toLowerCase() === f.toLowerCase())) {
        const next: string[] = [];
        for (const x of fub) {
          const v = x.trim().toLowerCase() === f.toLowerCase() ? target : x;
          if (!next.some((n) => n.toLowerCase() === v.toLowerCase())) next.push(v);
        }
        editContact(id, { tags: next }, { push: false });
      }
    }
    // A contact with the tag in both stores now has it twice; keep one.
    for (const id of ids) {
      if (fubTags(id).some((x) => x.toLowerCase() === target.toLowerCase())) {
        sqlite.prepare(`DELETE FROM contact_tags WHERE contact_fub_id = ? AND lower(trim(tag)) = ?`).run(id, target.toLowerCase());
      }
    }
  });
  tx();
  return ids.length;
}

/** Remove a tag from every contact. Returns how many contacts had it. */
export function deleteTag(tag: string): number {
  const ids = contactsWithTag(cleanTag(tag));
  untagContacts(ids, [tag]);
  return ids.length;
}
