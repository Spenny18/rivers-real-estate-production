// The Inbox (/admin/inbox): one conversation per CRM contact, with every
// email, text, call and note between Spencer and them in one thread, and
// everything else known about them alongside — web activity, email
// engagement, saved homes and searches, showings, transactions.
//
// Nothing here is a new store of record. It reads what's already kept:
//   emails       inbox_emails (server/gmail-inbox.ts), plus CRM-sent emails
//   texts        crm_activities kind=text (FUB's, synced per contact, and the
//                business line's, logged by server/sms.ts)
//   calls, notes crm_activities (the Follow Up Boss mirror)
//   activity     web_events / tracked_emails (server/tracking.ts)
//   saved homes  account_favorites / saved_searches (the client portal)
//   showings     tours (server/showings.ts)
//   transactions crm_deals (FUB) and deals (the app's own)
// The only state of its own is when each conversation was last read.

import { sqlite, storage } from "./storage";
import { listActivityForEmail, listTrackedEmailsFor, summarizeActivity } from "./tracking";
import { resolveShowingListing, toShowingView, type ShowingListing } from "./showings";
import { stateGet } from "./gmail-inbox";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS inbox_read (
    contact_fub_id TEXT PRIMARY KEY,
    read_at TEXT NOT NULL
  );
  -- Matching leads to contacts by email, case-insensitively, on every list
  -- load: the expressions must match the queries' exactly to be used.
  CREATE INDEX IF NOT EXISTS idx_crm_contacts_email_norm ON crm_contacts(lower(trim(email)));
  CREATE INDEX IF NOT EXISTS idx_leads_email_norm ON leads(lower(trim(email)));
`);

// ---- The conversation list ------------------------------------------------------------

export interface ConversationRow {
  contactFubId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  lastAt: string;
  lastKind: string;
  lastDirection: string | null;
  lastPreview: string | null;
  lastInboundAt: string | null;
  unread: boolean;
}

// Every message, from either source, as (contact, time, kind, direction, preview).
// CRM-mirrored emails that Gmail also delivered are left to the Gmail copy.
// Website inquiries count as messages too: a new lead with no email or text
// yet still gets a conversation, unread, with what they asked.
const MESSAGES_SQL = `
  SELECT contact_fub_id AS c, occurred_at AS at, 'email' AS kind, direction AS dir,
         subject || ' — ' || substr(coalesce(body_text, ''), 1, 140) AS preview
  FROM inbox_emails
  UNION ALL
  SELECT cc.fub_id, l.created_at, 'inquiry', 'inbound', 'Website inquiry — ' || substr(coalesce(l.message, ''), 1, 140)
  FROM leads l JOIN crm_contacts cc ON cc.email IS NOT NULL AND lower(trim(cc.email)) = lower(trim(l.email))
  UNION ALL
  SELECT a.contact_fub_id, a.occurred_at, a.kind, a.direction,
         CASE WHEN a.kind = 'email' THEN coalesce(a.title, '') || ' — ' || substr(coalesce(a.body, ''), 1, 140)
              WHEN a.kind = 'call' THEN 'Call' || CASE WHEN a.outcome IS NOT NULL THEN ' · ' || a.outcome ELSE '' END
              ELSE substr(coalesce(a.body, a.title, ''), 1, 160) END
  FROM crm_activities a
  WHERE a.kind IN ('text', 'email', 'call') AND a.contact_fub_id IS NOT NULL AND a.occurred_at IS NOT NULL
    AND NOT (a.kind = 'email' AND a.uid LIKE 'email:gmail:%'
             AND EXISTS (SELECT 1 FROM inbox_emails e WHERE e.gmail_id = substr(a.uid, 13)))
