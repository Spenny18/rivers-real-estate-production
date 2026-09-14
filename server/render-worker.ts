// The render worker: one report job per process.
//
// Rasterising three pages at print resolution and binding the PDF takes a
// few hundred megabytes of native memory that Node does not hand back to the
// operating system afterwards, and a few seconds of CPU during which nothing
// else runs. Inside the web server that meant a machine that grew by ~60MB
// per report until Fly killed it, and a health check that could miss its
// deadline mid-render. So the work happens here, in a child the host forks
// per job; when this process exits, every byte comes back.
//
// Protocol: the host sends one message, this process renders, writes the
// files it was told to, replies, and exits. Nothing here opens the database.

import fs from "node:fs";
import { pngsToPdf, renderPage1, renderPage2, renderPage3, svgToPng, type ReportData } from "./report-pages";

export type RenderJob =
  | { kind: "report"; data: ReportData; out: { pdf: string; png: [string, string, string] }; title: string }
  | { kind: "page"; data: ReportData; page: 1 | 2 | 3; scale: number; out: string };

export type RenderReply = { ok: true } | { ok: false; error: string };

export async function runJob(job: RenderJob): Promise<void> {
  if (job.kind === "page") {
    const svg = job.page === 1 ? renderPage1(job.data) : job.page === 2 ? renderPage2(job.data) : renderPage3(job.data);
    fs.writeFileSync(job.out, svgToPng(svg, job.scale));
    return;
  }
  const svg = [renderPage1(job.data), renderPage2(job.data), renderPage3(job.data)];
  const png = svg.map((s) => svgToPng(s));
  const pdf = await pngsToPdf(png, { title: job.title, subject: "Community market report" });
  fs.writeFileSync(job.out.pdf, pdf);
  png.forEach((buf, i) => fs.writeFileSync(job.out.png[i], buf));
}

// Only the forked child takes this branch. The host bundle also contains this
// module (for runJob and the types), so the check is on the env var the host
// sets when forking, never on require.main — which is the host's own module
// there, and would have the web server exit itself five seconds after boot.
if (process.env.RENDER_WORKER === "1") {
  process.once("message", (job: RenderJob) => {
    runJob(job)
      .then(() => {
        process.send!({ ok: true } satisfies RenderReply, undefined, undefined, () => process.exit(0));
      })
      .catch((e: any) => {
        process.send!({ ok: false, error: String(e?.stack ?? e?.message ?? e).slice(0, 2000) } satisfies RenderReply, undefined, undefined, () => process.exit(1));
      });
  });
  // The host has 5s to send the job; otherwise this process was orphaned.
  setTimeout(() => process.exit(2), 5000).unref();
}
