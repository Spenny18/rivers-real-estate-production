// The monthly newsletter, as email HTML.
//
// Same shape as the one Real Info Box sent for years, because the readers are
// used to it: a personal note up top, the market at a glance, the month's
// news and events, one longer article, one neighbourhood, and a footer that
// says who sent it and how to stop. Everything Spencer writes is in
// IssueContent; everything computed (the figures, the community reports)
// comes in through the RenderContext.
//
// Email HTML rules apply throughout — nested tables, inline styles, no
// webfont anyone can count on (see market-report.ts). The greeting and the
// unsubscribe link differ per recipient, so the page is rendered once with
// two placeholders and `personalize` fills them per address.

import { AGENT } from "./brand";
import { periodLabel, renderInfographic, type MarketReport } from "./market-report";

export interface NewsLink {
  title: string;
  source: string;
  url: string;
}
export interface EventItem {
  title: string;
  dates: string;
  blurb: string;
  url: string;
}
export interface Feature {
  title: string;
  body: string;
  imageUrl: string;
  url: string;
}
export interface IssueContent {
  /** The personal note. Paragraphs separated by blank lines. */
  intro: string;
  news: NewsLink[];
  events: EventItem[];
  article: Feature | null;
  neighbourhood: Feature | null;
  showMarket: boolean;
  showReports: boolean;
  showEvaluation: boolean;
}

export function defaultIssueContent(): IssueContent {
  return {
    intro: "",
    news: [],
    events: [],
    article: null,
    neighbourhood: null,
    showMarket: true,
    showReports: true,
    showEvaluation: true,
  };
}

/** Tolerant of anything the editor might have saved; never throws. */
export function parseIssueContent(json: string | null | undefined): IssueContent {
  const d = defaultIssueContent();
  if (!json) return d;
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return d;
  }
  if (!raw || typeof raw !== "object") return d;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const feature = (v: any): Feature | null =>
    v && typeof v === "object" && (str(v.title) || str(v.body)) ? { title: str(v.title), body: str(v.body), imageUrl: str(v.imageUrl), url: str(v.url) } : null;
  return {
    intro: str(raw.intro),
    news: Array.isArray(raw.news) ? raw.news.map((n: any) => ({ title: str(n?.title), source: str(n?.source), url: str(n?.url) })).filter((n: NewsLink) => n.title) : [],
    events: Array.isArray(raw.events)
      ? raw.events.map((e: any) => ({ title: str(e?.title), dates: str(e?.dates), blurb: str(e?.blurb), url: str(e?.url) })).filter((e: EventItem) => e.title)
      : [],
    article: feature(raw.article),
    neighbourhood: feature(raw.neighbourhood),
    showMarket: raw.showMarket !== false,
    showReports: raw.showReports !== false,
    showEvaluation: raw.showEvaluation !== false,
  };
}

export interface ReportLink {
  title: string;
  subtitle: string;
  pdfUrl: string;
}

export interface RenderContext {
  /** Public origin, no trailing slash. */
  origin: string;
  /** The figures for the issue's period, or null when none are entered. */
  report: MarketReport | null;
  commentary: { headline: string | null; body: string | null } | null;
  /** The month's community reports, as absolute links. */
  reports: ReportLink[];
}

export interface RenderedIssue {
  html: string;
  text: string;
}

/** Placeholders `personalize` fills. Chosen so nothing an editor types collides. */
export const GREETING_TOKEN = "%%GREETING%%";
export const UNSUB_TOKEN = "%%UNSUB_URL%%";

// ---- Styling -----------------------------------------------------------------------

const INK = "#000000";
const INK_SOFT = "#333333";
const BODY = "#666666";
const META = "#999999";
const RULE = "#E4E4E4";
const PAPER = "#F4F4F4";
const WHITE = "#FFFFFF";

const DISPLAY = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";
const SANS = "Montserrat, 'Helvetica Neue', Helvetica, Arial, sans-serif";

const FONT_LINK = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@400;600;700&display=swap";

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only http(s) links go out; anything else becomes no link at all. */
function safeUrl(u: string): string | null {
  const s = (u ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

function paragraphs(text: string, style = ""): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="font-family:${SANS};font-size:14px;line-height:1.6;color:${BODY};margin:0 0 14px;${style}">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function sectionHeading(label: string): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>` +
    `<td style="padding:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="width:40px;height:1px;background:${INK};font-size:0;line-height:0;">&nbsp;</td></tr><tr>` +
    `<td style="height:3px;font-size:0;line-height:0;">&nbsp;</td></tr><tr>` +
    `<td style="width:25px;height:1px;background:${INK};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr><tr>` +
    `<td style="padding:10px 0 0;font-family:${DISPLAY};font-size:22px;font-weight:600;letter-spacing:0.12em;color:${INK};text-transform:uppercase;">${esc(label)}</td>` +
    `</tr></table>`
  );
}

