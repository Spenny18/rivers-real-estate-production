// Admin API for the monthly market report.
//
// Behind requireAuth throughout. The rendered graphic is not secret — it goes
// to several hundred clients — but the half-finished draft with gaps in it is,
// and so is the ability to change the figures.

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import {
  CITYWIDE,
  PROPERTY_TYPES,
  buildReport,
  isValidPeriod,
  periodLabel,
  previousMonth,
  renderInfographic,
  sameMonthLastYear,
} from "./market-report";
import { CLASS_LABEL, PROPERTY_CLASSES, listScopes, series, type ClassFilter } from "./market-stats";
import { buildReportData, defaultReportPeriod, renderPage1, renderPage2, svgToPng } from "./market-report-render";
import { generateAllPresets, generateReport, getBatchProgress, parseReportRequest, toStored } from "./market-report-store";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/** Current month as YYYY-MM in Mountain time, which is the market being reported on. */
function currentPeriod(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}`;
}

/** Accepts a number, a numeric string, "$766,300", or blank for "leave alone". */
function num(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function registerMarketRoutes(app: Express, deps: { requireAuth: Middleware }) {
  const { requireAuth } = deps;

  // ---- Computed statistics (from the feed) ----------------------------------
  // Registered ahead of /:period so "scopes" and "series" are not read as
  // month names.

  /** Cities and subdivisions that have sales in the history table. */
  app.get("/api/admin/market/scopes", requireAuth, (_req, res) => {
    res.json(listScopes());
  });

  /**
   * Monthly series for one scope and property class.
   *
   *   ?kind=subdivision&name=Springbank%20Hill&cls=detached&months=13
   *   ?kind=city&name=Calgary&cls=all&months=25
   */
  app.get("/api/admin/market/series", requireAuth, (req, res) => {
    const kind = String(req.query.kind ?? "city");
    const name = String(req.query.name ?? "").trim();
    const cls = String(req.query.cls ?? "all");
    const months = Math.max(1, Math.min(121, Number(req.query.months ?? 13) || 13));
    const city = req.query.city ? String(req.query.city).trim() : undefined;
    const end = req.query.end ? String(req.query.end) : undefined;

    if (kind !== "city" && kind !== "subdivision") return res.status(400).json({ message: "kind must be city or subdivision" });
    if (!name) return res.status(400).json({ message: "name is required" });
    if (cls !== "all" && !(PROPERTY_CLASSES as readonly string[]).includes(cls)) {
      return res.status(400).json({ message: `cls must be one of ${[...PROPERTY_CLASSES, "all"].join(", ")}` });
    }
    if (end && !isValidPeriod(end)) return res.status(400).json({ message: "end must be YYYY-MM" });

    const scope = { kind, name, city } as const;
    res.json({
      scope,
      cls,
      label: CLASS_LABEL[cls as ClassFilter],
      months: series(scope, cls as ClassFilter, months, end),
    });
  });

  // ---- Community reports ------------------------------------------------------

  /** The monthly set. */
  app.get("/api/admin/market/reports/presets", requireAuth, (_req, res) => {
    res.json({ presets: storage.listReportPresets() });
  });

  app.post("/api/admin/market/reports/presets", requireAuth, (req, res) => {
    const parsed = parseReportRequest(req.body ?? {});
    if ("error" in parsed) return res.status(400).json({ message: parsed.error });
    storage.addReportPreset({ kind: parsed.kind, name: parsed.name, city: parsed.city ?? null, cls: parsed.cls });
    res.json({ ok: true, presets: storage.listReportPresets() });
  });

  app.delete("/api/admin/market/reports/presets/:id", requireAuth, (req, res) => {
    const id = Number((req.params as any).id);
    if (!id) return res.status(400).json({ message: "invalid id" });
    storage.deleteReportPreset(id);
    res.json({ ok: true, presets: storage.listReportPresets() });
  });

  /** Generated reports, newest period first, optionally for one period. */
  app.get("/api/admin/market/reports", requireAuth, (req, res) => {
    const period = req.query.period ? String(req.query.period) : undefined;
    if (period && !isValidPeriod(period)) return res.status(400).json({ message: "period must be YYYY-MM" });
    res.json({
      reports: storage.listMarketReports(period).map(toStored),
      defaultPeriod: defaultReportPeriod(),
      batch: getBatchProgress(),
    });
  });

  /**
   * One page as PNG, rendered on the fly and not kept — the admin preview.
   * Served as an image so the page can show it with an authenticated fetch.
   */
  app.get("/api/admin/market/reports/preview", requireAuth, async (req, res) => {
    const parsed = parseReportRequest(req.query as Record<string, unknown>);
    if ("error" in parsed) return res.status(400).json({ message: parsed.error });
    const page = Number(req.query.page) === 2 ? 2 : 1;
    try {
      const scope = { kind: parsed.kind, name: parsed.name, city: parsed.city ?? undefined } as const;
      const data = buildReportData(scope, parsed.cls, parsed.period ?? defaultReportPeriod());
      const svg = page === 1 ? renderPage1(data) : renderPage2(data);
      res.type("png").send(svgToPng(svg, 1.5));
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Render failed" });
    }
  });

  /** Render, save, and record one report. */
  app.post("/api/admin/market/reports/generate", requireAuth, async (req, res) => {
    const parsed = parseReportRequest(req.body ?? {});
    if ("error" in parsed) return res.status(400).json({ message: parsed.error });
    try {
      res.json({ ok: true, report: await generateReport(parsed) });
    } catch (e: any) {
      res.status(500).json({ message: e?.message ?? "Generate failed" });
    }
  });

  /** Every preset for a period, in the background; poll GET /reports for progress. */
  app.post("/api/admin/market/reports/generate-all", requireAuth, (req, res) => {
    const period = req.body?.period ? String(req.body.period) : defaultReportPeriod();
    if (!isValidPeriod(period)) return res.status(400).json({ message: "period must be YYYY-MM" });
    if (getBatchProgress().running) return res.status(409).json({ message: "A batch is already running." });
    if (storage.listReportPresets().length === 0) return res.status(400).json({ message: "The monthly set is empty." });
    generateAllPresets(period, false).catch((e) => console.error("[market-reports] batch failed:", e));
    res.json({ ok: true, message: "Generating" });
  });

  /** The assembled report for a period, with its comparison months. */
  app.get("/api/admin/market/:period", requireAuth, (req, res) => {
    const period = String((req.params as any).period ?? "");
    if (!isValidPeriod(period)) return res.status(400).json({ message: "Period must be YYYY-MM" });

    const report = buildReport(period);
    // The raw stored figures too, so the form can be populated for all three
    // months without a second round trip — entering last year's numbers is
    // part of setting this up, not an edge case.
    const periods = [period, previousMonth(period), sameMonthLastYear(period)];
    res.json({
      report,
      figures: storage.listMarketStats(periods),
      periods: {
        present: { key: period, label: periodLabel(period) },
        lastMonth: { key: previousMonth(period), label: periodLabel(previousMonth(period)) },
        lastYear: { key: sameMonthLastYear(period), label: periodLabel(sameMonthLastYear(period)) },
      },
      propertyTypes: PROPERTY_TYPES,
      citywideKey: CITYWIDE,
    });
  });

  /** Which periods have figures, plus a sensible default to open on. */
  app.get("/api/admin/market", requireAuth, (_req, res) => {
    res.json({ periods: storage.listMarketPeriods(), current: currentPeriod() });
  });

  /**
   * Save figures for one period.
   *
   * Merging, not replacing — see upsertMarketStats. A field omitted entirely is
   * left as it was; a field sent as null or "" is cleared.
   */
  app.put("/api/admin/market/:period", requireAuth, (req, res) => {
    const period = String((req.params as any).period ?? "");
    if (!isValidPeriod(period)) return res.status(400).json({ message: "Period must be YYYY-MM" });

    const entries = Array.isArray(req.body?.figures) ? req.body.figures : [];
    const valid = [...PROPERTY_TYPES, CITYWIDE] as string[];
    const clean: Array<Record<string, any>> = [];
    for (const e of entries) {
      const t = String(e?.propertyType ?? "");
      if (!valid.includes(t)) {
        return res.status(400).json({ message: `Unknown property type: ${t}` });
      }
      clean.push({
        propertyType: t,
        benchmarkPrice: num(e.benchmarkPrice),
        sales: num(e.sales),
        activeListings: num(e.activeListings),
        avgDom: num(e.avgDom),
      });
    }
    // A cleared field has to be written explicitly, because the upsert coalesces.
    for (const e of clean) {
      for (const [field, column] of [
        ["benchmarkPrice", "benchmarkPrice"],
        ["sales", "sales"],
        ["activeListings", "activeListings"],
        ["avgDom", "avgDom"],
      ] as const) {
        if (e[field] === null) {
          try {
            storage.clearMarketStat(period, e.propertyType, column);
          } catch {
            /* nothing stored for that type yet — nothing to clear */
          }
        }
      }
    }
    storage.upsertMarketStats(period, clean as any);

    if (req.body?.commentary !== undefined || req.body?.headline !== undefined) {
      storage.setMarketCommentary(
        period,
        req.body?.headline != null ? String(req.body.headline).slice(0, 300) : null,
        req.body?.commentary != null ? String(req.body.commentary).slice(0, 6000) : null,
      );
    }
    res.json({ ok: true, report: buildReport(period) });
  });

  /**
   * The graphic on its own.
   *
   * `format=html` returns a full standalone document for the admin preview
   * iframe; the default returns the fragment that gets embedded in the
   * newsletter, so the preview shows exactly what will be sent.
   */
  app.get("/api/admin/market/:period/infographic", requireAuth, (req, res) => {
    const period = String((req.params as any).period ?? "");
    if (!isValidPeriod(period)) return res.status(400).json({ message: "Period must be YYYY-MM" });

    const fragment = renderInfographic(buildReport(period));
    if (req.query.format === "html") {
      res.type("html").send(
        `<!doctype html><html><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@400;600;700&display=swap">` +
          `</head><body style="margin:0;padding:16px;background-color:#F4F4F4;">${fragment}</body></html>`,
      );
      return;
    }
    res.json({ html: fragment });
  });
}
