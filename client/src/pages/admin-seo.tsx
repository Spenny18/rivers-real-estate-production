// /admin/seo — keyword & internal-link console.
//
// Reads the report built by server/seo-keywords.ts, which crawls this app's own
// public routes on demand. Nothing here is hand-maintained: add a neighbourhood
// or publish a post, hit Rescan, and the clusters, scores, conflicts and link
// recommendations all reflect it.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, Search, AlertTriangle, Link2, Unlink, Target, ExternalLink, Save, X, UploadCloud,
  ImageDown,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface ScoreComponent { id: string; label: string; earned: number; max: number; detail: string }
interface PageAnalysis {
  path: string; status: number; title: string; description: string; h1: string;
  wordCount: number; cluster: string; clusterLabel: string; intent: string;
  isPillar: boolean; focusKeyword: string; focusSource: "override" | "derived";
  score: number; grade: "strong" | "fair" | "weak"; components: ScoreComponent[];
  inboundLinks: string[]; outboundLinks: string[]; externalDomains: string[];
  sisterDomainLinks: string[]; schemaTypes: string[];
  conflicts: { path: string; keyword: string; similarity: number }[];
  recommendedInboundFrom: { path: string; reason: string }[];
  suggestedKeyword: string | null; suggestionReason: string | null;
  gsc?: { clicks: number; impressions: number; position: number; topQuery: string | null };
  issues: string[];
}
interface SeoReport {
  ok: boolean; cached: boolean; generatedAt: string; pageCount: number; crawlMs: number;
  gsc: { ok: boolean; message?: string; rows: number };
  summary: { avgScore: number; strong: number; fair: number; weak: number; conflicts: number; orphans: number; missingKeyword: number };
  clusters: { id: string; label: string; pillar: string; headKeyword: string; intent: string; pages: number; avgScore: number; conflicts: number }[];
  pages: PageAnalysis[];
}

