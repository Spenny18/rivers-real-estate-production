// Generating community reports, keeping them, and doing it every month.
//
// A report is (scope, property class, period). Generating one renders both
// pages, writes the PDF and the two PNGs under the uploads root — so they are
// served at /uploads/reports/... like any other media, and a link to a PDF can
// go straight into an email — and records the row in market_reports.
//
// The "monthly set" is the list of reports Spencer sends every month (the
// presets table). On the second of each month, once the previous month is
// complete and the history sync has had a day to catch late closings, the
// cron generates every preset for that month that doesn't exist yet.

import fs from "node:fs";
import path from "node:path";
import { storage } from "./storage";
import { ensureUploadsDir } from "./uploads";
import { PROPERTY_CLASSES, isValidPeriod, type ClassFilter, type Scope } from "./market-stats";
import { buildReportData, defaultReportPeriod, renderReport } from "./market-report-render";

export interface ReportRequest {
  kind: "city" | "subdivision";
  name: string;
  city?: string | null;
  cls: ClassFilter;
  period?: string;
}

export function parseReportRequest(q: Record<string, unknown>): ReportRequest | { error: string } {
  const kind = String(q.kind ?? "subdivision");
  const name = String(q.name ?? "").trim();
  const cls = String(q.cls ?? "all");
  const city = q.city ? String(q.city).trim() : null;
  const period = q.period ? String(q.period) : undefined;
  if (kind !== "city" && kind !== "subdivision") return { error: "kind must be city or subdivision" };
  if (!name) return { error: "name is required" };
  if (cls !== "all" && !(PROPERTY_CLASSES as readonly string[]).includes(cls)) return { error: "unknown property class" };
  if (period && !isValidPeriod(period)) return { error: "period must be YYYY-MM" };
  return { kind, name, city, cls: cls as ClassFilter, period };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface StoredReport {
  id: number;
  period: string;
  kind: string;
  name: string;
  city: string | null;
  cls: string;
  title: string;
  subtitle: string;
  pdfUrl: string;
  png1Url: string;
  png2Url: string;
  generatedAt: string;
}

export function toStored(row: Record<string, any>): StoredReport {
  return {
    id: row.id,
    period: row.period,
    kind: row.kind,
    name: row.name,
    city: row.city ?? null,
    cls: row.cls,
    title: row.title,
    subtitle: row.subtitle,
    pdfUrl: `/uploads/${row.pdfPath}`,
    png1Url: `/uploads/${row.png1Path}`,
    png2Url: `/uploads/${row.png2Path}`,
    generatedAt: row.generatedAt,
  };
}

/** Render one report and keep it. Overwrites an existing one for the same key. */
export async function generateReport(req: ReportRequest): Promise<StoredReport> {
  const period = req.period ?? defaultReportPeriod();
  const scope: Scope = { kind: req.kind, name: req.name, city: req.city ?? undefined };
  const data = buildReportData(scope, req.cls, period);
  const rendered = await renderReport(data);

  const dir = ensureUploadsDir(path.join("reports", period));
  const base = `${slug(req.name)}-${req.cls}`;
  const pdfPath = path.join("reports", period, `${base}.pdf`);
  const png1Path = path.join("reports", period, `${base}-1.png`);
  const png2Path = path.join("reports", period, `${base}-2.png`);
  fs.writeFileSync(path.join(dir, `${base}.pdf`), rendered.pdf);
  fs.writeFileSync(path.join(dir, `${base}-1.png`), rendered.png[0]);
  fs.writeFileSync(path.join(dir, `${base}-2.png`), rendered.png[1]);

  const id = storage.upsertMarketReport({
    period,
    kind: req.kind,
    name: req.name,
    city: req.city ?? null,
    cls: req.cls,
    title: data.title,
    subtitle: data.subtitle,
    pdfPath,
    png1Path,
    png2Path,
    statsJson: JSON.stringify(data),
  });
  return toStored(storage.getMarketReport(id)!);
}

// ---- Generate the monthly set -----------------------------------------------------

export interface BatchProgress {
  running: boolean;
  period: string | null;
  total: number;
  done: number;
  current: string | null;
  errors: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

const batch: BatchProgress = {
  running: false,
  period: null,
  total: 0,
  done: 0,
  current: null,
  errors: [],
  startedAt: null,
  finishedAt: null,
};

export function getBatchProgress(): BatchProgress {
  return { ...batch, errors: [...batch.errors] };
}

/**
 * Every preset for a period. `onlyMissing` skips ones already generated for
 * that period, which is what the cron wants; the button regenerates all.
 */
export async function generateAllPresets(period: string, onlyMissing = false): Promise<BatchProgress> {
  if (batch.running) return getBatchProgress();
  const presets = storage.listReportPresets();
  const existing = new Set(
    storage.listMarketReports(period).map((r) => `${r.kind}|${r.name}|${r.city ?? ""}|${r.cls}`),
  );
  const todo = onlyMissing ? presets.filter((p) => !existing.has(`${p.kind}|${p.name}|${p.city ?? ""}|${p.cls}`)) : presets;

  Object.assign(batch, {
    running: true,
    period,
    total: todo.length,
    done: 0,
    current: null,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
  try {
    for (const p of todo) {
      batch.current = `${p.name} · ${p.cls}`;
      try {
        await generateReport({ kind: p.kind as "city" | "subdivision", name: p.name, city: p.city, cls: p.cls as ClassFilter, period });
      } catch (e: any) {
        batch.errors.push(`${p.name} ${p.cls}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      batch.done++;
    }
  } finally {
    batch.running = false;
    batch.current = null;
    batch.finishedAt = new Date().toISOString();
  }
  if (todo.length > 0) console.log(`[market-reports] ${period}: generated ${todo.length - batch.errors.length}/${todo.length}`);
  return getBatchProgress();
}

// ---- Monthly cron -----------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

function mountainDayOfMonth(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", day: "numeric" }).format(now));
}

/**
 * From the 2nd of the month, make sure last month's set exists. Hourly check,
 * cheap when there is nothing to do; idempotent because it only fills gaps.
 */
export async function ensureMonthlyReports(now = new Date()): Promise<void> {
  if (mountainDayOfMonth(now) < 2) return;
  if (storage.listReportPresets().length === 0) return;
  if (storage.mlsHistorySummary().sold === 0) return; // nothing to report from yet
  await generateAllPresets(defaultReportPeriod(now), true);
}

export function startMarketReportCron() {
  if (timer) return;
  setTimeout(() => {
    ensureMonthlyReports().catch((e) => console.error("[market-reports] uncaught:", e));
  }, 5 * 60 * 1000); // after the first history sync has had a chance to run
  timer = setInterval(() => {
    ensureMonthlyReports().catch((e) => console.error("[market-reports] uncaught:", e));
  }, 60 * 60 * 1000);
  console.log("[market-reports] monthly set scheduled (from the 2nd, hourly check)");
}
