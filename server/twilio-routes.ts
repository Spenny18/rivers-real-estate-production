// Twilio webhooks for the business line, plus the admin's setup endpoints.
//
// Public (Twilio calls these; each one checks Twilio's request signature):
//   POST /api/twilio/sms               a text arrived  -> relay (server/sms.ts)
//   POST /api/twilio/sms-status        delivery receipts for texts we sent
//   POST /api/twilio/voice             a call arrived  -> ring Spencer's cell
//   POST /api/twilio/voice/whisper     what Spencer hears before it connects
//   POST /api/twilio/voice/after-dial  unanswered -> voicemail
//   POST /api/twilio/voice/recording   voicemail ready -> emailed to Spencer
// Admin (requireAuth):
//   GET  /api/admin/sms/status         configured? webhook URLs to paste into Twilio
//   POST /api/admin/sms/test           text Spencer's cell from the business line
//   GET  /api/admin/sms/messages       recent texts, both directions

import type { Express, Request, Response, NextFunction } from "express";
import {
  handleInboundSms,
  prettyPhone,
  recentMessages,
  recordDeliveryStatus,
  sendSms,
  smsConfig,
  smsConfigured,
  toE164,
  twimlEmpty,
  validTwilioSignature,
  whoIs,
  xmlEscape,
} from "./sms";
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

function voicemailTwiml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say voice="Polly.Joanna">You've reached ${xmlEscape(AGENT.name)} with ${xmlEscape(AGENT.business)}. Please leave a message after the tone, or send a text to this number.</Say>` +
    `<Record maxLength="180" playBeep="true" timeout="5" recordingStatusCallback="/api/twilio/voice/recording" recordingStatusCallbackMethod="POST" />` +
    `<Say voice="Polly.Joanna">Sorry, no message was recorded. Goodbye.</Say>` +
    `</Response>`
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
    const cell = smsConfig().agentCell;
    if (!cell) return twiml(res, voicemailTwiml());
    const from = toE164(String(req.body?.From ?? ""));
    // The client's own number as caller ID, so Spencer's phone shows who it is.
    // Twilio allows passing an inbound caller's number through on a forward.
    const callerId = from ? ` callerId="${xmlEscape(from)}"` : "";
    twiml(
      res,
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
        `<Dial timeout="22" answerOnBridge="true"${callerId} action="/api/twilio/voice/after-dial" method="POST">` +
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
    const status = String(req.body?.DialCallStatus ?? "");
    if (status === "completed" || status === "answered") return twiml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    twiml(res, voicemailTwiml());
  });

  app.post("/api/twilio/voice/recording", requireTwilio, async (req, res) => {
    res.status(204).end();
    const b = req.body ?? {};
    const recordingUrl = String(b.RecordingUrl ?? "");
    if (!recordingUrl || String(b.RecordingStatus ?? "completed") !== "completed") return;
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
}
