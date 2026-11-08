// Admin API for monthly community-report subscriptions, plus the public
// unsubscribe page their emails link to. See server/community-report-subs.ts.

import type { Express, Request, Response, NextFunction } from "express";
import { AGENT } from "./brand";
import { publicOrigin } from "./origin";
import { esc, page } from "./newsletter-routes";
import {
  createListSub,
  createSub,
  deleteListSub,
  getListSub,
  isListSending,
  listListSubs,
  sendListSubNow,
  setListSubActive,
  deleteSub,
  findByToken,
  getSub,
  listSubsForEmail,
  optionsForNeighbourhood,
  previewSub,
  sendSub,
  setSubActive,
  unsubscribeByToken,
} from "./community-report-subs";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

export function registerCommunityReportRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  /** A contact's subscriptions, by email. */
  app.get("/api/admin/community-report-subs", requireAuth, (req, res) => {
    const email = String(req.query.email ?? "").trim();
    if (!email) return res.status(400).json({ message: "email is required" });
    res.json({ subs: listSubsForEmail(email) });
  });

  /** The property classes on offer for one neighbourhood page. */
  app.get("/api/admin/community-report-subs/options", requireAuth, (req, res) => {
    const r = optionsForNeighbourhood(String(req.query.slug ?? ""));
    if (!r.ok) return res.status(404).json({ message: r.error });
    res.json(r);
  });

  app.post("/api/admin/community-report-subs", requireAuth, (req, res) => {
    const b = req.body ?? {};
    const r = createSub({
      email: b.email,
      name: b.name,
      neighbourhoodSlug: b.neighbourhoodSlug,
      cls: b.cls,
      crmContactId: b.crmContactId ? String(b.crmContactId) : null,
      leadId: Number.isFinite(Number(b.leadId)) && b.leadId != null ? Number(b.leadId) : null,
    });
    if (!r.ok) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  app.patch("/api/admin/community-report-subs/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (typeof req.body?.active !== "boolean") return res.status(400).json({ message: "active must be true or false" });
    const sub = setSubActive(id, req.body.active);
    if (!sub) return res.status(404).json({ message: "Subscription not found" });
    res.json({ ok: true, sub });
  });

  app.delete("/api/admin/community-report-subs/:id", requireAuth, (req, res) => {
    res.json({ ok: deleteSub(Number(req.params.id)) });
  });

  /** Send this month's report now, rendering it if needed. */
  app.post("/api/admin/community-report-subs/:id/send", requireAuth, async (req, res) => {
    const r = await sendSub(Number(req.params.id), { render: true });
    if (r.status !== "sent") return res.status(r.error === "Subscription not found" ? 404 : 500).json({ message: r.error ?? "Not sent" });
    res.json({ ok: true, period: r.period, sub: getSub(Number(req.params.id)) });
  });

  /** The email as it would be sent, as HTML. */
  app.get("/api/admin/community-report-subs/:id/preview", requireAuth, async (req, res) => {
    const r = await previewSub(Number(req.params.id));
    if ("error" in r) return res.status(404).json({ message: r.error });
    res.type("html").send(r.html);
  });

  // ---- Smart lists ------------------------------------------------------------

  /** A smart list's report subscriptions (or all of them). */
  app.get("/api/admin/community-report-list-subs", requireAuth, (req, res) => {
    const listId = req.query.listId != null ? Number(req.query.listId) : undefined;
    res.json({ listSubs: listListSubs(listId).map((l) => ({ ...l, sending: isListSending(l.id) })) });
  });

  app.post("/api/admin/community-report-list-subs", requireAuth, (req, res) => {
    const b = req.body ?? {};
    const r = createListSub({ smartListId: Number(b.smartListId), neighbourhoodSlug: String(b.neighbourhoodSlug ?? ""), cls: b.cls });
    if (!r.ok) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  app.patch("/api/admin/community-report-list-subs/:id", requireAuth, (req, res) => {
    if (typeof req.body?.active !== "boolean") return res.status(400).json({ message: "active must be true or false" });
    const l = setListSubActive(Number(req.params.id), req.body.active);
    if (!l) return res.status(404).json({ message: "Not found" });
    res.json({ ok: true, listSub: l });
  });

  app.delete("/api/admin/community-report-list-subs/:id", requireAuth, (req, res) => {
    res.json({ ok: deleteListSub(Number(req.params.id)) });
  });

  /** Email this month's report to everyone in the list who hasn't had it. Background. */
  app.post("/api/admin/community-report-list-subs/:id/send", requireAuth, (req, res) => {
    const r = sendListSubNow(Number(req.params.id));
    if (!r.ok) return res.status(400).json({ message: r.error });
    r.done.catch((e) => console.error("[community-report-subs] list send failed:", e));
    res.json({ ok: true, queued: r.queued, listSub: getListSub(Number(req.params.id)) });
  });

  // ---- Public unsubscribe ----------------------------------------------------
  // GET asks for confirmation (so a mail scanner fetching the link doesn't
  // unsubscribe anyone); the button POSTs.

  const notFound = () =>
    page(
      "Link not recognised",
      `<h1>Link not recognised</h1><p>This unsubscribe link isn't one I sent. To stop receiving community reports, email <a href="mailto:${esc(AGENT.email)}">${esc(AGENT.email)}</a> and I'll take you off myself.</p>`,
    );

  app.get("/community-report/unsubscribe", (req, res) => {
    const token = String(req.query.t ?? "");
    res.type("html");
    // Look up without changing anything: unsubscribeByToken would act.
    const subs = token ? findByToken(token) : null;
    if (!subs) return res.status(404).send(notFound());
    const community = subs.neighbourhoodName ?? "community";
    if (!subs.active) {
      return res.send(page("Already unsubscribed", `<h1>You're unsubscribed</h1><p>${esc(subs.email)} no longer receives the monthly ${esc(community)} report.</p>`));
    }
    res.send(
      page(
        "Unsubscribe",
        `<h1>Unsubscribe</h1><p>Stop sending the monthly ${esc(community)} ${esc(subs.clsLabel.toLowerCase())} market report to <strong>${esc(subs.email)}</strong>?</p>` +
          `<form method="post" action="/community-report/unsubscribe?t=${encodeURIComponent(token)}"><button type="submit">Yes, unsubscribe me</button></form>` +
          `<p style="margin-top:20px;font-size:12px;">Changed your mind? Just close this page.</p>`,
      ),
    );
  });

  app.post("/community-report/unsubscribe", (req, res) => {
    const s = unsubscribeByToken(String(req.query.t ?? ""));
    res.type("html");
    if (!s) return res.status(404).send(notFound());
    res.send(
      page(
        "Unsubscribed",
        `<h1>Done</h1><p>${esc(s.email)} won't receive the monthly ${esc(s.neighbourhoodName ?? "community")} report again.</p>` +
          `<a class="btn" href="${esc(publicOrigin())}">Back to the site</a>`,
      ),
    );
  });
}

