import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Home,
  Users,
  Eye,
  CalendarClock,
  TrendingUp,
  Building2,
  Wallet,
  Target,
  MousePointerClick,
  SearchIcon,
  Globe2,
  Timer,
  AlertTriangle,
  Bot,
} from "lucide-react";
import { formatPriceCompact } from "@/lib/format";

interface AnalyticsSummary {
  kpis: {
    activeMls: number;
    totalMls: number;
    managedListings: number;
    totalLeads: number;
    upcomingTours: number;
    totalViews: number;
    portfolioValue: number;
    conversionRate: number;
  };
  weeklyLeads: { weekStart: string; leads: number }[];
  sources: { source: string; count: number }[];
  pipeline: { status: string; count: number }[];
  neighbourhoods: { name: string; leads: number }[];
}

interface SeoStats {
  days: number;
  range: { startDate: string; endDate: string };
  gsc: {
    ok: boolean;
    message?: string;
    summary?: { clicks: number; impressions: number; ctr: number; position: number };
    topQueries?: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
    topPages?: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
  };
  ga4: {
    ok: boolean;
    message?: string;
    summary?: { users: number; sessions: number; pageviews: number; avgEngagementSeconds: number };
    topPages?: { path: string; pageviews: number; users: number }[];
    sources?: { source: string; sessions: number; users: number }[];
  };
}

interface AiReferrals {
  ok: boolean;
  message?: string;
  days: number;
  summary?: {
    sessions: number;
    prevSessions: number;
    users: number;
    keyEvents: number;
    engagementRate: number;
    shareOfSessions: number;
  };
  engines?: { engine: string; sessions: number; users: number; keyEvents: number; sources: string[] }[];
  landingPages?: { path: string; sessions: number; keyEvents: number }[];
  daily?: { date: string; sessions: number }[];
}

const SOURCE_PALETTE = ["#23412d", "#D4AF37", "#1F2937", "#6B7280", "#9CA3AF", "#374151"];

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  "tour-booked": "Tour booked",
  closed: "Closed",
  lost: "Lost",
};

