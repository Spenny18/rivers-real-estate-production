// The CRM's Reports tab (server/crm-reports.ts): how leads arrive and how fast
// they're answered. Stat tiles, one single-series chart, and tables: the
// numbers are few and exact, so most of this reads better as text than as marks.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/queryClient";

interface Report {
  period: { days: number; from: string; to: string };
  summary: {
    newLeads: number;
    contacted: number;
    medianResponseMinutes: number | null;
    calls: { out: number; in: number };
    texts: { out: number; in: number };
    emails: { out: number; in: number };
    tasksOpen: number;
    tasksOverdue: number;
  };
  speed: Array<{ label: string; count: number }>;
  sources: Array<{ source: string; leads: number; contacted: number; medianResponseMinutes: number | null; nowActive: number }>;
  weeks: Array<{ week: string; newLeads: number; calls: number; texts: number; emails: number }>;
  stages: Array<{ stage: string; count: number }>;
  waiting: Array<{ id: string; name: string | null; source: string | null; created: string }>;
}

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];

/** Minutes as "3 min", "2.5 hr", "4 days". */
export function duration(mins: number | null): string {
  if (mins === null) return "—";
  if (mins < 60) return `${Math.round(mins)} min`;
  if (mins < 48 * 60) return `${(mins / 60).toFixed(mins < 600 ? 1 : 0).replace(/\.0$/, "")} hr`;
  return `${Math.round(mins / 1440)} days`;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric" });

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="eyebrow text-muted-foreground">{label}</div>
        <div className="font-serif text-3xl mt-1 tabular-nums">{value}</div>
        {sub && <div className="text-[12px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function Heading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="mb-2">
      <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground">{children}</div>
      {note && <div className="text-[12px] text-muted-foreground">{note}</div>}
    </div>
  );
}

/** A row with a proportional bar behind the count: one hue, the value as text. */
function BarRow({ label, count, max, muted }: { label: string; count: number; max: number; muted?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-3 py-1 text-[13px]">
      <span className="truncate">{label}</span>
      <div className="h-2.5 rounded-sm bg-secondary overflow-hidden" aria-hidden="true">
        <div className={`h-full rounded-sm ${muted ? "bg-muted-foreground/40" : "bg-foreground/80"}`} style={{ width: `${max ? (count / max) * 100 : 0}%` }} />
      </div>
      <span className="tabular-nums text-right">{count.toLocaleString("en-CA")}</span>
    </div>
  );
}