`;

/**
 * Before the inbox existed, nothing was ever "read". Only messages after it
 * went live count as unread, or day one would be thousands of red badges.
 */
function unreadFloor(): string {
  return stateGet("inbox_launched_at") ?? new Date().toISOString();
}

export function listConversations(opts: { filter?: "all" | "unread" | "text" | "email" | "call"; q?: string; limit?: number } = {}): ConversationRow[] {
  const limit = Math.min(opts.limit ?? 100, 300);
  const kindFilter =
    opts.filter === "text" ? `WHERE kind = 'text'` : opts.filter === "email" ? `WHERE kind = 'email'` : opts.filter === "call" ? `WHERE kind = 'call'` : "";
  const q = opts.q?.trim().toLowerCase();
  const rows = sqlite
    .prepare(
      `WITH m AS (SELECT * FROM (${MESSAGES_SQL}) ${kindFilter}),
       ranked AS (
         SELECT c, at, kind, dir, preview,
                ROW_NUMBER() OVER (PARTITION BY c ORDER BY at DESC) AS rn,
                MAX(CASE WHEN dir = 'inbound' THEN at END) OVER (PARTITION BY c) AS lastInboundAt
         FROM m
       )
       SELECT l.c AS contactFubId, cc.name, cc.email, cc.phone, cc.stage, l.at AS lastAt, l.lastInboundAt,
              l.kind AS lastKind, l.dir AS lastDirection, l.preview AS lastPreview, r.read_at AS readAt
       FROM ranked l
       JOIN crm_contacts cc ON cc.fub_id = l.c
       LEFT JOIN inbox_read r ON r.contact_fub_id = l.c
       WHERE l.rn = 1
       ${q ? `AND (lower(coalesce(cc.name, '')) LIKE @q OR lower(coalesce(cc.email, '')) LIKE @q OR replace(replace(replace(replace(coalesce(cc.phone, ''), '(', ''), ')', ''), '-', ''), ' ', '') LIKE @qDigits)` : ""}
       ORDER BY l.at DESC
       LIMIT @limit`,
    )
    .all({ limit: opts.filter === "unread" ? 1000 : limit, ...(q ? { q: `%${q}%`, qDigits: `%${q.replace(/\D/g, "") || q}%` } : {}) }) as Array<
    Omit<ConversationRow, "unread"> & { readAt: string | null }
  >;
  const floor = unreadFloor();
  const out = rows.map(({ readAt, ...r }) => {
    const seen = readAt && readAt > floor ? readAt : floor;
    return { ...r, unread: !!r.lastInboundAt && r.lastInboundAt > seen };
  });
  return (opts.filter === "unread" ? out.filter((r) => r.unread) : out).slice(0, limit);
}

export function unreadCount(): number {
  return listConversations({ filter: "unread", limit: 300 }).length;
}

export function markRead(contactFubId: string) {
  sqlite
    .prepare(`INSERT INTO inbox_read (contact_fub_id, read_at) VALUES (?, ?) ON CONFLICT(contact_fub_id) DO UPDATE SET read_at = excluded.read_at`)
    .run(contactFubId, new Date().toISOString());
}

// ---- One conversation --------------------------------------------------------------------

export interface ThreadItem {
  id: string;
  kind: "email" | "text" | "call" | "note" | "appointment" | "inquiry";
  direction: "inbound" | "outbound" | null;
  at: string;
  subject: string | null;
  body: string | null;
  meta: Record<string, unknown>;
}

export function threadFor(contactFubId: string, limit = 400): ThreadItem[] {
  const emails = sqlite
    .prepare(
      `SELECT gmail_id, thread_id, direction, from_addr, to_addrs, subject, body_text, message_id_header, has_attachments, occurred_at
       FROM inbox_emails WHERE contact_fub_id = ? ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(contactFubId, limit) as any[];
  const gmailIds = new Set(emails.map((e) => e.gmail_id));
  const contactEmail = (sqlite.prepare(`SELECT email FROM crm_contacts WHERE fub_id = ?`).get(contactFubId) as { email: string | null } | undefined)?.email;
  const inquiries = contactEmail
    ? (sqlite
        .prepare(`SELECT id, source, message, listing_id, created_at FROM leads WHERE lower(trim(email)) = lower(trim(?)) ORDER BY created_at DESC LIMIT 50`)
        .all(contactEmail) as any[])
    : [];
  const acts = sqlite
    .prepare(
      `SELECT uid, kind, title, body, direction, outcome, duration_seconds, occurred_at, raw
       FROM crm_activities
       WHERE contact_fub_id = ? AND kind IN ('text', 'email', 'call', 'note', 'appointment') AND occurred_at IS NOT NULL
       ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(contactFubId, limit) as any[];

  const items: ThreadItem[] = [
    ...inquiries.map((l) => ({
      id: `lead:${l.id}`,
      kind: "inquiry" as const,
      direction: "inbound" as const,
      at: l.created_at,
      subject: `Website inquiry · ${l.source}`,
      body: l.message,
      meta: { listingId: l.listing_id },
    })),
    ...emails.map((e) => ({
      id: `gmail:${e.gmail_id}`,
      kind: "email" as const,
      direction: e.direction,
      at: e.occurred_at,
      subject: e.subject,
      body: e.body_text,
      meta: {
        gmailId: e.gmail_id,
        threadId: e.thread_id,
        from: e.from_addr,
        to: e.to_addrs,
        messageIdHeader: e.message_id_header,
        hasAttachments: !!e.has_attachments,
      },
    })),
    ...acts
      .filter((a) => !(a.kind === "email" && typeof a.uid === "string" && a.uid.startsWith("email:gmail:") && gmailIds.has(a.uid.slice(12))))
      .map((a) => ({
        id: `act:${a.uid}`,
        kind: a.kind,
        direction: a.direction === "inbound" || a.direction === "outbound" ? a.direction : null,
        at: a.occurred_at,
        subject: a.kind === "email" || a.kind === "appointment" ? a.title : null,
        body: a.body,
        meta: {
          outcome: a.outcome,
          durationSeconds: a.duration_seconds,
          via: (a.uid as string).startsWith("text:twilio:") || (a.uid as string).startsWith("call:twilio:") ? "business line" : undefined,
          // Business-line calls: the call_log id, for its recording (see server/calls.ts).
          ...callMeta(a),
        },
      })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
}

function callMeta(a: { kind: string; uid: string; raw: string | null }): { callLogId?: number; hasRecording?: boolean } {
  if (a.kind !== "call" || !a.uid.startsWith("call:twilio:")) return {};
  try {
    const r = JSON.parse(a.raw ?? "{}");
    return { callLogId: Number(r.callLogId) || undefined, hasRecording: !!r.recording };
  } catch {
    return {};
  }
}

/** The most recent email in the conversation, for threading a reply onto it. */
export function lastEmailOf(contactFubId: string): { threadId: string | null; messageIdHeader: string | null; subject: string | null } | null {
  const e = sqlite
    .prepare(`SELECT thread_id, subject FROM inbox_emails WHERE contact_fub_id = ? ORDER BY occurred_at DESC LIMIT 1`)
    .get(contactFubId) as any;
  if (!e) return null;
  // In-Reply-To wants a real Message-ID; a just-sent message may not have its
  // header recorded yet, so take the newest one in that thread that does.
  const withHeader = sqlite
    .prepare(
      `SELECT message_id_header FROM inbox_emails WHERE contact_fub_id = ? AND thread_id IS ? AND message_id_header IS NOT NULL
       ORDER BY occurred_at DESC LIMIT 1`,
    )
    .get(contactFubId, e.thread_id) as any;
  return { threadId: e.thread_id, messageIdHeader: withHeader?.message_id_header ?? null, subject: e.subject };
}

// ---- Everything else about them ------------------------------------------------------------

function lower(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export function contactPanel(contact: { fubId: string; email: string | null; name: string | null }) {
  const email = lower(contact.email);

  // Web + email engagement (server/tracking.ts).
  const events = email ? listActivityForEmail(email, 150) : [];
  const engagement = email
    ? { summary: summarizeActivity(email, events), events: events.slice(0, 60), emails: listTrackedEmailsFor(email, 20) }
    : null;

  // Portal: saved homes and searches.
  const accountUser = email
    ? (sqlite.prepare(`SELECT id, lead_id AS leadId FROM account_users WHERE lower(email) = ?`).get(email) as { id: number; leadId: number } | undefined)
    : undefined;
  const leadIds = email
    ? (sqlite.prepare(`SELECT id FROM leads WHERE lower(email) = ?`).all(email) as Array<{ id: number }>).map((r) => r.id)
    : [];
  const favorites = accountUser
    ? (
        sqlite.prepare(`SELECT mls_id AS mlsId, created_at AS createdAt FROM account_favorites WHERE account_user_id = ? ORDER BY created_at DESC LIMIT 30`).all(accountUser.id) as Array<{
          mlsId: string;
          createdAt: string;
        }>
      ).map((f) => ({ ...resolveShowingListing(f.mlsId), savedAt: f.createdAt }))
    : [];
  const searchOwners = [
    ...(accountUser ? [`account_user_id = ${Number(accountUser.id)}`] : []),
    ...(leadIds.length ? [`lead_id IN (${leadIds.map(Number).join(",")})`] : []),
  ];
  const savedSearches = searchOwners.length
    ? (sqlite
        .prepare(
          `SELECT id, name, filters, frequency, active, last_sent_at AS lastSentAt, created_at AS createdAt
           FROM saved_searches WHERE ${searchOwners.join(" OR ")} ORDER BY created_at DESC LIMIT 20`,
        )
        .all() as any[]).map((s) => ({ ...s, active: !!s.active }))
    : [];

  // Form submissions on the site.
  const inquiries = email
    ? (sqlite
        .prepare(`SELECT id, source, message, listing_id AS listingId, created_at AS createdAt FROM leads WHERE lower(email) = ? ORDER BY created_at DESC LIMIT 20`)
        .all(email) as any[])
    : [];

  // Showings.
  const showings = (sqlite
    .prepare(`SELECT * FROM tours WHERE contact_fub_id = ? ${email ? "OR lower(client_email) = ?" : ""} ORDER BY scheduled_for DESC LIMIT 20`)
    .all(...(email ? [contact.fubId, email] : [contact.fubId])) as any[])
    .map((row) => storage.getTour(row.id))
    .filter(Boolean)
    .map((t) => toShowingView(t!));

  // Transactions: Follow Up Boss deals and the app's own.
  const fubDeals = sqlite
    .prepare(
      `SELECT fub_id AS fubId, name, value, stage_name AS stageName, status, closed_date AS closedDate
       FROM crm_deals WHERE contact_fub_id = ? ORDER BY coalesce(fub_updated_at, synced_at) DESC LIMIT 20`,
    )
    .all(contact.fubId);
  const appDeals = sqlite
    .prepare(
      `SELECT id, title, address, kind, status, mls_number AS mlsNumber, updated_at AS updatedAt
       FROM deals WHERE crm_contact_fub_id = ? ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(contact.fubId);

  const properties = contactProperties({
    favorites,
    views: events.filter((e) => e.kind === "listing_view" && e.mlsNumber).map((e) => ({ mlsNumber: e.mlsNumber!, at: e.occurredAt })),
    showings: showings.map((s: any) => ({ listing: s.listing, at: s.scheduledFor })),
    deals: (appDeals as Array<{ mlsNumber: string | null; updatedAt: string }>).filter((d) => d.mlsNumber).map((d) => ({ mlsNumber: d.mlsNumber!, at: d.updatedAt })),
    inquiries: (inquiries as Array<{ listingId: string | null; createdAt: string }>).filter((i) => i.listingId).map((i) => ({ listingId: i.listingId!, at: i.createdAt })),
  });

  return { engagement, favorites, savedSearches, inquiries, showings, transactions: { fub: fubDeals, app: appDeals }, properties };
}