function block(inner: string, pad = "28px 36px"): string {
  return `<tr><td style="padding:${pad};border-bottom:1px solid ${RULE};">${inner}</td></tr>`;
}

function button(label: string, url: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="background:${INK};padding:13px 26px;">` +
    `<a href="${esc(url)}" style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.18em;color:${WHITE};text-decoration:none;text-transform:uppercase;">${esc(label)}</a>` +
    `</td></tr></table>`
  );
}

function image(url: string, alt: string): string {
  const u = safeUrl(url);
  if (!u) return "";
  return `<img src="${esc(u)}" alt="${esc(alt)}" width="528" style="display:block;width:100%;max-width:528px;height:auto;margin:0 0 18px;border:0;">`;
}

// ---- Sections ----------------------------------------------------------------------

function header(origin: string, sendLabel: string): string {
  return (
    `<tr><td style="background:${INK};padding:28px 36px;text-align:center;">` +
    `<a href="${esc(origin)}" style="text-decoration:none;">` +
    `<img src="${esc(origin)}/rivers-logo.jpg" alt="${esc(AGENT.business)}" width="150" style="display:inline-block;width:150px;height:auto;border:0;">` +
    `</a></td></tr>` +
    `<tr><td style="padding:22px 36px 6px;text-align:center;border-bottom:1px solid ${RULE};">` +
    `<div style="font-family:${DISPLAY};font-size:26px;font-weight:600;letter-spacing:0.16em;color:${INK};text-transform:uppercase;">Calgary Market Update</div>` +
    `<div style="font-family:${SANS};font-size:11px;letter-spacing:0.22em;color:${META};text-transform:uppercase;padding:8px 0 16px;">${esc(sendLabel)}</div>` +
    `</td></tr>`
  );
}

function note(content: IssueContent): string {
  const sig =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;"><tr><td style="border-left:2px solid ${INK};padding:2px 0 2px 14px;">` +
    `<div style="font-family:${DISPLAY};font-size:19px;font-weight:600;letter-spacing:0.06em;color:${INK};">${esc(AGENT.name)}</div>` +
    `<div style="font-family:${SANS};font-size:12px;color:${BODY};line-height:1.7;">${esc(AGENT.phone)} &nbsp;·&nbsp; <a href="mailto:${esc(AGENT.email)}" style="color:${INK_SOFT};text-decoration:none;">${esc(AGENT.email)}</a><br>` +
    `<a href="https://${esc(AGENT.site)}" style="color:${INK_SOFT};text-decoration:none;">${esc(AGENT.site)}</a></div>` +
    `</td></tr></table>`;
  return block(
    `<div style="font-family:${DISPLAY};font-size:22px;font-weight:600;color:${INK};margin:0 0 14px;">${GREETING_TOKEN}</div>` +
      paragraphs(content.intro) +
      sig,
  );
}

function market(ctx: RenderContext, period: string): string {
  const parts: string[] = [sectionHeading(`The market · ${periodLabel(period)}`)];
  if (ctx.commentary?.headline) {
    parts.push(`<div style="font-family:${DISPLAY};font-size:20px;font-weight:600;line-height:1.3;color:${INK};margin:0 0 10px;">${esc(ctx.commentary.headline)}</div>`);
  }
  if (ctx.commentary?.body) parts.push(paragraphs(ctx.commentary.body));
  if (ctx.report) {
    parts.push(`<div style="margin:10px -36px 0;">${renderInfographic(ctx.report)}</div>`);
  }
  return block(parts.join(""));
}

function reports(ctx: RenderContext): string {
  const rows = ctx.reports
    .map(
      (r) =>
        `<tr><td style="padding:9px 0;border-bottom:1px solid ${RULE};">` +
        `<a href="${esc(r.pdfUrl)}" style="font-family:${SANS};font-size:14px;font-weight:600;color:${INK};text-decoration:none;">${esc(r.title)}</a>` +
        `<div style="font-family:${SANS};font-size:12px;color:${META};padding-top:2px;">${esc(r.subtitle)} &nbsp;·&nbsp; PDF</div>` +
        `</td></tr>`,
    )
    .join("");
  return block(
    sectionHeading("Community reports") +
      `<p style="font-family:${SANS};font-size:14px;line-height:1.6;color:${BODY};margin:0 0 8px;">Two pages on each community: median sold price, inventory, absorption and days on market, from the same board data I use for pricing.</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>` +
      `<p style="font-family:${SANS};font-size:12px;line-height:1.6;color:${META};margin:14px 0 0;">Want one for your community? Reply and I'll send it.</p>`,
  );
}