export function CrmReports({ onOpenContact }: { onOpenContact: (id: string) => void }) {
  const [days, setDays] = useState(30);
  const { data: r, isLoading, error } = useQuery<Report>({ queryKey: [`/api/admin/crm/reports?days=${days}`] });

  return (
    <div className="space-y-4" data-testid="crm-reports">
      <div className="flex flex-wrap items-center gap-1.5">
        {PERIODS.map((p) => (
          <Button key={p.days} size="sm" variant={days === p.days ? "default" : "outline"} onClick={() => setDays(p.days)} className="rounded-sm text-[11px] h-8">
            {p.label}
          </Button>
        ))}
      </div>
      {isLoading || !r ? (
        <p className="text-sm text-muted-foreground">{error ? apiErrorMessage(error) : "Working it out…"}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="NEW LEADS" value={r.summary.newLeads.toLocaleString("en-CA")} sub={`in the last ${PERIODS.find((p) => p.days === days)!.label}`} />
            <Tile label="CONTACTED" value={pct(r.summary.contacted, r.summary.newLeads)} sub={`${r.summary.contacted} of ${r.summary.newLeads} reached out to`} />
            <Tile label="MEDIAN RESPONSE" value={duration(r.summary.medianResponseMinutes)} sub="lead in to first call, text or email" />
            <Tile
              label="TASKS"
              value={r.summary.tasksOpen.toLocaleString("en-CA")}
              sub={r.summary.tasksOverdue ? `open · ${r.summary.tasksOverdue} overdue` : "open · none overdue"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-4">
                <Heading note="How soon each new lead got a first call, text or email">SPEED TO LEAD</Heading>
                {r.speed.map((s) => (
                  <BarRow key={s.label} label={s.label} count={s.count} max={Math.max(...r.speed.map((x) => x.count), 1)} muted={s.label === "Not contacted yet"} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <Heading note="Both directions, everything on the business line and Follow Up Boss">CONVERSATIONS</Heading>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-muted-foreground text-[12px]">
                      <th className="text-left font-normal py-1" />
                      <th className="text-right font-normal">You sent / made</th>
                      <th className="text-right font-normal">Received</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {(
                      [
                        ["Calls", r.summary.calls],
                        ["Texts", r.summary.texts],
                        ["Emails", r.summary.emails],
                      ] as const
                    ).map(([k, v]) => (
                      <tr key={k} className="border-t border-border">
                        <td className="py-1.5">{k}</td>
                        <td className="text-right">{v.out.toLocaleString("en-CA")}</td>
                        <td className="text-right">{v.in.toLocaleString("en-CA")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-4">
              <Heading note="Hover a week for the count">NEW LEADS BY WEEK</Heading>
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={r.weeks} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="week" tickFormatter={shortDate} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
                    <YAxis allowDecimals={false} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip
                      cursor={{ fill: "hsl(var(--secondary))" }}
                      labelFormatter={(w) => `Week of ${shortDate(String(w))}`}
                      formatter={(v) => [v as number, "New leads"]}
                      contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: "4px", fontSize: "12px" }}
                    />
                    <Bar dataKey="newLeads" fill="hsl(var(--foreground))" fillOpacity={0.8} radius={[4, 4, 0, 0]} maxBarSize={36} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <details className="mt-2 text-[12.5px]">
                <summary className="cursor-pointer text-muted-foreground">Week by week, with your calls, texts and emails</summary>
                <table className="w-full mt-2 tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground text-[12px]">
                      <th className="text-left font-normal py-1">Week of</th>
                      <th className="text-right font-normal">New leads</th>
                      <th className="text-right font-normal">Calls</th>
                      <th className="text-right font-normal">Texts</th>
                      <th className="text-right font-normal">Emails</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.weeks.map((w) => (
                      <tr key={w.week} className="border-t border-border">
                        <td className="py-1">{shortDate(w.week)}</td>
                        <td className="text-right">{w.newLeads}</td>
                        <td className="text-right">{w.calls}</td>
                        <td className="text-right">{w.texts}</td>
                        <td className="text-right">{w.emails}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 overflow-x-auto">
              <Heading note={`"Now active or further" is where those leads stand today: active client, under contract, closed or past client`}>LEAD SOURCES</Heading>
              {r.sources.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No new leads in this period.</p>
              ) : (
                <table className="w-full text-[13px] tabular-nums min-w-[520px]">
                  <thead>
                    <tr className="text-muted-foreground text-[12px]">
                      <th className="text-left font-normal py-1">Source</th>
                      <th className="text-right font-normal">Leads</th>
                      <th className="text-right font-normal">Contacted</th>
                      <th className="text-right font-normal">Median response</th>
                      <th className="text-right font-normal">Now active or further</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.sources.map((s) => (
                      <tr key={s.source} className="border-t border-border">
                        <td className="py-1.5 pr-3">{s.source}</td>
                        <td className="text-right">{s.leads}</td>
                        <td className="text-right">{pct(s.contacted, s.leads)}</td>
                        <td className="text-right">{duration(s.medianResponseMinutes)}</td>
                        <td className="text-right">
                          {s.nowActive} <span className="text-muted-foreground">({pct(s.nowActive, s.leads)})</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-4">
                <Heading note="New leads from this period nobody has called, texted or emailed, oldest first">WAITING FOR A FIRST CONTACT</Heading>
                {r.waiting.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Everyone has been contacted.</p>
                ) : (
                  r.waiting.map((w) => (
                    <button key={w.id} type="button" onClick={() => onOpenContact(w.id)} className="w-full flex gap-3 py-1 text-[13px] text-left hover:underline">
                      <span className="flex-1 truncate">{w.name ?? "Unnamed"}</span>
                      <span className="text-muted-foreground truncate max-w-[40%]">{w.source}</span>
                      <span className="text-muted-foreground w-24 text-right">{new Date(w.created).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</span>
                    </button>
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <Heading note="Everyone in the CRM, by stage today">ALL CONTACTS BY STAGE</Heading>
                {r.stages.slice(0, 12).map((s) => (
                  <BarRow key={s.stage} label={s.stage} count={s.count} max={r.stages[0]?.count ?? 1} />
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
