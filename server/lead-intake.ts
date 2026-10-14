// Leads from lead-source emails (REW.ca, Realtor.ca, Zillow, …), read straight
// from Gmail, so new leads don't depend on Follow Up Boss's email parsing.
//
// The Inbox poller (gmail-inbox.ts) already looks at every new message's
// headers. Mail from a contact goes to the Inbox; mail from a known lead
// source's domain comes here instead of being skipped:
//
//   1. The sender's domain says which source it is (LEAD_SOURCES) — the source
//      label is never left to a guess.
//   2. Claude reads the email and returns the person's name, email, phone,
//      what they asked about and whether it's a lead at all (a source's
//      newsletters and account notices aren't).
//   3. A lead with an email or phone becomes a lead + contact, matched to an
//      existing contact by email then phone. Anything Claude isn't sure of, or
//      that carries no contact details (ReferralExchange's "a referral is
//      waiting" emails), waits under "Needs review" on the Enquiries page.
//
// Every email that came through here is kept (lead_intake_emails), with what
// was read from it, so a wrong reading can be checked against the original.
// No email is sent to anyone: the source already notified Spencer.

import Anthropic from "@anthropic-ai/sdk";
import { sqlite, storage } from "./storage";
import { addressesIn, decode, walk, type GmailMessage } from "./gmail-inbox";
import { createNativeContact, findContact } from "./contacts";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS lead_intake_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    from_addr TEXT,
    subject TEXT,
    body_text TEXT,
    received_at TEXT NOT NULL,
    -- imported | duplicate | needs_review | not_a_lead | dismissed | sample
    status TEXT NOT NULL,
    reason TEXT,
    extracted TEXT,
    lead_id INTEGER,
    contact_fub_id TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lead_intake_status ON lead_intake_emails(status, received_at DESC);
`);

// ---- Sources ---------------------------------------------------------------------------

export interface LeadSource {
  /** The label leads and contacts get — matches Follow Up Boss's source names. */
  label: string;
  /** Sender domains; subdomains match too (em8244.referralexchange.com). */
  domains: string[];
}

export const LEAD_SOURCES: LeadSource[] = [
  { label: "REW.ca", domains: ["rew.ca"] },
  { label: "ReferralExchange", domains: ["referralexchange.com"] },
  { label: "Realtor.ca", domains: ["realtor.ca", "crea.ca"] },
  { label: "Zillow", domains: ["zillow.com"] },
  { label: "RealEstateAgents.com", domains: ["realestateagents.com"] },
  { label: "LoopNet", domains: ["loopnet.com"] },
  { label: "Yelp", domains: ["yelp.com"] },
];

/** The lead source a From header belongs to, by its domain; null for everyone else. */
export function sourceForSender(fromHeader: string): LeadSource | null {
  const addr = addressesIn(fromHeader)[0];
  const domain = addr?.split("@")[1];
  if (!domain) return null;
  return LEAD_SOURCES.find((s) => s.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) ?? null;
}

/** A Gmail search for mail from every source, e.g. `from:(rew.ca OR zillow.com)`. */
export function sourcesGmailQuery(): string {
  return `from:(${LEAD_SOURCES.flatMap((s) => s.domains).join(" OR ")})`;
}

// ---- Reading the email -----------------------------------------------------------------

/**
 * The email as text for Claude. Unlike the Inbox's body, nothing is cut as a
 * "quoted reply" (lead emails are full of "From:"/"Date:" lines), and links
 * keep their address, so "View referral" still says where it goes.
 */
export function leadEmailText(msg: GmailMessage): string {
  const parts = walk(msg.payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data && !p.filename);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data && !p.filename);
  // HTML first when there is one: lead emails' plain-text parts are often a stub.
  const text = html?.body?.data ? htmlWithLinks(decode(html.body.data)) : plain?.body?.data ? decode(plain.body.data) : msg.snippet ?? "";
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 30_000);
}

function htmlWithLinks(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return /^(https?:|mailto:|tel:)/i.test(href) && !label.includes(href) ? `${label} (${href})` : label;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n");
}

// ---- Asking Claude ---------------------------------------------------------------------

export interface Extracted {
  isLead: boolean;
  confident: boolean;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** What they asked, in their words where the email has them. */
  message: string | null;
  /** The listing or address they asked about. */
  property: string | null;
  /** buyer | seller | renter | referral | unknown */
  intent: string;
  /** A link to the lead in the source's own site, when the email has one. */
  link: string | null;
  /** One line for Spencer: why this is or isn't a lead, or what's missing. */
  note: string;
}

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isLead", "confident", "name", "email", "phone", "message", "property", "intent", "link", "note"],
  properties: {
    isLead: { type: "boolean" },
    confident: { type: "boolean" },
    name: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    phone: { type: ["string", "null"] },
    message: { type: ["string", "null"] },
    property: { type: ["string", "null"] },
    intent: { type: "string", enum: ["buyer", "seller", "renter", "referral", "unknown"] },
    link: { type: ["string", "null"] },
    note: { type: "string" },
  },
} as const;

const SYSTEM = `You read emails that real estate lead services (REW.ca, Realtor.ca, Zillow, ReferralExchange and similar) send to Spencer Rivers, a Calgary REALTOR®, and pull out the lead.

