// Every "Fix with Claude" run, newest first — where drafts wait for review
// and where an applied fix is found again to undo it.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, History } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { STATUS_LABELS, type FixProposal } from "./types";

const STATUS_TONE: Partial<Record<FixProposal["status"], string>> = {
  ready: "text-amber-700 dark:text-amber-400",
  applied: "text-emerald-700 dark:text-emerald-400",
  partially_applied: "text-emerald-700 dark:text-emerald-400",
  failed: "text-rose-700 dark:text-rose-400",
};

export function FixHistory({ onOpen }: { onOpen: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["/api/admin/seo/fixes"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/admin/seo/fixes");
      return ((await r.json()).fixes ?? []) as FixProposal[];
    },
    staleTime: 10 * 1000,
    refetchInterval: (q) =>
      ((q.state.data as FixProposal[] | undefined) ?? []).some((f) => f.status === "generating") ? 4000 : false,
  });

  const fixes = data ?? [];
  if (fixes.length === 0) return null;
  const waiting = fixes.filter((f) => f.status === "ready").length;

  return (
    <section className="border border-border bg-card" data-testid="section-fix-history">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 p-4 text-left"
      >
        <span className="flex items-center gap-2 font-display text-[11px] tracking-[0.16em] text-muted-foreground">
          <History className="w-3.5 h-3.5" /> FIX HISTORY · {fixes.length}
          {waiting > 0 && (
            <span className="text-amber-700 dark:text-amber-400 normal-case tracking-normal text-xs font-sans">
              {waiting} waiting for review
            </span>
          )}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {fixes.map((f) => (
            <li key={f.id}>
              <button
                onClick={() => onOpen(f.id)}
                className="w-full text-left px-4 py-3 hover:bg-secondary/40 flex flex-wrap items-center gap-x-4 gap-y-1"
              >
                <span className={`text-[10px] uppercase tracking-wider w-28 shrink-0 ${STATUS_TONE[f.status] ?? "text-muted-foreground"}`}>
                  {STATUS_LABELS[f.status]}
                </span>
                <span className="text-sm flex-1 min-w-0 truncate">{f.summary || f.subject?.label || `Fix #${f.id}`}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {new Date(f.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
