// Lead-source emails on the Enquiries page (server/lead-intake.ts).
//
//   GET  /api/admin/lead-intake               every email read, newest first, plus readiness
//   POST /api/admin/lead-intake/:id/import    { name, email?, phone?, message? } → a lead, by hand
//   POST /api/admin/lead-intake/:id/dismiss   not a lead after all
//   POST /api/admin/lead-intake/:id/retry     read it again with Claude
//   POST /api/admin/lead-intake/lookback      { days } read older source mail as samples (creates nothing)

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  LEAD_SOURCES,
  createLeadFromIntake,
  getIntake,
  intakeReadiness,
  intakeSeen,
  leadEmailText,
  leadMessage,
  listIntake,
  processLeadEmail,
  readIntake,
  sourceForSender,
  sourcesGmailQuery,
  updateIntake,
} from "./lead-intake";
import { agentUserId, gmailGet, lastInboxSync, type GmailMessage } from "./gmail-inbox";
import { inboxReadiness } from "./deal-inbox";
import { getValidAccessToken } from "./google-calendar";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const importSchema = z
  .object({
    name: z.string().trim().min(1, "A name is required").max(120),
    email: z.string().trim().email("That email doesn't look right").max(200).optional().nullable().or(z.literal("")),
    phone: z.string().trim().max(40).optional().nullable(),
    message: z.string().trim().max(4000).optional().nullable(),
  })
  .refine((b) => !!b.email || !!b.phone, "Add an email or a phone number");

function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function registerLeadIntakeRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  app.get("/api/admin/lead-intake", requireAuth, (_req, res) => {
    const gmail = inboxReadiness();
    const reader = intakeReadiness();
    res.json({
      ready: gmail.ok && reader.ok,
      reason: !gmail.ok ? gmail.reason : reader.reason,
      lastCheck: lastInboxSync()?.at ?? null,
      sources: LEAD_SOURCES.map((s) => s.label),
      rows: listIntake(150),
    });
  });

  app.post("/api/admin/lead-intake/:id/import", requireAuth, (req, res) => {
    const row = getIntake(Number(req.params.id));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.leadId) return res.status(409).json({ message: "Already a lead", leadId: row.leadId });
    const source = LEAD_SOURCES.find((s) => s.label === row.source);
    if (!source) return res.status(400).json({ message: `Unknown source ${row.source}` });
    const parsed = importSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Please check the form." });
    const b = parsed.data;
    const x = row.extracted;
    const made = createLeadFromIntake(source, {
      name: b.name,
      email: b.email || null,
      phone: b.phone || null,
      message: b.message || (x ? leadMessage(source, x) : `(via ${source.label})`),
      property: x?.property ?? null,
    });
    updateIntake(row.id, {
      status: made.duplicate ? "duplicate" : "imported",
      reason: made.duplicate ? `Same person as lead #${made.leadId} from earlier today` : "Added by hand",
      leadId: made.leadId,
      contactFubId: made.contactId,
    });
    res.json(getIntake(row.id));
  });

  app.post("/api/admin/lead-intake/:id/dismiss", requireAuth, (req, res) => {
    const row = getIntake(Number(req.params.id));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.leadId) return res.status(409).json({ message: "Already a lead" });
    updateIntake(row.id, { status: "dismissed" });
    res.json(getIntake(row.id));
  });

  app.post("/api/admin/lead-intake/:id/retry", requireAuth, async (req, res) => {
    const row = getIntake(Number(req.params.id));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.leadId) return res.status(409).json({ message: "Already a lead" });
    await readIntake(row.id, row.status === "sample" ? "sample" : "live");
    res.json(getIntake(row.id));
  });

  // Older source mail, read but never turned into leads: Follow Up Boss has
  // already handled it. Shows how well each source's emails are read before
  // trusting the live intake.
  app.post("/api/admin/lead-intake/lookback", requireAuth, async (req, res) => {
    const days = Math.min(Math.max(Number(req.body?.days) || 30, 1), 365);
    const limit = Math.min(Math.max(Number(req.body?.limit) || 40, 1), 100);
    const gmail = inboxReadiness();
    if (!gmail.ok) return res.status(400).json({ message: gmail.reason });
    const reader = intakeReadiness();
    if (!reader.ok) return res.status(400).json({ message: reader.reason });
    const userId = agentUserId();
    const token = userId ? await getValidAccessToken(userId) : null;
    if (!token) return res.status(400).json({ message: "Google connection expired. Reconnect it on the Scheduling page." });
    try {
      const q = `${sourcesGmailQuery()} newer_than:${days}d -in:spam -in:trash`;
      const list = await gmailGet(token, `/messages?q=${encodeURIComponent(q)}&maxResults=${limit}`);
      let read = 0;
      for (const m of list.messages ?? []) {
        const id = String(m.id);
        if (intakeSeen(id)) continue;
        const full: GmailMessage = await gmailGet(token, `/messages/${id}?format=full`);
        const source = sourceForSender(header(full, "From"));
        if (!source) continue;
        await processLeadEmail(
          source,
          {
            gmailId: id,
            from: header(full, "From"),
            subject: header(full, "Subject") || "(no subject)",
            body: leadEmailText(full),
            receivedAt: new Date(Number(full.internalDate ?? Date.now())).toISOString(),
          },
          "sample",
        );
        read += 1;
      }
      res.json({ read });
    } catch (e: any) {
      res.status(502).json({ message: String(e?.message ?? e).slice(0, 300) });
    }
  });
}
