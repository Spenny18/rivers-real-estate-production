// AI search visibility tracker (/admin/ai-visibility).
//
// AI assistants publish no impressions, so visibility is measured the way the
// commercial trackers do it: ask each assistant the questions buyers and
// sellers ask, through its API with web search on, and read the answers.
// Per answer we record whether Spencer / the sites are named or cited, where
// Spencer ranks among the agents it recommends, and which competitors it
// names instead. Runs weekly (and on demand); every answer is kept so trends
// and the raw text can be inspected.
//
// Engines (each is skipped when its key is missing):
//   ChatGPT     OPENAI_API_KEY      Responses API + web_search
//               AI_VIS_OPENAI_MODEL (default gpt-5-mini)
//   Perplexity  PERPLEXITY_API_KEY  Sonar API (searches the web itself)
//               AI_VIS_PERPLEXITY_MODEL (default sonar)
// Competitor extraction uses Claude (ANTHROPIC_API_KEY, AI_VIS_EXTRACT_MODEL,
// default claude-opus-5-5 at low effort); without it, competitors come from
// the cited domains only.
// AI_VIS_INTERVAL_DAYS (default 7) sets the schedule; AI_VIS_AUTORUN=0 stops it.

import Anthropic from "@anthropic-ai/sdk";
import { sqlite } from "./storage";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS ai_vis_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_vis_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,            -- running | done | failed
    trigger TEXT NOT NULL,           -- manual | schedule
    engines TEXT NOT NULL DEFAULT '[]',
    prompt_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS ai_vis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    prompt_id INTEGER NOT NULL,
    prompt_text TEXT NOT NULL,
    engine TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    citations TEXT NOT NULL DEFAULT '[]',
    mentioned INTEGER NOT NULL DEFAULT 0,
    cited INTEGER NOT NULL DEFAULT 0,
    position INTEGER,
    competitors TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ai_vis_results_run ON ai_vis_results(run_id);
