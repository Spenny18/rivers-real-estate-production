// The two-page community market report, rendered from the stats engine.
//
// This replaces the PDF Real Info Box produced per community and property
// type. Same two pages, same reading order, so a client who has received the
// old one recognises the new one:
//
//   Page 1  the price. Median sold price with month-over-month and
//           year-over-year change, a 13-month line, and ten-year annual
//           medians for the community and for the city it sits in.
//   Page 2  the activity. Active and sold counts, a 13-month comparison,
//           the listing absorption rate (sold ÷ active — the "odds of
//           selling"), and average days on market, each with 13 months of
//           history.
//
// Two departures from the original, both deliberate. The headline is a median
// of real sales rather than the board's modelled benchmark, by Spencer's
// choice, and it is labelled as a median everywhere. And the absorption donut
// is a meter with a hero number: a donut is the wrong form for one value.
//
// The drawing itself lives in report-pages.ts, which is pure and is what the
// render worker loads; this module assembles the data from the stats engine
// and re-exports the pages so callers need one import.

import { annualMedians, CLASS_LABEL, currentPeriod, priceBands, series, shiftPeriod, type ClassFilter, type Scope } from "./market-stats";
import type { ReportData } from "./report-pages";

export * from "./report-pages";

/** Last complete month: a report dated the 12th should not show a half month. */
export function defaultReportPeriod(now = new Date()): string {
  return shiftPeriod(currentPeriod(now), -1);
}

export function buildReportData(scope: Scope, cls: ClassFilter, period = defaultReportPeriod()): ReportData {
  const cityName = scope.kind === "city" ? scope.name : scope.city ?? "Calgary";
  const cityScope: Scope = { kind: "city", name: cityName };
  const endYear = Number(period.slice(0, 4));
  const at = new Date(Date.UTC(endYear, Number(period.slice(5)) - 1, 15));
  return {
    scope,
    cls,
    period,
    title: scope.name,
    subtitle: CLASS_LABEL[cls],
    cityName,
    months: series(scope, cls, 13, period),
    communityYears: annualMedians(scope, cls, 10, at),
    cityYears: scope.kind === "city" ? [] : annualMedians(cityScope, cls, 10, at),
    bands: priceBands(scope, cls, period, 12),
    generatedAt: new Date().toISOString(),
  };
}

