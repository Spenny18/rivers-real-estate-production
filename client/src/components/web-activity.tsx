// Website + email activity for the CRM: one person's timeline (shown in the
// contact drawer) and the "recently active" list. Data comes from
// /api/admin/tracking/*, backed by server/tracking.ts.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Globe, Home, Loader2, MailOpen, MousePointerClick, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ActivityEvent {
  id: number;
  kind: "pageview" | "listing_view" | "identify" | "email_open" | "email_click" | string;
  path: string | null;
  title: string | null;
  referrer: string | null;
  mlsNumber: string | null;
  props: {
    listing?: {
      mlsNumber?: string | null;
      address?: string | null;
      price?: number | null;
      beds?: number | null;
      baths?: number | null;
      neighbourhood?: string | null;
    };
    via?: string;
    emailKind?: string;
    likelyAutomated?: boolean;
  };
  occurredAt: string;
}

interface Summary {
  visits: number;
  pageviews: number;
  listingViews: number;
  lastSeenAt: string | null;
  firstSeenAt: string | null;
  firstReferrer: string | null;
  firstLanding: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  emailsSent: number;
  emailsOpened: number;
  emailsClicked: number;
  topNeighbourhoods: Array<{ name: string; count: number }>;
}

interface ActivityResponse {
  summary: Summary;
  events: ActivityEvent[];
}

export interface RecentVisitor {
  email: string;
  lastAt: string;
  events: number;
  listingViews: number;
  emailClicks: number;
  contactFubId: string | null;
  name: string | null;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function price(n: number | null | undefined): string | null {
  if (!n || !Number.isFinite(n)) return null;
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;
}

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.startsWith("/") ? null : url;
  }
}

const EMAIL_KIND_LABEL: Record<string, string> = {
  crm: "Email",
  lead_alert: "Listing alert",
  newsletter: "Newsletter",
  valuation: "Valuation email",
};

