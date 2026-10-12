// Twilio webhooks for the business line, plus the admin's setup endpoints.
//
// Public (Twilio calls these; each one checks Twilio's request signature):
//   POST /api/twilio/sms               a text arrived  -> relay (server/sms.ts)
//   POST /api/twilio/sms-status        delivery receipts for texts we sent
//   POST /api/twilio/voice             a call arrived  -> ring Spencer's cell (recorded);
//                                      from Spencer's own cell -> "enter a number" to call out
//   POST /api/twilio/voice/whisper     what Spencer hears before it connects
//   POST /api/twilio/voice/after-dial  unanswered -> voicemail
//   POST /api/twilio/voice/voicemail-done  after the voicemail is left
//   POST /api/twilio/voice/recording   voicemail ready -> logged + emailed to Spencer
//   POST /api/twilio/voice/call-recording  an answered call's recording is ready
//   POST /api/twilio/voice/dial-out    the number Spencer keyed in from his cell
//   POST /api/twilio/voice/outbound-agent   Spencer answered a click-to-call: press 1
//   POST /api/twilio/voice/outbound-connect dial the client
//   POST /api/twilio/voice/outbound-agent-status  his leg ended (never connected?)
//   POST /api/twilio/voice/outbound-after  how the client leg ended
//   POST /api/twilio/voice/client-notice   heard by the client on answer: recording notice
// Admin (requireAuth):
//   GET  /api/admin/sms/status         configured? webhook URLs to paste into Twilio
//   POST /api/admin/sms/test           text Spencer's cell from the business line
//   GET  /api/admin/sms/messages       recent texts, both directions
//   POST /api/admin/calls              click-to-call { contactFubId? , phone? }
//   GET  /api/admin/calls/:id/recording  stream a call's recording (mp3)
//   GET  /api/admin/business-line/activity  recent calls and texts, newest first

import type { Express, Request, Response, NextFunction } from "express";
import {
  ensureContactForPhone,
  handleInboundSms,
  prettyPhone,
  recentMessages,
  recordDeliveryStatus,
  replyTarget,
  sendSms,
  setReplyTarget,
  smsConfig,
  smsConfigured,
  toE164,
  twimlEmpty,
  validTwilioSignature,
  whoIs,
  xmlEscape,
} from "./sms";
import { callFromAdmin, fetchRecording, getCall, recentCalls, startCall, updateCall } from "./calls";
import { storage } from "./storage";
import { sendEmail } from "./email";
import { publicOrigin } from "./origin";
import { AGENT } from "./brand";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/**
 * Twilio signs the URL exactly as it called it. Behind Fly's proxy that's the
 * Host header over https; PUBLIC_ORIGIN is accepted too in case the webhook
 * was configured on the canonical domain and arrived via another.
 */
function signedUrls(req: Request): string[] {
  const host = req.get("x-forwarded-host") ?? req.get("host");
  return Array.from(new Set([host ? `https://${host}${req.originalUrl}` : "", `${publicOrigin()}${req.originalUrl}`].filter(Boolean)));
}

function requireTwilio(req: Request, res: Response, next: NextFunction) {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) params[k] = String(v);
  const sig = req.get("x-twilio-signature");
  if (signedUrls(req).some((u) => validTwilioSignature(u, params, sig))) return next();
  console.warn(`[twilio] rejected unsigned request to ${req.path}`);
  res.status(403).type("text/plain").send("Invalid signature");
}

function twiml(res: Response, xml: string) {
  res.type("text/xml").send(xml);
}

const VOICE = `voice="Polly.Joanna"`;

function say(text: string): string {
  return `<Say ${VOICE}>${xmlEscape(text)}</Say>`;
}

function hangup(text?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? say(text) : ""}<Hangup/></Response>`;
}

/** The call_log id Twilio was handed back in the callback URL (?call=N). */
function callIdOf(req: Request): number | null {
  const n = Number(req.query.call);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function voicemailTwiml(callId: number | null): string {
  const q = callId ? `?call=${callId}` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    say(`You've reached ${AGENT.name} with ${AGENT.business}. Please leave a message after the tone, or send a text to this number.`) +
    // An explicit action: without one, Twilio returns to after-dial when the
    // recording ends, which replayed this greeting in a loop.
    `<Record maxLength="180" playBeep="true" timeout="5" action="/api/twilio/voice/voicemail-done${q}" method="POST" recordingStatusCallback="/api/twilio/voice/recording${q}" recordingStatusCallbackMethod="POST" />` +
    say("Sorry, no message was recorded. Goodbye.") +
    `</Response>`
  );
}