export interface ContactProperty extends ShowingListing {
  /** Why it's here, newest first: "Saved", "Viewed 3×", "Showing Oct 24", "Deal", "Inquired". */
  reasons: string[];
  lastAt: string;
}

/**
 * Every listing this person has a connection to, in one list — so one can be
 * dropped into a text or email from the Inbox. Newest connection first.
 */
export function contactProperties(input: {
  favorites: Array<ShowingListing & { savedAt: string }>;
  views: Array<{ mlsNumber: string; at: string }>;
  showings: Array<{ listing: ShowingListing; at: string }>;
  deals: Array<{ mlsNumber: string; at: string }>;
  inquiries: Array<{ listingId: string; at: string }>;
}): ContactProperty[] {
  const byKey = new Map<string, ContactProperty & { views: number; order: string[] }>();
  const add = (l: ShowingListing, reason: string, at: string) => {
    if (l.source === "unknown") return;
    const key = l.mlsNumber ?? l.url ?? l.address;
    let p = byKey.get(key);
    if (!p) {
      p = { ...l, reasons: [], lastAt: at, views: 0, order: [] };
      byKey.set(key, p);
    }
    if (at > p.lastAt) p.lastAt = at;
    if (reason === "view") p.views += 1;
    else if (!p.order.includes(reason)) p.order.push(reason);
  };
  const resolved = new Map<string, ShowingListing>();
  const resolve = (id: string) => {
    if (!resolved.has(id)) resolved.set(id, resolveShowingListing(id));
    return resolved.get(id)!;
  };
  for (const f of input.favorites) add(f, "Saved", f.savedAt);
  for (const s of input.showings) {
    const when = new Date(s.at).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "America/Edmonton" });
    add(s.listing, `Showing ${when}`, s.at);
  }
  for (const d of input.deals) add(resolve(d.mlsNumber), "Deal", d.at);
  for (const i of input.inquiries) add(resolve(i.listingId), "Inquired", i.at);
  for (const v of input.views) add(resolve(v.mlsNumber), "view", v.at);
  return Array.from(byKey.values())
    .map(({ views, order, ...p }) => ({ ...p, reasons: [...order, ...(views ? [`Viewed${views > 1 ? ` ${views}×` : ""}`] : [])] }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, 25);
}
