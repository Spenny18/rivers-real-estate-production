// Admin API for the Inbox (server/inbox.ts). All behind requireAuth.
//
//   GET  /api/admin/inbox/conversations?filter=&q=   the list
//   GET  /api/admin/inbox/unread                     badge count for the nav
//   GET  /api/admin/inbox/contact/:fubId             thread + panel (marks it read)
//   POST /api/admin/inbox/contact/:fubId/reply       { channel: "email" | "text", body, subject? }
//   GET  /api/admin/inbox/status                     what's connected
//   POST /api/admin/inbox/sync                       read new Gmail now

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { sqlite, storage } from "./storage";
import { contactPanel, lastEmailOf, listConversations, markRead, threadFor, unreadCount } from "./inbox";
import { lastInboxSync, storeEmail, syncInboxEmails } from "./gmail-inbox";
import { inboxReadiness } from "./deal-inbox";
import { canSendEmail, sendGmail } from "./gmail";
import { getValidAccessToken } from "./google-calendar";
import { sendSms, smsConfigured } from "./sms";
import { createTrackedEmail } from "./tracking";
import { MAX_TOTAL_BYTES, dropAttachment, holdAttachment, releaseAttachments, takeAttachments } from "./email-attachments";
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
    const filter = (["all", "unread", "text", "email", "call"].includes(f) ? f : "all") as "all" | "unread" | "text" | "email" | "call";
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

  // The formatted version of one email, fetched from Gmail on demand. Only for
  // mail already in the Inbox — this can't be used to read the rest of the
  // mailbox. ?images=1 lets remote pictures load (they can be tracking pixels).
  app.get("/api/admin/inbox/email/:gmailId/original", requireAuth, async (req, res) => {
    const gmailId = String((req.params as any).gmailId ?? "");
    const known = sqlite.prepare(`SELECT 1 FROM inbox_emails WHERE gmail_id = ?`).get(gmailId);
    if (!known) return res.status(404).json({ message: "That email isn't in the Inbox." });
    try {
      const { originalEmail } = await import("./email-original");
      res.set("Cache-Control", "private, no-store");
      res.json(await originalEmail(gmailId, { images: req.query.images === "1", hideQuoted: req.query.quoted === "0" }));
    } catch (e: any) {
      res.status(502).json({ message: e?.message ?? "Couldn't fetch the original from Gmail" });
    }
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

  // A file for an email being written (server/email-attachments.ts). Raw
  // bytes, sent as application/octet-stream so the JSON parser leaves them
  // alone; the real type and name come in headers.
  app.post(
    "/api/admin/email-attachments",
    requireAuth,
    express.raw({ type: "application/octet-stream", limit: MAX_TOTAL_BYTES + 1024 }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ message: "No file received." });
      let name = String(req.headers["x-filename"] ?? "attachment");
      try {
        name = decodeURIComponent(name);
      } catch {
        /* as sent */
      }
      const r = holdAttachment(name, String(req.headers["x-file-type"] ?? ""), req.body);
      if ("error" in r) return res.status(400).json({ message: r.error });
      res.json({ id: r.id });
    },
  );
  app.delete("/api/admin/email-attachments/:id", requireAuth, (req, res) => {
    dropAttachment(String(req.params.id));
    res.json({ ok: true });
  });

  app.post("/api/admin/inbox/contact/:fubId/reply", requireAuth, async (req, res) => {
    const fubId = String(req.params.fubId);
    const contact = storage.getCrmContact(fubId);
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    const channel = req.body?.channel === "text" ? "text" : "email";
    const typed = String(req.body?.body ?? "").trim();
    if (!typed) return res.status(400).json({ message: "The message is empty." });
    // Merge fields ({contact_first_name}, {inquiry_address} …) are filled in
    // for this contact; a misspelt one stops the send rather than going out
    // with its braces showing (server/merge-fields.ts).
    const { renderMerge, unknownFields } = await import("./merge-fields");
    const unknown = unknownFields(`${typed} ${String(req.body?.subject ?? "")}`);
    if (unknown.length) {
      return res.status(400).json({ message: `Not sent: {${unknown[0]}} isn't a merge field. Fix it or use Insert field.` });
    }
    const body = renderMerge(typed, fubId);
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
    const subject = renderMerge(
      String(req.body?.subject ?? "").trim() ||
        (last?.subject ? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`) : ""),
      fubId,
    );
    if (!subject) return res.status(400).json({ message: "Give the email a subject." });
    const taken = takeAttachments(req.body?.attachmentIds);
    if ("error" in taken) return res.status(400).json({ message: taken.error });

    // Opens and clicks come back to this contact's activity (server/tracking.ts).
    let html: string | undefined;
    try {
      // Listing links on their own line go out as property cards (server/listing-card.ts).
      const { emailHtml } = await import("./listing-card");
      html = emailHtml(body, createTrackedEmail(contact.email, subject, { kind: "crm", channel: "gmail", contactFubId: fubId }));
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
      signature: req.body?.signature !== false,
      attachments: taken.files,
    });
    if (!sent.ok || !sent.messageId) return res.status(502).json({ message: sent.error ?? "Send failed" });
    releaseAttachments(taken.files);

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
      hasAttachments: taken.files.length > 0,
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
