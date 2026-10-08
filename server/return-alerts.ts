// "Back on the site" alerts — the Follow Up Boss feature Spencer relied on
// most: an email the moment a known lead starts browsing again, with what
// they're looking at.
//
// Detection happens on the page view itself (queueReturnAlertIfReturning in
// tracking.ts), which only queues a row. This sends it a few minutes later,
// so the email can say which listings they opened rather than just "they're
// here" — the first page of a return visit is usually the homepage or a
// search, and the listing they came back for is a click or two in.
//
// Env:
//   RETURN_ALERTS=off           disable entirely (queueing and sending)
//   RETURN_ALERT_GAP_HOURS=12   how long away counts as "coming back"
//   RETURN_ALERT_TO             recipient; default SPENCER_NOTIFY_EMAIL, then AGENT.email

import { sqlite } from "./storage";
import { sendEmail } from "./email";
import { AGENT } from "./brand";
import { publicOrigin } from "./origin";
import { returnAlertsEnabled } from "./tracking";

/** Wait this long after a visit starts before describing it. */
const SEND_DELAY_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;
/** A row this old is stale news; mark it skipped rather than alert hours late after downtime. */
const STALE_MS = 3 * 3600_000;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function recipient(): string {
  return process.env.RETURN_ALERT_TO || process.env.SPENCER_NOTIFY_EMAIL || AGENT.email;
}

/** Addresses that are Spencer, not a lead — his own browsing must never alert him. */
function ownAddresses(): Set<string> {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const m = v?.match(/[^\s<>]+@[^\s<>]+/);
    if (m) out.add(m[0].toLowerCase());
  };
  add(AGENT.email);
  add(process.env.SPENCER_NOTIFY_EMAIL);
  add(process.env.RESEND_FROM_EMAIL);
  add(process.env.RETURN_ALERT_TO);
  try {
    for (const u of sqlite.prepare("SELECT email FROM users").all() as Array<{ email: string }>) add(u.email);
  } catch {
    /* users table always exists in practice; never fatal */
  }
  return out;
}

interface Person {
  name: string | null;
  phone: string | null;
  stage: string | null;
  fubId: string | null;
}

/** Who this is, from the CRM mirror first and the site's own leads second. */
function lookupPerson(email: string): Person {
  const c = sqlite
    .prepare(`SELECT name, phone, stage, fub_id AS fubId FROM crm_contacts WHERE lower(email) = ? LIMIT 1`)
    .get(email) as Person | undefined;
  if (c) return c;
  const l = sqlite
    .prepare(`SELECT name, phone FROM leads WHERE lower(email) = ? ORDER BY id DESC LIMIT 1`)
    .get(email) as { name: string | null; phone: string | null } | undefined;
  return { name: l?.name ?? null, phone: l?.phone ?? null, stage: null, fubId: null };
}

interface VisitRow {
  kind: string;
  path: string | null;
  props: string;
  occurred_at: string;
}

function awayFor(prevIso: string | null, startIso: string): string {
  if (!prevIso) return "First visit since they became known";
  const days = Math.floor((Date.parse(startIso) - Date.parse(prevIso)) / 86_400_000);
  if (days < 1) return "Back after a few hours away";
  if (days === 1) return "First visit in a day";
  return `First visit in ${days} days`;
}

function price(n: unknown): string | null {
  return typeof n === "number" && n > 0
    ? n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : `$${Math.round(n / 1000)}K`
    : null;
}

