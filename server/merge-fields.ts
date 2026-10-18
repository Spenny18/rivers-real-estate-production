// Merge fields: {contact_first_name}, {inquiry_address}, {custom_birthday} …
// filled in per contact when a text or email goes out (Inbox, automations).
//
// The set mirrors Follow Up Boss's (Contact, Company, Agent, Sender, Property,
// Last viewed, Lead source, Other, Tour, Custom), with the app's own data
// behind each. Custom fields come from two places:
//   - Follow Up Boss's custom fields — names and labels kept in custom_fields
//     (synced, so they outlive FUB), values in the contact's synced `raw`;
//   - fields added in the app (Automations → Insert field → Custom fields),
//     values set on the contact in the Inbox.
// An app value wins over FUB's when both exist.
//
// Syntax: {field}, or {field|fallback} for when it's empty, e.g.
// "Hi {contact_first_name|there}". Unknown fields are left as typed and
// reported, so a typo can be caught before anything is sent.

import { sqlite, storage } from "./storage";
import { AGENT } from "./brand";
import { publicOrigin } from "./origin";
import { fubConfigured, fubGet } from "./fub-client";
import { findListingByAddress, resolveShowingListing } from "./showings";
import { tidyAddress } from "./listing-card";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS custom_fields (
    key TEXT PRIMARY KEY,               -- the merge field, e.g. custom_birthday
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',  -- text | date | number | dropdown
    source TEXT NOT NULL,               -- fub | app
    fub_name TEXT,                      -- e.g. customBirthday
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contact_field_values (
    contact_fub_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (contact_fub_id, key)
  );
`);

// ---- The catalog ---------------------------------------------------------------------

export interface MergeField {
  token: string;
  label: string;
  group: string;
}

const FIXED: MergeField[] = [
  { group: "Contact", token: "contact_name", label: "Contact name" },
  { group: "Contact", token: "contact_first_name", label: "Contact first name" },
  { group: "Contact", token: "contact_last_name", label: "Contact last name" },
  { group: "Contact", token: "contact_and_relationships_first_name", label: "Contact and relationships first name" },
  { group: "Contact", token: "contact_email", label: "Contact email" },
  { group: "Contact", token: "contact_phone", label: "Contact phone" },
  { group: "Contact", token: "contact_address", label: "Contact address" },
  { group: "Contact", token: "contact_street", label: "Contact street" },
  { group: "Contact", token: "contact_city", label: "Contact city" },
  { group: "Contact", token: "contact_state", label: "Contact province" },
  { group: "Contact", token: "contact_zipcode", label: "Contact postal code" },
  { group: "Contact", token: "contact_country", label: "Contact country" },
  { group: "Company", token: "company_name", label: "Company name" },
  { group: "Company", token: "company_phone", label: "Company phone" },
  { group: "Agent", token: "agent_name", label: "Agent name" },
  { group: "Agent", token: "agent_first_name", label: "Agent first name" },
  { group: "Agent", token: "agent_last_name", label: "Agent last name" },
  { group: "Agent", token: "agent_email", label: "Agent email" },
  { group: "Agent", token: "agent_phone", label: "Agent phone (business line)" },
  { group: "Agent", token: "agent_mobile_phone", label: "Agent mobile phone" },
  { group: "Sender", token: "sender_name", label: "Sender name" },
  { group: "Sender", token: "sender_first_name", label: "Sender first name" },
  { group: "Sender", token: "sender_last_name", label: "Sender last name" },
  { group: "Sender", token: "sender_email", label: "Sender email" },
  { group: "Sender", token: "sender_phone", label: "Sender phone (business line)" },
  { group: "Sender", token: "sender_mobile_phone", label: "Sender mobile phone" },
  { group: "Property", token: "inquiry_address", label: "Inquiry address" },
  { group: "Property", token: "inquiry_address_url", label: "Inquiry address URL" },
  { group: "Last viewed", token: "viewed_address", label: "Viewed address" },
  { group: "Last viewed", token: "viewed_address_url", label: "Viewed address URL" },
  { group: "Last viewed", token: "last_5_urls", label: "Last 5 URLs" },
  { group: "Lead source", token: "lead_source", label: "Lead source" },
  { group: "Other", token: "greeting_time", label: "Greeting time (Good morning / afternoon / evening)" },
  { group: "Tour", token: "tour_time", label: "Tour time (next showing)" },
];

const LEGACY_FALLBACK: Record<string, string> = { first_name: "there", property: "the property" };

/** Older names that still work: the first automations used these. */
const ALIASES: Record<string, string> = {
  first_name: "contact_first_name",
  name: "contact_name",
  property: "inquiry_address",
  source: "lead_source",
};

export function customFields(): Array<{ key: string; label: string; type: string; source: string; fubName: string | null }> {
  return (sqlite.prepare(`SELECT key, label, type, source, fub_name AS fubName FROM custom_fields ORDER BY label COLLATE NOCASE`).all() as any[]);
}

export function mergeFieldCatalog(): MergeField[] {
  return [...FIXED, ...customFields().map((c) => ({ group: "Custom", token: c.key, label: c.label }))];
}

/** "Kid Name(s)" → "custom_kid_names". */
export function customKeyFor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/\([^)]*\)/g, (m) => m.replace(/[()]/g, ""))
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `custom_${slug || "field"}`;
}

// ---- Custom fields -------------------------------------------------------------------------

export function addCustomField(label: string, type = "text"): { key: string } | { error: string } {
  const clean = label.trim().slice(0, 60);
  if (!clean) return { error: "Give the field a name." };
  const key = customKeyFor(clean);
  if (FIXED.some((f) => f.token === key) || sqlite.prepare(`SELECT 1 FROM custom_fields WHERE key = ?`).get(key)) {
    return { error: `There's already a field called {${key}}.` };
  }
  const t = ["text", "date", "number"].includes(type) ? type : "text";
  sqlite.prepare(`INSERT INTO custom_fields (key, label, type, source, created_at) VALUES (?, ?, ?, 'app', ?)`).run(key, clean, t, new Date().toISOString());
  return { key };
}

