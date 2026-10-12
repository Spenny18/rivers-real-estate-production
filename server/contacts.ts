// Contacts the app owns, so new leads don't depend on Follow Up Boss.
//
// crm_contacts began as a mirror of FUB people, keyed by FUB's id, and
// everything downstream — the inbox, showings, tracking, deals — hangs off
// that key. Native contacts live in the same table with an "app-" id, so all
// of it works for them unchanged, and the FUB sync (which only ever writes
// rows by FUB id) can't overwrite them.
//
// Where they come from:
//   - every new lead (any website form, a booking, a portal sign-up): matched
//     to an existing contact by email, then phone; otherwise a contact is
//     created. Hooked into storage.createLead so a new lead source is covered
//     without remembering to call anything.
//   - by hand, from the CRM.
//
// While FUB is still running, a lead is also pushed there, and its person
// comes back on the next sync with a FUB id. reconcileNativeContacts() then
// folds the app's copy into FUB's — moving its texts, emails, showings,
// tracking and deals across — so there's one contact, not two. Once FUB is
// switched off nothing comes back, and the app's contact is simply the contact.

import { randomBytes } from "node:crypto";
import { sqlite, storage } from "./storage";
import type { Lead } from "@shared/schema";

export const NATIVE_PREFIX = "app-";

export function isNativeContact(fubId: string): boolean {
  return fubId.startsWith(NATIVE_PREFIX);
}

