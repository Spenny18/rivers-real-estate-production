// Text and email templates (server/templates.ts): list, create, edit, delete,
// and import from Follow Up Boss. Merge fields go in with "Insert field" and
// are filled in for each contact when a template is sent from the Inbox.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Download, Loader2, Mail, MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { MergeFieldPicker, insertAtCursor } from "@/components/merge-field-picker";

export interface MessageTemplate {
  id: number;
  kind: "email" | "text";
  name: string;
  subject: string | null;
  body: string;
  hasHtml: boolean;
  source: "app" | "fub";
  unknownFields: string[];
  updatedAt: string;
}

type Kind = "email" | "text";
const NEW = -1;

export default function AdminTemplatesPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>("text");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const { data: templates = [], isLoading } = useQuery<MessageTemplate[]>({ queryKey: [`/api/admin/templates?kind=${kind}`] });
  const refresh = () => qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith("/api/admin/templates") });

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? templates.filter((t) => `${t.name} ${t.subject ?? ""} ${t.body}`.toLowerCase().includes(n)) : templates;
  }, [templates, q]);

  const importFub = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/templates/import-fub")).json(),
    onSuccess: refresh,
  });
  const imported = importFub.data as { email: number; text: number; withUnknownFields: number; error?: string } | undefined;
  const current = selected === NEW ? null : templates.find((t) => t.id === selected) ?? null;

  return (
    <AppShell pageTitle="Templates">
      <div className="px-4 sm:px-8 py-7 space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-3xl" style={{ letterSpacing: "-0.01em" }}>
              Templates
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Reusable texts and emails. Use them from the Inbox with <span className="font-medium">Templates</span>; merge fields like{" "}
              <span className="font-mono text-[12px]">{"{contact_first_name}"}</span> fill in for each person.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="rounded-sm" onClick={() => importFub.mutate()} disabled={importFub.isPending} data-testid="templates-import-fub">
              {importFub.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Download className="w-4 h-4 mr-1.5" />}
              Import from Follow Up Boss
            </Button>
            <Button className="rounded-sm" onClick={() => setSelected(NEW)} data-testid="templates-new">
              <Plus className="w-4 h-4 mr-1" /> New {kind === "email" ? "email" : "text"} template
            </Button>
          </div>
        </div>
        {importFub.isError && <p className="text-sm text-destructive">{apiErrorMessage(importFub.error)}</p>}
        {imported && (
          <p className="text-sm text-muted-foreground">
            Imported {imported.email} email and {imported.text} text templates from Follow Up Boss (running it again updates them).
            {imported.withUnknownFields > 0 && ` ${imported.withUnknownFields} use a merge field the app doesn't have; they're flagged below.`}
            {imported.error && ` ${imported.error}`}
          </p>
        )}

        <div className="flex gap-1.5">
          {(["text", "email"] as Kind[]).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={kind === k ? "default" : "outline"}
              className="rounded-sm h-8 text-xs"
              onClick={() => {
                setKind(k);
                setSelected(null);
              }}
            >
              {k === "text" ? <MessageSquare className="w-3.5 h-3.5 mr-1" /> : <Mail className="w-3.5 h-3.5 mr-1" />}
              {k === "text" ? "Text templates" : "Email templates"}
            </Button>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
          <Card className="h-fit">
            <CardContent className="p-0">
              <div className="p-3 border-b border-border relative">
                <Search className="absolute left-5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" className="pl-8 h-9 rounded-sm text-[13px]" />
              </div>
              <div className="max-h-[65vh] overflow-y-auto divide-y divide-border">
                {isLoading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
                {!isLoading && shown.length === 0 && (
                  <div className="p-4 text-sm text-muted-foreground">{q ? "No templates match." : "No templates yet. Create one, or import from Follow Up Boss."}</div>
                )}
                {shown.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setSelected(t.id)}
                    className={`w-full text-left px-3 py-2.5 ${selected === t.id ? "bg-secondary" : "hover:bg-secondary/50"}`}
                    data-testid={`template-${t.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium truncate flex-1">{t.name}</span>
                      {t.source === "fub" && <Badge variant="outline" className="rounded-sm text-[9.5px] shrink-0">FUB</Badge>}
                      {t.unknownFields.length > 0 && <Badge variant="destructive" className="rounded-sm text-[9.5px] shrink-0">Check fields</Badge>}
                    </div>
                    <div className="text-[12px] text-muted-foreground truncate">{t.kind === "email" ? t.subject : t.body}</div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {selected === null ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">Pick a template to edit, or create a new one.</CardContent>
            </Card>
          ) : (
            <TemplateEditor
              key={`${kind}-${selected}`}
              kind={kind}
              template={current}
              onSaved={(t) => {
                refresh();
                setSelected(t.id);
              }}
              onDeleted={() => {
                refresh();
                setSelected(null);
              }}
            />
          )}
        </div>
      </div>
    </AppShell>
  );
}

function TemplateEditor({
  kind,
  template,
  onSaved,
  onDeleted,
}: {
  kind: Kind;
  template: MessageTemplate | null;
  onSaved: (t: MessageTemplate) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  useEffect(() => {
    setName(template?.name ?? "");
    setSubject(template?.subject ?? "");
    setBody(template?.body ?? "");
  }, [template?.id]);

  const bodyBox = useRef<HTMLTextAreaElement>(null);
  const subjectBox = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const subjectCaret = useRef<number | null>(null);
  const lastBox = useRef<"subject" | "body">("body");

  const save = useMutation({
    mutationFn: async () =>
      (
        await apiRequest(template ? "PATCH" : "POST", template ? `/api/admin/templates/${template.id}` : "/api/admin/templates", {
          kind,
          name,
          subject: kind === "email" ? subject : undefined,
          body,
        })
      ).json(),
    onSuccess: onSaved,
  });
  const remove = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/admin/templates/${template!.id}`)).json(),
    onSuccess: onDeleted,
  });
  const dirty = !template || name !== template.name || body !== template.body || (kind === "email" && subject !== (template.subject ?? ""));

  const insertField = (token: string) => {
    if (kind === "email" && lastBox.current === "subject") {
      const r = insertAtCursor(subjectBox.current, subject, token, subjectCaret.current);
      setSubject(r.value);
      subjectCaret.current = r.caret;
      return;
    }
    const r = insertAtCursor(bodyBox.current, body, token, caret.current);
    setBody(r.value);
    caret.current = r.caret;
    setTimeout(() => {
      bodyBox.current?.focus();
      bodyBox.current?.setSelectionRange(r.caret, r.caret);
    }, 0);
  };

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" className="font-medium" data-testid="template-name" />
          {template && (
            <Button
              variant="ghost"
              size="sm"
              className="rounded-sm"
              onClick={() => window.confirm(`Delete "${template.name}"?`) && remove.mutate()}
              aria-label="Delete template"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
        {template?.source === "fub" && (
          <p className="text-[12px] text-muted-foreground">
            Imported from Follow Up Boss{template.hasHtml ? " (its designed layout is kept; this is the plain-text version used in the Inbox)" : ""}. Edits here stay
            here; importing again would overwrite them.
          </p>
        )}
        {template && template.unknownFields.length > 0 && (
          <p className="text-[12px] text-destructive">
            Uses {template.unknownFields.map((f) => `{${f}}`).join(", ")}, which the app doesn't have. Replace it with Insert field, or add it as a custom field,
            before sending this template.
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[11px] tracking-[0.14em] uppercase text-muted-foreground">{kind === "email" ? "Subject and message" : "Message"}</span>
          <MergeFieldPicker onPick={insertField} />
        </div>
        {kind === "email" && (
          <Input
            ref={subjectBox}
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              subjectCaret.current = e.target.selectionStart;
            }}
            onFocus={() => (lastBox.current = "subject")}
            onSelect={() => (subjectCaret.current = subjectBox.current?.selectionStart ?? null)}
            placeholder="Subject"
            data-testid="template-subject"
          />
        )}
        <Textarea
          ref={bodyBox}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            caret.current = e.target.selectionStart;
          }}
          onFocus={() => (lastBox.current = "body")}
          onSelect={() => (caret.current = bodyBox.current?.selectionStart ?? null)}
          rows={kind === "email" ? 14 : 6}
          placeholder={kind === "email" ? "Hi {contact_first_name|there},\n\n…" : "Hi {contact_first_name|there}, …"}
          data-testid="template-body"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-muted-foreground">
            {kind === "text" ? `${body.length} characters${body.length > 160 ? ` · ${Math.ceil(body.length / 153)} texts` : ""}` : "Your Gmail signature is added when sent."}
          </span>
          <Button className="rounded-sm" onClick={() => save.mutate()} disabled={!dirty || !name.trim() || !body.trim() || save.isPending} data-testid="template-save">
            {save.isPending ? "Saving…" : dirty ? "Save template" : "Saved"}
          </Button>
        </div>
        {save.isError && <p className="text-sm text-destructive">{apiErrorMessage(save.error)}</p>}
      </CardContent>
    </Card>
  );
}
