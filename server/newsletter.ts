// The newsletter engine: assembling an issue, sending it, and the cron.
//
// Sending goes through Resend's batch endpoint, a hundred addresses a call,
// one call a second, which is well inside the account's rate limit and gets a
// few thousand people their email in under a minute. Every address is
// recorded as it goes, so a send that dies part-way — a deploy, a crash —
// resumes at the next boot with the people already reached skipped.
//
// The list is the app's own (newsletter_subscribers), not the CRM mirror,
// and the only things that ever take someone off it are their own click, a
// bounce or a complaint reported back by Resend, or Spencer in the admin.

import { createHmac, timingSafeEqual } from "node:crypto";
import { storage, type NewsletterIssueRow, type NewsletterSubscriber } from "./storage";
import { publicOrigin } from "./origin";
import { AGENT } from "./brand";
import { sendEmail } from "./email";
import { buildReport, isValidPeriod, periodLabel } from "./market-report";
import { defaultReportPeriod } from "./market-report-render";
import { toStored } from "./market-report-store";
import {
  defaultIssueContent,
  parseIssueContent,
  personalize,
  renderNewsletter,
  sendMonthLabel,
  type IssueContent,
  type RenderContext,
  type RenderedIssue,
} from "./newsletter-template";

// ---- Assembling an issue -----------------------------------------------------------

export function unsubscribeUrl(token: string): string {
  return `${publicOrigin()}/newsletter/unsubscribe?t=${encodeURIComponent(token)}`;
}

/** Everything computed that the template shows for a period. */
export function buildRenderContext(period: string): RenderContext {
  const origin = publicOrigin();
  let report = null;
  try {
    const r = buildReport(period);
    // A report with nothing in it renders as a page of dashes; leave it out.
    if (r.benchmark.some((b) => b.present != null) || r.listings.sold.present != null) report = r;
  } catch {
    report = null;
  }
  return {
    origin,
    report,
    commentary: storage.getMarketCommentaryFull(period),
    reports: storage.listMarketReports(period).map((row) => {
      const s = toStored(row);
      return { title: s.title, subtitle: s.subtitle, pdfUrl: `${origin}${s.pdfUrl}` };
    }),
  };
}

export interface IssueView extends Omit<NewsletterIssueRow, "contentJson"> {
  content: IssueContent;
}

export function toIssueView(row: NewsletterIssueRow): IssueView {
  const { contentJson, ...rest } = row;
  return { ...rest, content: parseIssueContent(contentJson) };
}

/** The issue with its placeholders still in — one render, then personalize per address. */
export function renderIssue(row: NewsletterIssueRow): RenderedIssue {
  return renderNewsletter(
    { period: row.period, subject: row.subject, preheader: row.preheader, content: parseIssueContent(row.contentJson) },
    buildRenderContext(row.period),
  );
}

/** What the admin sees: rendered for a sample reader. */
export function previewIssue(row: NewsletterIssueRow, firstName = "Spencer"): { subject: string; html: string; text: string } {
  const r = renderIssue(row);
  const sample = { firstName, unsubUrl: `${publicOrigin()}/newsletter/unsubscribe?t=preview` };
  return { subject: row.subject, html: personalize(r.html, sample), text: personalize(r.text, sample) };
}

export function defaultSubject(period: string): string {
  return `Calgary Market Update ${sendMonthLabel(period)}`;
}

/** A fresh draft for a period, or the one that already exists. */
export function ensureDraft(period: string): NewsletterIssueRow {
  const existing = storage.findNewsletterIssueByPeriod(period);
  if (existing) return existing;
  const id = storage.createNewsletterIssue({
    period,
    subject: defaultSubject(period),
    preheader: `${periodLabel(period)} figures, what's on this month, and a note from Spencer.`,
    contentJson: JSON.stringify(defaultIssueContent()),
  });
  return storage.getNewsletterIssue(id)!;
}

// ---- Sending -----------------------------------------------------------------------

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
}

/** Sends a batch; one result per input, in order. Never throws for a single bad address. */
export type Transport = (emails: OutgoingEmail[]) => Promise<Array<{ id?: string; error?: string }>>;

const BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = 700;