`);

// ---------------------------------------------------------------------------
// Brand + engines
// ---------------------------------------------------------------------------

/** How Spencer shows up in an answer. Names are matched case-insensitively. */
const BRAND_NAMES = ["Spencer Rivers", "Rivers Real Estate", "Luxury Homes Calgary"];
const BRAND_DOMAINS = ["riversrealestate.ca", "luxuryhomescalgary.ca"];
const BRAND_RE = new RegExp(
  [...BRAND_NAMES, ...BRAND_DOMAINS].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

export type Engine = "chatgpt" | "perplexity";
export const ENGINE_LABELS: Record<Engine, string> = { chatgpt: "ChatGPT", perplexity: "Perplexity" };

export function configuredEngines(): Engine[] {
  const out: Engine[] = [];
  if (process.env.OPENAI_API_KEY) out.push("chatgpt");
  if (process.env.PERPLEXITY_API_KEY) out.push("perplexity");
  return out;
}

const SYSTEM_HINT =
  "The person asking lives in or is moving to Calgary, Alberta, Canada. Answer as you normally would, " +
  "naming specific people, companies and websites where that helps.";

export interface EngineAnswer {
  text: string;
  citations: { url: string; title?: string }[];
}

async function askChatGpt(question: string): Promise<EngineAnswer> {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.AI_VIS_OPENAI_MODEL || "gpt-5-mini",
      instructions: SYSTEM_HINT,
      input: question,
      tools: [{ type: "web_search" }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  const parts: string[] = [];
  const citations: EngineAnswer["citations"] = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c?.type !== "output_text") continue;
      parts.push(c.text ?? "");
      for (const a of c.annotations ?? []) {
        if (a?.type === "url_citation" && a.url) citations.push({ url: a.url, title: a.title });
      }
    }
  }
  const text = parts.join("\n").trim() || String(data?.output_text ?? "").trim();
  if (!text) throw new Error("OpenAI returned no answer text");
  return { text, citations: dedupe(citations) };
}

async function askPerplexity(question: string): Promise<EngineAnswer> {
  const base = (process.env.PERPLEXITY_BASE_URL || "https://api.perplexity.ai").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
    body: JSON.stringify({
      model: process.env.AI_VIS_PERPLEXITY_MODEL || "sonar",
      messages: [
        { role: "system", content: SYSTEM_HINT },
        { role: "user", content: question },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("Perplexity returned no answer text");
  const citations: EngineAnswer["citations"] = [
    ...(data?.search_results ?? []).map((r: any) => ({ url: r?.url, title: r?.title })),
    ...(data?.citations ?? []).map((u: any) => ({ url: typeof u === "string" ? u : u?.url })),
  ].filter((c) => typeof c.url === "string" && c.url);
  return { text, citations: dedupe(citations) };
}

function dedupe(cs: EngineAnswer["citations"]): EngineAnswer["citations"] {
  const seen = new Set<string>();
  return cs.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Answer analysis
// ---------------------------------------------------------------------------

export interface Analysis {
  mentioned: boolean;
  cited: boolean;
  position: number | null;
  competitors: string[];
}

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["recommended"],
  properties: {
    recommended: {
      type: "array",
      description:
        "Every real estate agent, team or brokerage the answer names or recommends, in the order they first appear. Use the name as written. Exclude portals (Realtor.ca, Zillow), news sites and associations.",
      items: { type: "string" },
    },
  },
} as const;

/** Agents/brokerages named in the answer, in order of appearance (Claude). */
async function extractNamed(answer: string): Promise<string[] | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const model = process.env.AI_VIS_EXTRACT_MODEL?.trim() || "claude-opus-5-5";
  const client = new Anthropic();
  const msg = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    ...(model === "claude-opus-5-5"
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {}),
    output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACT_SCHEMA as any } },
    system:
      "You read an AI assistant's answer about real estate and list the real estate agents, teams and brokerages it names. " +
      "Return only names that appear in the answer.",
    messages: [{ role: "user", content: `<answer>\n${answer.slice(0, 20000)}\n</answer>` }],
  } as any);
  if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") return null;
  const text = msg.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  try {
    const out = JSON.parse(text);
    return Array.isArray(out?.recommended) ? out.recommended.map((s: any) => String(s).trim()).filter(Boolean) : null;
  } catch {
    return null;
  }
}

export async function analyseAnswer(a: EngineAnswer): Promise<Analysis> {
  const mentionedByText = BRAND_RE.test(a.text);
  const cited = a.citations.some((c) => BRAND_DOMAINS.some((d) => hostOf(c.url).endsWith(d)));
  let named: string[] | null = null;
  try {
    named = await extractNamed(a.text);
  } catch (err: any) {
    console.warn("[ai-visibility] extraction failed:", err?.message ?? err);
  }
  let position: number | null = null;
  let competitors: string[];
  if (named) {
    const idx = named.findIndex((n) => BRAND_RE.test(n));
    position = idx >= 0 ? idx + 1 : null;
    competitors = named.filter((n) => !BRAND_RE.test(n));
  } else {
    // No extractor: the cited sites are the best available competitor signal.
    competitors = Array.from(
      new Set(a.citations.map((c) => hostOf(c.url)).filter((h) => h && !BRAND_DOMAINS.some((d) => h.endsWith(d)))),
    );
  }
  return { mentioned: mentionedByText || cited || position !== null, cited, position, competitors };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const DEFAULT_PROMPTS = [
  "Who is the best luxury real estate agent in Calgary?",
  "Who should I hire to sell my luxury home in Calgary?",
  "Best realtor to sell a $2 million home in Calgary",
  "Top real estate agents in Calgary for homes over $1 million",
  "Who is the best realtor in Aspen Woods, Calgary?",
  "Best real estate agent for Springbank Hill Calgary",
  "Who sells the most homes in Upper Mount Royal Calgary?",
  "Best realtor for Elbow Park and Britannia in Calgary",
  "Who is a good luxury condo specialist realtor in Calgary?",
  "Best realtor in Calgary for empty nesters downsizing",
  "Which Calgary realtor is best for relocating from Vancouver or Toronto?",
  "How do I choose a luxury listing agent in Calgary?",
  "What are the best luxury neighbourhoods in Calgary?",
  "Best neighbourhoods in Calgary for a $2 million budget",
  "Is Aspen Woods or Springbank Hill better for a luxury home in Calgary?",
  "What is the Calgary luxury real estate market like right now?",
  "How long do luxury homes take to sell in Calgary?",
  "How should I price my luxury home in Calgary?",
  "Are off-market luxury listings common in Calgary?",
  "Who are the top Calgary realtors with CLHMS certification?",
];

export interface Prompt {
  id: number;
  text: string;
  active: boolean;
}

export function listPrompts(): Prompt[] {
  let rows = sqlite.prepare("SELECT * FROM ai_vis_prompts ORDER BY id").all() as any[];
  if (rows.length === 0) {
    const ins = sqlite.prepare("INSERT OR IGNORE INTO ai_vis_prompts (text, active, created_at) VALUES (?, 1, ?)");
    const now = new Date().toISOString();
    for (const t of DEFAULT_PROMPTS) ins.run(t, now);
    rows = sqlite.prepare("SELECT * FROM ai_vis_prompts ORDER BY id").all() as any[];
  }
  return rows.map((r) => ({ id: r.id, text: r.text, active: Boolean(r.active) }));
}

export const MAX_PROMPTS = 60;

export function addPrompt(text: string): Prompt {
  const t = text.trim().slice(0, 300);
  if (!t) throw new Error("Question is empty");
  if (listPrompts().length >= MAX_PROMPTS) throw new Error(`Up to ${MAX_PROMPTS} questions`);
  const r = sqlite
    .prepare("INSERT INTO ai_vis_prompts (text, active, created_at) VALUES (?, 1, ?)")
    .run(t, new Date().toISOString());
  return { id: Number(r.lastInsertRowid), text: t, active: true };
}

export function updatePrompt(id: number, patch: { text?: string; active?: boolean }): void {
  if (typeof patch.text === "string" && patch.text.trim()) {
    sqlite.prepare("UPDATE ai_vis_prompts SET text = ? WHERE id = ?").run(patch.text.trim().slice(0, 300), id);
  }
  if (typeof patch.active === "boolean") {
    sqlite.prepare("UPDATE ai_vis_prompts SET active = ? WHERE id = ?").run(patch.active ? 1 : 0, id);
  }
}

export function deletePrompt(id: number): void {
  sqlite.prepare("DELETE FROM ai_vis_prompts WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

let running: number | null = null;

export function isRunning(): boolean {
  return running !== null;
}

async function withEngine(engine: Engine, q: string): Promise<EngineAnswer> {
  return engine === "chatgpt" ? askChatGpt(q) : askPerplexity(q);
}

/** Start a run in the background; returns its id. */
export function startRun(trigger: "manual" | "schedule"): number {
  if (running !== null) throw new Error("A check is already running");
  const engines = configuredEngines();
  if (!engines.length) throw new Error("No AI engine is configured (OPENAI_API_KEY or PERPLEXITY_API_KEY)");
  const prompts = listPrompts().filter((p) => p.active);
  if (!prompts.length) throw new Error("No active questions to check");
  const id = Number(
    sqlite
      .prepare(
        "INSERT INTO ai_vis_runs (started_at, status, trigger, engines, prompt_count) VALUES (?, 'running', ?, ?, ?)",
      )
      .run(new Date().toISOString(), trigger, JSON.stringify(engines), prompts.length).lastInsertRowid,
  );
  running = id;
  const insert = sqlite.prepare(
    `INSERT INTO ai_vis_results
       (run_id, prompt_id, prompt_text, engine, answer, citations, mentioned, cited, position, competitors, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const jobs = prompts.flatMap((p) => engines.map((e) => ({ p, e })));
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { p, e } = job;
      try {
        const ans = await withEngine(e, p.text);
        const an = await analyseAnswer(ans);
        insert.run(
          id, p.id, p.text, e, ans.text, JSON.stringify(ans.citations), an.mentioned ? 1 : 0, an.cited ? 1 : 0,
          an.position, JSON.stringify(an.competitors), null, new Date().toISOString(),
        );
      } catch (err: any) {
        insert.run(id, p.id, p.text, e, "", "[]", 0, 0, null, "[]", String(err?.message ?? err).slice(0, 500), new Date().toISOString());
      }
    }
  };
  // Three at a time keeps a 20-question run to a few minutes without
  // tripping rate limits.
  Promise.all([worker(), worker(), worker()])
    .then(() => {
      const failed = (sqlite.prepare("SELECT COUNT(*) AS n FROM ai_vis_results WHERE run_id = ? AND error IS NOT NULL").get(id) as any).n;
      const total = prompts.length * engines.length;
      sqlite
        .prepare("UPDATE ai_vis_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
        .run(failed === total ? "failed" : "done", new Date().toISOString(), failed ? `${failed} of ${total} checks failed` : null, id);
      console.log(`[ai-visibility] run ${id} finished (${total - failed}/${total} ok)`);
    })
    .catch((err) => {
      sqlite
        .prepare("UPDATE ai_vis_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
        .run(new Date().toISOString(), String(err?.message ?? err), id);
    })
    .finally(() => {
      running = null;
    });
  return id;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface ResultRow {
  promptId: number;
  prompt: string;
  engine: Engine;
  answer: string;
  citations: { url: string; title?: string }[];
  mentioned: boolean;
  cited: boolean;
  position: number | null;
  competitors: string[];
  error: string | null;
}

function rowToResult(r: any): ResultRow {
  const parse = (s: string, d: any) => {
    try {
      return JSON.parse(s);
    } catch {
      return d;
    }
  };
  return {
    promptId: r.prompt_id,
    prompt: r.prompt_text,
    engine: r.engine,
    answer: r.answer,
    citations: parse(r.citations, []),
    mentioned: Boolean(r.mentioned),
    cited: Boolean(r.cited),
    position: r.position ?? null,
    competitors: parse(r.competitors, []),
    error: r.error ?? null,
  };
}

function engineSummary(rows: ResultRow[]) {
  const by: Record<string, { engine: string; checked: number; mentioned: number; cited: number; errors: number }> = {};
  for (const r of rows) {
    const e = (by[r.engine] ??= { engine: r.engine, checked: 0, mentioned: 0, cited: 0, errors: 0 });
    if (r.error) {
      e.errors++;
      continue;
    }
    e.checked++;
    if (r.mentioned) e.mentioned++;
    if (r.cited) e.cited++;
  }
  return Object.values(by);
}

/** Normalise a competitor name for counting ("Jane Doe - RE/MAX" ≈ "jane doe"). */
function compKey(name: string): string {
  return name.toLowerCase().replace(/\s*[-–—|,(].*$/, "").replace(/[^a-z0-9& ]/g, "").trim();
}

/**
 * Share of voice: every name the answers recommend, Spencer included,
 * counted once per answer. Rank is 1 + the number of names named in more
 * answers, so equal counts share a rank ("tied #2").
 */
export function leaderboard(rows: ResultRow[]) {
  const YOU = "__you__";
  const by = new Map<string, { name: string; answers: number; isYou: boolean }>();
  let answers = 0;
  for (const r of rows) {
    if (r.error) continue;
    answers++;
    const keys = new Set<string>();
    if (r.mentioned) keys.add(YOU);
    for (const c of r.competitors) {
      const k = compKey(c);
      if (k && !keys.has(k)) {
        keys.add(k);
        if (!by.has(k)) by.set(k, { name: c, answers: 0, isYou: false });
      }
    }
    for (const k of Array.from(keys)) {
      const e = by.get(k) ?? { name: "Spencer Rivers (you)", answers: 0, isYou: true };
      e.answers++;
      by.set(k, e);
    }
  }
  const list = Array.from(by.values()).sort((a, b) => b.answers - a.answers || Number(b.isYou) - Number(a.isYou));
  const rankOf = (n: number) => 1 + list.filter((x) => x.answers > n).length;
  const ranked = list.map((x) => ({ ...x, rank: rankOf(x.answers), tied: list.filter((y) => y.answers === x.answers).length > 1 }));
  const you = ranked.find((x) => x.isYou) ?? null;
  return {
    answers,
    names: ranked.length,
    you: you ? { rank: you.rank, tied: you.tied, answers: you.answers } : null,
    top: ranked.slice(0, 30),
  };
}

const OWN_DOMAINS = ["riversrealestate.ca", "luxuryhomescalgary.ca"];

/**
 * Third-party sites the answers lean on, across every question: the places
 * worth getting listed, reviewed or published on. Ranked by how many
 * questions cite them where Spencer was NOT named — those are the gaps.
 */
export function citedSources(rows: ResultRow[]) {
  const by = new Map<string, { host: string; questions: Set<string>; gaps: Set<string>; engines: Set<string>; example: string }>();
  for (const r of rows) {
    if (r.error) continue;
    const hosts = new Set(r.citations.map((c) => hostOf(c.url)).filter((h) => h && !OWN_DOMAINS.some((d) => h.endsWith(d))));
    for (const h of Array.from(hosts)) {
      const e = by.get(h) ?? { host: h, questions: new Set(), gaps: new Set(), engines: new Set(), example: "" };
      e.questions.add(r.prompt);
      if (!r.mentioned) e.gaps.add(r.prompt);
      e.engines.add(r.engine);
      if (!e.example) e.example = r.citations.find((c) => hostOf(c.url) === h)?.url ?? "";
      by.set(h, e);
    }
  }
  return Array.from(by.values())
    .sort((a, b) => b.gaps.size - a.gaps.size || b.questions.size - a.questions.size)
    .slice(0, 20)
    .map((e) => ({
      host: e.host,
      questions: e.questions.size,
      gaps: e.gaps.size,
      engines: Array.from(e.engines),
      example: e.example,
      gapQuestions: Array.from(e.gaps),
    }));
}

export function intervalDays(): number {
  const n = Number(process.env.AI_VIS_INTERVAL_DAYS);
  return Number.isFinite(n) && n >= 1 ? n : 7;
}

export function report() {
  const engines = configuredEngines();
  const prompts = listPrompts();
  const runs = (sqlite.prepare("SELECT * FROM ai_vis_runs ORDER BY id DESC LIMIT 12").all() as any[]).map((r) => {
    const rows = (sqlite.prepare("SELECT * FROM ai_vis_results WHERE run_id = ?").all(r.id) as any[]).map(rowToResult);
    const lb = leaderboard(rows);
    return {
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      trigger: r.trigger,
      promptCount: r.prompt_count,
      error: r.error,
      engines: engineSummary(rows),
      rank: lb.you ? { rank: lb.you.rank, tied: lb.you.tied, of: lb.names } : null,
    };
  });
  const latest = runs.find((r) => r.status !== "running") ?? null;
  const results = latest
    ? (sqlite.prepare("SELECT * FROM ai_vis_results WHERE run_id = ? ORDER BY prompt_id, engine").all(latest.id) as any[]).map(rowToResult)
    : [];

  const counts = new Map<string, { name: string; count: number; engines: Set<string>; prompts: Set<string> }>();
  for (const r of results) {
    for (const c of r.competitors) {
      const k = compKey(c);
      if (!k) continue;
      const e = counts.get(k) ?? { name: c, count: 0, engines: new Set(), prompts: new Set() };
      e.count++;
      e.engines.add(r.engine);
      e.prompts.add(r.prompt);
      counts.set(k, e);
    }
  }
  const competitors = Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map((c) => ({ name: c.name, mentions: c.count, engines: Array.from(c.engines), prompts: Array.from(c.prompts) }));

  const lastDone = runs.find((r) => r.status === "done" || r.status === "failed");
  const nextRunAt =
    process.env.AI_VIS_AUTORUN === "0" || !engines.length
      ? null
      : new Date((lastDone ? Date.parse(lastDone.startedAt) : Date.now()) + intervalDays() * 86_400_000).toISOString();

  return {
    engines: { chatgpt: engines.includes("chatgpt"), perplexity: engines.includes("perplexity") },
    extractor: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    running: isRunning(),
    schedule: { intervalDays: intervalDays(), nextRunAt },
    // Rough per-run cost: ~$0.02 per engine check with web search, plus
    // ~$0.01 per answer for the Claude extraction.
    estimatedCostPerRun: Number(
      (prompts.filter((p) => p.active).length * engines.length * 0.03).toFixed(2),
    ),
    prompts,
    runs,
    latestRunId: latest?.id ?? null,
    results,
    competitors,
    shareOfVoice: leaderboard(results),
    sources: citedSources(results),
  };
}

// ---------------------------------------------------------------------------
// Per-question context for "Improve" (server/seo-fix.ts, kind "ai_question")
// ---------------------------------------------------------------------------

export interface QuestionContext {
  promptId: number;
  question: string;
  checkedAt: string | null;
  results: Array<{
    engine: Engine;
    mentioned: boolean;
    cited: boolean;
    position: number | null;
    competitors: string[];
    citations: { url: string; title?: string }[];
    answer: string;
    error: string | null;
  }>;
}

/** The question and its answers from the most recent check that covered it. */
export function questionContext(promptId: number): QuestionContext | null {
  const p = sqlite.prepare("SELECT * FROM ai_vis_prompts WHERE id = ?").get(promptId) as any;
  if (!p) return null;
  const last = sqlite
    .prepare("SELECT run_id, created_at FROM ai_vis_results WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1")
    .get(promptId) as any;
  const rows = last
    ? (sqlite.prepare("SELECT * FROM ai_vis_results WHERE prompt_id = ? AND run_id = ?").all(promptId, last.run_id) as any[])
    : [];
  return {
    promptId,
    question: p.text,
    checkedAt: last?.created_at ?? null,
    results: rows.map(rowToResult).map((r) => ({
      engine: r.engine,
      mentioned: r.mentioned,
      cited: r.cited,
      position: r.position,
      competitors: r.competitors,
      citations: r.citations,
      answer: r.answer,
      error: r.error,
    })),
  };
}

// ---------------------------------------------------------------------------
// Question suggestions
// ---------------------------------------------------------------------------
// Claude proposes questions worth tracking, weighing demand (Search Console
// impressions for related queries — the only volume signal we have; AI
// assistants publish none), likelihood of conversion (hiring intent, and
// GA4 key events on the page that would answer it) and how close we already
// are. One suggestion set is kept; asking again replaces it.

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS ai_vis_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,            -- generating | ready | failed
    items TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    model TEXT
  );
`);

const LEVELS = ["high", "medium", "low"] as const;
type Level = (typeof LEVELS)[number];

export interface QuestionSuggestion {
  question: string;
  relatedQuery: string;
  demand: Level;
  demandEvidence: string;
  conversion: Level;
  conversionWhy: string;
  lowHanging: Level;
  lowHangingWhy: string;
  bestPage: string;
  score: number;
}

const SUGGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "question", "relatedQuery", "demand", "demandEvidence", "conversion", "conversionWhy",
          "lowHanging", "lowHangingWhy", "bestPage", "score",
        ],
        properties: {
          question: { type: "string", description: "Phrased the way a person would ask ChatGPT." },
          relatedQuery: { type: "string", description: "The Search Console query behind it, or \"\"." },
          demand: { type: "string", enum: [...LEVELS] },
          demandEvidence: { type: "string" },
          conversion: { type: "string", enum: [...LEVELS] },
          conversionWhy: { type: "string" },
          lowHanging: { type: "string", enum: [...LEVELS] },
          lowHangingWhy: { type: "string" },
          bestPage: { type: "string", description: "Live path best placed to win it, or \"\"." },
          score: { type: "integer", description: "0–100 overall priority." },
        },
      },
    },
  },
} as const;

const SUGGEST_SYSTEM = `You pick the questions a Calgary luxury real estate agent should track in AI assistants (ChatGPT, Perplexity). The agent is Spencer Rivers (REALTOR®, CLHMS, Certified Condo Specialist, Rivers Real Estate / Synterra Realty); the site is riversrealestate.ca. Clients are mostly $1M+ buyers and sellers, condo buyers, downsizers and relocations.

Suggest up to 15 NEW questions (never repeat or reword one already tracked). Rate each on:
- demand: how many people plausibly ask it. Base this on the Search Console data supplied (impressions for the related query over the last 90 days). Quote the numbers in demandEvidence, e.g. "Search Console: 1,240 impressions/90d for 'luxury realtor calgary'". When no supplied query relates, say "No Search Console data — estimated" and rate conservatively. Never invent numbers.
- conversion: how likely someone asking it is to become a client. Hiring and pricing questions ("who should I hire", "best realtor for", "how much is my home worth") are high; market and neighbourhood research is medium; general information is low. Where the page that would answer it has GA4 key events, mention them.
- lowHanging: how quickly it can be won. High when the site already ranks in Google's top 20 for the related query, already has a strong page on it, or the assistants already name Spencer for a close question; low when nothing on the site covers it.
- score: 0–100 overall, weighing conversion most, then low-hanging, then demand.
Phrase questions the way people type them into ChatGPT (full sentences, Calgary named). Prefer specific neighbourhoods, price points and situations over generic ones. bestPage must be a path from the supplied page list, or "".`;

function levelOf(v: any): Level {
  return LEVELS.includes(v) ? v : "low";
}

export function latestSuggestions() {
  suggestionsRunning(); // clears a row left behind by a restart
  const r = sqlite.prepare("SELECT * FROM ai_vis_suggestions ORDER BY id DESC LIMIT 1").get() as any;
  if (!r) return null;
  let items: QuestionSuggestion[] = [];
  try {
    items = JSON.parse(r.items);
  } catch {
    items = [];
  }
  // Hide ones added since the suggestions were made.
  const tracked = new Set(listPrompts().map((p) => normQ(p.text)));
  return {
    status: r.status as "generating" | "ready" | "failed",
    createdAt: r.created_at as string,
    error: (r.error as string | null) ?? null,
    items: items.filter((s) => !tracked.has(normQ(s.question))),
  };
}

function normQ(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/** Data the suggestion prompt is built from. Separate so it can be tested. */
export interface SuggestInputs {
  gscQueries: Array<{ query: string; impressions: number; clicks: number; position: number; page: string; keyEvents: number }>;
  pages: Array<{ path: string; title: string }>;
}

function suggestPrompt(inp: SuggestInputs): string {
  const rep = report();
  const status = new Map<number, string>();
  for (const r of rep.results) {
    const s = r.error ? "error" : r.mentioned ? `named${r.position ? ` #${r.position}` : ""}` : "not named";
    status.set(r.promptId, `${status.get(r.promptId) ? `${status.get(r.promptId)}, ` : ""}${ENGINE_LABELS[r.engine]}: ${s}`);
  }
  const parts: string[] = [];
  parts.push(
    `# Questions already tracked (latest result)\n${rep.prompts
      .map((p) => `- ${p.text}${status.has(p.id) ? ` — ${status.get(p.id)}` : ""}`)
      .join("\n")}`,
  );
  if (rep.competitors.length) {
    parts.push(`# Competitors the assistants name most\n${rep.competitors.slice(0, 12).map((c) => `- ${c.name} (${c.mentions}×)`).join("\n")}`);
  }
  parts.push(
    inp.gscQueries.length
      ? `# Search Console queries (last 90 days; position is the average Google rank; key events are GA4 conversions on that page)\n${inp.gscQueries
          .map((q) => `- "${q.query}" — ${q.impressions} impr, ${q.clicks} clicks, pos ${q.position.toFixed(1)}, page ${q.page}${q.keyEvents ? `, ${q.keyEvents} key events` : ""}`)
          .join("\n")}`
      : "# Search Console queries\nNot available — rate demand as estimated.",
  );
  parts.push(`# Live pages\n${inp.pages.map((p) => `${p.path} | ${p.title.slice(0, 80)}`).join("\n")}`);
  return parts.join("\n\n");
}