A lead is a specific person who contacted Spencer or was assigned/referred to him: an inquiry about a listing, a request to sell, a showing request, a referral, a "homeseeker" he claimed. Newsletters, invoices, account and billing notices, marketing, review reminders and summaries of many people are not leads.

Rules:
- Only report details that appear in the email. Never invent or guess an email address, phone number or name. Spencer's own details (Spencer Rivers, spencer@riversrealestate.ca, his brokerage) are never the lead's.
- The service's own addresses and support numbers (noreply@…, support@…, toll-free help lines) are not the lead's contact details.
- message: what the person wrote or asked, in their words when the email quotes them; otherwise a short plain description of the request. null if there's nothing.
- property: the address or listing they asked about, if any.
- link: the URL in the email that opens this lead or referral on the service's site, if there is one.
- confident: true only when this is clearly a lead AND the name and at least one way to reach them (email or phone) are clearly stated.
- note: one short sentence for Spencer, e.g. "Buyer inquiry on 212-3223 83 Street NW" or "Referral details are only on ReferralExchange's site" or "Monthly invoice, not a lead".`;

const MODEL = process.env.LEAD_INTAKE_MODEL?.trim() || "claude-sonnet-5-5";

export function intakeReadiness(): { ok: boolean; reason?: string } {
  if (process.env.LEAD_INTAKE_FAKE === "1") return { ok: true };
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { ok: false, reason: "ANTHROPIC_API_KEY is not set on the server, so lead emails can't be read yet. They're kept under Needs review." };
  }
  return { ok: true };
}

async function extract(source: LeadSource, subject: string, from: string, body: string): Promise<{ data: Extracted; model: string }> {
  if (process.env.LEAD_INTAKE_FAKE === "1") return { data: fakeExtract(body), model: "fake" };
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA as any } },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Source: ${source.label}\nFrom: ${from}\nSubject: ${subject}\n\n<<<EMAIL\n${body}\nEMAIL>>>`,
      },
    ],
  });
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to read this email");
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { data: JSON.parse(text) as Extracted, model: msg.model || MODEL };
}

