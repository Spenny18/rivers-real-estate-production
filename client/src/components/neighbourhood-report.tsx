// Community market report lead magnet for neighbourhood pages: page 1 of the
// report for the community's most common property type as a free preview; the
// full PDF, for whichever type the visitor picks, is emailed on request.
// Renders nothing when the community has no report yet (the API 404s).
import { Component, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { Check, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/queryClient";

type ClassValue = "detached" | "semi_detached" | "row" | "apartment" | "all";

interface ReportTeaser {
  title: string;
  subtitle: string;
  cls: ClassValue;
  period: string;
  periodLabel: string;
  previewUrl: string;
  pages: number;
  classOptions: Array<{ value: ClassValue; label: string }>;
  /** 13 months ending at `period` — page 1's median sold price chart. */
  months?: Array<{ period: string; median: number | null; sales: number }>;
}

// How the heading names what's being sold, per property class.
const CLASS_NOUN: Record<ClassValue, string> = {
  detached: "detached homes",
  semi_detached: "semi-detached homes",
  row: "townhomes",
  apartment: "apartments",
  all: "homes",
};

// What the gated pages (2–3) add beyond the free page 1.
const INSIDE = [
  "Active vs. sold listings and absorption rate: buyer's or seller's market",
  "Average days on market, month by month",
  "Which price bands are selling, and how fast",
  "New listings and sold-to-list price ratios",
];

// The block is an optional extra on the page: if it ever throws, hide it
// rather than take the whole neighbourhood page down with it.
class HideOnError extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error("[neighbourhood report] render failed:", err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function NeighbourhoodReport(props: { slug: string; name: string }) {
  return (
    <HideOnError>
      <NeighbourhoodReportInner {...props} />
    </HideOnError>
  );
}

function NeighbourhoodReportInner({ slug, name }: { slug: string; name: string }) {
  const { data } = useQuery<ReportTeaser | null>({
    queryKey: ["/api/public/neighbourhoods", slug, "report", "v2"],
    queryFn: async () => {
      const r = await fetch(apiUrl(`/api/public/neighbourhoods/${slug}/report`));
      if (!r.ok) return null;
      return r.json();
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const [form, setForm] = useState({ name: "", email: "", phone: "", cls: "" as ClassValue | "" });
  const [error, setError] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: async (cls: ClassValue) => {
      const r = await fetch(apiUrl(`/api/public/neighbourhoods/${slug}/report`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...form, cls }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) {
        throw new Error(
          body.message ??
            (r.status === 429
              ? "Too many requests — please try again later."
              : "Something went wrong. Please try again."),
        );
      }
      return body;
    },
    onMutate: () => setError(null),
    onError: (e: Error) => setError(e.message),
  });

  if (!data || !data.previewUrl) return null;
  const pagesLocked = Math.max(1, (data.pages ?? 3) - 1);
  // A teaser cached from before property types existed has no options (or
  // cls) — fall back to "All residential" rather than break the page.
  const classOptions: Array<{ value: ClassValue; label: string }> = Array.isArray(data.classOptions)
    ? data.classOptions
    : [{ value: "all", label: "All residential" }];
  const previewCls: ClassValue = data.cls ?? "all";
  const defaultCls = classOptions.some((o) => o.value === previewCls)
    ? previewCls
    : (classOptions[0]?.value ?? previewCls);
  const selectedCls = form.cls || defaultCls;
  const selectedLabel =
    classOptions.find((o) => o.value === selectedCls)?.label ?? data.subtitle;
  const previewIsAll = previewCls === "all";

  return (
    <section
      className="max-w-[1300px] mx-auto px-4 lg:px-8 py-20 lg:py-28"
      data-testid="section-community-report"
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-12 lg:gap-20 items-center">
        {/* Page 1, with the locked pages fanned out behind it */}
        <div className="relative mx-auto w-full max-w-[440px] pr-8 pb-8">
          {Array.from({ length: pagesLocked }).map((_, i) => (
            <div
              key={i}
              aria-hidden
              className="absolute bg-white border border-border shadow-sm"
              style={{
                inset: 0,
                transform: `translate(${(pagesLocked - i) * 16}px, ${(pagesLocked - i) * 16}px)`,
              }}
            >
              {i === 0 && (
                <div className="absolute bottom-3 right-3 flex items-center gap-1.5 text-[10px] font-display tracking-[0.2em] text-muted-foreground">
                  <Lock className="w-3 h-3" strokeWidth={1.8} />
                  {pagesLocked} MORE {pagesLocked === 1 ? "PAGE" : "PAGES"}
                </div>
              )}
            </div>
          ))}
          <a
            href={data.previewUrl}
            target="_blank"
            rel="noopener"
            className="relative block bg-white border border-border shadow-[0_18px_40px_-12px_rgba(0,0,0,0.25)] transition-transform duration-300 hover:-translate-y-1"
            data-testid="link-report-preview"
          >
            <img
              src={data.previewUrl}
              alt={`${data.title} market report, ${data.periodLabel} — page 1`}
              loading="lazy"
              width={816}
              height={1056}
              className="block w-full h-auto"
            />
          </a>
        </div>

        {/* Pitch + form */}
        <div>
          <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
            MARKET REPORT · {previewIsAll ? "" : `${data.subtitle.toUpperCase()} · `}
            {data.periodLabel.toUpperCase()}
          </div>
          <h2 className="mt-3 font-serif text-3xl lg:text-[44px] leading-[1.08]">
            What {CLASS_NOUN[previewCls] ?? "homes"} in {name} are really selling for
          </h2>
          {Array.isArray(data.months) && data.months.some((m) => m.median != null) && (
            <MedianChart months={data.months} label={`${name} ${previewIsAll ? "" : data.subtitle}`.trim()} />
          )}
          <p className="mt-5 text-muted-foreground text-[15px] leading-[1.7] max-w-xl">
            Page one is yours to read. Get the full {data.pages}-page report for the property
            type you're interested in, built from every MLS sale in {name} and updated monthly,
            sent straight to your inbox. Inside:
          </p>
          <ul className="mt-6 space-y-2.5">
            {INSIDE.map((line) => (
              <li key={line} className="flex items-start gap-3 text-[15px]">
                <Check className="w-4 h-4 mt-1 shrink-0 text-[#23412d] dark:text-emerald-400" strokeWidth={2} />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          {request.isSuccess ? (
            <div
              className="mt-8 border border-border border-l-4 border-l-[#23412d] p-6 bg-secondary/40"
              data-testid="report-request-success"
            >
              <div className="font-serif text-2xl">Check your inbox</div>
              <p className="mt-2 text-muted-foreground text-[15px] leading-[1.6]">
                The full {name} {selectedLabel.toLowerCase()} report is on its way to {form.email}. Questions about what it
                means for your home? Call or text Spencer at{" "}
                <a href="tel:+14039669237" className="underline">
                  (403) 966-9237
                </a>
                .
              </p>
            </div>
          ) : (
            <form
              className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                request.mutate(selectedCls);
              }}
              data-testid="form-report-request"
            >
              <Input
                required
                autoComplete="name"
                placeholder="Full name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="h-12 rounded-sm"
                data-testid="input-report-name"
              />
              <Input
                required
                type="email"
                autoComplete="email"
                placeholder="Email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="h-12 rounded-sm"
                data-testid="input-report-email"
              />
              <label className="sm:col-span-2 block">
                <span className="sr-only">Property type</span>
                <select
                  required
                  value={selectedCls}
                  onChange={(e) => setForm({ ...form, cls: e.target.value as ClassValue })}
                  className="h-12 w-full rounded-sm border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="select-report-class"
                >
                  {classOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      Property type: {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                type="tel"
                autoComplete="tel"
                placeholder="Phone (optional)"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="h-12 rounded-sm sm:col-span-2"
                data-testid="input-report-phone"
              />
              <Button
                type="submit"
                disabled={request.isPending}
                className="h-12 rounded-sm font-display text-[11px] tracking-[0.22em] sm:col-span-2"
                data-testid="button-report-request"
              >
                {request.isPending ? "PREPARING YOUR REPORT…" : "GET FULL REPORT"}
              </Button>
              {error && (
                <p className="sm:col-span-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <p className="sm:col-span-2 text-xs text-muted-foreground leading-relaxed">
                Free, no obligation. Spencer may follow up personally — you can opt out anytime.
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function compactMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(n / 1_000)}K`;
}

/**
 * Median sold price over 13 months, drawn like page 1 of the report: a black
 * line with alternating value labels, the latest month in gold. Months with no
 * sales are gaps, not zeros.
 */
export function MedianChart({
  months,
  label,
}: {
  months: Array<{ period: string; median: number | null; sales: number }>;
  label: string;
}) {
  const W = 640;
  const H = 230;
  const padX = 34;
  const top = 40;
  const bottom = 162;
  const vals = months.map((m) => m.median).filter((v): v is number => v != null);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || max * 0.1 || 1;
  const lo = min - span * 0.15;
  const hi = max + span * 0.15;
  const step = (W - padX * 2) / Math.max(1, months.length - 1);
  const x = (i: number) => padX + i * step;
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const last = months.length - 1;

  // Line segments, broken across months with no sales.
  const segments: string[] = [];
  let cur: string[] = [];
  months.forEach((m, i) => {
    if (m.median == null) {
      if (cur.length > 1) segments.push(cur.join(" "));
      cur = [];
    } else {
      cur.push(`${cur.length ? "L" : "M"}${x(i).toFixed(1)},${y(m.median).toFixed(1)}`);
    }
  });
  if (cur.length > 1) segments.push(cur.join(" "));

  // Label only the first, lowest, highest and latest months — every point
  // labelled is unreadable at phone width.
  const known = months.map((m, i) => ({ i, v: m.median })).filter((p): p is { i: number; v: number } => p.v != null);
  const labelled = new Set<number>([
    known[0]?.i,
    known.reduce((a, b) => (b.v < a.v ? b : a), known[0])?.i,
    known.reduce((a, b) => (b.v > a.v ? b : a), known[0])?.i,
    known[known.length - 1]?.i,
  ].filter((i): i is number => i != null));
  // Peaks get their label above, troughs below, so labels clear the line.
  const labelAbove = (i: number) => {
    const v = months[i].median!;
    const around = [months[i - 1]?.median, months[i + 1]?.median].filter((n): n is number => n != null);
    return around.length === 0 || v >= around.reduce((a, b) => a + b, 0) / around.length;
  };

  const years = Array.from(new Set(months.map((m) => m.period.slice(0, 4))));
  const latest = months[last];

  return (
    <figure className="mt-7 max-w-xl" data-testid="chart-median-sold-price">
      <figcaption className="flex items-baseline justify-between gap-4">
        <span className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
          MEDIAN SOLD PRICE · 13 MONTHS
        </span>
        {latest?.median != null && (
          <span className="font-serif text-xl tabular-nums">{compactMoney(latest.median)}</span>
        )}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 w-full h-auto text-foreground"
        role="img"
        aria-label={`Median sold price for ${label}, ${months[0]?.period} to ${latest?.period}`}
      >
        <line x1={padX - 14} x2={W - padX + 14} y1={bottom + 18} y2={bottom + 18} className="stroke-border" strokeWidth={1} />
        {segments.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {months.map((m, i) => {
          if (m.median == null) return null;
          const isLast = i === last;
          const above = labelAbove(i);
          return (
            <g key={m.period}>
              <circle cx={x(i)} cy={y(m.median)} r={isLast ? 6 : 4} fill={isLast ? "#D4AF37" : "currentColor"} />
              {labelled.has(i) && (
              <text
                x={x(i)}
                y={y(m.median) + (above ? -14 : 24)}
                textAnchor="middle"
                className={isLast ? "fill-foreground" : "fill-muted-foreground"}
                style={{ fontSize: 15, fontWeight: isLast ? 700 : 500 }}
              >
                {compactMoney(m.median)}
              </text>
              )}
            </g>
          );
        })}
        {months.map((m, i) => (
          <text
            key={`m-${m.period}`}
            x={x(i)}
            y={bottom + 38}
            textAnchor="middle"
            className="fill-muted-foreground"
            style={{ fontSize: 14 }}
          >
            {MONTH_ABBR[Number(m.period.slice(5)) - 1]}
          </text>
        ))}
        {years.map((yr) => {
          const idx = months.map((m, i) => (m.period.startsWith(yr) ? i : -1)).filter((i) => i >= 0);
          const mid = (x(idx[0]) + x(idx[idx.length - 1])) / 2;
          return (
            <text key={yr} x={mid} y={bottom + 58} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 12, letterSpacing: 1 }}>
              {yr}
            </text>
          );
        })}
      </svg>
    </figure>
  );
}
