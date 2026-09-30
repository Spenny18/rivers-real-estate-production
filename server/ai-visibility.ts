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

export function intervalDays(): number {
  const n = Number(process.env.AI_VIS_INTERVAL_DAYS);
  return Number.isFinite(n) && n >= 1 ? n : 7;
}

export function report() {
  const engines = configuredEngines();
  const prompts = listPrompts();
  const runs = (sqlite.prepare("SELECT * FROM ai_vis_runs ORDER BY id DESC LIMIT 12").all() as any[]).map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    trigger: r.trigger,
    promptCount: r.prompt_count,
    error: r.error,
    engines: engineSummary(
      (sqlite.prepare("SELECT * FROM ai_vis_results WHERE run_id = ?").all(r.id) as any[]).map(rowToResult),
    ),
  }));
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
  };
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
  timer = setInterval(maybeRun, 60 * 60 * 1000);
  timer.unref?.();
  console.log(`[ai-visibility] check every ${intervalDays()} days (hourly due-check)`);
}