const GRADE_STYLES: Record<string, string> = {
  strong: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  fair: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  weak: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

interface SitemapEntry {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  warnings?: number;
  errors?: number;
}
interface ScStatus {
  ok?: boolean;
  connected?: boolean;
  siteUrl?: string;
  sitemaps?: SitemapEntry[];
  lastSubmittedAt?: string;
  reason?: string;
  error?: string;
}

const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "never";

/**
 * Sitemap submission to Search Console.
 *
 * The submit also runs automatically 60s after every deploy (see
 * server/search-console.ts). This card exists so the state is visible and so a
 * submit can be forced without waiting to ship — previously the only way to
 * run one was a fetch() pasted into the browser console.
 *
 * lastDownloaded is the number that actually matters: lastSubmitted only says
 * we asked, while lastDownloaded says Google went and re-read the file.
 */
function SitemapCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ScStatus>({
    queryKey: ["/api/admin/seo/search-console"],
    queryFn: async () => {
      const r = await fetch("/api/admin/seo/search-console", { credentials: "include" });
      if (!r.ok && r.status !== 400) throw new Error("Failed to load Search Console status");
      return r.json();
    },
    staleTime: 60 * 1000,
  });

  const submit = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/seo/search-console/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "include",
      });
      const json = await r.json();
      if (!json.ok) throw new Error(json.error ?? json.reason ?? "Submit failed");
      return json;
    },
    onSuccess: (r: any) => {
      toast({
        title: "Sitemap submitted",
        description: `${r.submitted} → ${r.siteUrl}. Google re-reads it on its own schedule, usually within a day.`,
      });
      qc.invalidateQueries({ queryKey: ["/api/admin/seo/search-console"] });
    },
    onError: (e: any) =>
      toast({ title: "Submit failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const sm = data?.sitemaps?.[0];
  const blocked = data?.reason ?? data?.error;

  return (
    <section className="border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-display text-[11px] tracking-[0.16em] text-muted-foreground mb-1.5">
            SITEMAP · SEARCH CONSOLE
          </div>
          {isLoading ? (
            <Skeleton className="h-5 w-72" />
          ) : blocked ? (
            <p className="text-[13px] text-amber-700 dark:text-amber-400 flex items-start gap-2 max-w-xl leading-relaxed">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              {blocked}
            </p>
          ) : (
            <>
              <p className="text-sm text-foreground">
                Connected to <span className="font-mono text-[13px]">{data?.siteUrl}</span>. Submitted
                automatically after each deploy.
              </p>
              {sm ? (
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  <span>Last submitted <span className="text-foreground">{fmtDate(sm.lastSubmitted)}</span></span>
                  <span>Last read by Google <span className="text-foreground">{fmtDate(sm.lastDownloaded)}</span></span>
                  {sm.isPending && <span className="text-amber-600 dark:text-amber-400">queued</span>}
                  <span className={sm.errors ? "text-rose-600 dark:text-rose-400" : ""}>
                    {sm.errors ?? 0} error{sm.errors === 1 ? "" : "s"}
                  </span>
                  <span className={sm.warnings ? "text-amber-600 dark:text-amber-400" : ""}>
                    {sm.warnings ?? 0} warning{sm.warnings === 1 ? "" : "s"}
                  </span>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Google is holding no sitemap for this property yet. Submit one to start.
                </p>
              )}
            </>
          )}
        </div>
        <Button
          onClick={() => submit.mutate()}
          disabled={submit.isPending || !!blocked}
          className="gap-2 rounded-sm font-display text-[11px] tracking-[0.18em] shrink-0"
          data-testid="button-sitemap-submit"
        >
          <UploadCloud className={`w-3.5 h-3.5 ${submit.isPending ? "animate-pulse" : ""}`} />
          SUBMIT SITEMAP
        </Button>
      </div>
    </section>
  );
}

interface LegacyResult { table: string; slug: string; from: string; to?: string; status: string; error?: string }
interface LegacyReport {
  ok: boolean; dryRun: boolean; scanned: number; migrated: number; failed: number; skipped: number;
  results: LegacyResult[];
}

/**
 * Hero images still served by the old WordPress host.
 *
 * These are the og:image, the schema.org image and the hero on the page, so
 * the day luxuryhomescalgary.ca stops answering they all break at once. The
 * migration copies each file onto our own volume and repoints the row.
 *
 * Preview first, deliberately: the run fetches from a third-party host and
 * rewrites content rows, and a retired WordPress commonly answers 200 with a
 * parking page — which the server rejects, but which is much easier to reason
 * about after seeing the list.
 */
function LegacyImagesCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [report, setReport] = useState<LegacyReport | null>(null);

  const { data } = useQuery<{ ok: boolean; count: number }>({
    queryKey: ["/api/admin/seo/legacy-images"],
    queryFn: async () => {
      const r = await fetch("/api/admin/seo/legacy-images", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load legacy image status");
      return r.json();
    },
    staleTime: 60 * 1000,
  });

  const run = useMutation({
    mutationFn: async (dryRun: boolean) => {
      const r = await fetch("/api/admin/seo/legacy-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
        credentials: "include",
      });
      return (await r.json()) as LegacyReport;
    },
    onSuccess: (rep) => {
      setReport(rep);
      if (rep.dryRun) {
        toast({ title: `${rep.scanned} image${rep.scanned === 1 ? "" : "s"} would be copied`, description: "Nothing changed yet — press Migrate to run it." });
      } else if (rep.ok) {
        toast({ title: `Migrated ${rep.migrated}`, description: "Rows now point at /uploads/legacy/ on our own storage." });
      } else {
        toast({
          title: `${rep.migrated} migrated, ${rep.failed} failed`,
          description: "Rows that failed were left pointing at the old host.",
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["/api/admin/seo/legacy-images"] });
    },
    onError: (e: any) => toast({ title: "Migration failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const count = data?.count ?? 0;
  if (data && count === 0 && !report) return null; // nothing to do — stay out of the way

  return (
    <section className="border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-display text-[11px] tracking-[0.16em] text-muted-foreground mb-1.5">
            LEGACY WORDPRESS IMAGES
          </div>
          <p className="text-sm text-foreground max-w-2xl leading-relaxed">
            {count} hero image{count === 1 ? "" : "s"} {count === 1 ? "is" : "are"} still served by
            luxuryhomescalgary.ca. They are the social preview and the schema image as well as the
            hero, so they all break together if that host goes away. Copy them onto our own storage.
          </p>
          {report && (
            <div className="mt-3 text-xs text-muted-foreground tabular-nums flex flex-wrap gap-x-5 gap-y-1">
              <span>{report.dryRun ? "Preview" : "Run"}: {report.scanned} scanned</span>
              <span className="text-foreground">{report.migrated} {report.dryRun ? "would copy" : "copied"}</span>
              {report.failed > 0 && <span className="text-rose-600 dark:text-rose-400">{report.failed} failed</span>}
            </div>
          )}
          {report?.results?.some((r) => r.status === "failed") && (
            <ul className="mt-2 text-xs text-rose-600 dark:text-rose-400 space-y-0.5 max-h-40 overflow-auto">
              {report.results.filter((r) => r.status === "failed").slice(0, 12).map((r) => (
                <li key={`${r.table}-${r.slug}`} className="font-mono">
                  {r.table}/{r.slug} — {r.error}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="ghost"
            onClick={() => run.mutate(true)}
            disabled={run.isPending}
            className="rounded-sm font-display text-[11px] tracking-[0.18em]"
            data-testid="button-legacy-preview"
          >
            PREVIEW
          </Button>
          <Button
            onClick={() => run.mutate(false)}
            disabled={run.isPending || count === 0}
            className="gap-2 rounded-sm font-display text-[11px] tracking-[0.18em]"
            data-testid="button-legacy-migrate"
          >
            <ImageDown className={`w-3.5 h-3.5 ${run.isPending ? "animate-pulse" : ""}`} />
            MIGRATE
          </Button>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="text-[10px] tracking-[0.16em] uppercase text-muted-foreground font-semibold">{label}</div>
      <div className={`font-serif text-3xl mt-2 tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  const tone = score >= 75 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-2 min-w-[92px]">
      <div className="h-1.5 flex-1 bg-secondary overflow-hidden rounded-sm">
        <div className={`h-full ${tone}`} style={{ width: `${score}%` }} />
      </div>
      <span className="tabular-nums text-xs font-semibold w-7 text-right">{score}</span>
    </div>
  );
}

export default function AdminSeoPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [clusterFilter, setClusterFilter] = useState<string>("all");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [draftKeyword, setDraftKeyword] = useState("");

  const { data, isLoading, isFetching } = useQuery<SeoReport>({
    queryKey: ["/api/admin/seo/keywords"],
    queryFn: async () => {
      const r = await fetch("/api/admin/seo/keywords", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load SEO report");
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const rescan = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/seo/keywords?refresh=1", { credentials: "include" });
      if (!r.ok) throw new Error("Rescan failed");
      return r.json();
    },
    onSuccess: (fresh) => {
      qc.setQueryData(["/api/admin/seo/keywords"], fresh);
      toast({ title: "Rescan complete", description: `${fresh.pageCount} pages crawled in ${(fresh.crawlMs / 1000).toFixed(1)}s.` });
    },
    onError: (e: any) => toast({ title: "Rescan failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const saveKeyword = useMutation({
    mutationFn: async (v: { path: string; focusKeyword: string }) =>
      apiRequest("PUT", "/api/admin/seo/keywords", v),
    onSuccess: () => {
      toast({ title: "Focus keyword saved", description: "Rescan to see the updated score." });
      qc.invalidateQueries({ queryKey: ["/api/admin/seo/keywords"] });
    },
  });

  const clearKeyword = useMutation({
    mutationFn: async (path: string) =>
      apiRequest("DELETE", `/api/admin/seo/keywords?path=${encodeURIComponent(path)}`),
    onSuccess: () => {
      toast({ title: "Reverted to derived keyword" });
      qc.invalidateQueries({ queryKey: ["/api/admin/seo/keywords"] });
    },
  });

  const pages = useMemo(() => {
    let list = data?.pages ?? [];
    if (clusterFilter !== "all") list = list.filter((p) => p.cluster === clusterFilter);
    if (onlyIssues) list = list.filter((p) => p.issues.length || p.conflicts.length);
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((p) =>
        p.path.toLowerCase().includes(needle) ||
        p.focusKeyword.toLowerCase().includes(needle) ||
        p.title.toLowerCase().includes(needle));
    }
    return list;
  }, [data, q, clusterFilter, onlyIssues]);

  const conflictPairs = useMemo(() => {
    const seen = new Set<string>();
    const out: { a: PageAnalysis; bPath: string; keyword: string }[] = [];
    for (const p of data?.pages ?? []) {
      for (const c of p.conflicts) {
        const key = [p.path, c.path].sort().join("::");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a: p, bPath: c.path, keyword: p.focusKeyword });
      }
    }
    return out;
  }, [data]);

  return (
    <AppShell
      pageTitle="SEO Keywords"
      pageActions={
        <Button onClick={() => rescan.mutate()} disabled={rescan.isPending || isFetching}
          className="gap-2 rounded-sm font-display text-[11px] tracking-[0.18em]" data-testid="button-seo-rescan">
          <RefreshCw className={`w-3.5 h-3.5 ${rescan.isPending ? "animate-spin" : ""}`} />
          RESCAN SITE
        </Button>
      }
    >
      <div className="p-6 lg:p-8 space-y-8">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" />
          </div>
        ) : !data?.ok ? (
          <div className="border border-border p-8 text-muted-foreground">
            Could not build the SEO report. Try Rescan.
          </div>
        ) : (
          <>
            <SitemapCard />
            <LegacyImagesCard />

            {/* Summary */}
            <section>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <Stat label="Pages analysed" value={data.pageCount} />
                <Stat label="Average score" value={data.summary.avgScore} />
                <Stat label="Strong" value={data.summary.strong} tone="text-emerald-600 dark:text-emerald-400" />
                <Stat label="Weak" value={data.summary.weak} tone="text-rose-600 dark:text-rose-400" />
                <Stat label="Keyword conflicts" value={data.summary.conflicts} tone={data.summary.conflicts ? "text-rose-600 dark:text-rose-400" : ""} />
                <Stat label="Orphan pages" value={data.summary.orphans} tone={data.summary.orphans ? "text-amber-600 dark:text-amber-400" : ""} />
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Crawled {data.pageCount} routes in {(data.crawlMs / 1000).toFixed(1)}s ·{" "}
                {data.gsc.ok
                  ? `Search Console connected (${data.gsc.rows} page/query rows)`
                  : `Search Console not connected — scoring uses on-page signals only${data.gsc.message ? ` (${data.gsc.message})` : ""}`}
                {" · "}Generated {new Date(data.generatedAt).toLocaleString()}
              </p>
            </section>

            {/* Clusters */}
            <section>
              <h2 className="font-serif text-2xl mb-1">Clusters</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Each cluster has one pillar page that owns the head term. Child pages must target something narrower.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.clusters.map((c) => (
                  <button key={c.id} onClick={() => setClusterFilter(clusterFilter === c.id ? "all" : c.id)}
                    className={`text-left border p-4 transition-colors ${clusterFilter === c.id ? "border-foreground bg-secondary/50" : "border-border bg-card hover:border-foreground/40"}`}
                    data-testid={`cluster-${c.id}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-semibold text-sm">{c.label}</div>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.intent}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-2 font-mono">{c.pillar}</div>
                    <div className="text-xs mt-1">owns <span className="font-semibold">{c.headKeyword}</span></div>
                    <div className="flex items-center gap-4 mt-3 text-xs tabular-nums">
                      <span>{c.pages} pages</span>
                      <span>avg {c.avgScore}</span>
                      {c.conflicts > 0 && (
                        <span className="text-rose-600 dark:text-rose-400">{c.conflicts} conflict{c.conflicts === 1 ? "" : "s"}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {/* Conflicts */}
            {conflictPairs.length > 0 && (
              <section>
                <h2 className="font-serif text-2xl mb-1 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-rose-500" /> Cannibalization
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Two pages targeting the same subject. The narrower page should re-target or redirect into the other.
                </p>
                <div className="border border-border divide-y divide-border">
                  {conflictPairs.map(({ a, bPath, keyword }) => (
                    <div key={`${a.path}::${bPath}`} className="p-4 bg-card">
                      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                        both targeting “{keyword}”
                      </div>
                      <div className="grid gap-1.5 font-mono text-sm">
                        <div className="flex items-center gap-2">
                          {a.isPillar && <span className="text-[9px] uppercase tracking-wider bg-secondary px-1.5 py-0.5">pillar</span>}
                          <button onClick={() => setOpen(a.path)} className="underline underline-offset-2 text-left">{a.path}</button>
                        </div>
                        <div><button onClick={() => setOpen(bPath)} className="underline underline-offset-2 text-left">{bPath}</button></div>
                      </div>
                      {a.suggestedKeyword && (
                        <div className="mt-3 text-sm border-l-2 border-emerald-500 pl-3">
                          <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-semibold block">Suggested</span>
                          Re-target <span className="font-mono">{a.path}</span> to “<b>{a.suggestedKeyword}</b>” — {a.suggestionReason}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Page table */}
            <section>
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <h2 className="font-serif text-2xl flex-1">Pages</h2>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by path, keyword, title"
                    className="pl-9 h-9 w-64 rounded-sm" data-testid="input-seo-filter" />
                </div>
                <Button variant={onlyIssues ? "default" : "outline"} onClick={() => setOnlyIssues((v) => !v)}
                  className="h-9 rounded-sm text-xs" data-testid="button-seo-issues">
                  Needs attention
                </Button>
                {clusterFilter !== "all" && (
                  <Button variant="outline" onClick={() => setClusterFilter("all")} className="h-9 rounded-sm text-xs gap-1">
                    <X className="w-3 h-3" /> {data.clusters.find((c) => c.id === clusterFilter)?.label}
                  </Button>
                )}
              </div>

              <div className="border border-border overflow-x-auto">
                <table className="w-full text-sm min-w-[860px]">
                  <thead>
                    <tr className="bg-secondary/60 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      <th className="text-left font-semibold px-4 py-2.5">Page</th>
                      <th className="text-left font-semibold px-4 py-2.5">Focus keyword</th>
                      <th className="text-left font-semibold px-4 py-2.5">Cluster</th>
                      <th className="text-right font-semibold px-4 py-2.5">Links in</th>
                      <th className="text-left font-semibold px-4 py-2.5">Score</th>
                      <th className="text-left font-semibold px-4 py-2.5">Flags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pages.map((p) => (
                      <tr key={p.path} className="hover:bg-secondary/30 cursor-pointer align-top"
                        onClick={() => { setOpen(p.path); setDraftKeyword(p.focusKeyword); }}
                        data-testid={`seo-row-${p.path}`}>
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs">{p.path}</div>
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{p.title || "— no title —"}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs">{p.focusKeyword || <em className="text-muted-foreground">none</em>}</span>
                          {p.focusSource === "override" && (
                            <span className="ml-2 text-[9px] uppercase tracking-wider bg-secondary px-1.5 py-0.5">set</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {p.clusterLabel}{p.isPillar && <span className="ml-1 text-foreground font-semibold">· pillar</span>}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-xs">{p.inboundLinks.length}</td>
                        <td className="px-4 py-3"><ScoreBar score={p.score} /></td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {p.conflicts.length > 0 && (
                              <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 border ${GRADE_STYLES.weak}`}>conflict</span>
                            )}
                            {p.inboundLinks.length === 0 && (
                              <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 border ${GRADE_STYLES.fair}`}>orphan</span>
                            )}
                            {p.sisterDomainLinks.length > 0 && (
                              <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 border ${GRADE_STYLES.fair}`}>leaks</span>
                            )}
                            {p.issues.length > 0 && p.conflicts.length === 0 && p.inboundLinks.length > 0 && (
                              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-border text-muted-foreground">
                                {p.issues.length}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {pages.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground text-sm">No pages match.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>

      {/* Detail drawer */}
      {open && data && (() => {
        const p = data.pages.find((x) => x.path === open);
        if (!p) return null;
        return (
          <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
            <button className="flex-1 bg-black/40" aria-label="Close" onClick={() => setOpen(null)} />
            <div className="w-full max-w-xl bg-background border-l border-border overflow-y-auto">
              <div className="sticky top-0 bg-background border-b border-border p-5 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm break-all">{p.path}</div>
                  <div className="text-xs text-muted-foreground mt-1">{p.clusterLabel} · {p.wordCount} words · HTTP {p.status}</div>
                </div>
                <a href={p.path} target="_blank" rel="noreferrer" className="p-2 hover:bg-secondary" aria-label="Open page">
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button onClick={() => setOpen(null)} className="p-2 hover:bg-secondary" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-6">
                {/* Focus keyword editor */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2 flex items-center gap-1.5">
                    <Target className="w-3 h-3" /> Focus keyword
                  </div>
                  <div className="flex gap-2">
                    <Input value={draftKeyword} onChange={(e) => setDraftKeyword(e.target.value)}
                      placeholder="e.g. aspen woods homes for sale" className="rounded-sm h-9" data-testid="input-focus-keyword" />
                    <Button className="rounded-sm h-9 gap-1.5" data-testid="button-save-keyword"
                      onClick={() => saveKeyword.mutate({ path: p.path, focusKeyword: draftKeyword })}>
                      <Save className="w-3.5 h-3.5" /> Save
                    </Button>
                    {p.focusSource === "override" && (
                      <Button variant="outline" className="rounded-sm h-9" onClick={() => clearKeyword.mutate(p.path)}>
                        Reset
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {p.focusSource === "override"
                      ? "Set by hand. Reset to derive it from the page title again."
                      : "Derived from the page title. Saving pins it so future edits don't silently change the target."}
                  </p>
                  {p.suggestedKeyword && (
                    <div className="mt-3 border-l-2 border-emerald-500 pl-3 text-sm">
                      <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-semibold block">Suggested target</span>
                      <button className="underline underline-offset-2 font-semibold" onClick={() => setDraftKeyword(p.suggestedKeyword!)}>
                        {p.suggestedKeyword}
                      </button>
                      <p className="text-muted-foreground mt-1">{p.suggestionReason}</p>
                    </div>
                  )}
                </div>

                {/* Score breakdown */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2">
                    Score {p.score}/100
                  </div>
                  <div className="border border-border divide-y divide-border">
                    {p.components.map((c) => (
                      <div key={c.id} className="flex items-start gap-3 px-3 py-2">
                        <div className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${c.earned === c.max ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium">{c.label}</div>
                          <div className="text-xs text-muted-foreground">{c.detail}</div>
                        </div>
                        <div className="tabular-nums text-xs text-muted-foreground">{c.earned}/{c.max}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Search Console */}
                {p.gsc && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2">Search Console</div>
                    <div className="text-sm tabular-nums">
                      {p.gsc.clicks} clicks · {p.gsc.impressions} impressions
                      {p.gsc.topQuery && <> · best query “<b>{p.gsc.topQuery}</b>” at position {p.gsc.position.toFixed(1)}</>}
                    </div>
                  </div>
                )}

                {/* Links */}
                <div className="grid gap-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2 flex items-center gap-1.5">
                      <Link2 className="w-3 h-3" /> Editorial links in ({p.inboundLinks.length})
                    </div>
                    {p.inboundLinks.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {p.inboundLinks.map((l) => (
                          <button key={l} onClick={() => setOpen(l)} className="font-mono text-xs bg-secondary px-2 py-1 hover:bg-secondary/70">{l}</button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        None. Nav and footer links are excluded — they appear on every page, so they don't tell Google this page matters.
                      </p>
                    )}
                  </div>

                  {p.recommendedInboundFrom.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.16em] text-emerald-600 dark:text-emerald-400 font-semibold mb-2 flex items-center gap-1.5">
                        <Unlink className="w-3 h-3" /> Recommended links in
                      </div>
                      <div className="border border-border divide-y divide-border">
                        {p.recommendedInboundFrom.map((r) => (
                          <div key={r.path} className="px-3 py-2">
                            <button onClick={() => setOpen(r.path)} className="font-mono text-xs underline underline-offset-2">{r.path}</button>
                            <div className="text-xs text-muted-foreground mt-0.5">{r.reason}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2">
                      Editorial links out ({p.outboundLinks.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {p.outboundLinks.length
                        ? p.outboundLinks.map((l) => (
                            <button key={l} onClick={() => setOpen(l)} className="font-mono text-xs bg-secondary px-2 py-1 hover:bg-secondary/70">{l}</button>
                          ))
                        : <span className="text-xs text-muted-foreground">None.</span>}
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2">External links</div>
                    <div className="text-xs text-muted-foreground">
                      {p.externalDomains.length ? p.externalDomains.join(", ") : "None — no outbound citations."}
                    </div>
                    {p.sisterDomainLinks.length > 0 && (
                      <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                        {p.sisterDomainLinks.length} link{p.sisterDomainLinks.length === 1 ? "" : "s"} to luxuryhomescalgary.ca — passes authority to the competing domain.
                      </div>
                    )}
                  </div>
                </div>

                {/* Issues */}
                {p.issues.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2">Issues</div>
                    <ul className="text-sm space-y-1 list-disc pl-4 text-muted-foreground">
                      {p.issues.map((i) => <li key={i}>{i}</li>)}
                    </ul>
                  </div>
                )}

                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold mb-2">Metadata</div>
                  <div className="text-xs space-y-1.5">
                    <div><span className="text-muted-foreground">Title:</span> {p.title || "—"}</div>
                    <div><span className="text-muted-foreground">Description:</span> {p.description || "—"}</div>
                    <div><span className="text-muted-foreground">H1:</span> {p.h1 || "—"}</div>
                    <div><span className="text-muted-foreground">Schema:</span> {p.schemaTypes.join(", ") || "none"}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </AppShell>
  );
}
