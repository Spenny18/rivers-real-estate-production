// Envelopes on the deal page: send several draft documents together, and
// follow each person's progress across them. Server: server/deal-routes.ts
// ("Envelopes") and server/envelope-store.ts.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, Copy, Loader2, Mail, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtDateTime, type DealView, type EnvelopeView } from "@/lib/esign-types";

const ENV_STATUS: Record<EnvelopeView["status"], { label: string; style: string }> = {
  sent: { label: "Out for signature", style: "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-100" },
  completed: { label: "Completed", style: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100" },
  declined: { label: "Declined", style: "bg-red-100 text-red-900 border-red-200 dark:bg-red-950 dark:text-red-100" },
  voided: { label: "Voided", style: "bg-secondary text-muted-foreground border-border" },
};

export function SendTogetherDialog({ deal, open, onOpenChange }: { deal: DealView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const drafts = deal.documents.filter((d) => d.status === "draft" && !d.envelopeId);
  const [picked, setPicked] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!open) return;
    setPicked(drafts.filter((d) => d.signerCount > 0).map((d) => d.id));
    setTitle(`${deal.title}: documents for signature`);
    setMessage("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/admin/deals/${deal.id}/envelopes`, { documentIds: picked, title, message: message || null })).json() as Promise<EnvelopeView>,
    onSuccess: (env) => {
      qc.invalidateQueries({ queryKey: [`/api/admin/deals/${deal.id}`] });
      qc.invalidateQueries({ queryKey: ["/api/admin/deals"] });
      toast({
        title: env.warning ? "Sent, with a problem" : "Envelope sent",
        description: env.warning ?? `${env.documents.length} document${env.documents.length === 1 ? "" : "s"} to ${env.recipients.length} ${env.recipients.length === 1 ? "person" : "people"}, one email each.`,
        variant: env.warning ? "destructive" : undefined,
      });
      onOpenChange(false);
    },
    onError: (e) => toast({ title: "Couldn't send", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send documents together</DialogTitle>
          <DialogDescription>
            Each person gets one email and signs everything that's theirs in one sitting. Every document still gets its own signed copy and
            certificate. Set up each document's signers and boxes first.
          </DialogDescription>
        </DialogHeader>
        {drafts.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">There are no draft documents on this deal to send.</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-sm border border-border divide-y divide-border">
              {drafts.map((d) => {
                const on = picked.includes(d.id);
                return (
                  <label key={d.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer">
                    <Checkbox
                      checked={on}
                      onCheckedChange={(v) => setPicked(v ? [...picked, d.id] : picked.filter((x) => x !== d.id))}
                      disabled={d.signerCount === 0}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] truncate">{d.title}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {d.signerCount ? `${d.signerCount} signer${d.signerCount === 1 ? "" : "s"}` : "No signers yet — set it up first"}
                        {d.signingOrder === "sequential" ? " · in order" : ""}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div>
              <label className="text-[12px] text-muted-foreground block mb-1">Envelope title (the email subject)</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className="text-[12px] text-muted-foreground block mb-1">Note to the signers (optional)</label>
              <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => send.mutate()} disabled={!picked.length || !title.trim() || send.isPending} data-testid="button-send-envelope">
            {send.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
            Send {picked.length} document{picked.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EnvelopeCard({ dealId, env }: { dealId: number; env: EnvelopeView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: [`/api/admin/deals/${dealId}`] });
  const remind = useMutation({
    mutationFn: async (recipientId?: number) =>
      (await apiRequest("POST", `/api/admin/envelopes/${env.id}/remind`, recipientId ? { recipientId } : {})).json() as Promise<EnvelopeView & { sent: number }>,
    onSuccess: (r) => {
      refresh();
      toast({ title: `Reminder sent to ${r.sent} ${r.sent === 1 ? "person" : "people"}` });
    },
    onError: (e) => toast({ title: "Couldn't remind", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const voidEnv = useMutation({
    mutationFn: async (reason: string) => (await apiRequest("POST", `/api/admin/envelopes/${env.id}/void`, { reason })).json(),
    onSuccess: () => {
      refresh();
      toast({ title: "Envelope voided" });
    },
    onError: (e) => toast({ title: "Couldn't void", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const st = ENV_STATUS[env.status];

  return (
    <Card data-testid={`envelope-${env.id}`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium text-[14px] truncate">{env.title}</div>
            <div className="text-[12px] text-muted-foreground">
              Envelope · {env.documents.length} document{env.documents.length === 1 ? "" : "s"}
              {env.sentAt ? ` · sent ${fmtDateTime(env.sentAt)}` : ""}
              {env.completedAt ? ` · completed ${fmtDateTime(env.completedAt)}` : ""}
              {env.voidedAt ? ` · voided ${fmtDateTime(env.voidedAt)}${env.voidReason ? `: ${env.voidReason}` : ""}` : ""}
            </div>
          </div>
          <Badge variant="outline" className={`text-[10px] shrink-0 ${st.style}`}>
            {st.label}
          </Badge>
        </div>

        <div className="text-[12.5px] space-y-0.5">
          {env.documents.map((d) => (
            <a key={d.id} href={`/admin/deals/${dealId}/documents/${d.id}`} className="flex items-center gap-1.5 hover:underline underline-offset-2">
              {d.status === "completed" ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              ) : d.status === "sent" ? (
                <Clock className="h-3.5 w-3.5 text-amber-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              {d.title}
              {d.signingOrder === "sequential" ? <span className="text-muted-foreground"> · in order</span> : null}
            </a>
          ))}
        </div>

        <div className="rounded-sm border border-border divide-y divide-border">
          {env.recipients.map((r) => (
            <div key={r.id} className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] truncate">{r.name}</div>
                <div className="text-[11.5px] text-muted-foreground truncate">
                  {r.email} · {r.signed} of {r.total} signed
                  {r.status === "declined" ? " · declined" : r.waiting && !r.canSignNow ? " · waiting on others" : ""}
                  {r.lastEmailAt ? ` · emailed ${fmtDateTime(r.lastEmailAt)}` : ""}
                </div>
              </div>
              <button
                className="text-[11.5px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                onClick={() => {
                  void navigator.clipboard.writeText(r.signUrl);
                  toast({ title: "Signing link copied", description: "It's private to this person." });
                }}
              >
                <Copy className="h-3 w-3" /> Link
              </button>
              {env.status === "sent" && r.canSignNow > 0 ? (
                <button
                  className="text-[11.5px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  onClick={() => remind.mutate(r.id)}
                  disabled={remind.isPending}
                >
                  <Mail className="h-3 w-3" /> Remind
                </button>
              ) : null}
            </div>
          ))}
        </div>

        {env.status === "sent" ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => remind.mutate(undefined)} disabled={remind.isPending}>
              {remind.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Mail className="h-3.5 w-3.5 mr-1" />} Remind everyone waiting
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => {
                const reason = window.prompt("Void this envelope? Every unsigned document in it is voided. Reason (optional):");
                if (reason !== null) voidEnv.mutate(reason);
              }}
            >
              Void
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
