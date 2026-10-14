// "Recent activity" on the dashboard: who just visited the site, opened or
// clicked an email, saved a listing, enquired or replied (server/dashboard-activity.ts).

import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, Home, MailOpen, MousePointerClick, UserPlus, MessageSquare, Heart, Reply } from "lucide-react";
import { timeAgo } from "@/lib/mock-data";

type Kind = "visit" | "listing" | "open" | "click" | "signup" | "inquiry" | "saved" | "reply";

interface Row {
  key: string;
  contactFubId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  kind: Kind;
  label: string;
  path: string | null;
  at: string;
  count: number;
}

const ICONS: Record<Kind, { icon: any; className: string }> = {
  visit: { icon: Eye, className: "text-amber-600 dark:text-amber-400" },
  listing: { icon: Home, className: "text-amber-600 dark:text-amber-400" },
  open: { icon: MailOpen, className: "text-sky-600 dark:text-sky-400" },
  click: { icon: MousePointerClick, className: "text-sky-600 dark:text-sky-400" },
  signup: { icon: UserPlus, className: "text-emerald-600 dark:text-emerald-400" },
  inquiry: { icon: MessageSquare, className: "text-emerald-600 dark:text-emerald-400" },
  saved: { icon: Heart, className: "text-rose-600 dark:text-rose-400" },
  reply: { icon: Reply, className: "text-violet-600 dark:text-violet-400" },
};

const FILTERS: Array<[string, string]> = [
  ["all", "All activity"],
  ["visit", "Website visits"],
  ["open", "Email opens"],
  ["click", "Email clicks"],
  ["saved", "Saved listings"],
  ["inquiry", "Inquiries"],
  ["reply", "Replies"],
];

function initials(name: string | null, email: string | null): string {
  const src = (name || email || "?").trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (name ? parts[1]?.[0] ?? "" : "")).toUpperCase();
}

export function RecentActivity() {
  const [kind, setKind] = useState("all");
  const { data, isLoading } = useQuery<Row[]>({
    queryKey: [`/api/admin/dashboard/activity?days=30&limit=25&kind=${kind}`],
    refetchInterval: 60_000,
  });

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h3 className="font-serif text-xl" style={{ letterSpacing: "-0.01em" }}>
              Recent activity
            </h3>
            <p className="eyebrow text-muted-foreground mt-1">Contacts on your site and in your email, last 30 days</p>
          </div>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-[180px] rounded-sm h-9" data-testid="select-activity-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">Nothing yet in the last 30 days.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="font-medium px-5 py-2.5">Name</th>
                  <th className="font-medium px-3 py-2.5 hidden lg:table-cell">Email</th>
                  <th className="font-medium px-3 py-2.5 hidden md:table-cell">Phone</th>
                  <th className="font-medium px-3 py-2.5">Last activity</th>
                  <th className="font-medium px-3 py-2.5 whitespace-nowrap">Time</th>
                  <th className="font-medium px-5 py-2.5 hidden sm:table-cell">Stage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.map((r) => {
                  const { icon: Icon, className } = ICONS[r.kind];
                  const name = r.name || r.email || "Unknown";
                  return (
                    <tr key={r.key} className="hover:bg-secondary/40" data-testid="row-activity">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="w-8 h-8 shrink-0 rounded-full bg-secondary text-foreground flex items-center justify-center text-[11px] font-medium">
                            {initials(r.name, r.email)}
                          </span>
                          {r.contactFubId ? (
                            <Link href={`/admin/crm?contact=${encodeURIComponent(r.contactFubId)}`} className="truncate hover:underline underline-offset-2">
                              {name}
                            </Link>
                          ) : (
                            <span className="truncate">{name}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 hidden lg:table-cell text-muted-foreground max-w-[200px] truncate">{r.email ?? ""}</td>
                      <td className="px-3 py-3 hidden md:table-cell text-muted-foreground whitespace-nowrap">{r.phone ?? ""}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon className={`w-4 h-4 shrink-0 ${className}`} strokeWidth={1.8} />
                          <span className="truncate max-w-[340px]" title={r.label}>
                            {r.label}
                          </span>
                          {r.count > 1 && (
                            <span className="text-xs text-muted-foreground whitespace-nowrap">+{r.count - 1} more</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">{timeAgo(r.at)}</td>
                      <td className="px-5 py-3 hidden sm:table-cell text-muted-foreground">{r.stage ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