/**
 * Bridge to a client from the business line, recorded from answer. The client
 * hears the recording notice (client-notice) before they're connected.
 */
function dialClientTwiml(callId: number, to: string, intro?: string): string {
  const from = smsConfig().from!;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    (intro ? say(intro) : "") +
    `<Dial timeout="30" answerOnBridge="true" callerId="${xmlEscape(from)}" record="record-from-answer-dual" ` +
    `recordingStatusCallback="/api/twilio/voice/call-recording?call=${callId}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed" ` +
    `action="/api/twilio/voice/outbound-after?call=${callId}" method="POST">` +
    `<Number url="/api/twilio/voice/client-notice" method="POST">${xmlEscape(to)}</Number>` +
    `</Dial></Response>`
  );
}

export function registerTwilioRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  // ---- Texts -------------------------------------------------------------------

  app.post("/api/twilio/sms", requireTwilio, async (req, res) => {
    const b = req.body ?? {};
    try {
      twiml(res, await handleInboundSms(String(b.From ?? ""), String(b.Body ?? ""), b.MessageSid ? String(b.MessageSid) : null));
    } catch (e: any) {
      console.error("[twilio] inbound sms failed:", e?.message ?? e);
      twiml(res, twimlEmpty());
    }
  });

  app.post("/api/twilio/sms-status", requireTwilio, (req, res) => {
    const b = req.body ?? {};
    if (b.MessageSid && b.MessageStatus) recordDeliveryStatus(String(b.MessageSid), String(b.MessageStatus), b.ErrorCode ? String(b.ErrorCode) : null);
    res.status(204).end();
  });

  // ---- Calls -------------------------------------------------------------------

  app.post("/api/twilio/voice", requireTwilio, (req, res) => {
    const cfg = smsConfig();
    const cell = cfg.agentCell;
    const from = toE164(String(req.body?.From ?? ""));

    // Spencer calling his own business line: dial out from it.
    if (cell && from === cell) {
      const last = replyTarget();
      const lastName = last ? whoIs(last).name ?? prettyPhone(last) : null;
      return twiml(
        res,
        `<?xml version="1.0" encoding="UTF-8"?><Response>` +
          `<Gather input="dtmf" finishOnKey="#" timeout="10" action="/api/twilio/voice/dial-out" method="POST">` +
          say(`Business line. Enter the number to call, then press pound.${lastName ? ` Or press star, then pound, to call ${lastName}.` : ""}`) +
          `</Gather>` +
          say("No number entered. Goodbye.") +
          `</Response>`,
      );
    }

    const contact = from ? ensureContactForPhone(from, "call") : { contactFubId: null, name: null };
    const call = startCall({
      callSid: req.body?.CallSid ? String(req.body.CallSid) : null,
      direction: "inbound",
      clientNumber: from ?? String(req.body?.From ?? "unknown"),
      contactFubId: contact.contactFubId,
    });
    // A caller is someone Spencer may want to text back: make them the relay's
    // reply target, as a text would.
    if (from) setReplyTarget(from);
    if (!cell) return twiml(res, voicemailTwiml(call.id));

    // The client's own number as caller ID, so Spencer's phone shows who it is.
    // Twilio allows passing an inbound caller's number through on a forward.
    const callerId = from ? ` callerId="${xmlEscape(from)}"` : "";
    twiml(
      res,
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
        say(`Thanks for calling ${AGENT.business}. This call may be recorded.`) +
        `<Dial timeout="22" answerOnBridge="true"${callerId} record="record-from-answer-dual" ` +
        `recordingStatusCallback="/api/twilio/voice/call-recording?call=${call.id}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed" ` +
        `action="/api/twilio/voice/after-dial?call=${call.id}" method="POST">` +
        `<Number url="/api/twilio/voice/whisper" method="POST">${xmlEscape(cell)}</Number>` +
        `</Dial></Response>`,
    );
  });

  // Heard by Spencer only, before the call connects: which line, and who.
  app.post("/api/twilio/voice/whisper", requireTwilio, (req, res) => {
    // On the whisper leg, From is the original caller.
    const from = toE164(String(req.body?.From ?? ""));
    const who = from ? whoIs(from).name : null;
    twiml(
      res,
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Business line${who ? `, ${xmlEscape(who)}` : ""}.</Say></Response>`,
    );
  });

  app.post("/api/twilio/voice/after-dial", requireTwilio, (req, res) => {
    const callId = callIdOf(req);
    const status = String(req.body?.DialCallStatus ?? "");
    const now = new Date().toISOString();
    if (status === "completed" || status === "answered") {
      if (callId) updateCall(callId, { status: "answered", durationSeconds: Number(req.body?.DialCallDuration ?? 0) || null, endedAt: now });
      return twiml(res, hangup());
    }
    // Not answered (or the forward failed — e.g. Twilio error 13227, the
    // geo permission): record why, then take a message.
    if (callId) {
      const err = req.body?.ErrorCode ? `Twilio ${req.body.ErrorCode}: ${String(req.body?.ErrorMessage ?? "").slice(0, 200)}` : undefined;
      updateCall(callId, { status: "missed", error: err, endedAt: now });
    }
    twiml(res, voicemailTwiml(callId));
  });

  app.post("/api/twilio/voice/voicemail-done", requireTwilio, (_req, res) => {
    twiml(res, hangup("Thanks. Goodbye."));
  });

  // An answered call's recording (inbound or outbound), ready on Twilio.
  app.post("/api/twilio/voice/call-recording", requireTwilio, (req, res) => {
    res.status(204).end();
    const callId = callIdOf(req);
    const b = req.body ?? {};
    if (!callId || !b.RecordingSid || String(b.RecordingStatus ?? "completed") !== "completed") return;
    updateCall(callId, { recordingSid: String(b.RecordingSid), recordingSeconds: Number(b.RecordingDuration ?? 0) || null });
  });

  app.post("/api/twilio/voice/recording", requireTwilio, async (req, res) => {
    res.status(204).end();
    const b = req.body ?? {};
    const recordingUrl = String(b.RecordingUrl ?? "");
    if (!recordingUrl || String(b.RecordingStatus ?? "completed") !== "completed") return;
    const callId = callIdOf(req);
    if (callId && b.RecordingSid) {
      updateCall(callId, { status: "voicemail", voicemail: true, recordingSid: String(b.RecordingSid), recordingSeconds: Number(b.RecordingDuration ?? 0) || null });
    }
    try {
      const cfg = smsConfig();
      // The call's From isn't on this callback; ask Twilio for the call.
      let caller = "";
      if (b.CallSid) {
        const call = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Calls/${encodeURIComponent(String(b.CallSid))}.json`,
          { headers: { Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}` } },
        ).then((r) => (r.ok ? r.json() : null));
        caller = toE164(call?.from ?? "") ?? "";
      }
      const who = caller ? whoIs(caller) : { name: null, contactFubId: null };
      const audio = await fetch(`${recordingUrl}.mp3`, {
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}` },
      });
      const mp3 = audio.ok ? Buffer.from(await audio.arrayBuffer()) : null;
      const label = who.name ? `${who.name} · ${prettyPhone(caller)}` : caller ? prettyPhone(caller) : "Unknown caller";
      const seconds = Number(b.RecordingDuration ?? 0);
      await sendEmail({
        to: process.env.SPENCER_NOTIFY_EMAIL || AGENT.email,
        cc: "",
        subject: `Voicemail from ${label}`,
        html:
          `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111;">` +
          `<p><strong>${xmlEscape(label)}</strong> left a ${seconds}s voicemail on your business line.</p>` +
          (mp3 ? `<p>The recording is attached.</p>` : `<p>The recording couldn't be downloaded; it's in your Twilio console under Monitor → Call logs.</p>`) +
          (caller ? `<p><a href="tel:${xmlEscape(caller)}">Call back</a></p>` : "") +
          `</div>`,
        attachments: mp3 ? [{ filename: "voicemail.mp3", content: mp3.toString("base64"), contentType: "audio/mpeg" }] : undefined,
      });
    } catch (e: any) {
      console.error("[twilio] voicemail email failed:", e?.message ?? e);
    }
  });

  // ---- Outbound calls -------------------------------------------------------------

  // Spencer keyed a number in from his cell (or * for the last person in touch).
  app.post("/api/twilio/voice/dial-out", requireTwilio, (req, res) => {
    const digits = String(req.body?.Digits ?? "").trim();
    const to = digits.startsWith("*") ? replyTarget() : toE164(digits);
    if (!to) {
      return twiml(
        res,
        `<?xml version="1.0" encoding="UTF-8"?><Response>${say(digits.startsWith("*") ? "No one has called or texted in the last day." : "That number didn't look right.")}<Redirect method="POST">/api/twilio/voice</Redirect></Response>`,
      );
    }
    const contact = ensureContactForPhone(to, "call");
    const call = startCall({ direction: "outbound", clientNumber: to, contactFubId: contact.contactFubId });
    setReplyTarget(to);
    twiml(res, dialClientTwiml(call.id, to, `Calling ${contact.name ?? prettyPhone(to)}.`));
  });

  // Click-to-call: Spencer answered his cell. Press 1 so his own voicemail
  // can't answer and be put through to the client.
  app.post("/api/twilio/voice/outbound-agent", requireTwilio, (req, res) => {
    const call = callIdOf(req) ? getCall(callIdOf(req)!) : null;
    if (!call) return twiml(res, hangup());
    const name = call.contactFubId ? storage.getCrmContact(call.contactFubId)?.name : null;
    twiml(
      res,
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
        `<Gather input="dtmf" numDigits="1" timeout="8" action="/api/twilio/voice/outbound-connect?call=${call.id}" method="POST">` +
        say(`Business line. Press 1 to call ${name ?? prettyPhone(call.clientNumber)}.`) +
        `</Gather>${say("No key pressed. Goodbye.")}</Response>`,
    );
  });

  app.post("/api/twilio/voice/outbound-connect", requireTwilio, (req, res) => {
    const call = callIdOf(req) ? getCall(callIdOf(req)!) : null;
    if (!call || String(req.body?.Digits ?? "") !== "1") return twiml(res, hangup("Cancelled."));
    setReplyTarget(call.clientNumber);
    twiml(res, dialClientTwiml(call.id, call.clientNumber, "Connecting."));
  });

  // Spencer's leg of a click-to-call ended. If the client was never dialled
  // (he didn't answer, declined, or didn't press 1), say so on the log.
  app.post("/api/twilio/voice/outbound-agent-status", requireTwilio, (req, res) => {
    res.status(204).end();
    const call = callIdOf(req) ? getCall(callIdOf(req)!) : null;
    const st = String(req.body?.CallStatus ?? "");
    if (!call || call.status !== "ringing" || !["completed", "no-answer", "busy", "failed", "canceled"].includes(st)) return;
    updateCall(call.id, { status: "canceled", error: st === "completed" ? "Not connected (no key pressed)" : `Your phone: ${st}`, endedAt: new Date().toISOString() });
  });

  app.post("/api/twilio/voice/outbound-after", requireTwilio, (req, res) => {
    const callId = callIdOf(req);
    const st = String(req.body?.DialCallStatus ?? "");
    if (callId) {
      updateCall(callId, {
        status: st === "completed" || st === "answered" ? "answered" : st || "failed",
        durationSeconds: Number(req.body?.DialCallDuration ?? 0) || null,
        error: req.body?.ErrorCode ? `Twilio ${req.body.ErrorCode}: ${String(req.body?.ErrorMessage ?? "").slice(0, 200)}` : undefined,
        endedAt: new Date().toISOString(),
      });
    }
    twiml(res, hangup());
  });

  // Played to the client when they pick up, before they're connected.
  app.post("/api/twilio/voice/client-notice", requireTwilio, (_req, res) => {
    twiml(res, `<?xml version="1.0" encoding="UTF-8"?><Response>${say("This call may be recorded.")}</Response>`);
  });

  // ---- Admin ---------------------------------------------------------------------

  app.get("/api/admin/sms/status", requireAuth, (_req, res) => {
    const cfg = smsConfig();
    const origin = publicOrigin();
    res.json({
      ...smsConfigured(),
      from: cfg.from ? prettyPhone(cfg.from) : null,
      agentCell: cfg.agentCell ? prettyPhone(cfg.agentCell) : null,
      webhooks: {
        sms: `${origin}/api/twilio/sms`,
        voice: `${origin}/api/twilio/voice`,
      },
    });
  });

  app.post("/api/admin/sms/test", requireAuth, async (_req, res) => {
    const cell = smsConfig().agentCell;
    if (!cell) return res.status(400).json({ message: "Set AGENT_CELL_NUMBER first — that's where the test goes." });
    const r = await sendSms(cell, `Test from your business line: texting works. Client texts to this number will be forwarded here, and your replies go back to them from it.`, { kind: "test" });
    if (!r.ok) return res.status(502).json({ message: r.error });
    res.json({ ok: true });
  });

  app.get("/api/admin/sms/messages", requireAuth, (_req, res) => {
    res.json(recentMessages(100));
  });

  app.post("/api/admin/calls", requireAuth, async (req, res) => {
    const contactFubId = typeof req.body?.contactFubId === "string" ? req.body.contactFubId : null;
    const contact = contactFubId ? storage.getCrmContact(contactFubId) : null;
    const phone = (typeof req.body?.phone === "string" && req.body.phone) || contact?.phone || "";
    if (!phone) return res.status(400).json({ message: "No phone number to call." });
    const r = await callFromAdmin({ phone, contactFubId: contact?.fubId ?? null });
    if (!r.ok) return res.status(502).json({ message: r.error });
    res.json({ ok: true, callId: r.callId });
  });

  // The recording, streamed through the app so Twilio's URL and credentials
  // never reach the browser.
  app.get("/api/admin/calls/:id/recording", requireAuth, async (req, res) => {
    const call = getCall(Number((req.params as any).id));
    if (!call?.recordingSid) return res.status(404).json({ message: "No recording for this call." });
    try {
      const r = await fetchRecording(call.recordingSid);
      if (!r.ok) return res.status(502).json({ message: `Twilio ${r.status}` });
      res.set("Content-Type", "audio/mpeg");
      res.set("Cache-Control", "private, max-age=3600");
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e: any) {
      res.status(502).json({ message: e?.message ?? "Couldn't fetch the recording" });
    }
  });

  // Calls and texts on the business line, newest first — including numbers
  // that aren't anyone yet.
  app.get("/api/admin/business-line/activity", requireAuth, (_req, res) => {
    const calls = recentCalls(60).map((c: any) => ({
      kind: "call" as const,
      id: `call:${c.id}`,
      callId: c.id,
      at: c.startedAt,
      direction: c.direction,
      number: prettyPhone(c.clientNumber),
      contactFubId: c.contactFubId,
      name: c.contactName,
      status: c.status,
      durationSeconds: c.durationSeconds,
      voicemail: c.voicemail,
      hasRecording: c.hasRecording,
    }));
    const cfg = smsConfig();
    const texts = (recentMessages(120) as any[])
      .filter((m) => m.kind === "client" || m.kind === "relay")
      .filter((m) => !(m.direction === "inbound" && m.kind === "relay")) // Spencer's own texts to the line; the relayed copy is the record
      .map((m) => {
        const other = m.direction === "inbound" ? m.fromNumber : m.toNumber;
        const who = other && other !== cfg.agentCell ? whoIs(other) : { name: null, contactFubId: null };
        return {
          kind: "text" as const,
          id: `text:${m.id}`,
          at: m.createdAt,
          direction: m.direction,
          number: other ? prettyPhone(other) : "",
          contactFubId: m.contactFubId ?? who.contactFubId,
          name: who.name,
          body: m.body,
          status: m.status,
          error: m.error,
        };
      });
    res.json([...calls, ...texts].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80));
  });
}
