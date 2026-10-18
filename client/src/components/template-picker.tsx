// Pick a saved text or email template (server/templates.ts). Used by the
// Inbox composer and bulk texts.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { FileStack } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { MessageTemplate } from "@/pages/admin-templates";

export function TemplatePicker({ kind, onPick, disabled }: { kind: "email" | "text"; onPick: (t: MessageTemplate) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data: templates = [], isLoading } = useQuery<MessageTemplate[]>({ queryKey: [`/api/admin/templates?kind=${kind}`], enabled: open });
  const n = q.trim().toLowerCase();
  const shown = n ? templates.filter((t) => `${t.name} ${t.subject ?? ""} ${t.body}`.toLowerCase().includes(n)) : templates;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="px-2.5 py-1 rounded-sm text-[11.5px] flex items-center gap-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-50"
          data-testid="inbox-templates"
        >
          <FileStack className="h-3 w-3" /> Templates
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[400px] p-0">
        <div className="p-2 border-b border-border">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${kind} templates`} autoFocus className="h-8 text-[13px]" />
        </div>
        <div className="max-h-[360px] overflow-y-auto divide-y divide-border">
          {isLoading && <div className="px-3 py-2 text-[12px] text-muted-foreground">Loading…</div>}
          {!isLoading && shown.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-muted-foreground">
              {templates.length ? "No templates match." : "No templates yet."}{" "}
              <Link href="/admin/templates" className="underline underline-offset-2">
                Manage templates
              </Link>
            </div>
          )}
          {shown.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                onPick(t);
                setOpen(false);
                setQ("");
              }}
              className="w-full text-left px-3 py-2 hover:bg-secondary"
              data-testid={`use-template-${t.id}`}
            >
              <div className="text-[13px] font-medium truncate flex items-center gap-1.5">
                {t.name}
                {t.unknownFields.length > 0 && <span className="text-[10px] text-destructive font-normal">check fields</span>}
              </div>
              <div className="text-[11.5px] text-muted-foreground line-clamp-2 whitespace-pre-line">{t.kind === "email" && t.subject ? `${t.subject} — ${t.body}` : t.body}</div>
            </button>
          ))}
        </div>
        <div className="border-t border-border px-3 py-2 text-[11.5px]">
          <Link href="/admin/templates" className="underline underline-offset-2">
            Manage templates
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