export function buildReturnAlert(
  email: string,
  person: Person,
  alert: { visitStartedAt: string; prevSeenAt: string | null },
  visit: VisitRow[],
): { subject: string; html: string; text: string } {
  const origin = publicOrigin();
  const who = person.name || email;
  const listings: Array<{ line: string; url: string }> = [];
  const pages: string[] = [];
  const seen = new Set<string>();
  let fromEmail = false;
  for (const e of visit) {
    if (e.kind === "email_click") fromEmail = true;
    if (!e.path || seen.has(`${e.kind}:${e.path}`)) continue;
    seen.add(`${e.kind}:${e.path}`);
    if (e.kind === "listing_view") {
      let l: any = {};
      try {
        l = JSON.parse(e.props).listing ?? {};
      } catch {
        /* show what we have */
      }
      const bits = [price(l.price), l.beds ? `${l.beds} bd` : null, l.baths ? `${l.baths} ba` : null, l.neighbourhood]
        .filter(Boolean)
        .join(" · ");
      listings.push({ line: `${l.address ?? l.mlsNumber ?? e.path}${bits ? ` — ${bits}` : ""}`, url: `${origin}${e.path}` });
    } else if (e.kind === "pageview") {
      pages.push(e.path);
    }
  }
  // A listing view also records a pageview of the same path; list it once.
  const listingPaths = new Set(listings.map((l) => l.url.slice(origin.length)));
  const otherPages = pages.filter((p) => !listingPaths.has(p));

  const away = awayFor(alert.prevSeenAt, alert.visitStartedAt);
  const subject = `${who} is back on the site${fromEmail ? " (from your email)" : ""}`;
  const contactUrl = person.fubId
    ? `${origin}/admin/crm?contact=${encodeURIComponent(person.fubId)}`
    : `${origin}/admin/leads`;

  const meta = [email, person.phone, person.stage].filter(Boolean) as string[];
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0a0a0a;line-height:1.55;">` +
    `<p style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#6b7280;margin:0 0 6px;">Back on the site</p>` +
    `<p style="font-family:Georgia,serif;font-size:24px;margin:0 0 4px;">${esc(who)}</p>` +
    `<p style="margin:0 0 4px;color:#6b7280;font-size:13px;">${meta.map(esc).join(" · ")}</p>` +
    `<p style="margin:0 0 18px;font-size:14px;">${esc(away)}${fromEmail ? " — arrived by clicking one of your emails" : ""}.</p>` +
    (listings.length
      ? `<p style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#6b7280;margin:0 0 6px;">Listings viewed</p>` +
        `<ul style="margin:0 0 16px;padding-left:18px;font-size:14px;">` +
        listings.map((l) => `<li style="margin:0 0 4px;"><a href="${esc(l.url)}" style="color:#23412d;">${esc(l.line)}</a></li>`).join("") +
        `</ul>`
      : "") +
    (otherPages.length
      ? `<p style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#6b7280;margin:0 0 6px;">Pages</p>` +
        `<p style="margin:0 0 16px;font-size:13px;color:#374151;">${otherPages.slice(0, 12).map(esc).join("<br>")}${otherPages.length > 12 ? `<br>+${otherPages.length - 12} more` : ""}</p>`
      : "") +
    `<p style="margin:20px 0 0;"><a href="${esc(contactUrl)}" style="display:inline-block;padding:12px 22px;background:#0a0a0a;color:#fff;text-decoration:none;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;">Open in CRM</a></p>` +
    `<p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">Activity from the first ${Math.round(SEND_DELAY_MS / 60000)} minutes of the visit. The full timeline is on their CRM record.</p>` +
    `</div>`;

  const text = [
    `${who} is back on the site.`,
    meta.join(" · "),
    `${away}${fromEmail ? " — arrived by clicking one of your emails" : ""}.`,
    "",
    ...(listings.length ? ["Listings viewed:", ...listings.map((l) => `- ${l.line}\n  ${l.url}`), ""] : []),
    ...(otherPages.length ? ["Pages:", ...otherPages.slice(0, 12).map((p) => `- ${p}`), ""] : []),
    `Open in CRM: ${contactUrl}`,
  ].join("\n");

  return { subject, html, text };
}

export async function returnAlertTick(): Promise<void> {
  const now = Date.now();
  const due = sqlite
    .prepare(
      `SELECT id, email, visit_started_at AS visitStartedAt, prev_seen_at AS prevSeenAt
       FROM return_alerts WHERE status = 'pending' AND visit_started_at <= ? ORDER BY id LIMIT 20`,
    )
    .all(new Date(now - SEND_DELAY_MS).toISOString()) as Array<{
    id: number;
    email: string;
    visitStartedAt: string;
    prevSeenAt: string | null;
  }>;
  if (due.length === 0) return;

  const mark = sqlite.prepare(`UPDATE return_alerts SET status = ?, sent_at = ?, error = ? WHERE id = ?`);
  const own = ownAddresses();
  for (const a of due) {
    if (own.has(a.email)) {
      mark.run("skipped", null, "own address", a.id);
      continue;
    }
    if (now - Date.parse(a.visitStartedAt) > STALE_MS) {
      mark.run("skipped", null, "stale", a.id);
      continue;
    }
    const visit = sqlite
      .prepare(
        `SELECT kind, path, props, occurred_at FROM web_events
         WHERE email = ? AND occurred_at >= ? AND kind IN ('pageview', 'listing_view', 'email_click')
         ORDER BY occurred_at ASC LIMIT 200`,
      )
      .all(a.email, new Date(Date.parse(a.visitStartedAt) - 5 * 60_000).toISOString()) as VisitRow[];
    const msg = buildReturnAlert(a.email, lookupPerson(a.email), a, visit);
    const r = await sendEmail({ to: recipient(), subject: msg.subject, html: msg.html, text: msg.text, cc: "", replyTo: a.email });
    if (r.ok) {
      mark.run("sent", new Date().toISOString(), null, a.id);
      console.log(`[return-alerts] sent for ${a.email}`);
    } else {
      mark.run("failed", null, String(r.error ?? "send failed").slice(0, 300), a.id);
      console.error(`[return-alerts] send failed for ${a.email}: ${r.error}`);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startReturnAlertCron() {
  if (timer || !returnAlertsEnabled()) return;
  timer = setInterval(() => {
    returnAlertTick().catch((e) => console.error("[return-alerts] uncaught:", e));
  }, TICK_MS);
  console.log("[return-alerts] scheduled (every minute)");
}