export function suggestionsRunning(): boolean {
  const r = sqlite.prepare("SELECT id, status, created_at FROM ai_vis_suggestions ORDER BY id DESC LIMIT 1").get() as any;
  if (r?.status !== "generating") return false;
  // A restart mid-generation leaves the row behind; don't let it block forever.
  if (Date.now() - Date.parse(r.created_at) > 10 * 60_000) {
    sqlite.prepare("UPDATE ai_vis_suggestions SET status = 'failed', error = 'Interrupted — try again' WHERE id = ?").run(r.id);
    return false;
  }
  return true;
}

/** Start generating suggestions in the background. */
export function startSuggestions(loadInputs: () => Promise<SuggestInputs>): number {
  if (suggestionsRunning()) throw new Error("Suggestions are already being prepared");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Suggestions need ANTHROPIC_API_KEY on the server");
  }
  const id = Number(
    sqlite
      .prepare("INSERT INTO ai_vis_suggestions (created_at, status) VALUES (?, 'generating')")
      .run(new Date().toISOString()).lastInsertRowid,
  );
  (async () => {
    const model = process.env.AI_VIS_SUGGEST_MODEL?.trim() || "claude-opus-5-5";
    const inputs = await loadInputs();
    const client = new Anthropic();
    const msg: any = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      ...(model === "claude-opus-5-5"
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
      output_config: { effort: "medium", format: { type: "json_schema", schema: SUGGEST_SCHEMA as any } },
      system: SUGGEST_SYSTEM,
      messages: [{ role: "user", content: suggestPrompt(inputs) }],
    } as any);
    if (msg.stop_reason === "refusal") throw new Error("Claude declined this request — try again");
    if (msg.stop_reason === "max_tokens") throw new Error("The answer was cut off — try again");
    const text = (msg.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
    const out = JSON.parse(text);
    const tracked = new Set(listPrompts().map((p) => normQ(p.text)));
    const livePaths = new Set(inputs.pages.map((p) => p.path));
    const seen = new Set<string>();
    const items: QuestionSuggestion[] = (Array.isArray(out?.suggestions) ? out.suggestions : [])
      .map((s: any) => ({
        question: String(s?.question ?? "").trim().slice(0, 300),
        relatedQuery: String(s?.relatedQuery ?? "").trim(),
        demand: levelOf(s?.demand),
        demandEvidence: String(s?.demandEvidence ?? ""),
        conversion: levelOf(s?.conversion),
        conversionWhy: String(s?.conversionWhy ?? ""),
        lowHanging: levelOf(s?.lowHanging),
        lowHangingWhy: String(s?.lowHangingWhy ?? ""),
        bestPage: livePaths.has(String(s?.bestPage ?? "")) ? String(s.bestPage) : "",
        score: Math.max(0, Math.min(100, Math.round(Number(s?.score) || 0))),
      }))
      .filter((s: QuestionSuggestion) => {
        const k = normQ(s.question);
        if (!k || tracked.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a: QuestionSuggestion, b: QuestionSuggestion) => b.score - a.score)
      .slice(0, 15);
    sqlite
      .prepare("UPDATE ai_vis_suggestions SET status = 'ready', items = ?, model = ? WHERE id = ?")
      .run(JSON.stringify(items), msg.model || model, id);
  })().catch((err: any) => {
    console.error("[ai-visibility] suggestions failed:", err?.message ?? err);
    sqlite
      .prepare("UPDATE ai_vis_suggestions SET status = 'failed', error = ? WHERE id = ?")
      .run(String(err?.message ?? err).slice(0, 500), id);
  });
  return id;
}