function fromHeader(): string {
  const from = process.env.RESEND_FROM_EMAIL ?? "";
  return from.includes("<") ? from : `${AGENT.name} <${from}>`;
}

function toResendPayload(e: OutgoingEmail) {
  return {
    from: fromHeader(),
    to: [e.to],
    reply_to: AGENT.email,
    subject: e.subject,
    html: e.html,
    text: e.text,
    headers: {
      "List-Unsubscribe": `<${e.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

async function resendCall(path: string, body: unknown, idempotencyKey?: string): Promise<{ status: number; json: any; text: string }> {
  const r = await fetch(`https://api.resend.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}

/**
 * The real thing. A batch that Resend rejects outright (a malformed address
 * in it fails the whole call) is retried one address at a time, so one bad
 * row cannot cost ninety-nine good ones.
 */
export const resendTransport: Transport = async (emails) => {
  const key = `newsletter-${Date.now()}-${emails[0]?.to ?? ""}`;
  let r = await resendCall("/emails/batch", emails.map(toResendPayload), key);
  if (r.status === 429 || r.status >= 500) {
    await new Promise((res) => setTimeout(res, 3000));
    r = await resendCall("/emails/batch", emails.map(toResendPayload), key);
  }
  if (r.status >= 200 && r.status < 300 && Array.isArray(r.json?.data)) {
    return emails.map((_, i) => ({ id: r.json.data[i]?.id }));
  }
  if (r.status >= 500 || r.status === 429) {
    const error = `Resend ${r.status}: ${r.text.slice(0, 200)}`;
    return emails.map(() => ({ error }));
  }
  // A 4xx: find the address that broke it.
  const out: Array<{ id?: string; error?: string }> = [];
  for (const e of emails) {
    const one = await resendCall("/emails", toResendPayload(e));
    out.push(one.status >= 200 && one.status < 300 ? { id: one.json?.id } : { error: `Resend ${one.status}: ${one.text.slice(0, 200)}` });
    await new Promise((res) => setTimeout(res, BATCH_INTERVAL_MS));
  }
  return out;
};

export interface SendProgress {
  running: boolean;
  issueId: number | null;
  total: number;
  done: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

const progress: SendProgress = { running: false, issueId: null, total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null, lastError: null };

export function getSendProgress(): SendProgress {
  return { ...progress };
}

export function newsletterConfigured(): { ok: boolean; reason?: string } {
  if (!process.env.RESEND_API_KEY) return { ok: false, reason: "RESEND_API_KEY is not set" };
  if (!process.env.RESEND_FROM_EMAIL) return { ok: false, reason: "RESEND_FROM_EMAIL is not set" };
  return { ok: true };
}

/**
 * Send an issue to everyone subscribed who has not already had it.
 * Safe to call again after an interruption; refuses to run twice at once.
 */
export async function sendIssue(
  issueId: number,
  opts: { transport?: Transport; intervalMs?: number } = {},
): Promise<{ status: "sent" | "busy" | "not-found" | "not-configured" | "nobody"; sent: number; failed: number; error?: string }> {
  if (progress.running) return { status: "busy", sent: 0, failed: 0 };
  const row = storage.getNewsletterIssue(issueId);
  if (!row) return { status: "not-found", sent: 0, failed: 0 };
  const transport = opts.transport ?? resendTransport;
  if (!opts.transport) {
    const c = newsletterConfigured();
    if (!c.ok) return { status: "not-configured", sent: 0, failed: 0, error: c.reason };
  }

  const already = storage.newsletterSentSubscriberIds(issueId);
  const recipients = storage.listNewsletterRecipients().filter((s) => !already.has(s.id));
  if (recipients.length === 0 && already.size === 0) return { status: "nobody", sent: 0, failed: 0 };

  Object.assign(progress, {
    running: true,
    issueId,
    total: recipients.length,
    done: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
  });
  storage.updateNewsletterIssue(issueId, { status: "sending", recipients: already.size + recipients.length });
  console.log(`[newsletter] issue #${issueId} "${row.subject}" — ${recipients.length} to send${already.size ? `, ${already.size} already reached` : ""}`);

  const rendered = renderIssue(row);
  let sent = 0;
  let failed = 0;
  try {
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);
      const emails: OutgoingEmail[] = batch.map((s) => {
        const unsub = unsubscribeUrl(s.token);
        const p = { firstName: s.firstName, unsubUrl: unsub };
        return { to: s.email, subject: row.subject, html: personalize(rendered.html, p), text: personalize(rendered.text, p), unsubscribeUrl: unsub };
      });
      let results: Array<{ id?: string; error?: string }>;
      try {
        results = await transport(emails);
      } catch (e: any) {
        results = emails.map(() => ({ error: String(e?.message ?? e).slice(0, 200) }));
      }
      storage.recordNewsletterSends(
        batch.map((s, j) => ({
          issueId,
          subscriberId: s.id,
          email: s.email,
          status: results[j]?.error ? "failed" : "sent",
          resendId: results[j]?.id ?? null,
          error: results[j]?.error ?? null,
        })),
      );
      for (const r of results) {
        if (r.error) {
          failed++;
          progress.lastError = r.error;
        } else sent++;
      }
      progress.done = sent + failed;
      progress.failed = failed;
      if (i + BATCH_SIZE < recipients.length) await new Promise((res) => setTimeout(res, opts.intervalMs ?? BATCH_INTERVAL_MS));
    }
    const stats = storage.newsletterSendStats(issueId);
    storage.updateNewsletterIssue(issueId, {
      status: "sent",
      sentAt: new Date().toISOString(),
      recipients: stats.sent + stats.failed,
      delivered: stats.sent,
      failed: stats.failed,
    });
    console.log(`[newsletter] issue #${issueId} done: ${stats.sent} sent, ${stats.failed} failed`);
    return { status: "sent", sent, failed };
  } finally {
    progress.running = false;
    progress.finishedAt = new Date().toISOString();
  }
}

/** One copy to one address, rendered for that person — the "send me a test" button. */
export async function sendTest(issueId: number, to: string): Promise<{ ok: boolean; error?: string }> {
  const row = storage.getNewsletterIssue(issueId);
  if (!row) return { ok: false, error: "Issue not found" };
  const c = newsletterConfigured();
  if (!c.ok) return { ok: false, error: c.reason };
  const r = renderIssue(row);
  const sub = storage.getNewsletterSubscriberByEmail(to);
  const p = { firstName: sub?.firstName ?? null, unsubUrl: sub ? unsubscribeUrl(sub.token) : `${publicOrigin()}/newsletter/unsubscribe?t=test` };
  const res = await sendEmail({
    to,
    subject: `[TEST] ${row.subject}`,
    html: personalize(r.html, p),
    text: personalize(r.text, p),
    cc: "", // no auto-CC on a test
    replyTo: AGENT.email,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ---- Unsubscribe and provider feedback ---------------------------------------------

export function unsubscribeByToken(token: string, reason: string): NewsletterSubscriber | null {
  const s = storage.getNewsletterSubscriberByToken(token);
  if (!s) return null;
  if (s.status === "subscribed") storage.setNewsletterSubscriberStatus(s.id, "unsubscribed", reason);
  return s;
}

/**
 * Verify a Resend webhook (Svix signing: HMAC-SHA256 over "id.timestamp.body"
 * with the base64 secret after "whsec_"), then act on bounces and complaints.
 */
export function verifyResendSignature(
  rawBody: Buffer | string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string,
  now = Date.now(),
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 5 * 60) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody.toString()}`).digest();
  return headers.signature.split(/\s+/).some((part) => {
    const [, sig] = part.split(",");
    if (!sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export function applyResendEvent(event: any): { handled: boolean; note: string } {
  const type = String(event?.type ?? "");
  const to: string[] = Array.isArray(event?.data?.to) ? event.data.to : typeof event?.data?.to === "string" ? [event.data.to] : [];
  if (type === "email.bounced") {
    const bounceType = String(event?.data?.bounce?.type ?? "").toLowerCase();
    // A transient bounce (full mailbox, greylisting) is not a reason to drop someone.
    if (bounceType === "transient") return { handled: false, note: "transient bounce ignored" };
    let n = 0;
    for (const addr of to) {
      const s = storage.getNewsletterSubscriberByEmail(addr);
      if (s && s.status === "subscribed") {
        storage.setNewsletterSubscriberStatus(s.id, "bounced", `Bounce: ${event?.data?.bounce?.message ?? bounceType ?? "unknown"}`.slice(0, 300));
        n++;
      }
    }
    return { handled: true, note: `${n} bounced` };
  }
  if (type === "email.complained") {
    let n = 0;
    for (const addr of to) {
      const s = storage.getNewsletterSubscriberByEmail(addr);
      if (s && s.status === "subscribed") {
        storage.setNewsletterSubscriberStatus(s.id, "complained", "Marked as spam by the recipient");
        n++;
      }
    }
    return { handled: true, note: `${n} complained` };
  }
  return { handled: false, note: `ignored ${type || "event"}` };
}

// ---- CSV import ----------------------------------------------------------------------

export interface ImportRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
}

/** Split CSV text into rows of cells, honouring quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === "\t" || ch === ";") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Pull (email, first name, last name) out of whatever the export looks like.
 * Real Info Box, Follow Up Boss and Mailchimp all label the columns
 * differently; a header row is used when there is one, and failing that any
 * cell that looks like an address counts.
 */
export function rowsFromCsv(text: string): ImportRow[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const emailCol = find(/e-?mail/);
  const hasHeader = emailCol >= 0;
  const firstCol = hasHeader ? find(/^(first|given)[ _-]?(name)?$|first ?name/) : -1;
  const lastCol = hasHeader ? find(/^(last|sur|family)[ _-]?(name)?$|last ?name|surname/) : -1;
  const nameCol = hasHeader ? find(/^(full ?)?name$|^contact( name)?$/) : -1;

  const out: ImportRow[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    let email = "";
    if (hasHeader) email = (r[emailCol] ?? "").trim().toLowerCase();
    else email = (r.find((c) => EMAIL_RE.test(c.trim())) ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    let firstName: string | null = firstCol >= 0 ? (r[firstCol] ?? "").trim() || null : null;
    let lastName: string | null = lastCol >= 0 ? (r[lastCol] ?? "").trim() || null : null;
    if (!firstName && !lastName && nameCol >= 0) {
      const parts = (r[nameCol] ?? "").trim().split(/\s+/).filter(Boolean);
      firstName = parts[0] ?? null;
      lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
    out.push({ email, firstName, lastName });
  }
  return out;
}

// ---- Cron ----------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

function mountainDayOfMonth(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", day: "numeric" }).format(now));
}

/**
 * Hourly: finish a send a restart cut off, send anything scheduled whose
 * time has come, and from the 2nd make sure a draft for last month exists so
 * Spencer opens the admin to a newsletter that only needs its words.
 */
export async function newsletterTick(now = new Date()): Promise<void> {
  if (progress.running) return;
  const interrupted = storage.listNewsletterIssues().find((i) => i.status === "sending");
  if (interrupted) {
    console.log(`[newsletter] issue #${interrupted.id} was cut off mid-send — resuming`);
    await sendIssue(interrupted.id);
    return;
  }
  for (const due of storage.dueNewsletterIssues(now.toISOString())) {
    const r = await sendIssue(due.id);
    if (r.status !== "sent") console.error(`[newsletter] scheduled issue #${due.id} did not send: ${r.status} ${r.error ?? ""}`);
    return; // one per tick; the next tick picks up the rest
  }
  if (mountainDayOfMonth(now) >= 2) {
    const period = defaultReportPeriod(now);
    if (isValidPeriod(period) && !storage.findNewsletterIssueByPeriod(period)) {
      ensureDraft(period);
      console.log(`[newsletter] drafted ${defaultSubject(period)}`);
    }
  }
}

export function startNewsletterCron() {
  if (timer) return;
  setTimeout(() => {
    newsletterTick().catch((e) => console.error("[newsletter] uncaught:", e));
  }, 2 * 60 * 1000);
  timer = setInterval(() => {
    newsletterTick().catch((e) => console.error("[newsletter] uncaught:", e));
  }, 60 * 60 * 1000);
  console.log("[newsletter] scheduled (hourly: resume, send due, draft from the 2nd)");
}