export default function AdminAnalyticsPage() {
  const [seoDays, setSeoDays] = useState<7 | 28 | 90>(28);
  const { data, isLoading } = useQuery<AnalyticsSummary>({ queryKey: ["/api/analytics/summary"] });
  const seo = useQuery<SeoStats>({
    queryKey: ["/api/analytics/seo-stats", { days: seoDays }],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/seo-stats?days=${seoDays}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`seo-stats ${r.status}`);
      return r.json();
    },
  });

  const ai = useQuery<AiReferrals>({
    queryKey: ["/api/analytics/ai-referrals", { days: seoDays }],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/ai-referrals?days=${seoDays}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`ai-referrals ${r.status}`);
      return r.json();
    },
  });

  if (isLoading || !data) {
    return (
      <AppShell pageTitle="Analytics">
        <div className="p-6 max-w-[1400px] mx-auto">
          <div className="text-sm text-muted-foreground py-12 text-center">Loading analytics…</div>
        </div>
      </AppShell>
    );
  }

  const { kpis, weeklyLeads, sources, pipeline, neighbourhoods } = data;

  return (
    <AppShell pageTitle="Analytics">
      <div className="p-6 max-w-[1400px] mx-auto">
        <div className="mb-6">
          <h1 className="font-serif text-3xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
            Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Where attention is going across your portfolio. Refreshes with every MLS sync and lead capture.
          </p>
        </div>

        {/* SEO + Traffic section (GA4 + Google Search Console) ----------- */}
        <SeoTrafficSection
          data={seo.data}
          loading={seo.isLoading}
          error={seo.isError ? "Couldn't reach the SEO data API." : null}
          days={seoDays}
          onDaysChange={setSeoDays}
        />

        {/* Visits from AI assistants (GA4), same date range ---------------- */}
        <AiReferralsSection
          data={ai.data}
          loading={ai.isLoading}
          error={ai.isError ? "Couldn't reach the AI referrals API." : null}
          days={seoDays}
        />

        {/* KPI grid — 6 cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <KpiCard
            icon={Home}
            label="Active MLS"
            value={kpis.activeMls.toLocaleString("en-CA")}
            sub={`of ${kpis.totalMls.toLocaleString("en-CA")} total`}
          />
          <KpiCard
            icon={Building2}
            label="Managed listings"
            value={kpis.managedListings.toString()}
            sub="on riversrealestate.ca"
          />
          <KpiCard
            icon={Users}
            label="Leads (lifetime)"
            value={kpis.totalLeads.toString()}
            sub={`${pipeline.find((p) => p.status === "new")?.count ?? 0} new`}
          />
          <KpiCard
            icon={CalendarClock}
            label="Upcoming tours"
            value={kpis.upcomingTours.toString()}
            sub="confirmed + requested"
          />
          <KpiCard
            icon={Eye}
            label="Total views"
            value={kpis.totalViews.toLocaleString("en-CA")}
            sub="across all listings"
          />
          <KpiCard
            icon={Target}
            label="Conversion"
            value={`${kpis.conversionRate}%`}
            sub="qualified + closed"
          />
        </div>

        {/* Portfolio value strip */}
        <Card className="mb-6">
          <CardContent className="p-5 flex items-center gap-5 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-sm bg-foreground text-background flex items-center justify-center">
                <Wallet className="w-4 h-4" strokeWidth={1.6} />
              </div>
              <div>
                <div className="eyebrow text-muted-foreground">Portfolio value (managed)</div>
                <div className="font-serif text-3xl text-foreground" style={{ letterSpacing: "-0.02em" }}>
                  {formatPriceCompact(kpis.portfolioValue)}
                </div>
              </div>
            </div>
            <div className="flex-1 text-xs text-muted-foreground max-w-md">
              Sum of list price across the {kpis.managedListings} listings managed under your account.
              MLS-feed inventory is not counted here.
            </div>
          </CardContent>
        </Card>

        {/* Charts grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Leads per week */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="eyebrow text-muted-foreground">Leads per week</div>
                  <div className="font-serif text-xl mt-0.5" style={{ letterSpacing: "-0.01em" }}>
                    Last 12 weeks
                  </div>
                </div>
                <TrendingUp className="w-4 h-4 text-muted-foreground" strokeWidth={1.6} />
              </div>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={weeklyLeads}>
                    <defs>
                      <linearGradient id="leadsArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#23412d" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#23412d" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="weekStart"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      tickFormatter={(v) =>
                        new Date(v).toLocaleDateString("en-CA", { month: "short", day: "numeric" })
                      }
                    />
                    <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--background))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 2,
                        fontSize: 12,
                      }}
                      labelFormatter={(v) =>
                        new Date(v).toLocaleDateString("en-CA", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="leads"
                      stroke="#23412d"
                      strokeWidth={2}
                      fill="url(#leadsArea)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Lead sources pie */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="eyebrow text-muted-foreground">Lead sources</div>
                  <div className="font-serif text-xl mt-0.5" style={{ letterSpacing: "-0.01em" }}>
                    Where they come from
                  </div>
                </div>
              </div>
              {sources.length === 0 ? (
                <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
                  No leads yet
                </div>
              ) : (
                <div className="grid grid-cols-[180px_1fr] gap-4 items-center">
                  <div className="h-[180px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={sources}
                          dataKey="count"
                          nameKey="source"
                          innerRadius={48}
                          outerRadius={80}
                          paddingAngle={2}
                          stroke="hsl(var(--background))"
                          strokeWidth={2}
                        >
                          {sources.map((_, i) => (
                            <Cell key={i} fill={SOURCE_PALETTE[i % SOURCE_PALETTE.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: "hsl(var(--background))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 2,
                            fontSize: 12,
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="space-y-1.5 text-sm">
                    {sources.map((s, i) => (
                      <li key={s.source} className="flex items-center gap-2">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-sm"
                          style={{ background: SOURCE_PALETTE[i % SOURCE_PALETTE.length] }}
                        />
                        <span className="capitalize">{s.source.replace("-", " ")}</span>
                        <span className="ml-auto font-display tracking-[0.1em] text-xs text-muted-foreground">
                          {s.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pipeline */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="eyebrow text-muted-foreground">Pipeline</div>
                  <div className="font-serif text-xl mt-0.5" style={{ letterSpacing: "-0.01em" }}>
                    Leads by status
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                {pipeline.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No leads to show.</div>
                ) : (
                  pipeline
                    .sort((a, b) => b.count - a.count)
                    .map((p) => {
                      const max = Math.max(...pipeline.map((x) => x.count));
                      const pct = max > 0 ? (p.count / max) * 100 : 0;
                      return (
                        <div key={p.status}>
                          <div className="flex items-center justify-between text-xs mb-0.5">
                            <span className="font-medium">{STATUS_LABELS[p.status] ?? p.status}</span>
                            <span className="font-display tracking-[0.1em] text-muted-foreground">
                              {p.count}
                            </span>
                          </div>
                          <div className="h-2 bg-secondary rounded-sm overflow-hidden">
                            <div
                              className="h-full bg-foreground transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })
                )}
              </div>
            </CardContent>
          </Card>

          {/* Neighbourhoods */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="eyebrow text-muted-foreground">Top neighbourhoods</div>
                  <div className="font-serif text-xl mt-0.5" style={{ letterSpacing: "-0.01em" }}>
                    By lead volume
                  </div>
                </div>
              </div>
              {neighbourhoods.length === 0 ? (
                <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">
                  No neighbourhood data yet
                </div>
              ) : (
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={neighbourhoods} layout="vertical" margin={{ left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                        allowDecimals={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={120}
                        tick={{ fontSize: 11, fill: "hsl(var(--foreground))" }}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 2,
                          fontSize: 12,
                        }}
                      />
                      <Bar dataKey="leads" fill="#D4AF37" radius={[0, 2, 2, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Home;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.6} />
          <div className="eyebrow text-muted-foreground truncate">{label}</div>
        </div>
        <div className="font-serif text-2xl text-foreground" style={{ letterSpacing: "-0.02em" }}>
          {value}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</div>
      </CardContent>
    </Card>
  );
}

// ---------- SEO + Traffic section --------------------------------------
// Pulls live data from /api/analytics/seo-stats which queries Google Search
// Console (Search Analytics API) and GA4 (Data API) using a server-side
// service-account JWT. Layout: a 6-card KPI strip + two side-by-side tables
// (top queries, top pages) + two more (top GA4 pages, traffic sources).
// Each block degrades independently — if GSC auth is OK but GA4 isn't, you
// still see GSC.

function SeoTrafficSection({
  data,
  loading,
  error,
  days,
  onDaysChange,
}: {
  data: SeoStats | undefined;
  loading: boolean;
  error: string | null;
  days: 7 | 28 | 90;
  onDaysChange: (d: 7 | 28 | 90) => void;
}) {
  const gsc = data?.gsc;
  const ga4 = data?.ga4;

  // GSC's "ctr" comes back as a fraction (0.024 = 2.4%); position is 1-based.
  const fmtPct = (v: number | undefined) =>
    typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—";
  const fmtPos = (v: number | undefined) =>
    typeof v === "number" && v > 0 ? v.toFixed(1) : "—";
  const fmtSeconds = (v: number | undefined) =>
    typeof v === "number"
      ? v >= 60
        ? `${Math.floor(v / 60)}m ${v % 60}s`
        : `${v}s`
      : "—";
  const fmtNum = (v: number | undefined) =>
    typeof v === "number" ? v.toLocaleString("en-CA") : "—";
  const stripOrigin = (url: string) =>
    url.replace(/^https?:\/\/(www\.)?riversrealestate\.ca/, "") || "/";

  return (
    <section className="mb-8">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <div className="eyebrow text-muted-foreground">Traffic & search</div>
          <h2
            className="font-serif text-2xl text-foreground mt-1"
            style={{ letterSpacing: "-0.01em" }}
          >
            Search Console & GA4
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            {data?.range
              ? `${data.range.startDate} → ${data.range.endDate}`
              : `Last ${days} days`}{" "}
            · cached for 1 hour
          </p>
        </div>
        <div className="inline-flex p-1 bg-secondary rounded-sm gap-0.5">
          {([7, 28, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDaysChange(d)}
              className={`h-8 px-3 font-display tracking-[0.14em] text-[10px] rounded-sm ${
                days === d
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`button-seo-range-${d}`}
            >
              {d}D
            </button>
          ))}
        </div>
      </div>

      {/* Error banner — only when the whole endpoint failed */}
      {error && (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="p-4 flex items-start gap-2.5">
            <AlertTriangle
              className="w-4 h-4 mt-0.5 shrink-0 text-destructive"
              strokeWidth={1.6}
            />
            <div className="text-sm text-foreground/80">{error}</div>
          </CardContent>
        </Card>
      )}

      {/* KPI strip — 6 cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        <KpiCard
          icon={MousePointerClick}
          label="Clicks"
          value={loading ? "…" : fmtNum(gsc?.summary?.clicks)}
          sub="Search Console"
        />
        <KpiCard
          icon={SearchIcon}
          label="Impressions"
          value={loading ? "…" : fmtNum(gsc?.summary?.impressions)}
          sub="Search Console"
        />
        <KpiCard
          icon={Target}
          label="CTR"
          value={loading ? "…" : fmtPct(gsc?.summary?.ctr)}
          sub="clicks ÷ impressions"
        />
        <KpiCard
          icon={TrendingUp}
          label="Avg position"
          value={loading ? "…" : fmtPos(gsc?.summary?.position)}
          sub="lower is better"
        />
        <KpiCard
          icon={Users}
          label="Users"
          value={loading ? "…" : fmtNum(ga4?.summary?.users)}
          sub="GA4 (unique)"
        />
        <KpiCard
          icon={Globe2}
          label="Sessions"
          value={loading ? "…" : fmtNum(ga4?.summary?.sessions)}
          sub="GA4"
        />
      </div>

      {/* Engagement strip (1 metric on its own row) */}
      <Card className="mb-4">
        <CardContent className="p-4 flex items-center gap-4 flex-wrap">
          <Timer
            className="w-4 h-4 text-muted-foreground shrink-0"
            strokeWidth={1.6}
          />
          <div>
            <div className="eyebrow text-muted-foreground">
              Average engagement / user
            </div>
            <div
              className="font-serif text-xl text-foreground mt-0.5"
              style={{ letterSpacing: "-0.01em" }}
            >
              {loading ? "…" : fmtSeconds(ga4?.summary?.avgEngagementSeconds)}
            </div>
          </div>
          <div className="text-xs text-muted-foreground ml-auto">
            Pageviews:{" "}
            <span className="font-medium text-foreground">
              {loading ? "…" : fmtNum(ga4?.summary?.pageviews)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Two-up: top queries (GSC) + top pages (GSC) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow text-muted-foreground">
                Top search queries
              </div>
              <span className="text-[11px] text-muted-foreground">
                Search Console
              </span>
            </div>
            <BlockState
              loading={loading}
              ok={gsc?.ok}
              message={gsc?.message}
              empty={!gsc?.topQueries?.length}
              emptyLabel="No queries in this range yet."
            >
              <table className="w-full text-xs">
                <thead className="text-muted-foreground text-[10px] tracking-[0.1em] uppercase">
                  <tr>
                    <th className="text-left py-1.5 font-medium">Query</th>
                    <th className="text-right font-medium">Clicks</th>
                    <th className="text-right font-medium">Impr</th>
                    <th className="text-right font-medium">CTR</th>
                    <th className="text-right font-medium">Pos</th>
                  </tr>
                </thead>
                <tbody>
                  {(gsc?.topQueries ?? []).map((r) => (
                    <tr
                      key={r.query}
                      className="border-t border-border/60"
                    >
                      <td className="py-1.5 truncate max-w-[260px]">
                        {r.query}
                      </td>
                      <td className="text-right tabular-nums">{fmtNum(r.clicks)}</td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {fmtNum(r.impressions)}
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {fmtPct(r.ctr)}
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {fmtPos(r.position)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </BlockState>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow text-muted-foreground">
                Top landing pages (search)
              </div>
              <span className="text-[11px] text-muted-foreground">
                Search Console
              </span>
            </div>
            <BlockState
              loading={loading}
              ok={gsc?.ok}
              message={gsc?.message}
              empty={!gsc?.topPages?.length}
              emptyLabel="No landing-page data yet."
            >
              <table className="w-full text-xs">
                <thead className="text-muted-foreground text-[10px] tracking-[0.1em] uppercase">
                  <tr>
                    <th className="text-left py-1.5 font-medium">Page</th>
                    <th className="text-right font-medium">Clicks</th>
                    <th className="text-right font-medium">Impr</th>
                    <th className="text-right font-medium">Pos</th>
                  </tr>
                </thead>
                <tbody>
                  {(gsc?.topPages ?? []).map((r) => (
                    <tr key={r.page} className="border-t border-border/60">
                      <td className="py-1.5 truncate max-w-[260px]">
                        <a
                          href={r.page}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {stripOrigin(r.page)}
                        </a>
                      </td>
                      <td className="text-right tabular-nums">{fmtNum(r.clicks)}</td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {fmtNum(r.impressions)}
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {fmtPos(r.position)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </BlockState>
          </CardContent>
        </Card>
      </div>

      {/* Two-up: top pages (GA4) + traffic sources (GA4) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow text-muted-foreground">
                Top pages (all traffic)
              </div>
              <span className="text-[11px] text-muted-foreground">GA4</span>
            </div>
            <BlockState
              loading={loading}
              ok={ga4?.ok}
              message={ga4?.message}
              empty={!ga4?.topPages?.length}
              emptyLabel="GA4 hasn't recorded any pageviews yet — give it 24h."
            >
              <table className="w-full text-xs">
                <thead className="text-muted-foreground text-[10px] tracking-[0.1em] uppercase">
                  <tr>
                    <th className="text-left py-1.5 font-medium">Path</th>
                    <th className="text-right font-medium">Views</th>
                    <th className="text-right font-medium">Users</th>
                  </tr>
                </thead>
                <tbody>
                  {(ga4?.topPages ?? []).map((r) => (
                    <tr key={r.path} className="border-t border-border/60">
                      <td className="py-1.5 truncate max-w-[300px]">
                        <a
                          href={r.path}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {r.path}
                        </a>
                      </td>
                      <td className="text-right tabular-nums">
                        {fmtNum(r.pageviews)}
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {fmtNum(r.users)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </BlockState>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow text-muted-foreground">
                Traffic sources
              </div>
              <span className="text-[11px] text-muted-foreground">GA4</span>
            </div>
            <BlockState
              loading={loading}
              ok={ga4?.ok}
              message={ga4?.message}
              empty={!ga4?.sources?.length}
              emptyLabel="No source data yet."
            >
              <ul className="space-y-2">
                {(ga4?.sources ?? []).map((s) => {
                  const max = Math.max(
                    ...(ga4?.sources ?? []).map((x) => x.sessions),
                  );
                  const pct = max > 0 ? (s.sessions / max) * 100 : 0;
                  return (
                    <li key={s.source}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="font-medium truncate">{s.source}</span>
                        <span className="font-display tracking-[0.08em] text-[10px] text-muted-foreground tabular-nums">
                          {fmtNum(s.sessions)} sessions
                        </span>
                      </div>
                      <div className="h-2 bg-secondary rounded-sm overflow-hidden">
                        <div
                          className="h-full bg-foreground transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </BlockState>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// ---------- AI assistant referrals -------------------------------------
// Visits from ChatGPT, Perplexity, Gemini, Copilot etc., from GA4 via
// /api/analytics/ai-referrals. The only first-party AI-search signal: the
// assistants don't publish impressions, and Google AI Overview clicks are
// counted as google / organic above.

function AiReferralsSection({
  data,
  loading,
  error,
  days,
}: {
  data: AiReferrals | undefined;
  loading: boolean;
  error: string | null;
  days: 7 | 28 | 90;
}) {
  const s = data?.summary;
  const fmtNum = (v: number | undefined) =>
    typeof v === "number" ? v.toLocaleString("en-CA") : "—";
  const fmtPct = (v: number | undefined) =>
    typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—";
  const change = (() => {
    if (!s) return "—";
    if (s.prevSessions === 0) return s.sessions > 0 ? "new this period" : "none last period";
    const pct = ((s.sessions - s.prevSessions) / s.prevSessions) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs previous ${days}d`;
  })();
  const maxEngine = Math.max(1, ...(data?.engines ?? []).map((e) => e.sessions));

  return (
    <section className="mb-8">
      <div className="mb-4">
        <div className="eyebrow text-muted-foreground">AI search</div>
        <h2 className="font-serif text-2xl text-foreground mt-1" style={{ letterSpacing: "-0.01em" }}>
          AI assistant referrals
        </h2>
        <p className="text-xs text-muted-foreground mt-1 max-w-[720px]">
          Visits that came from ChatGPT, Perplexity, Gemini, Copilot and other AI assistants, last {days} days
          (GA4). AI tools don't publish impressions, so this is real clicks only. Google AI Overview clicks are
          counted as Google search above.
        </p>
      </div>

      {error && (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="p-4 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" strokeWidth={1.6} />
            <div className="text-sm text-foreground/80">{error}</div>
          </CardContent>
        </Card>
      )}
      {data && !data.ok && (
        <Card className="mb-4">
          <CardContent className="p-4 text-xs text-destructive/80">{data.message ?? "Couldn't load."}</CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <KpiCard icon={Bot} label="AI sessions" value={loading ? "…" : fmtNum(s?.sessions)} sub={loading ? "" : change} />
        <KpiCard
          icon={Globe2}
          label="Share of traffic"
          value={loading ? "…" : fmtPct(s?.shareOfSessions)}
          sub="of all sessions"
        />
        <KpiCard icon={Target} label="Key events" value={loading ? "…" : fmtNum(s?.keyEvents)} sub="leads & conversions from AI" />
        <KpiCard
          icon={Timer}
          label="Engagement rate"
          value={loading ? "…" : fmtPct(s?.engagementRate)}
          sub="engaged sessions"
        />
      </div>

      <Card className="mb-4">
        <CardContent className="p-5">
          <div className="eyebrow text-muted-foreground mb-3">Daily AI sessions</div>
          <BlockState
            loading={loading}
            ok={data?.ok}
            message={data?.message}
            empty={!s?.sessions}
            emptyLabel="No visits from AI assistants in this range yet."
          >
            <div className="h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data?.daily ?? []} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    tickFormatter={(d: string) => d.slice(5)}
                    minTickGap={24}
                  />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="sessions" stroke="#23412d" fill="#23412d" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </BlockState>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow text-muted-foreground">By assistant</div>
              <span className="text-[11px] text-muted-foreground">GA4</span>
            </div>
            <BlockState
              loading={loading}
              ok={data?.ok}
              message={data?.message}
              empty={!data?.engines?.length}
              emptyLabel="No AI assistant has sent visits yet."
            >
              <ul className="space-y-2">
                {(data?.engines ?? []).map((e) => (
                  <li key={e.engine} title={e.sources.join(", ")}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="font-medium truncate">{e.engine}</span>
                      <span className="font-display tracking-[0.08em] text-[10px] text-muted-foreground tabular-nums">
                        {fmtNum(e.sessions)} sessions
                        {e.keyEvents > 0 ? ` · ${fmtNum(e.keyEvents)} key events` : ""}
                      </span>
                    </div>
                    <div className="h-2 bg-secondary rounded-sm overflow-hidden">
                      <div className="h-full bg-foreground" style={{ width: `${(e.sessions / maxEngine) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </BlockState>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow text-muted-foreground">Pages AI sends visitors to</div>
              <span className="text-[11px] text-muted-foreground">GA4</span>
            </div>
            <BlockState
              loading={loading}
              ok={data?.ok}
              message={data?.message}
              empty={!data?.landingPages?.length}
              emptyLabel="No landing pages yet."
            >
              <table className="w-full text-xs">
                <thead className="text-muted-foreground text-[10px] tracking-[0.1em] uppercase">
                  <tr>
                    <th className="text-left py-1.5 font-medium">Page</th>
                    <th className="text-right font-medium">Sessions</th>
                    <th className="text-right font-medium">Key events</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.landingPages ?? []).map((r) => (
                    <tr key={r.path} className="border-t border-border/60">
                      <td className="py-1.5 truncate max-w-[300px]">
                        <a href={r.path} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {r.path}
                        </a>
                      </td>
                      <td className="text-right tabular-nums">{fmtNum(r.sessions)}</td>
                      <td className="text-right tabular-nums text-muted-foreground">{fmtNum(r.keyEvents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </BlockState>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// Per-block state wrapper. If the block returned ok:false (API auth /
// permissions / quota issue), surfaces the server's message. If it's
// loading or empty, shows the appropriate placeholder. Otherwise renders
// the table/chart.
function BlockState({
  loading,
  ok,
  message,
  empty,
  emptyLabel,
  children,
}: {
  loading: boolean;
  ok: boolean | undefined;
  message: string | undefined;
  empty: boolean;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center">
        Loading…
      </div>
    );
  }
  if (ok === false) {
    return (
      <div className="text-xs text-destructive/80 leading-relaxed py-2">
        {message ?? "Couldn't load."}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center">
        {emptyLabel}
      </div>
    );
  }
  return <>{children}</>;
}
