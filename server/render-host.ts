// Runs report renders in a child process, one at a time.
//
// See render-worker.ts for why. In production the worker is the sibling
// bundle dist/render-worker.cjs; in development (tsx, no bundle) the same
// code runs in-process, which is fine on a laptop and keeps the dev loop
// simple. Jobs are queued so two admin tabs pressing Regenerate at once
// cannot double the machine's peak memory.

import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { periodLong, type ReportData } from "./report-pages";
import { runJob, type RenderJob, type RenderReply } from "./render-worker";

const JOB_TIMEOUT_MS = 120_000;

function workerPath(): string | null {
  // Bundled: dist/index.cjs sits next to dist/render-worker.cjs.
  if (typeof __filename === "string" && __filename.endsWith(".cjs")) {
    const p = path.join(path.dirname(__filename), "render-worker.cjs");
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

function runInChild(job: RenderJob, worker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { execArgv: [], env: { ...process.env, RENDER_WORKER: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(new Error(`Render timed out after ${JOB_TIMEOUT_MS / 1000}s`));
    }, JOB_TIMEOUT_MS);
    child.once("message", (reply: RenderReply) => (reply.ok ? done() : done(new Error(reply.error))));
    child.once("error", (e) => done(e));
    child.once("exit", (code, signal) => {
      if (!settled) done(new Error(signal === "SIGKILL" ? "Render worker was killed (out of memory?)" : `Render worker exited with code ${code}`));
    });
    child.send(job);
  });
}

// One job at a time.
let chain: Promise<unknown> = Promise.resolve();
function enqueue(job: RenderJob): Promise<void> {
  const worker = workerPath();
  const run = () => (worker ? runInChild(job, worker) : runJob(job));
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** Render all three pages and the PDF straight to the given paths. */
export function renderReportToFiles(data: ReportData, out: { pdf: string; png: [string, string, string] }): Promise<void> {
  return enqueue({ kind: "report", data, out, title: `${data.title} ${data.subtitle} market report — ${periodLong(data.period)}` });
}

/** One page as a PNG buffer — the admin preview. */
export async function renderPageToPng(data: ReportData, page: 1 | 2 | 3, scale: number): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `report-preview-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await enqueue({ kind: "page", data, page, scale, out: tmp });
    return fs.readFileSync(tmp);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}
