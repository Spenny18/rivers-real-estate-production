// "Download everything": the CRM and everything hanging off it, as a zip of
// CSV files Spencer keeps, so leaving Follow Up Boss doesn't make this app the
// only copy of his business. Opens in Excel, Numbers or Google Sheets.
//
// One CSV per table, every column, including `raw` — the untouched Follow Up
// Boss payload behind each mirrored row, where custom fields live. Columns that
// hold credentials (passwords, tokens, secrets, signing keys) are left out, and
// tables that are only machinery (sessions, caches, sync bookkeeping) aren't
// exported. The nightly encrypted backup (backup.ts) remains the full-fidelity
// copy of the whole database; this is the readable one.
//
// Streamed: each table is read a page at a time into the zip as it downloads.

import type { Writable } from "node:stream";
import { sqlite } from "./storage";
import { ZipStream } from "./zip-stream";

/** Exported tables, with what each holds, in the README's order. */
export const EXPORT_TABLES: Array<[table: string, about: string]> = [
  ["crm_contacts", "Contacts: name, email, phone, stage, source, tags. `raw` is Follow Up Boss's full record (custom fields included)."],
  ["contact_tags", "Tags added in the app (automations or by hand)."],
  ["contact_overrides", "Contact fields edited in the app, which the Follow Up Boss sync keeps."],
  ["contact_field_values", "Custom field values (merge fields)."],
  ["custom_fields", "Custom field definitions."],
  ["crm_activities", "History per contact: notes, tasks, appointments, calls, texts, emails and website events (`kind` says which)."],
  ["crm_deals", "Follow Up Boss deals."],
  ["crm_pipelines", "Follow Up Boss deal pipelines."],
  ["crm_stages", "Follow Up Boss deal stages."],
  ["crm_config", "Follow Up Boss settings snapshot: action plans, smart lists, custom fields, groups."],
  ["leads", "Website enquiries."],
  ["lead_intake_emails", "Lead-source emails (REW, Realtor.ca, Zillow…) and what was read from them."],
  ["sms_messages", "Texts sent and received on the business line."],
  ["sms_opt_outs", "Numbers that texted STOP."],
  ["call_log", "Calls on the business line."],
  ["inbox_emails", "Emails in the Inbox."],
  ["tracked_emails", "Emails sent from the app, with opens and clicks."],
  ["tours", "Showings."],
  ["bookings", "Bookings from the scheduling pages."],
  ["deals", "Transactions."],
  ["deal_events", "Transaction history."],
  ["deal_fields", "Transaction details (dates, conditions, amounts)."],
  ["saved_searches", "Saved searches."],
  ["lead_alerts", "Listing alerts."],
  ["automations", "Automations (action plans)."],
  ["automation_runs", "Who is or was in each automation."],
  ["automation_steps", "Every step automations took."],
  ["message_templates", "Email and text templates."],
  ["bulk_texts", "Bulk texts."],
  ["bulk_text_recipients", "Bulk text recipients and delivery."],
  ["newsletter_subscribers", "Newsletter list."],
  ["newsletter_issues", "Newsletters sent."],
  ["account_users", "Client portal accounts."],
  ["account_favorites", "Client portal favourites."],
  ["account_property_notes", "Client portal notes on properties."],
  ["social_posts", "Social posts."],
  ["listing_assets", "Copy written for your listings."],
  ["my_listings", "Your Pillar 9 listings."],
  ["web_visitors", "Website visitors."],
  ["web_events", "Website activity."],
  ["testimonials", "Testimonials."],
];

/** Columns never exported: credentials. */
export function isSecretColumn(name: string): boolean {
  return /password|token|secret|signature_key|initials_key|api_key/i.test(name);
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Buffer.isBuffer(v) ? `<${v.length} bytes>` : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tableExists(name: string): boolean {
  return !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function columnsOf(table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** Row counts for the tables that exist, for the page and the README. */
export function exportSummary(): Array<{ table: string; rows: number; about: string }> {
  return EXPORT_TABLES.filter(([t]) => tableExists(t)).map(([table, about]) => ({
    table,
    about,
    rows: (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  }));
}

/** Write the whole export as a zip to `out` (a response). */
export async function writeExport(out: Writable): Promise<{ tables: number; rows: number }> {
  const zip = new ZipStream(out);
  const stamp = new Date().toISOString();
  const summary = exportSummary();
  const readme = [
    "Rivers Real Estate: CRM export",
    `Made ${stamp}`,
    "",
    "One CSV per table. Open in Excel, Numbers or Google Sheets (UTF-8).",
    "Columns named fub_id / contact_fub_id link rows to a contact in crm_contacts.csv.",
    "`raw` columns hold Follow Up Boss's original record, including custom fields.",
    "Passwords, tokens and other credentials are left out.",
    "",
    ...summary.map((s) => `${s.table}.csv  (${s.rows.toLocaleString("en-CA")} rows)  ${s.about}`),
    "",
  ].join("\r\n");
  await zip.file("README.txt", readme);

  let total = 0;
  for (const { table } of summary) {
    const cols = columnsOf(table).filter((c) => !isSecretColumn(c));
    if (cols.length === 0) continue;
    await zip.begin(`${table}.csv`);
    // A byte-order mark so Excel reads the file as UTF-8.
    await zip.data("﻿" + cols.map(csvCell).join(",") + "\r\n");
    // Pages of rows by rowid, each read in full before awaiting the socket:
    // an open iterator would hold the connection busy for every other request.
    const page = sqlite
      .prepare(`SELECT rowid AS __rowid, ${cols.map((c) => `"${c}"`).join(", ")} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 2000`)
      .raw(true);
    let after = 0;
    let buf: string[] = [];
    let size = 0;
    for (;;) {
      const rows = page.all(after) as unknown[][];
      if (rows.length === 0) break;
      for (const r of rows) {
        after = Number(r[0]);
        const line = r.slice(1).map(csvCell).join(",") + "\r\n";
        buf.push(line);
        size += line.length;
        total++;
      }
      if (size > 512 * 1024) {
        await zip.data(buf.join(""));
        buf = [];
        size = 0;
      }
    }
    if (buf.length) await zip.data(buf.join(""));
    await zip.end();
  }
  await zip.finish();
  return { tables: summary.length, rows: total };
}
