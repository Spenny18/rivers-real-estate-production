// "Notifications on this device" (server/push.ts, lib/push.ts): turn push on
// for the iPhone's Home Screen app (or any browser), pick what notifies, and
// send a test.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Loader2, Share } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { timeAgoShort } from "@/lib/format";
import { currentPushState, deviceLabel, subscribeThisDevice, unsubscribeThisDevice, type PushState } from "@/lib/push";

interface PushConfig {
  publicKey: string;
  settings: Record<string, boolean>;
  kinds: Record<string, string>;
  devices: Array<{ endpoint: string; label: string | null; service: string; createdAt: string; lastOkAt: string | null; lastError: string | null }>;
}

const KEY = "/api/admin/push";

export function PushNotificationsCard({ compact = false }: { compact?: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data } = useQuery<PushConfig>({ queryKey: [KEY] });
  const [state, setState] = useState<PushState | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const refreshState = () =>
    currentPushState()
      .then((s) => {
        setState(s.state);
        setEndpoint(s.endpoint);
      })
      .catch(() => setState("unsupported"));
  useEffect(() => {
    refreshState();
  }, []);

  const turnOn = useMutation({
    mutationFn: async () => {
      const sub = await subscribeThisDevice(data!.publicKey);
      return (await apiRequest("POST", `${KEY}/subscribe`, { subscription: sub, label: deviceLabel() })).json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      refreshState();
      toast({ title: "Notifications are on for this device" });
    },
    onError: (e) => {
      refreshState();
      toast({ title: "Couldn't turn on notifications", description: apiErrorMessage(e), variant: "destructive" });
    },
  });
  const turnOff = useMutation({
    mutationFn: async () => {
      const ep = await unsubscribeThisDevice();
      if (ep) await apiRequest("POST", `${KEY}/unsubscribe`, { endpoint: ep });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      refreshState();
    },
    onError: (e) => toast({ title: "Couldn't turn them off", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const save = useMutation({
    mutationFn: async (patch: Record<string, boolean>) => (await apiRequest("PUT", `${KEY}/settings`, patch)).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
    onError: (e) => toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const test = useMutation({
    mutationFn: async () => (await apiRequest("POST", `${KEY}/test`)).json(),
    onSuccess: (r: { sent: number }) => toast({ title: "Test sent", description: `To ${r.sent} device${r.sent === 1 ? "" : "s"}. It can take a few seconds.` }),
    onError: (e) => toast({ title: "Couldn't send the test", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (!data || state === null) return null;
  // On the dashboard, only speak up when there's something to do on this device.
  if (compact && (state === "on" || state === "unsupported")) return null;

  const otherDevices = data.devices.filter((d) => d.endpoint !== endpoint);
  return (
    <Card data-testid="push-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {state === "on" ? <Bell className="h-4 w-4 shrink-0" /> : <BellOff className="h-4 w-4 text-muted-foreground shrink-0" />}
          <div className="flex-1 min-w-[200px]">
            <div className="text-sm font-medium">Notifications on this device</div>
            <div className="text-[12px] text-muted-foreground" data-testid="push-state">
              {state === "on" && "On. New leads, texts, emails, missed calls and due tasks show up here."}
              {state === "off" && "Get a notification for new leads, texts, emails, missed calls and due tasks."}
              {state === "blocked" && "Blocked. Allow them in your phone's Settings → Notifications → Rivers Admin, then reopen the app."}
              {state === "unsupported" && "This browser can't show push notifications."}
              {state === "install-first" && (
                <span>
                  On iPhone, open this from the Home Screen app: in Safari tap <Share className="inline h-3.5 w-3.5 align-text-bottom" aria-label="Share" /> Share, then
                  "Add to Home Screen", open Rivers Admin from your Home Screen, sign in, and turn them on there.
                </span>
              )}
            </div>
          </div>
          {state === "off" && (
            <Button size="sm" className="rounded-sm text-[11px]" onClick={() => turnOn.mutate()} disabled={turnOn.isPending} data-testid="button-push-on">
              {turnOn.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "TURN ON"}
            </Button>
          )}
          {state === "on" && (
            <>
              <Button size="sm" variant="outline" className="rounded-sm text-[11px]" onClick={() => test.mutate()} disabled={test.isPending} data-testid="button-push-test">
                {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Send a test"}
              </Button>
              <Button size="sm" variant="ghost" className="rounded-sm text-[11px] text-muted-foreground" onClick={() => turnOff.mutate()} disabled={turnOff.isPending}>
                Turn off here
              </Button>
            </>
          )}
        </div>

        {!compact && (
          <div className="border-t border-border pt-3 space-y-2 text-[12.5px]">
            <div className="font-display text-[10px] tracking-[0.18em] text-muted-foreground">WHAT NOTIFIES (EVERY DEVICE)</div>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
              {Object.entries(data.kinds).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2">
                  <Switch checked={data.settings[k] !== false} onCheckedChange={(v) => save.mutate({ [k]: v })} disabled={save.isPending} data-testid={`switch-push-${k}`} />
                  {label}
                </label>
              ))}
            </div>
            {otherDevices.length > 0 && (
              <div className="text-muted-foreground">
                Also on:{" "}
                {otherDevices.map((d, i) => (
                  <span key={d.endpoint}>
                    {i ? ", " : ""}
                    {d.label ?? d.service}
                    {d.lastError ? " (last one failed)" : d.lastOkAt ? ` (last ${timeAgoShort(d.lastOkAt)})` : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
