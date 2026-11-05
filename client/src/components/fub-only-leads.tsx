// "Leads only Follow Up Boss caught" (server/lead-alerts.ts fubOnlyLeads): the
// people FUB brought in that the app had no enquiry for, grouped by source.
// Every source listed still delivers only into FUB and needs repointing to the
// Gmail inbox the app reads before FUB is switched off.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, Unplug } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgoShort } from "@/lib/format";

interface FubOnly {
  days: number;
  since: string;
  sources: Array<{ source: string; count: number; missed: number; last: string }>;
  leads: Array<{ contactId: string; name: string | null; source: string; createdAt: string; alsoInApp: boolean }>;
}

const KEY = "/api/admin/lead-texts/fub-only";

export function FubOnlyLeadsCard() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery<FubOnly>({ queryKey: [KEY], refetchInterval: 5 * 60_000 });
  if (!data) return null;
  const missed = data.sources.reduce((n, s) => n + s.missed, 0);
  const sinceLabel = new Date(data.since).toLocaleDateString("en-CA", { month: "short", day: "numeric" });

  if (data.sources.length === 0) {
    return (
      <Card data-testid="fub-only-card">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="text-[12.5px]">
            <span className="font-medium text-sm">Every lead reached the app first</span>
            <span className="block text-muted-foreground">
              Since {sinceLabel}, Follow Up Boss hasn't brought in anyone the app didn't already have.
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="fub-only-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Unplug className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-[200px]">
            <div className="text-sm font-medium">
              {missed > 0 ? `${missed} lead${missed === 1 ? "" : "s"} only Follow Up Boss caught` : "Follow Up Boss caught some leads first"}
            </div>
            <div className="text-[12px] text-muted-foreground">
              Since {sinceLabel}. These sources still deliver only into Follow Up Boss. Repoint them to your Gmail before switching it off.
            </div>
          </div>
          <button type="button" onClick={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground" aria-label="More" aria-expanded={open}>
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
        <div className="text-[12.5px]">
          {data.sources.map((s) => (
            <div key={s.source} className="flex gap-3 py-0.5" data-testid="fub-only-source">
              <span className="flex-1 truncate font-medium">{s.source}</span>
              <span className="text-muted-foreground">
                {s.missed} missed{s.count > s.missed ? ` · ${s.count - s.missed} reached the app later` : ""}
              </span>
              <span className="text-muted-foreground w-16 text-right">{timeAgoShort(s.last)}</span>
            </div>
          ))}
        </div>
        {open && (
          <div className="space-y-3 text-[12.5px] border-t border-border pt-3">
            <p className="text-muted-foreground leading-relaxed">
              Each person here arrived through Follow Up Boss's sync, the alerts marked "via Follow Up Boss", without an enquiry in the app. In each
              source's settings, change where new leads are sent from Follow Up Boss to your email, and the app reads them like REW.ca and Realtor.ca.
              A source that won't email at all needs another route into the app. "Reached the app later" means the app got that person's enquiry
              too, after Follow Up Boss did.
            </p>
            <div>
              <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1">RECENT</div>
              {data.leads.map((l) => (
                <div key={l.contactId} className="flex gap-3 py-0.5">
                  <Link href={`/admin/crm?contact=${encodeURIComponent(l.contactId)}`} className="flex-1 truncate hover:underline">
                    {l.name ?? "Lead"}
                  </Link>
                  <span className="text-muted-foreground truncate max-w-[45%]">
                    {l.source}
                    {l.alsoInApp ? " · reached the app later" : ""}
                  </span>
                  <span className="text-muted-foreground w-16 text-right">{timeAgoShort(l.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
