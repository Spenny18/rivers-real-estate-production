// /admin/market-reports — the community market reports.
//
// Pick a community (or a city) and a property type, look at the two pages,
// generate and keep the report, and manage the monthly set that the server
// generates on its own from the 2nd of each month.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, FileDown, Loader2, Plus, Trash2, Layers, Image as ImageIcon } from "lucide-react";
import { apiErrorMessage, apiRequest, apiUrl } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Kind = "city" | "subdivision";
type Cls = "detached" | "semi_detached" | "row" | "apartment" | "all";

const CLASS_LABEL: Record<Cls, string> = {
  detached: "Detached",
  semi_detached: "Semi-Detached",
  row: "Row",
  apartment: "Apartment",
  all: "All residential",
};

interface ScopeOption {
  name: string;
  city?: string;
  sales: number;
}
interface Scopes {
  cities: ScopeOption[];
  subdivisions: ScopeOption[];
  floor: string | null;
}
interface Preset {
  id: number;
  kind: Kind;
  name: string;
  city: string | null;
  cls: Cls;
}
interface StoredReport {
  id: number;
  period: string;
  kind: Kind;
  name: string;
  city: string | null;
  cls: Cls;
  title: string;
  subtitle: string;
  pdfUrl: string;
  png1Url: string;
  png2Url: string;
  generatedAt: string;
}
interface ReportsPayload {
  reports: StoredReport[];
  defaultPeriod: string;
  batch: {
    running: boolean;
    period: string | null;
    total: number;
    done: number;
    current: string | null;
    errors: string[];
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function periodLabel(p: string): string {
  return `${MONTHS[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;
}
function shift(p: string, n: number): string {
  const [y, m] = p.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Fetch an authenticated image and hand back an object URL for an <img>. */
function useAuthedImage(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    if (!path) {
      setUrl(null);
      return;
    }
    setLoading(true);
    setError(null);
    apiRequest("GET", path)
      .then((r) => r.blob())
      .then((b) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(b);
        setUrl(revoked);
      })
      .catch((e) => !cancelled && setError(apiErrorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [path]);
  return { url, loading, error };
}

export default function AdminMarketReportsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const scopes = useQuery<Scopes>({ queryKey: ["/api/admin/market/scopes"] });
  const presets = useQuery<{ presets: Preset[] }>({ queryKey: ["/api/admin/market/reports/presets"] });
  const reports = useQuery<ReportsPayload>({
    queryKey: ["/api/admin/market/reports"],
    refetchInterval: (q) => (q.state.data?.batch.running ? 3_000 : 60_000),
  });

  const [kind, setKind] = useState<Kind>("subdivision");
  const [name, setName] = useState("");
  const [city, setCity] = useState<string | null>(null);
  const [cls, setCls] = useState<Cls>("detached");
  const [period, setPeriod] = useState<string>("");
  const [search, setSearch] = useState("");
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  useEffect(() => {
    if (reports.data?.defaultPeriod && !period) setPeriod(reports.data.defaultPeriod);
  }, [reports.data?.defaultPeriod, period]);

  const periods = useMemo(() => {
    const base = reports.data?.defaultPeriod;
    if (!base) return [];
    return Array.from({ length: 13 }, (_, i) => shift(base, -i));
  }, [reports.data?.defaultPeriod]);

  const options = useMemo(() => {
    const list = kind === "city" ? scopes.data?.cities ?? [] : scopes.data?.subdivisions ?? [];
    const q = search.trim().toLowerCase();
    return (q ? list.filter((o) => o.name.toLowerCase().includes(q)) : list).slice(0, 40);
  }, [scopes.data, kind, search]);

  const query = name && period ? `kind=${kind}&name=${encodeURIComponent(name)}${city ? `&city=${encodeURIComponent(city)}` : ""}&cls=${cls}&period=${period}` : null;
  const page1 = useAuthedImage(previewKey ? `/api/admin/market/reports/preview?${previewKey}&page=1` : null);
  const page2 = useAuthedImage(previewKey ? `/api/admin/market/reports/preview?${previewKey}&page=2` : null);

  const generate = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/market/reports/generate", { kind, name, city, cls, period });
      return (await r.json()) as { report: StoredReport };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/market/reports"] });
      toast({ title: "Report saved", description: `${r.report.title} · ${r.report.subtitle} · ${periodLabel(r.report.period)}` });
    },
    onError: (e) => toast({ title: "Couldn't generate", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const addPreset = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/market/reports/presets", { kind, name, city, cls }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/market/reports/presets"] });
      toast({ title: "Added to the monthly set" });
    },
    onError: (e) => toast({ title: "Couldn't add", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const removePreset = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/market/reports/presets/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/market/reports/presets"] }),
  });

  const generateAll = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/market/reports/generate-all", { period }),
    onSuccess: () => {
      toast({ title: "Generating the monthly set", description: "This page updates as each report lands." });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["/api/admin/market/reports"] }), 800);
    },
    onError: (e) => toast({ title: "Couldn't start", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const batch = reports.data?.batch;
  const forPeriod = (reports.data?.reports ?? []).filter((r) => r.period === period);
  const presetList = presets.data?.presets ?? [];
  const isPreset = presetList.some((p) => p.kind === kind && p.name === name && (p.city ?? null) === (city ?? null) && p.cls === cls);

  return (
    <AppShell
      pageTitle="Community Reports"
      pageActions={
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => generateAll.mutate()}
            disabled={generateAll.isPending || !!batch?.running || presetList.length === 0 || !period}
            className="rounded-sm font-display tracking-[0.16em] text-[11px]"
            data-testid="button-generate-all"
          >
            {batch?.running ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Layers className="w-4 h-4 mr-1.5" />}
            {batch?.running ? `${batch.done}/${batch.total}…` : `GENERATE SET · ${period ? periodLabel(period).toUpperCase() : ""}`}
          </Button>
        </div>
      }
    >
      <div className="px-8 py-7 space-y-6 max-w-7xl">
        {/* Picker */}
        <Card>
          <CardContent className="p-5">
            <div className="grid gap-4 lg:grid-cols-[160px_1fr_180px_190px]">
              <div>
                <label className="eyebrow text-muted-foreground block mb-1.5">Scope</label>
                <Select value={kind} onValueChange={(v) => { setKind(v as Kind); setName(""); setCity(null); }}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="subdivision">Community</SelectItem>
                    <SelectItem value="city">City / town</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="eyebrow text-muted-foreground block mb-1.5">
                  {kind === "city" ? "City" : "Community"} {name ? `· ${name}${city ? ` (${city})` : ""}` : ""}
                </label>
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={scopes.isLoading ? "Loading…" : `Search ${kind === "city" ? "cities" : "communities"} with sales…`}
                  className="h-10"
                  data-testid="input-scope-search"
                />
                {search && (
                  <div className="mt-1 max-h-48 overflow-y-auto rounded-sm border border-border bg-background text-[13px]">
                    {options.length === 0 && <div className="px-3 py-2 text-muted-foreground">No match</div>}
                    {options.map((o) => (
                      <button
                        key={`${o.name}|${o.city ?? ""}`}
                        type="button"
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-secondary"
                        onClick={() => { setName(o.name); setCity(o.city ?? null); setSearch(""); }}
                      >
                        <span>{o.name}{o.city && kind === "subdivision" ? <span className="text-muted-foreground"> · {o.city}</span> : null}</span>
                        <span className="text-muted-foreground tabular-nums">{o.sales} sales</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="eyebrow text-muted-foreground block mb-1.5">Property type</label>
                <Select value={cls} onValueChange={(v) => setCls(v as Cls)}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CLASS_LABEL) as Cls[]).map((k) => (
                      <SelectItem key={k} value={k}>{CLASS_LABEL[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="eyebrow text-muted-foreground block mb-1.5">Month</label>
                <Select value={period} onValueChange={setPeriod}>
                  <SelectTrigger className="h-10"><SelectValue placeholder="…" /></SelectTrigger>
                  <SelectContent>
                    {periods.map((p) => (
                      <SelectItem key={p} value={p}>{periodLabel(p)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => setPreviewKey(query)}
                disabled={!query}
                className="rounded-sm font-display tracking-[0.16em] text-[11px]"
                data-testid="button-preview"
              >
                <Eye className="w-4 h-4 mr-1.5" /> PREVIEW
              </Button>
              <Button
                variant="outline"
                onClick={() => generate.mutate()}
                disabled={!query || generate.isPending}
                className="rounded-sm font-display tracking-[0.16em] text-[11px]"
                data-testid="button-generate"
              >
                {generate.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <FileDown className="w-4 h-4 mr-1.5" />}
                GENERATE &amp; SAVE
              </Button>
              <Button
                variant="ghost"
                onClick={() => addPreset.mutate()}
                disabled={!name || isPreset || addPreset.isPending}
                className="rounded-sm font-display tracking-[0.16em] text-[11px]"
                data-testid="button-add-preset"
              >
                <Plus className="w-4 h-4 mr-1.5" /> {isPreset ? "IN THE MONTHLY SET" : "ADD TO MONTHLY SET"}
              </Button>
              {scopes.data?.floor && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Sold history from {scopes.data.floor}. Earlier months show N/A.
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Preview */}
        {previewKey && (
          <div className="grid gap-4 lg:grid-cols-2">
            {[page1, page2].map((p, i) => (
              <Card key={i}>
                <CardContent className="p-3">
                  <div className="eyebrow text-muted-foreground mb-2">Page {i + 1}</div>
                  {p.loading && <div className="flex h-96 items-center justify-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>}
                  {p.error && <div className="text-sm text-destructive">{p.error}</div>}
                  {p.url && <img src={p.url} alt={`Report page ${i + 1}`} className="w-full border border-border" data-testid={`img-preview-${i + 1}`} />}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Monthly set */}
          <Card>
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <h2 className="font-serif text-lg" style={{ letterSpacing: "-0.01em" }}>Monthly set</h2>
                <span className="eyebrow text-muted-foreground">{presetList.length} report{presetList.length === 1 ? "" : "s"}</span>
              </div>
              <div className="px-5 py-3 text-xs text-muted-foreground">
                Generated on its own from the 2nd of each month for the month just ended. Add the communities and property types you send.
              </div>
              {presetList.length === 0 ? (
                <div className="px-5 pb-5 text-sm text-muted-foreground">Nothing yet. Pick a community above and add it.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {presetList.map((p) => (
                    <li key={p.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                      <span>
                        {p.name}
                        {p.kind === "subdivision" && p.city ? <span className="text-muted-foreground"> · {p.city}</span> : null}
                        <Badge variant="outline" className="ml-2 text-[10px] tracking-[0.1em]">{CLASS_LABEL[p.cls]}</Badge>
                      </span>
                      <Button variant="ghost" size="icon" onClick={() => removePreset.mutate(p.id)} aria-label="Remove" data-testid={`button-remove-preset-${p.id}`}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {batch?.errors?.length ? (
                <div className="px-5 py-3 text-xs text-destructive border-t border-border">
                  {batch.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Generated */}
          <Card>
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <h2 className="font-serif text-lg" style={{ letterSpacing: "-0.01em" }}>
                  Generated · {period ? periodLabel(period) : ""}
                </h2>
                <span className="eyebrow text-muted-foreground">{forPeriod.length}</span>
              </div>
              {forPeriod.length === 0 ? (
                <div className="px-5 py-5 text-sm text-muted-foreground">No reports for this month yet.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {forPeriod.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                      <span>
                        {r.title} <span className="text-muted-foreground">· {r.subtitle}</span>
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <a href={apiUrl(r.pdfUrl)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-secondary" data-testid={`link-pdf-${r.id}`}>
                          <FileDown className="w-3.5 h-3.5" /> PDF
                        </a>
                        <a href={apiUrl(r.png1Url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-secondary">
                          <ImageIcon className="w-3.5 h-3.5" /> 1
                        </a>
                        <a href={apiUrl(r.png2Url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-secondary">
                          <ImageIcon className="w-3.5 h-3.5" /> 2
                        </a>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