// ---------------------------------------------------------------------------
// Blog queue — "Send to blog routine"
// ---------------------------------------------------------------------------
// A question the assistants don't name Spencer for can be queued for the
// BOFU blog routine, which reads GET /api/public/blog-queue (through a Make
// tool, like the blog list) before its 12-week plan and writes one queued
// question per run. It sends queueId with the draft, which marks the item
// written. Only the question and non-sensitive context are public.

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS ai_vis_blog_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id INTEGER,
    question TEXT NOT NULL,
    best_page TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',   -- queued | written | dismissed
    slug TEXT,
    created_at TEXT NOT NULL,
    done_at TEXT
  );
`);

export interface QueueItem {
  id: number;
  promptId: number | null;
  question: string;
  bestPage: string;
  notes: string;
  status: "queued" | "written" | "dismissed";
  slug: string | null;
  createdAt: string;
  doneAt: string | null;
}

function rowToQueue(r: any): QueueItem {
  return {
    id: r.id,
    promptId: r.prompt_id ?? null,
    question: r.question,
    bestPage: r.best_page,
    notes: r.notes,
    status: r.status,
    slug: r.slug ?? null,
    createdAt: r.created_at,
    doneAt: r.done_at ?? null,
  };
}

export function listBlogQueue(limit = 30): QueueItem[] {
  return (sqlite.prepare("SELECT * FROM ai_vis_blog_queue ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(rowToQueue);
}

/** What the blog routine reads: queued items, oldest first. */
export function publicBlogQueue() {
  return (sqlite.prepare("SELECT * FROM ai_vis_blog_queue WHERE status = 'queued' ORDER BY id").all() as any[])
    .map(rowToQueue)
    .map((q) => ({ queueId: q.id, question: q.question, bestPage: q.bestPage, notes: q.notes, queuedAt: q.createdAt }));
}

export function queueBlogForPrompt(promptId: number, bestPage = ""): QueueItem {
  const ctx = questionContext(promptId);
  if (!ctx) throw new Error("That question is no longer tracked");
  const open = sqlite
    .prepare("SELECT id FROM ai_vis_blog_queue WHERE prompt_id = ? AND status = 'queued'")
    .get(promptId) as any;
  if (open) throw new Error("This question is already queued for the blog routine");
  const ok = ctx.results.filter((r) => !r.error);
  const notNamed = ok.filter((r) => !r.mentioned).map((r) => ENGINE_LABELS[r.engine]);
  const hosts = Array.from(
    new Set(ok.flatMap((r) => r.citations.map((c) => hostOf(c.url))).filter((h) => h && !OWN_DOMAINS.some((d) => h.endsWith(d)))),
  ).slice(0, 8);
  const notes = [
    notNamed.length ? `Not named by ${notNamed.join(" or ")} for this question.` : "Named, but not reliably — strengthen it.",
    hosts.length ? `Sources the assistants relied on: ${hosts.join(", ")}.` : "",
    "Answer the question directly in the first paragraph, name Spencer Rivers (REALTOR®, CLHMS) as the answer where it's honest to do so, and end with a \"## Frequently Asked Questions\" section using ### questions (the site emits FAQPage schema from it).",
  ]
    .filter(Boolean)
    .join(" ");
  const r = sqlite
    .prepare("INSERT INTO ai_vis_blog_queue (prompt_id, question, best_page, notes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(promptId, ctx.question, bestPage, notes, new Date().toISOString());
  return rowToQueue(sqlite.prepare("SELECT * FROM ai_vis_blog_queue WHERE id = ?").get(Number(r.lastInsertRowid)));
}

/** Called when the routine posts a draft with queueId. */
export function markQueueWritten(id: number, slug: string): boolean {
  const r = sqlite
    .prepare("UPDATE ai_vis_blog_queue SET status = 'written', slug = ?, done_at = ? WHERE id = ? AND status = 'queued'")
    .run(slug, new Date().toISOString(), id);
  return r.changes > 0;
}

export function dismissQueueItem(id: number): void {
  sqlite
    .prepare("UPDATE ai_vis_blog_queue SET status = 'dismissed', done_at = ? WHERE id = ? AND status = 'queued'")
    .run(new Date().toISOString(), id);
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

function maybeRun() {
  if (isRunning() || !configuredEngines().length) return;
  const last = sqlite.prepare("SELECT started_at FROM ai_vis_runs ORDER BY id DESC LIMIT 1").get() as any;
  if (last && Date.now() - Date.parse(last.started_at) < intervalDays() * 86_400_000) return;
  try {
    const id = startRun("schedule");
    console.log(`[ai-visibility] scheduled run ${id} started`);
  } catch (err: any) {
    console.warn("[ai-visibility] scheduled run not started:", err?.message ?? err);
  }
}

export function startAiVisibilityCron() {
  if (timer) return;
  if (process.env.NODE_ENV !== "production" || process.env.AI_VIS_AUTORUN === "0") {
    console.log("[ai-visibility] weekly check disabled (not production or AI_VIS_AUTORUN=0)");
    return;
  }
  timer = setInterval(() => {
    maybeRun();
    // The crawler audit runs on the same weekly rhythm.
    import("./ai-crawler-audit")
      .then(({ latestCrawlerAudit, startCrawlerAudit }) => {
        const last = latestCrawlerAudit();
        if (!last || Date.now() - Date.parse(last.at) > intervalDays() * 86_400_000) startCrawlerAudit();
      })
      .catch((e) => console.error("[crawler-audit] schedule failed:", e?.message ?? e));
  }, 60 * 60 * 1000);
  timer.unref?.();
  console.log(`[ai-visibility] check every ${intervalDays()} days (hourly due-check)`);
}