/** Local testing without an API key (LEAD_INTAKE_FAKE=1): pulls the first email/phone it sees. */
function fakeExtract(body: string): Extracted {
  const email = addressesIn(body).find((a) => !/noreply|no-reply|support|riversrealestate/.test(a)) ?? null;
  const phone = body.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? null;
  const name = body.match(/Name:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  return {
    isLead: !!(email || phone),
    confident: !!(name && (email || phone)),
    name,
    email,
    phone,
    message: body.match(/Message:\s*([^\n]+)/i)?.[1]?.trim() ?? null,
    property: null,
    intent: "unknown",
    link: null,
    note: "Read by the local stand-in, not Claude",
  };
}

// ---- Turning a reading into a lead --------------------------------------------------------

function cleanEmail(v: string | null | undefined): string | null {
  const e = (v ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  // The service's own addresses and Spencer's are never the lead's.
  if (sourceForSender(e) || /riversrealestate\.ca$|luxuryhomescalgary\.ca$/.test(e)) return null;
  return e;
}

function cleanPhone(v: string | null | undefined): string | null {
  const digits = (v ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const ten = digits.slice(-10);
  // Toll-free numbers are the service's help line, not the lead.
  if (/^8(00|33|44|55|66|77|88)/.test(ten)) return null;
  return v!.trim();
}

/** The lead's message as the Enquiries page shows it. */
export function leadMessage(source: LeadSource, x: Pick<Extracted, "message" | "property" | "intent" | "link">): string {
  return [
    x.property ? `About: ${x.property}` : null,
    x.message,
    x.intent && x.intent !== "unknown" ? `(${x.intent} lead via ${source.label})` : `(via ${source.label})`,
    x.link ? `Open on ${source.label}: ${x.link}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A lead from the same person and source in the last day: the source sending a second email about one inquiry. */
function recentLeadFor(source: string, email: string | null, phone: string | null): number | null {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = sqlite.prepare(`SELECT id, email, phone FROM leads WHERE source = ? AND created_at >= ?`).all(source, since) as Array<{
    id: number;
    email: string;
    phone: string | null;
  }>;
  const p = phone?.replace(/\D/g, "").slice(-10);
  return rows.find((r) => (email && r.email.toLowerCase() === email) || (p && r.phone?.replace(/\D/g, "").slice(-10) === p))?.id ?? null;
}

export interface LeadInput {
  name: string;
  email: string | null;
  phone: string | null;
  message: string;
}

/** Create the lead (and its contact, with the source as its source). */
export function createLeadFromIntake(source: LeadSource, input: LeadInput): { leadId: number; contactId: string; duplicate: boolean } {
  const email = cleanEmail(input.email);
  const phone = cleanPhone(input.phone) ?? input.phone?.trim() ?? null;
  const dup = recentLeadFor(source.label, email, phone);
  let contactId = findContact(email, phone);
  if (!contactId) {
    // Made here rather than by storage.createLead's hook, so the contact's
    // source reads "REW.ca" and not "Website · REW.ca".
    contactId = createNativeContact({
      name: input.name.trim() || email || phone || "New lead",
      email,
      phone,
      stage: "Lead",
      source: source.label,
      tags: ["email-lead"],
    }).fubId;
  }
  if (dup) return { leadId: dup, contactId, duplicate: true };
  const lead = storage.createLead({
    listingId: null,
    name: input.name.trim() || email || phone || "New lead",
    email: email ?? "",
    phone,
    message: input.message,
    source: source.label,
    status: "new",
  });
  return { leadId: lead.id, contactId, duplicate: false };
}

// ---- Processing one email ------------------------------------------------------------------

export interface IntakeRow {
  id: number;
  gmailId: string;
  source: string;
  fromAddr: string | null;
  subject: string | null;
  bodyText: string | null;
  receivedAt: string;
  status: string;
  reason: string | null;
  extracted: Extracted | null;
  leadId: number | null;
  contactFubId: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowFrom(r: any): IntakeRow {
  return {
    id: r.id,
    gmailId: r.gmail_id,
    source: r.source,
    fromAddr: r.from_addr,
    subject: r.subject,
    bodyText: r.body_text,
    receivedAt: r.received_at,
    status: r.status,
    reason: r.reason,
    extracted: r.extracted ? JSON.parse(r.extracted) : null,
    leadId: r.lead_id,
    contactFubId: r.contact_fub_id,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getIntake(id: number): IntakeRow | null {
  const r = sqlite.prepare(`SELECT * FROM lead_intake_emails WHERE id = ?`).get(id);
  return r ? rowFrom(r) : null;
}

export function listIntake(limit = 100): IntakeRow[] {
  return (sqlite.prepare(`SELECT * FROM lead_intake_emails ORDER BY received_at DESC LIMIT ?`).all(limit) as any[]).map(rowFrom);
}

export function intakeSeen(gmailId: string): boolean {
  return !!sqlite.prepare(`SELECT 1 FROM lead_intake_emails WHERE gmail_id = ?`).get(gmailId);
}

export function updateIntake(
  id: number,
  patch: Partial<{ status: string; reason: string | null; extracted: Extracted | null; leadId: number | null; contactFubId: string | null; model: string | null }>,
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.reason !== undefined) set("reason", patch.reason);
  if (patch.extracted !== undefined) set("extracted", patch.extracted ? JSON.stringify(patch.extracted) : null);
  if (patch.leadId !== undefined) set("lead_id", patch.leadId);
  if (patch.contactFubId !== undefined) set("contact_fub_id", patch.contactFubId);
  if (patch.model !== undefined) set("model", patch.model);
  set("updated_at", new Date().toISOString());
  sqlite.prepare(`UPDATE lead_intake_emails SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export interface IncomingLeadEmail {
  gmailId: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

/**
 * Record a lead-source email and act on it. `mode: "sample"` reads it but
 * creates nothing — for looking back at older mail that Follow Up Boss
 * already handled.
 */
export async function processLeadEmail(source: LeadSource, email: IncomingLeadEmail, mode: "live" | "sample" = "live"): Promise<IntakeRow> {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO lead_intake_emails (gmail_id, source, from_addr, subject, body_text, received_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'needs_review', ?, ?)`,
    )
    .run(email.gmailId, source.label, email.from.slice(0, 300), email.subject.slice(0, 500), email.body, email.receivedAt, now, now);
  const id = (sqlite.prepare(`SELECT id FROM lead_intake_emails WHERE gmail_id = ?`).get(email.gmailId) as { id: number }).id;
  await readIntake(id, mode);
  return getIntake(id)!;
}

/** Read (or re-read) a stored email with Claude, then import it, park it or set it aside. */
export async function readIntake(id: number, mode: "live" | "sample" = "live"): Promise<void> {
  const row = getIntake(id);
  if (!row) return;
  const source = LEAD_SOURCES.find((s) => s.label === row.source);
  if (!source) return updateIntake(id, { status: "needs_review", reason: `Unknown source ${row.source}` });
  const ready = intakeReadiness();
  if (!ready.ok) return updateIntake(id, { status: "needs_review", reason: ready.reason ?? null });

  let data: Extracted;
  let model: string;
  try {
    ({ data, model } = await extract(source, row.subject ?? "", row.fromAddr ?? "", row.bodyText ?? ""));
  } catch (e: any) {
    return updateIntake(id, { status: "needs_review", reason: `Couldn't read it: ${String(e?.message ?? e).slice(0, 200)}` });
  }
  data.email = cleanEmail(data.email);
  data.phone = cleanPhone(data.phone);

  if (!data.isLead) return updateIntake(id, { status: "not_a_lead", reason: data.note, extracted: data, model });
  if (mode === "sample") return updateIntake(id, { status: "sample", reason: data.note, extracted: data, model });
  if (!data.confident || !data.name || (!data.email && !data.phone)) {
    const missing = !data.email && !data.phone ? "No email or phone in the email. " : "";
    return updateIntake(id, { status: "needs_review", reason: `${missing}${data.note}`.trim(), extracted: data, model });
  }
  const made = createLeadFromIntake(source, {
    name: data.name,
    email: data.email,
    phone: data.phone,
    message: leadMessage(source, data),
  });
  updateIntake(id, {
    status: made.duplicate ? "duplicate" : "imported",
    reason: made.duplicate ? `Same person as lead #${made.leadId} from earlier today` : data.note,
    extracted: data,
    leadId: made.leadId,
    contactFubId: made.contactId,
    model,
  });
  if (!made.duplicate) console.log(`[lead-intake] new ${source.label} lead #${made.leadId}`);
}
