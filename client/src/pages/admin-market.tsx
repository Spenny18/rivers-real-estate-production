// /admin/market — the monthly market report.
//
// Enter the board's published figures for a month; see the graphic that will
// go out. Three months are editable at once because that is how the graphic
// works: it compares this month against last month and the same month a year
// ago, so setting it up for the first time means entering all three.

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, TriangleAlert, CheckCircle2, ExternalLink } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Figure {
  period: string;
  propertyType: string;
  benchmarkPrice: number | null;
  sales: number | null;
  activeListings: number | null;
  avgDom: number | null;
}

interface MarketPayload {
  report: {
    period: string;
    periodLabel: string;
    absorptionRate: number | null;
    marketStatus: string | null;
    missing: string[];
    complete: boolean;
  };
  figures: Figure[];
  periods: Record<"present" | "lastMonth" | "lastYear", { key: string; label: string }>;
  propertyTypes: string[];
  citywideKey: string;
}

const TYPE_LABEL: Record<string, string> = {
  detached: "Detached",
  semi_detached: "Semi-Detached",
  row: "Row",
  apartment: "Apartment",
  all: "Citywide",
};

/** Keyed as `${period}:${propertyType}:${field}` so one flat map holds the form. */
type Draft = Record<string, string>;
const key = (p: string, t: string, f: string) => `${p}:${t}:${f}`;