/** One timeline row's icon and wording. */
function describe(e: ActivityEvent): { Icon: typeof Eye; text: React.ReactNode } {
  switch (e.kind) {
    case "listing_view": {
      const l = e.props.listing ?? {};
      const bits = [price(l.price), l.beds ? `${l.beds} bd` : null, l.baths ? `${l.baths} ba` : null, l.neighbourhood]
        .filter(Boolean)
        .join(" · ");
      return {
        Icon: Home,
        text: (
          <>
            Viewed{" "}
            <a href={e.path ?? "#"} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {l.address ?? e.mlsNumber ?? "a listing"}
            </a>
            {bits && <span className="text-muted-foreground"> · {bits}</span>}
          </>
        ),
      };
    }
    case "pageview":
      return {
        Icon: Eye,
        text: (
          <>
            <span className="text-muted-foreground">Visited</span> {e.path}
          </>
        ),
      };
    case "identify":
      return { Icon: UserCheck, text: <>Identified via {e.props.via ?? "the site"}</> };
    case "email_open":
      return {
        Icon: MailOpen,
        text: (
          <>
            Opened {EMAIL_KIND_LABEL[e.props.emailKind ?? ""]?.toLowerCase() ?? "email"}{" "}
            <span className="text-muted-foreground">“{e.title}”</span>
            {e.props.likelyAutomated && (
              <span className="text-muted-foreground" title="Opened within a minute of sending — usually a mail server or privacy proxy loading images, not a person.">
                {" "}· likely automated
              </span>
            )}
          </>
        ),
      };
    case "email_click":
      return {
        Icon: MousePointerClick,
        text: (
          <>
            Clicked <span className="text-muted-foreground">{host(e.path) ?? e.path}</span> in “{e.title}”
          </>
        ),
      };
    default:
      return { Icon: Globe, text: e.kind };
  }
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-sm bg-secondary/40 px-3 py-2">
      <div className="text-[16px] font-serif leading-tight">{value}</div>
      <div className="font-display text-[9.5px] tracking-[0.16em] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

const INITIAL_ROWS = 25;

/** The contact drawer's website + email section. */
export function WebActivityPanel({ email }: { email: string }) {
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useQuery<ActivityResponse>({
    queryKey: [`/api/admin/tracking/activity?email=${encodeURIComponent(email)}`],
  });

  return (
    <div data-testid="web-activity">
      <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-2">
        WEBSITE &amp; EMAIL ACTIVITY
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : !data || data.events.length === 0 ? (
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          No tracked activity yet. It starts once they submit a form on the site, sign in to their
          portal, or click a link in an email sent from here.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="LAST SEEN" value={data.summary.lastSeenAt ? ago(data.summary.lastSeenAt) : "—"} />
            <Stat label="VISITS" value={data.summary.visits} />
            <Stat label="LISTINGS VIEWED" value={data.summary.listingViews} />
            <Stat
              label={`OF ${data.summary.emailsSent} TRACKED EMAIL${data.summary.emailsSent === 1 ? "" : "S"}`}
              value={`${data.summary.emailsOpened} opened · ${data.summary.emailsClicked} clicked`}
            />
          </div>
          {(data.summary.topNeighbourhoods.length > 0 || data.summary.firstReferrer || data.summary.utmSource) && (
            <div className="text-[12.5px] text-muted-foreground leading-relaxed space-y-0.5">
              {data.summary.topNeighbourhoods.length > 0 && (
                <div>
                  Looking at:{" "}
                  <span className="text-foreground">
                    {data.summary.topNeighbourhoods.map((n) => `${n.name} (${n.count})`).join(", ")}
                  </span>
                </div>
              )}
              {(data.summary.utmSource || data.summary.firstReferrer) && (
                <div>
                  First came from:{" "}
                  <span className="text-foreground">
                    {data.summary.utmSource
                      ? `${data.summary.utmSource}${data.summary.utmCampaign ? ` / ${data.summary.utmCampaign}` : ""}`
                      : host(data.summary.firstReferrer)}
                  </span>
                  {data.summary.firstSeenAt && ` · ${when(data.summary.firstSeenAt)}`}
                </div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            {(showAll ? data.events : data.events.slice(0, INITIAL_ROWS)).map((e) => {
              const { Icon, text } = describe(e);
              return (
                <div key={e.id} className="flex items-start gap-2.5">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-[3px]" />
                  <div className="min-w-0 flex-1 text-[13px] leading-snug break-words">{text}</div>
                  <div className="text-[11.5px] text-muted-foreground shrink-0 whitespace-nowrap">
                    {when(e.occurredAt)}
                  </div>
                </div>
              );
            })}
          </div>
          {!showAll && data.events.length > INITIAL_ROWS && (
            <Button variant="ghost" size="sm" className="rounded-sm text-[11px]" onClick={() => setShowAll(true)}>
              Show all {data.events.length}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Identified people active on the site or in email recently, newest first. */
export function RecentlyActiveList({ onOpen }: { onOpen: (fubId: string) => void }) {
  const [days, setDays] = useState(7);
  const { data = [], isLoading } = useQuery<RecentVisitor[]>({
    queryKey: [`/api/admin/tracking/recent?days=${days}`],
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {[1, 7, 30].map((d) => (
          <Button
            key={d}
            size="sm"
            variant={days === d ? "default" : "outline"}
            onClick={() => setDays(d)}
            className="rounded-sm text-[11px]"
          >
            {d === 1 ? "Today" : `${d} days`}
          </Button>
        ))}
        <span className="text-[12px] text-muted-foreground">
          Known people only — anonymous traffic stays in Google Analytics.
        </span>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6">Nobody identified has been active in this window.</p>
      ) : (
        <div className="space-y-1.5" data-testid="recently-active">
          {data.map((v) => {
            const body = (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 rounded-sm border border-border hover:border-foreground/30 transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] truncate">{v.name ?? v.email}</div>
                  {v.name && <div className="text-[12px] text-muted-foreground truncate">{v.email}</div>}
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {v.listingViews} listing{v.listingViews === 1 ? "" : "s"} · {v.events} event{v.events === 1 ? "" : "s"}
                  {v.emailClicks > 0 && ` · ${v.emailClicks} email click${v.emailClicks === 1 ? "" : "s"}`}
                </div>
                <div className="text-[12px] text-muted-foreground w-20 text-right">{ago(v.lastAt)}</div>
              </div>
            );
            return v.contactFubId ? (
              <button key={v.email} className="w-full text-left" onClick={() => onOpen(v.contactFubId!)}>
                {body}
              </button>
            ) : (
              <div key={v.email} title="Not in the CRM mirror yet">
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