function cleanEmail(v: string | null | undefined): string | null {
  const e = (v ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

function last10(v: string | null | undefined): string | null {
  const d = (v ?? "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? d : null;
}

function splitName(name: string): { first: string | null; last: string | null } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

/** An existing contact with this email, or failing that this phone number. Prefers FUB's copy. */
export function findContact(email: string | null | undefined, phone: string | null | undefined): string | null {
  const e = cleanEmail(email);
  if (e) {
    const rows = sqlite.prepare(`SELECT fub_id AS id FROM crm_contacts WHERE lower(trim(email)) = ?`).all(e) as Array<{ id: string }>;
    const pick = rows.find((r) => !isNativeContact(r.id)) ?? rows[0];
    if (pick) return pick.id;
  }
  const p = last10(phone);
  if (p) {
    const rows = sqlite
      .prepare(`SELECT fub_id AS id, phone FROM crm_contacts WHERE phone IS NOT NULL AND phone != ''`)
      .all() as Array<{ id: string; phone: string }>;
    const matches = rows.filter((r) => last10(r.phone) === p);
    const pick = matches.find((r) => !isNativeContact(r.id)) ?? matches[0];
    if (pick) return pick.id;
  }
  return null;
}

export interface NewContact {
  name: string;
  email?: string | null;
  phone?: string | null;
  stage?: string | null;
  source?: string | null;
  tags?: string[];
  assignedTo?: string | null;
}

export function createNativeContact(input: NewContact) {
  const id = `${NATIVE_PREFIX}${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  const { first, last } = splitName(input.name);
  storage.upsertCrmContacts([
    {
      fubId: id,
      name: input.name.trim(),
      firstName: first,
      lastName: last,
      email: cleanEmail(input.email) ?? (input.email?.trim() || null),
      phone: input.phone?.trim() || null,
      stage: input.stage?.trim() || "Lead",
      source: input.source?.trim() || null,
      assignedTo: input.assignedTo ?? null,
      tags: JSON.stringify(Array.from(new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean)))),
      // The FUB-named timestamp columns are what every list sorts on.
      fubCreatedAt: now,
      fubUpdatedAt: now,
      lastActivityAt: now,
      raw: JSON.stringify({ origin: "app" }),
      syncedAt: now,
    },
  ]);
  return storage.getCrmContact(id)!;
}

/** Edit a contact the app owns. FUB's are read-only here: the next sync would undo the change. */
export function updateNativeContact(id: string, patch: Partial<NewContact>) {
  const existing = storage.getCrmContact(id);
  if (!existing || !isNativeContact(id)) return null;
  const name = patch.name?.trim() || existing.name || "";
  const { first, last } = splitName(name);
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `UPDATE crm_contacts SET name = ?, first_name = ?, last_name = ?, email = ?, phone = ?, stage = ?, source = ?,
         tags = ?, fub_updated_at = ?, synced_at = ? WHERE fub_id = ?`,
    )
    .run(
      name,
      first,
      last,
      patch.email !== undefined ? cleanEmail(patch.email) ?? (patch.email?.trim() || null) : existing.email,
      patch.phone !== undefined ? patch.phone?.trim() || null : existing.phone,
      patch.stage !== undefined ? patch.stage?.trim() || "Lead" : existing.stage,
      patch.source !== undefined ? patch.source?.trim() || null : existing.source,
      patch.tags !== undefined ? JSON.stringify(Array.from(new Set(patch.tags.map((t) => t.trim()).filter(Boolean)))) : existing.tags,
      now,
      now,
      id,
    );
  return storage.getCrmContact(id)!;
}

/**
 * A lead just arrived: make sure there's a contact for it. Returns the
 * contact's id and whether it was new. Fills in a native contact's missing
 * phone or name from the lead; FUB's contacts are left to FUB.
 */
export function ensureContactForLead(lead: Pick<Lead, "name" | "email" | "phone" | "source">): { id: string; created: boolean } | null {
  if (!cleanEmail(lead.email) && !last10(lead.phone)) return null;
  const existing = findContact(lead.email, lead.phone);
  if (existing) {
    if (isNativeContact(existing)) {
      const c = storage.getCrmContact(existing)!;
      if ((!c.phone && lead.phone) || (!c.name && lead.name)) {
        updateNativeContact(existing, { phone: c.phone || lead.phone, name: c.name || lead.name });
      }
      sqlite.prepare(`UPDATE crm_contacts SET last_activity_at = ?, fub_updated_at = ? WHERE fub_id = ?`).run(new Date().toISOString(), new Date().toISOString(), existing);
    }
    return { id: existing, created: false };
  }
  const c = createNativeContact({
    name: lead.name?.trim() || cleanEmail(lead.email) || lead.phone || "New lead",
    email: lead.email,
    phone: lead.phone,
    stage: "Lead",
    source: lead.source ? `Website · ${lead.source}` : "Website",
  });
  return { id: c.fubId, created: true };
}

// ---- Folding the app's copy into FUB's -------------------------------------------------

/** Every column outside crm_contacts that names a contact. */
const CONTACT_REFERENCES: Array<[table: string, column: string]> = [
  ["crm_activities", "contact_fub_id"],
  ["crm_deals", "contact_fub_id"],
  ["tours", "contact_fub_id"],
  ["deals", "crm_contact_fub_id"],
  ["inbox_emails", "contact_fub_id"],
  ["tracked_emails", "contact_fub_id"],
  ["sms_messages", "contact_fub_id"],
];

function tableExists(name: string): boolean {
  return !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/** Move everything from one contact to another, then remove the first. */
export function mergeContactInto(fromId: string, toId: string) {
  if (fromId === toId) return;
  const tx = sqlite.transaction(() => {
    for (const [table, column] of CONTACT_REFERENCES) {
      if (tableExists(table)) sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(toId, fromId);
    }
    if (tableExists("inbox_read")) {
      // Keep whichever read time is later.
      const rows = sqlite.prepare(`SELECT read_at FROM inbox_read WHERE contact_fub_id IN (?, ?)`).all(fromId, toId) as Array<{ read_at: string }>;
      const latest = rows.map((r) => r.read_at).sort().pop();
      sqlite.prepare(`DELETE FROM inbox_read WHERE contact_fub_id IN (?, ?)`).run(fromId, toId);
      if (latest) sqlite.prepare(`INSERT INTO inbox_read (contact_fub_id, read_at) VALUES (?, ?)`).run(toId, latest);
    }
    sqlite.prepare(`DELETE FROM crm_contacts WHERE fub_id = ?`).run(fromId);
  });
  tx();
}

/**
 * After a FUB contacts sync: any app contact FUB now also has (same email, or
 * same phone when there's no email) is folded into FUB's copy.
 */
export function reconcileNativeContacts(): number {
  const natives = sqlite
    .prepare(`SELECT fub_id AS id, email, phone FROM crm_contacts WHERE fub_id LIKE '${NATIVE_PREFIX}%'`)
    .all() as Array<{ id: string; email: string | null; phone: string | null }>;
  if (natives.length === 0) return 0;
  let merged = 0;
  for (const n of natives) {
    const e = cleanEmail(n.email);
    let target: string | undefined;
    if (e) {
      target = (
        sqlite.prepare(`SELECT fub_id AS id FROM crm_contacts WHERE lower(trim(email)) = ? AND fub_id NOT LIKE '${NATIVE_PREFIX}%' LIMIT 1`).get(e) as
          | { id: string }
          | undefined
      )?.id;
    } else if (last10(n.phone)) {
      const p = last10(n.phone);
      const rows = sqlite
        .prepare(`SELECT fub_id AS id, phone FROM crm_contacts WHERE phone IS NOT NULL AND fub_id NOT LIKE '${NATIVE_PREFIX}%'`)
        .all() as Array<{ id: string; phone: string }>;
      target = rows.find((r) => last10(r.phone) === p)?.id;
    }
    if (target) {
      mergeContactInto(n.id, target);
      merged++;
    }
  }
  if (merged) console.log(`[contacts] folded ${merged} app contact${merged === 1 ? "" : "s"} into their Follow Up Boss copies`);
  return merged;
}

// Every lead the app creates gets a contact. See storage.createLead.
storage.onLeadCreated = (lead) => {
  try {
    ensureContactForLead(lead);
  } catch (e: any) {
    console.error("[contacts] couldn't create a contact for lead", lead.id, e?.message ?? e);
  }
};
