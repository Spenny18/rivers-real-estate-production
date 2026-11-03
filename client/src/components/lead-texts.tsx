// "Text me new leads" (server/lead-alerts.ts): a text from the business line
// to Spencer's cell for every new lead. Settings, a test text, and the last few.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, ChevronDown, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { timeAgoShort } from "@/lib/format";

interface LeadTexts {
  settings: { enabled: boolean; quietHours: boolean; enabledAt: string };
  configured: boolean;
  missing: string[];
  cell: string | null;
  recent: Array<{ key: string; contactName: string | null; status: string; error: string | null; createdAt: string; sendAfter: string | null }>;
}

const KEY = "/api/admin/lead-texts";

const STATUS: Record<string, string> = {
  sent: "Texted",
  sending: "Sending",
  held: "Waiting for 7 am",
  burst: "In a summary text",
  summarized: "Sent in a summary",
  failed: "Not sent",
  off: "Alerts were off",
};

export function LeadTextsCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery<LeadTexts>({ queryKey: [KEY] });
  const save = useMutation({
    mutationFn: async (patch: Partial<LeadTexts["settings"]>) => (await apiRequest("PUT", KEY, patch)).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
    onError: (e) => toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const test = useMutation({
    mutationFn: async () => apiRequest("POST", `${KEY}/test`),
    onSuccess: () => toast({ title: "Test text sent", description: `Check ${data?.cell ?? "your cell"}.` }),
    onError: (e) => toast({ title: "Couldn't send the test", description: apiErrorMessage(e), variant: "destructive" }),
  });
  if (!data) return null;
  const s = data.settings;
  return (
    <Card data-testid="lead-texts-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <BellRing className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-[200px]">
            <div className="text-sm font-medium">Text me new leads</div>
            <div className="text-[12px] text-muted-foreground">
              {data.configured
                ? `A text from the business line to ${data.cell} the moment a lead comes in.`
                : `Texting isn't set up yet: ${data.missing.join(", ")} missing on the server.`}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[12.5px]">
            <Switch checked={s.enabled} onCheckedChange={(v) => save.mutate({ enabled: v })} disabled={!data.configured || save.isPending} data-testid="switch-lead-texts" />
            On
          </label>
          <Button size="sm" variant="outline" className="rounded-sm text-[11px]" onClick={() => test.mutate()} disabled={!data.configured || test.isPending} data-testid="button-lead-text-test">
            {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Send a test"}
          </Button>
          <button type="button" onClick={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground" aria-label="More" aria-expanded={open}>
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
        {open && (
          <div className="space-y-3 text-[12.5px] border-t border-border pt-3">
            <label className="flex items-start gap-2">
              <Switch checked={s.quietHours} onCheckedChange={(v) => save.mutate({ quietHours: v })} disabled={!data.configured || save.isPending} data-testid="switch-quiet-hours" />
              <span>
                Quiet hours: leads between 10 pm and 7 am wait and are texted at 7 am.
                <span className="block text-muted-foreground">Off means every lead texts right away, day or night.</span>
              </span>
            </label>
            <p className="text-muted-foreground leading-relaxed">
              Each text has the lead's name, number, email, source and message, and a link to them in the CRM. Replying to the alert doesn't text the
              lead: start your reply with their number and a colon ("4035551234: Hi…") to text them from the business line. Leads Follow Up Boss
              brings in alert too, once, when the sync first sees them. More than 6 in an hour are rolled into one summary text.
            </p>
            {data.recent.length > 0 && (
              <div>
                <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground mb-1">RECENT</div>
                {data.recent.map((r) => (
                  <div key={r.key} className="flex gap-3 py-0.5">
                    <span className="flex-1 truncate">{r.contactName ?? "Lead"}</span>
                    <span className={r.status === "failed" ? "text-destructive" : "text-muted-foreground"} title={r.error ?? undefined}>
                      {STATUS[r.status] ?? r.status}
                    </span>
                    <span className="text-muted-foreground w-16 text-right">{timeAgoShort(r.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