function currentPeriod(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

export default function AdminMarketPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [period, setPeriod] = useState(currentPeriod());
  const [draft, setDraft] = useState<Draft>({});

  const { data, isLoading } = useQuery<MarketPayload>({
    queryKey: [`/api/admin/market/${period}`],
  });

  // Seed the form from what's stored whenever the period changes. Anything the
  // user has since typed wins — this only fills, never overwrites.
  useEffect(() => {
    if (!data) return;
    const seeded: Draft = {};
    for (const f of data.figures) {
      for (const field of ["benchmarkPrice", "sales", "activeListings", "avgDom"] as const) {
        const v = f[field];
        if (v != null) seeded[key(f.period, f.propertyType, field)] = String(v);
      }
    }
    setDraft((prev) => ({ ...seeded, ...prev }));
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      // Send each of the three months separately — they're distinct records,
      // and a failure part-way should leave the others saved rather than
      // silently roll everything back.
      const months = data ? [data.periods.present, data.periods.lastMonth, data.periods.lastYear] : [];
      for (const m of months) {
        const figures = [...(data?.propertyTypes ?? []), data?.citywideKey ?? "all"].map((t) => ({
          propertyType: t,
          benchmarkPrice: draft[key(m.key, t, "benchmarkPrice")] ?? "",
          sales: draft[key(m.key, t, "sales")] ?? "",
          activeListings: draft[key(m.key, t, "activeListings")] ?? "",
          avgDom: draft[key(m.key, t, "avgDom")] ?? "",
        }));
        await apiRequest("PUT", `/api/admin/market/${m.key}`, { figures });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/admin/market/${period}`] });
      setPreviewNonce(Date.now());
      toast({ title: "Saved", description: "The graphic below is regenerated." });
    },
    onError: (e) =>
      toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // The preview is fetched and injected, not pointed at with an iframe src.
  //
  // An iframe's src is a plain browser navigation: it cannot carry the bearer
  // token apiRequest attaches, so it falls back to the session cookie — and
  // those are held in memory and die on every deploy. The preview would then
  // show {"message":"Unauthorized"} until the next sign-in, which is exactly
  // the failure the CRM probe hit. srcDoc sidesteps it entirely.
  const [previewNonce, setPreviewNonce] = useState(0);
  const { data: previewHtml, isFetching: previewLoading } = useQuery<string>({
    queryKey: [`market-preview`, period, previewNonce],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/market/${period}/infographic`);
      const { html } = (await res.json()) as { html: string };
      return (
        `<!doctype html><html><head><meta charset="utf-8">` +
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@400;600;700&display=swap">` +
        `</head><body style="margin:0;padding:16px;background-color:#F4F4F4;">${html}</body></html>`
      );
    },
  });

  /** Full-size view, from the fetched markup rather than a second authed request. */
  function openFullSize() {
    if (!previewHtml) return;
    const url = URL.createObjectURL(new Blob([previewHtml], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    // Give the new tab time to load before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const months = data ? [data.periods.present, data.periods.lastMonth, data.periods.lastYear] : [];
  const set = (p: string, t: string, f: string, v: string) =>
    setDraft((d) => ({ ...d, [key(p, t, f)]: v }));

  return (
    <AppShell
      pageTitle="Market Report"
      pageActions={
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || isLoading}
          data-testid="button-save-market"
          className="rounded-sm font-display tracking-[0.16em] text-[11px]"
        >
          {save.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> SAVING…
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-1.5" /> SAVE FIGURES
            </>
          )}
        </Button>
      }
    >
      <div className="px-8 py-7 max-w-[1500px]">
        <div className="flex flex-wrap items-end gap-4 mb-6">
          <div>
            <label className="eyebrow text-muted-foreground block mb-1.5">Reporting month</label>
            <Input
              type="month"
              value={period}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
              data-testid="input-market-period"
              className="rounded-sm w-48"
            />
          </div>
          {data && (
            <div className="flex flex-wrap items-center gap-2 pb-1.5">
              {data.report.complete ? (
                <Badge variant="outline" className="text-[10px] tracking-[0.1em] border-emerald-500 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="w-3 h-3 mr-1.5" /> READY TO SEND
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] tracking-[0.1em] border-amber-500 text-amber-700 dark:text-amber-500">
                  <TriangleAlert className="w-3 h-3 mr-1.5" /> {data.report.missing.length} FIGURE
                  {data.report.missing.length === 1 ? "" : "S"} MISSING
                </Badge>
              )}
              {data.report.marketStatus && (
                <Badge variant="outline" className="text-[10px] tracking-[0.1em]">
                  {data.report.marketStatus.toUpperCase()}
                  {data.report.absorptionRate != null && ` · ${data.report.absorptionRate.toFixed(2)}%`}
                </Badge>
              )}
            </div>
          )}
        </div>

        {data && !data.report.complete && (
          <Card className="mb-5 border-amber-300 dark:border-amber-900">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Still needed before this can go out:{" "}
                <span className="text-foreground">{data.report.missing.join("; ")}</span>. The graphic
                renders anyway with a dash in place of anything absent, so you can see it taking shape.
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_640px]">
          {/* ---- Figures ---- */}
          <div className="space-y-5">
            {months.map((m, mi) => (
              <Card key={m.key}>
                <CardContent className="p-5">
                  <div className="flex items-baseline gap-2.5 mb-4">
                    <h2 className="font-serif text-xl">{m.label}</h2>
                    <span className="eyebrow text-muted-foreground">
                      {mi === 0 ? "This month" : mi === 1 ? "Last month" : "A year ago"}
                    </span>
                  </div>

                  <div className="eyebrow text-muted-foreground mb-2">Benchmark price by type</div>
                  <div className="grid gap-2.5 sm:grid-cols-2 mb-5">
                    {(data?.propertyTypes ?? []).map((t) => (
                      <label key={t} className="block">
                        <span className="text-[12px] text-muted-foreground block mb-1">{TYPE_LABEL[t] ?? t}</span>
                        <Input
                          inputMode="numeric"
                          placeholder="—"
                          value={draft[key(m.key, t, "benchmarkPrice")] ?? ""}
                          onChange={(e) => set(m.key, t, "benchmarkPrice", e.target.value)}
                          data-testid={`input-${m.key}-${t}-benchmark`}
                          className="rounded-sm tabular-nums"
                        />
                      </label>
                    ))}
                  </div>

                  <div className="eyebrow text-muted-foreground mb-2">Citywide</div>
                  <div className="grid gap-2.5 sm:grid-cols-3">
                    {(
                      [
                        ["activeListings", "Active listings"],
                        ["sales", "Sales"],
                        ["avgDom", "Avg. days on market"],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={field} className="block">
                        <span className="text-[12px] text-muted-foreground block mb-1">{label}</span>
                        <Input
                          inputMode="numeric"
                          placeholder="—"
                          value={draft[key(m.key, data?.citywideKey ?? "all", field)] ?? ""}
                          onChange={(e) => set(m.key, data?.citywideKey ?? "all", field, e.target.value)}
                          data-testid={`input-${m.key}-${field}`}
                          className="rounded-sm tabular-nums"
                        />
                      </label>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}

            <Card>
              <CardContent className="p-5">
                <h3 className="font-display text-[11px] tracking-[0.16em] text-muted-foreground mb-2">
                  WHERE THESE COME FROM
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  The Calgary Real Estate Board publishes these each month. Benchmark price is their
                  Home Price Index — a modelled price for a typical home of that type, not an average
                  of sales — which is why it's entered rather than calculated from your MLS feed. A
                  median worked out from raw sales would be a different number, and it would disagree
                  with the board, the Herald, and every other agent's newsletter.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* ---- Preview ---- */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <span className="eyebrow text-muted-foreground">
                What your clients will see
                {previewLoading && <Loader2 className="w-3 h-3 ml-2 inline animate-spin" />}
              </span>
              <button
                type="button"
                onClick={openFullSize}
                disabled={!previewHtml}
                className="text-[12px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                Open full size <ExternalLink className="w-3 h-3" />
              </button>
            </div>
            <iframe
              srcDoc={previewHtml ?? ""}
              title="Market report preview"
              data-testid="market-preview"
              className="w-full rounded-sm border border-border bg-white"
              style={{ height: "1500px" }}
            />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