/** Removes a field added in the app (FUB's come back on the next sync, so they can't be). */
export function deleteCustomField(key: string): boolean {
  const n = sqlite.prepare(`DELETE FROM custom_fields WHERE key = ? AND source = 'app'`).run(key).changes;
  if (n) sqlite.prepare(`DELETE FROM contact_field_values WHERE key = ?`).run(key);
  return n > 0;
}

let lastFubFieldSync = 0;

/** Copy Follow Up Boss's custom field names and labels (hourly at most). */
export async function syncFubCustomFields(force = false): Promise<number> {
  if (!fubConfigured() || (!force && Date.now() - lastFubFieldSync < 55 * 60_000)) return 0;
  lastFubFieldSync = Date.now();
  const r = await fubGet<any>("/customFields", { limit: 100 });
  if (!r.ok) return 0;
  const list: Array<{ name: string; label: string; type?: string }> = r.data?.customfields ?? r.data?.customFields ?? [];
  const upsert = sqlite.prepare(
    `INSERT INTO custom_fields (key, label, type, source, fub_name, created_at) VALUES (?, ?, ?, 'fub', ?, ?)
     ON CONFLICT(key) DO UPDATE SET label = excluded.label, type = excluded.type, fub_name = excluded.fub_name
     WHERE custom_fields.source = 'fub'`,
  );
  const now = new Date().toISOString();
  for (const f of list) if (f?.name && f?.label) upsert.run(customKeyFor(f.label), f.label, f.type ?? "text", f.name, now);
  return list.length;
}

