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
