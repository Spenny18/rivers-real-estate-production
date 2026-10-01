// AI crawler access audit (AI Visibility page).
//
// Getting recommended by an assistant is moot if its crawler can't read the
// site. For each search and AI crawler this checks, against the live public
// site: does robots.txt let it in, and does a real page come back (200) with
// its article text in the server-rendered HTML? Requests go out to the
// public origin, so a firewall or CDN rule that blocks a user agent shows up
// here. Blocks by crawler IP range can't be simulated and are not covered.
// Runs weekly alongside the visibility check, and on demand.

import { sqlite } from "./storage";
import { storage } from "./storage";
import { publicOrigin } from "./origin";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS ai_crawler_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    report TEXT NOT NULL
  );
`);

/** Crawlers that matter for AI answers and search, with their robots token. */
export const CRAWLERS = [
  { token: "OAI-SearchBot", owner: "OpenAI", role: "ChatGPT search results", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)" },
  { token: "ChatGPT-User", owner: "OpenAI", role: "ChatGPT fetching a page for a user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" },
  { token: "GPTBot", owner: "OpenAI", role: "Model training", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" },
  { token: "Claude-SearchBot", owner: "Anthropic", role: "Claude search results", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)" },
  { token: "Claude-User", owner: "Anthropic", role: "Claude fetching a page for a user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +https://www.anthropic.com)" },
  { token: "ClaudeBot", owner: "Anthropic", role: "Model training", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
  { token: "PerplexityBot", owner: "Perplexity", role: "Perplexity search index", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" },
  { token: "Perplexity-User", owner: "Perplexity", role: "Perplexity fetching a page for a user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)" },
  { token: "Googlebot", owner: "Google", role: "Google Search, AI Overviews and AI Mode", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { token: "Google-Extended", owner: "Google", role: "Gemini training/grounding opt-out (robots.txt only)", ua: "" },
  { token: "Bingbot", owner: "Microsoft", role: "Bing and Copilot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36" },
  { token: "Applebot", owner: "Apple", role: "Siri and Spotlight", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)" },
  { token: "meta-externalagent", owner: "Meta", role: "Meta AI", ua: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)" },
  { token: "CCBot", owner: "Common Crawl", role: "Open dataset many models train on", ua: "CCBot/2.0 (https://commoncrawl.org/faq/)" },
] as const;

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      // "Disallow:" with no path allows everything — not a rule.
      if (val) cur.rules.push({ allow: key === "allow", path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith("$");
  const body = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/** RFC 9309: the most specific group for the token; longest matching rule wins, allow on ties. */
export function robotsAllows(groups: RobotsGroup[], token: string, path: string): { allowed: boolean; group: string; rule: string | null } {
  const t = token.toLowerCase();
  let group = groups.find((g) => g.agents.includes(t));
  // Googlebot obeys "googlebot" groups; most crawlers match product tokens by prefix.
  if (!group) group = groups.find((g) => g.agents.some((a) => a !== "*" && t.startsWith(a)));
  if (!group) group = groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, group: "(none)", rule: null };
  let best: { allow: boolean; path: string } | null = null;
  for (const r of group.rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return {
    allowed: best ? best.allow : true,
    group: group.agents.join(", "),
    rule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.path}` : null,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface CrawlerResult {
  token: string;
  owner: string;
  role: string;
  robots: { allowed: boolean; group: string; rule: string | null };
  /** null when the crawler has no user agent of its own (Google-Extended). */
  fetch: { status: number; contentVisible: boolean; error?: string } | null;
  ok: boolean;
}

export interface AuditReport {
  at: string;
  testedUrl: string;
  robotsFound: boolean;
  sitemapListed: boolean;
  llmsTxt: boolean;
  crawlers: CrawlerResult[];
  blocked: number;
}

async function get(url: string, ua: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(20_000) });
  return { status: res.status, text: await res.text() };
}

/** A phrase that only appears if the article body was server-rendered. */
function bodyProbe(body: string): string {
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 80 && !/^(#|>|-|\*|!|\[)/.test(p) && !/https?:\/\//.test(p));
  return (para ?? "").replace(/\*\*?|_/g, "").split(/[.!?]/)[0].trim().slice(0, 50);
}

export async function runCrawlerAudit(): Promise<AuditReport> {
  const origin = publicOrigin().replace(/\/+$/, "");
  const browserUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

  // The newest published post: real article text that must be in the HTML.
  const post = storage.listBlogPosts().find((p: any) => (p.status ?? "published") === "published");
  const path = post ? `/blog/${post.slug}` : "/";
  const probe = post ? bodyProbe(post.body ?? "") : "";
  const visible = (html: string) => (probe ? html.includes(probe.slice(0, 40)) : /<h1[\s>]/i.test(html));

  let robotsTxt = "";
  let robotsFound = false;
  try {
    const r = await get(`${origin}/robots.txt`, browserUa);
    robotsFound = r.status === 200;
    if (robotsFound) robotsTxt = r.text;
  } catch {
    robotsFound = false;
  }
  const groups = parseRobots(robotsTxt);
  let llmsTxt = false;
  try {
    llmsTxt = (await get(`${origin}/llms.txt`, browserUa)).status === 200;
  } catch {
    llmsTxt = false;
  }

  const crawlers: CrawlerResult[] = [];
  for (const c of CRAWLERS) {
    const robots = robotsAllows(groups, c.token, path);
    let fetchRes: CrawlerResult["fetch"] = null;
    if (c.ua) {
      try {
        const r = await get(`${origin}${path}`, c.ua);
        fetchRes = { status: r.status, contentVisible: r.status === 200 && visible(r.text) };
      } catch (err: any) {
        fetchRes = { status: 0, contentVisible: false, error: String(err?.message ?? err).slice(0, 120) };
      }
    }
    crawlers.push({
      token: c.token,
      owner: c.owner,
      role: c.role,
      robots,
      fetch: fetchRes,
      ok: robots.allowed && (!fetchRes || fetchRes.contentVisible),
    });
  }
  const report: AuditReport = {
    at: new Date().toISOString(),
    testedUrl: `${origin}${path}`,
    robotsFound,
    sitemapListed: /^\s*sitemap\s*:/im.test(robotsTxt),
    llmsTxt,
    crawlers,
    blocked: crawlers.filter((c) => !c.ok).length,
  };
  sqlite.prepare("INSERT INTO ai_crawler_audits (created_at, report) VALUES (?, ?)").run(report.at, JSON.stringify(report));
  sqlite.prepare("DELETE FROM ai_crawler_audits WHERE id NOT IN (SELECT id FROM ai_crawler_audits ORDER BY id DESC LIMIT 20)").run();
  return report;
}

export function latestCrawlerAudit(): AuditReport | null {
  const r = sqlite.prepare("SELECT report FROM ai_crawler_audits ORDER BY id DESC LIMIT 1").get() as any;
  if (!r) return null;
  try {
    return JSON.parse(r.report);
  } catch {
    return null;
  }
}

let auditing = false;
export function auditRunning(): boolean {
  return auditing;
}

/** Start an audit in the background unless one is running. */
export function startCrawlerAudit(): boolean {
  if (auditing) return false;
  auditing = true;
  runCrawlerAudit()
    .then((r) => {
      if (r.blocked) console.warn(`[crawler-audit] ${r.blocked} crawler(s) can't read ${r.testedUrl}`);
    })
    .catch((e) => console.error("[crawler-audit] failed:", e?.message ?? e))
    .finally(() => {
      auditing = false;
    });
  return true;
}