function news(items: NewsLink[]): string {
  const rows = items
    .map((n) => {
      const u = safeUrl(n.url);
      const title = u
        ? `<a href="${esc(u)}" style="color:${INK};text-decoration:none;">${esc(n.title)}</a>`
        : `<span style="color:${INK};">${esc(n.title)}</span>`;
      return (
        `<tr><td style="padding:8px 0;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:14px;line-height:1.5;">` +
        `${title}${n.source ? ` <span style="color:${META};">– ${esc(n.source)}</span>` : ""}</td></tr>`
      );
    })
    .join("");
  return block(sectionHeading("In the news") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`);
}

function evaluation(origin: string): string {
  return (
    `<tr><td style="padding:0;border-bottom:1px solid ${RULE};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="background:${INK};padding:34px 36px;text-align:center;">` +
    `<div style="font-family:${DISPLAY};font-size:24px;font-weight:600;letter-spacing:0.08em;color:${WHITE};margin:0 0 8px;">What is your home worth now?</div>` +
    `<div style="font-family:${SANS};font-size:13px;line-height:1.6;color:#BBBBBB;margin:0 0 20px;">A real number from the sold data, not an algorithm's guess. No obligation, and I don't hand your details to anyone.</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="background:${WHITE};padding:13px 26px;">` +
    `<a href="${esc(origin)}/home-evaluation" style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.18em;color:${INK};text-decoration:none;text-transform:uppercase;">Request a home evaluation</a>` +
    `</td></tr></table></td></tr></table></td></tr>`
  );
}

function events(items: EventItem[]): string {
  const rows = items
    .map((e) => {
      const u = safeUrl(e.url);
      const title = u ? `<a href="${esc(u)}" style="color:${INK};text-decoration:none;">${esc(e.title)}</a>` : esc(e.title);
      return (
        `<div style="padding:0 0 16px;">` +
        `<div style="font-family:${SANS};font-size:14px;font-weight:700;color:${INK};line-height:1.4;">${title}${e.dates ? ` <span style="font-weight:400;color:${META};">(${esc(e.dates)})</span>` : ""}</div>` +
        (e.blurb ? `<div style="font-family:${SANS};font-size:13px;line-height:1.6;color:${BODY};padding-top:3px;">${esc(e.blurb)}</div>` : "") +
        `</div>`
      );
    })
    .join("");
  return block(sectionHeading("This month in Calgary") + rows);
}

function feature(heading: string, f: Feature, linkLabel: string): string {
  const u = safeUrl(f.url);
  return block(
    sectionHeading(heading) +
      image(f.imageUrl, f.title) +
      (f.title ? `<div style="font-family:${DISPLAY};font-size:22px;font-weight:600;line-height:1.3;color:${INK};margin:0 0 12px;">${esc(f.title)}</div>` : "") +
      paragraphs(f.body) +
      (u ? button(linkLabel, u) : ""),
  );
}

function footer(origin: string): string {
  return (
    `<tr><td style="padding:26px 36px 30px;background:${PAPER};text-align:center;">` +
    `<div style="font-family:${SANS};font-size:11px;line-height:1.7;color:${META};">` +
    `This email was sent by ${esc(AGENT.name)} · ${esc(AGENT.brokerage)}<br>${esc(AGENT.address)}<br>` +
    `<a href="${esc(origin)}" style="color:${META};text-decoration:underline;">${esc(AGENT.site)}</a> &nbsp;·&nbsp; ${esc(AGENT.phone)}` +
    `</div>` +
    `<div style="font-family:${SANS};font-size:11px;line-height:1.7;color:${META};padding-top:14px;">` +
    `You're receiving this because you asked for Calgary market updates from ${esc(AGENT.name)}. ` +
    `<a href="${UNSUB_TOKEN}" style="color:${INK_SOFT};text-decoration:underline;">Unsubscribe</a> at any time.` +
    `</div>` +
    `<div style="font-family:${SANS};font-size:10px;line-height:1.6;color:#B5B5B5;padding-top:12px;">` +
    `Market figures from Pillar 9 MLS® System data. Information is deemed reliable but not guaranteed, and is not intended to solicit properties already listed for sale.` +
    `</div>` +
    `</td></tr>`
  );
}

// ---- The whole thing ---------------------------------------------------------------

export interface IssueForRender {
  period: string;
  subject: string;
  preheader: string | null;
  content: IssueContent;
}