export function setContactField(contactId: string, key: string, value: string | null) {
  if (value === null || value.trim() === "") {
    sqlite.prepare(`DELETE FROM contact_field_values WHERE contact_fub_id = ? AND key = ?`).run(contactId, key);
  } else {
    sqlite
      .prepare(
        `INSERT INTO contact_field_values (contact_fub_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(contact_fub_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(contactId, key, value.trim().slice(0, 1000), new Date().toISOString());
  }
}

/** Every custom field with this contact's value, and where it came from. */
export function contactCustomFields(contactId: string) {
  const c = storage.getCrmContact(contactId);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(c?.raw ?? "{}");
  } catch {
    /* none */
  }
  const app = new Map(
    (sqlite.prepare(`SELECT key, value FROM contact_field_values WHERE contact_fub_id = ?`).all(contactId) as Array<{ key: string; value: string }>).map(
      (r) => [r.key, r.value],
    ),
  );
  return customFields().map((f) => {
    const fubValue = f.fubName && raw[f.fubName] != null && raw[f.fubName] !== "" ? String(raw[f.fubName]) : null;
    const appValue = app.get(f.key) ?? null;
    return { ...f, value: appValue ?? fubValue, fubValue, appValue };
  });
}

// ---- Values for one contact ------------------------------------------------------------------

export interface MergeContext {
  /** The property this message is about, when the caller knows (an automation's lead). */
  property?: string | null;
  source?: string | null;
}

function splitName(name: string | null | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

function formatDate(v: string): string {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return v;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return d.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function greeting(now = new Date()): string {
  const h = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", hour: "numeric", hour12: false }).format(now)) % 24;
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function absoluteUrl(path: string | null | undefined): string {
  if (!path) return "";
  return /^https?:\/\//.test(path) ? path : `${publicOrigin()}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Every merge field's value for one contact. Empty string when there's nothing. */
export function mergeValues(contactId: string, ctx: MergeContext = {}): Record<string, string> {
  const c: any = storage.getCrmContact(contactId) ?? {};
  let raw: any = {};
  try {
    raw = JSON.parse(c.raw ?? "{}");
  } catch {
    /* none */
  }
  const name = (c.name ?? "").trim();
  const split = splitName(name);
  const first = c.firstName || split.first;
  const last = c.lastName || split.last;
  const addr = Array.isArray(raw.addresses) ? raw.addresses[0] ?? {} : {};
  const street = addr.street ?? "";
  const city = addr.city ?? "";
  const state = addr.state ?? "";
  const zip = addr.code ?? addr.zip ?? "";
  const email = (c.email ?? "").trim().toLowerCase();

  // The property they asked about: the caller's, else their latest enquiry.
  let inquiry = ctx.property ?? "";
  let inquiryUrl = "";
  if (email || !inquiry) {
    const lead = email
      ? (sqlite.prepare(`SELECT listing_id AS listingId, message FROM leads WHERE lower(email) = ? ORDER BY created_at DESC LIMIT 1`).get(email) as
          | { listingId: string | null; message: string | null }
          | undefined)
      : undefined;
    const about = lead?.message?.match(/^About:\s*(.+)$/m)?.[1] ?? "";
    const listing = lead?.listingId ? resolveShowingListing(lead.listingId) : findListingByAddress(inquiry || about);
    if (!inquiry) inquiry = listing && listing.source !== "unknown" ? listing.address : about;
    if (listing && listing.source !== "unknown") inquiryUrl = listing.url ?? "";
  }

  // What they last looked at on the site.
  const views = email
    ? (sqlite
        .prepare(`SELECT kind, path, title, mls_number AS mls FROM web_events WHERE email = ? AND kind IN ('listing_view', 'pageview') ORDER BY occurred_at DESC LIMIT 40`)
        .all(email) as Array<{ kind: string; path: string | null; title: string | null; mls: string | null }>)
    : [];
  const lastListing = views.find((v) => v.kind === "listing_view");
  let viewedAddress = "";
  let viewedUrl = "";
  if (lastListing) {
    const l = lastListing.mls ? resolveShowingListing(lastListing.mls) : null;
    viewedAddress = l && l.source !== "unknown" ? l.address : lastListing.title ?? "";
    viewedUrl = l?.url ?? absoluteUrl(lastListing.path);
  }
  const last5 = Array.from(new Set(views.map((v) => absoluteUrl(v.path)).filter(Boolean))).slice(0, 5).join("\n");

  // Their next showing.
  const tour = sqlite
    .prepare(
      `SELECT scheduled_for AS at FROM tours WHERE (contact_fub_id = ? ${email ? "OR lower(client_email) = ?" : ""})
         AND scheduled_for >= ? AND status NOT IN ('cancelled', 'canceled') ORDER BY scheduled_for LIMIT 1`,
    )
    .get(...(email ? [contactId, email] : [contactId]), new Date().toISOString()) as { at: string } | undefined;
  const tourTime = tour
    ? new Date(tour.at).toLocaleString("en-CA", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Edmonton" })
    : "";

  const agent = splitName(AGENT.name);
  // The business line, read directly rather than through sms.ts (which
  // imports contacts.ts, which imports automations.ts, which imports this).
  const digits = (process.env.TWILIO_FROM_NUMBER ?? "").replace(/\D/g, "").slice(-10);
  const businessPhone = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : AGENT.phone;

  const values: Record<string, string> = {
    contact_name: name,
    contact_first_name: first ?? "",
    contact_last_name: last ?? "",
    contact_and_relationships_first_name: first ?? "",
    contact_email: c.email ?? "",
    contact_phone: c.phone ?? "",
    contact_address: [street, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    contact_street: street,
    contact_city: city,
    contact_state: state,
    contact_zipcode: zip,
    contact_country: addr.country && !/zone/i.test(addr.country) ? addr.country : street ? "Canada" : "",
    company_name: AGENT.business,
    company_phone: businessPhone,
    agent_name: AGENT.name,
    agent_first_name: agent.first,
    agent_last_name: agent.last,
    agent_email: AGENT.email,
    agent_phone: businessPhone,
    agent_mobile_phone: AGENT.phone,
    inquiry_address: tidyAddress(inquiry),
    inquiry_address_url: inquiryUrl,
    viewed_address: tidyAddress(viewedAddress),
    viewed_address_url: viewedUrl,
    last_5_urls: last5,
    lead_source: ctx.source ?? c.source ?? "",
    greeting_time: greeting(),
    tour_time: tourTime,
  };
  for (const k of ["name", "first_name", "last_name", "email", "phone", "mobile_phone"]) values[`sender_${k}`] = values[`agent_${k}`];
  for (const f of contactCustomFields(contactId)) values[f.key] = f.value ? (f.type === "date" ? formatDate(f.value) : f.value) : "";
  return values;
}

// ---- Filling in a message ---------------------------------------------------------------------

const TOKEN = /\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}/gi;

/** The field names used in a message that aren't merge fields. */
export function unknownFields(template: string): string[] {
  const known = new Set([...mergeFieldCatalog().map((f) => f.token), ...Object.keys(ALIASES), "agent_name", "agent_first_name", "agent_phone"]);
  const out = new Set<string>();
  for (const m of Array.from(template.matchAll(TOKEN))) {
    const k = m[1].toLowerCase();
    if (!known.has(k)) out.add(k);
  }
  return Array.from(out);
}

/** Fill in a message for one contact. Unknown fields are left as typed. */
export function renderMerge(template: string, contactId: string, ctx: MergeContext = {}): string {
  return renderMergeChecked(template, contactId, ctx).text;
}

/**
 * Fill in a message, and say which fields came out empty for this person
 * (no value, no "|fallback"), so a bulk send can hold their copy rather than
 * text "Hi ," to them.
 */
export function renderMergeChecked(template: string, contactId: string, ctx: MergeContext = {}): { text: string; blank: string[] } {
  if (!/\{/.test(template)) return { text: template, blank: [] };
  const values = mergeValues(contactId, ctx);
  const blank = new Set<string>();
  const text = template.replace(TOKEN, (whole, rawKey: string, fallback: string | undefined) => {
    let key = rawKey.toLowerCase();
    if (!(key in values) && ALIASES[key]) key = ALIASES[key];
    if (!(key in values)) return whole;
    const v = values[key];
    if (v) return v;
    if (fallback !== undefined) return fallback.trim();
    // What the first automations' fields said when empty; kept so they read the same.
    const legacy = LEGACY_FALLBACK[rawKey.toLowerCase()];
    if (legacy === undefined) blank.add(rawKey.toLowerCase());
    return legacy ?? "";
  });
  return { text, blank: Array.from(blank) };
}
