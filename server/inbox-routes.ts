// Admin API for the Inbox (server/inbox.ts). All behind requireAuth.
//
//   GET  /api/admin/inbox/conversations?filter=&q=   the list
//   GET  /api/admin/inbox/unread                     badge count for the nav
//   GET  /api/admin/inbox/contact/:fubId             thread + panel (marks it read)
//   POST /api/admin/inbox/contact/:fubId/reply       { channel: "email" | "text", body, subject? }
//   GET  /api/admin/inbox/status                     what's connected
//   POST /api/admin/inbox/sync                       read new Gmail now

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { contactPanel, lastEmailOf, listConversations, markRead, threadFor, unreadCount } from "./inbox";
import { lastInboxSync, storeEmail, syncInboxEmails } from "./gmail-inbox";
import { inboxReadiness } from "./deal-inbox";
import { canSendEmail, sendGmail } from "./gmail";
import { getValidAccessToken } from "./google-calendar";
import { sendSms, smsConfigured } from "./sms";
import { createTrackedEmail, plainTextToTrackedHtml } from "./tracking";
import { fubConfigured } from "./fub-client";
import { syncTextsForContact } from "./fub-sync";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function dto(c: any) {
  return {
    fubId: c.fubId,
    name: c.name,
    firstName: c.firstName,
    email: c.email,
    phone: c.phone,
    stage: c.stage,
    source: c.source,
    tags: c.tags,
    assignedTo: c.assignedTo,
    fubCreatedAt: c.fubCreatedAt,
    lastActivityAt: c.lastActivityAt,
  };
}

/** The Message-ID Gmail gave a message we just sent, so the next reply can thread onto it. */
async function sentMessageIdHeader(userId: number, gmailId: string): Promise<string | null> {
  if (!inboxReadiness().ok) return null;
  const token = await getValidAccessToken(userId);
  if (!token) return null;
  try {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailId)}?format=metadata&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!r.ok) return null;
    const m: any = await r.json();
    return m?.payload?.headers?.find((h: any) => /^message-id$/i.test(h.name))?.value ?? null;
  } catch {
    return null;
  }
}

export function registerInboxRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;
  const userIdOf = (req: Request) => (req as any).authUserId as number;

  app.get("/api/admin/inbox/conversations", requireAuth, (req, res) => {
    const f = String(req.query.filter ?? "all");
    const filter = (["all", "unread", "text", "email"].includes(f) ? f : "all") as "all" | "unread" | "text" | "email";
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 80) : undefined;
    res.json(listConversations({ filter, q, limit: 150 }));
  });

  app.get("/api/admin/inbox/unread", requireAuth, (_req, res) => {
    res.json({ count: unreadCount() });
  });

  app.get("/api/admin/inbox/status", requireAuth, (req, res) => {
    const gmail = inboxReadiness();
    res.json({
      gmail: { ok: gmail.ok, reason: gmail.reason ?? null, lastSync: lastInboxSync() },
      canEmail: canSendEmail(userIdOf(req)),
      canText: smsConfigured(),
    });
  });

  app.post("/api/admin/inbox/sync", requireAuth, async (_req, res) => {
    res.json(await syncInboxEmails());
  });

  app.get("/api/admin/inbox/contact/:fubId", requireAuth, async (req, res) => {
    const fubId = String(req.params.fubId);
    const contact = storage.getCrmContact(fubId);
    if (!contact) return res.status(404).json({ message: "Contact not found" });

    // Follow Up Boss texts only come one contact at a time (see fub-sync), so
    // opening the conversation is when they're fetched. Never fatal.
    let fubTexts: { ok: boolean; error?: string } = { ok: true };
    if (fubConfigured()) {
      try {
        await syncTextsForContact(fubId);
      } catch (e: any) {
        fubTexts = { ok: false, error: String(e?.message ?? e).slice(0, 200) };
      }
    }
    markRead(fubId);
    const last = lastEmailOf(fubId);
    res.json({
      contact: dto(contact),
      thread: threadFor(fubId),
      panel: contactPanel({ fubId, email: contact.email, name: contact.name }),
      replySubject: last?.subject ? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`) : null,
      fubTexts,
    });
  });

  app.post("/api/admin/inbox/contact/:fubId/reply", requireAuth, async (req, res) => {
    const fubId = String(req.params.fubId);
    const contact = storage.getCrmContact(fubId);
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    const channel = req.body?.channel === "text" ? "text" : "email";
    const body = String(req.body?.body ?? "").trim();
    if (!body) return res.status(400).json({ message: "The message is empty." });
    const userId = userIdOf(req);

    if (channel === "text") {
      if (!contact.phone) return res.status(400).json({ message: "This contact has no phone number." });
      const r = await sendSms(contact.phone, body, { kind: "client", contactFubId: fubId });
      if (!r.ok) return res.status(502).json({ message: r.error });
      markRead(fubId);
      return res.json({ ok: true });
    }

    if (!contact.email) return res.status(400).json({ message: "This contact has no email address." });
    const last = lastEmailOf(fubId);
    const subject =
      String(req.body?.subject ?? "").trim() ||
      (last?.subject ? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`) : "");
    if (!subject) return res.status(400).json({ message: "Give the email a subject." });

    // Opens and clicks come back to this contact's activity (server/tracking.ts).
    let html: string | undefined;
    try {
      html = plainTextToTrackedHtml(body, createTrackedEmail(contact.email, subject, { kind: "crm", channel: "gmail", contactFubId: fubId }));
    } catch (e: any) {
      console.error("[inbox] tracking setup failed:", e?.message ?? e);
    }
    // Thread onto the conversation only when replying to its subject.
    const replying = !!last && subject.replace(/^re:\s*/i, "") === (last.subject ?? "").replace(/^re:\s*/i, "");
    const sent = await sendGmail(userId, {
      to: contact.email,
      subject,
      text: body,
      html,
      threadId: replying ? last!.threadId ?? undefined : undefined,
      inReplyTo: replying ? last!.messageIdHeader ?? undefined : undefined,
    });
    if (!sent.ok || !sent.messageId) return res.status(502).json({ message: sent.error ?? "Send failed" });

    const now = new Date().toISOString();
    storeEmail({
      gmailId: sent.messageId,
      threadId: sent.threadId ?? null,
      contactFubId: fubId,
      direction: "outbound",
      from: "",
      to: contact.email,
      subject,
      body,
      messageIdHeader: await sentMessageIdHeader(userId, sent.messageId),
      hasAttachments: false,
      occurredAt: now,
    });
    // The CRM contact drawer reads crm_activities; keep it in step (the inbox
    // de-duplicates this against the Gmail copy by message id).
    storage.upsertCrmActivities([
      {
        uid: `email:gmail:${sent.messageId}`,
        kind: "email",
        fubId: null,
        contactFubId: fubId,
        title: subject,
        body: body.slice(0, 4000),
        direction: "outbound",
        outcome: null,
        durationSeconds: null,
        occurredAt: now,
        dueAt: null,
        completed: false,
        assignedTo: null,
        raw: JSON.stringify({ gmailMessageId: sent.messageId, gmailThreadId: sent.threadId }),
        syncedAt: now,
      },
    ]);
    markRead(fubId);
    res.json({ ok: true });
  });
}