/** The month named in the header: the month the issue goes out, not the one it reports on. */
export function sendMonthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // one month on
  return `${d.toLocaleString("en-CA", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}

export function renderNewsletter(issue: IssueForRender, ctx: RenderContext): RenderedIssue {
  const c = issue.content;
  const rows: string[] = [header(ctx.origin, sendMonthLabel(issue.period)), note(c)];
  if (c.showMarket && (ctx.report || ctx.commentary?.body)) rows.push(market(ctx, issue.period));
  if (c.showReports && ctx.reports.length) rows.push(reports(ctx));
  if (c.news.length) rows.push(news(c.news));
  if (c.showEvaluation) rows.push(evaluation(ctx.origin));
  if (c.events.length) rows.push(events(c.events));
  if (c.article) rows.push(feature("Worth reading", c.article, "Read more"));
  if (c.neighbourhood) rows.push(feature(`Neighbourhood spotlight`, c.neighbourhood, "Explore the community"));
  rows.push(footer(ctx.origin));

  const preheader = issue.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${PAPER};">${esc(issue.preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>`
    : "";

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="x-apple-disable-message-reformatting"><title>${esc(issue.subject)}</title>` +
    `<link rel="stylesheet" href="${FONT_LINK}">` +
    `<style>body{margin:0;padding:0;background:${PAPER};} img{-ms-interpolation-mode:bicubic;} a{color:${INK};} @media (max-width:620px){.wrap{width:100%!important;}}</style>` +
    `</head><body style="margin:0;padding:0;background-color:${PAPER};">${preheader}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAPER};"><tr><td align="center" style="padding:24px 8px;">` +
    `<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${WHITE};border:1px solid ${RULE};">` +
    rows.join("") +
    `</table></td></tr></table></body></html>`;

  return { html, text: renderText(issue, ctx) };
}

function renderText(issue: IssueForRender, ctx: RenderContext): string {
  const c = issue.content;
  const out: string[] = [`CALGARY MARKET UPDATE — ${sendMonthLabel(issue.period)}`, "", GREETING_TOKEN, "", c.intro.trim(), "", AGENT.name, AGENT.phone, AGENT.email, AGENT.site];
  if (c.showMarket && ctx.report) {
    out.push("", `THE MARKET · ${periodLabel(issue.period)}`);
    if (ctx.commentary?.headline) out.push(ctx.commentary.headline);
    if (ctx.commentary?.body) out.push(ctx.commentary.body);
    for (const row of ctx.report.benchmark) {
      const p = row.present == null ? "—" : `$${Math.round(row.present).toLocaleString("en-CA")}`;
      out.push(`${row.label}: ${p}`);
    }
    if (ctx.report.marketStatus) out.push(`Market: ${ctx.report.marketStatus}`);
  }
  if (c.showReports && ctx.reports.length) {
    out.push("", "COMMUNITY REPORTS");
    for (const r of ctx.reports) out.push(`${r.title} — ${r.pdfUrl}`);
  }
  if (c.news.length) {
    out.push("", "IN THE NEWS");
    for (const n of c.news) out.push(`${n.title}${n.source ? ` – ${n.source}` : ""}${safeUrl(n.url) ? ` ${n.url}` : ""}`);
  }
  if (c.showEvaluation) out.push("", `What is your home worth now? ${ctx.origin}/home-evaluation`);
  if (c.events.length) {
    out.push("", "THIS MONTH IN CALGARY");
    for (const e of c.events) out.push(`${e.title}${e.dates ? ` (${e.dates})` : ""}`, e.blurb, "");
  }
  if (c.article) out.push("", "WORTH READING", c.article.title, c.article.body, safeUrl(c.article.url) ?? "");
  if (c.neighbourhood) out.push("", "NEIGHBOURHOOD SPOTLIGHT", c.neighbourhood.title, c.neighbourhood.body, safeUrl(c.neighbourhood.url) ?? "");
  out.push(
    "",
    "—",
    `This email was sent by ${AGENT.name} · ${AGENT.brokerage}, ${AGENT.address}`,
    `You're receiving this because you asked for Calgary market updates. Unsubscribe: ${UNSUB_TOKEN}`,
  );
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Fill the two per-recipient placeholders. Works on the HTML and the text alike. */
export function personalize(body: string, r: { firstName: string | null; unsubUrl: string }): string {
  const name = (r.firstName ?? "").trim();
  const greeting = name ? `Dear ${name},` : "Hello,";
  return body.split(GREETING_TOKEN).join(esc(greeting)).split(UNSUB_TOKEN).join(r.unsubUrl);
}
