// /admin/deals/:id/forms/:templateId — review and fill a form for a deal.
//
// The server pre-fills what it knows (the deal, its MLS listing, the client
// in Follow Up Boss, the agent, and whatever was typed on the previous form
// for this deal). The agent checks the parties, fills the rest, watches the
// live preview, and creates the document: a draft with the signers and their
// boxes already in place, ready to send.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, FilePlus2, Loader2, RefreshCw } from "lucide-react";
import { apiErrorMessage, apiRequest, apiUrl, getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PdfPages } from "@/components/pdf-pages";
import { fmtDateTime, type DealView, type DocumentDetail, type FormFillBox, type FormPrefill, type PrefillSource } from "@/lib/esign-types";
import {
  BINDING_BY_KEY,
  BINDING_GROUP_LABELS,
  PARTY_ATTRS,
  bindingLabel,
  formatFillValue,
  parsePartyKey,
  partyKey,
  type Binding,
  type BindingGroup,
  type FillType,
  type PartyAttr,
  type PartyRole,
} from "@shared/form-bindings";

const PAGE_WIDTH = 640;
const ORDINAL = ["First", "Second", "Third", "Fourth"];
const ATTR_LABELS: Record<PartyAttr, string> = { name: "Full name", email: "Email", phone: "Phone", address: "Mailing address" };
const GROUP_ORDER: BindingGroup[] = ["property", "offer", "amendment", "listing", "document", "agent"];
const SOURCE_LABELS: Record<PrefillSource, string> = {
  deal: "from the deal",
  listing: "from the MLS® listing",
  agent: "your details",
  contact: "from Follow Up Boss",
  previous: "carried forward",
  auto: "automatic",
};

interface FieldSpec {
  key: string;
  label: string;
  type: FillType;
  group: BindingGroup | "custom";
  hint?: string;
  readOnly: boolean;
}

export default function AdminDealFormPage() {
  const params = useParams<{ id: string; templateId: string }>();
  const dealId = Number(params.id);
  const templateId = Number(params.templateId);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: deal } = useQuery<DealView>({ queryKey: [`/api/admin/deals/${dealId}`], enabled: Number.isFinite(dealId) });
  const { data: prefill, isLoading, error } = useQuery<FormPrefill>({
    queryKey: [`/api/admin/deals/${dealId}/form-prefill?templateId=${templateId}`],
    enabled: Number.isFinite(dealId) && Number.isFinite(templateId),
    staleTime: Infinity,
  });

  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [title, setTitle] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!prefill || values) return;
    setValues(prefill.values);
    setPreviewValues(prefill.values);
    setTitle(prefill.template.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // Re-render the preview a moment after typing stops.
  useEffect(() => {
    if (!values) return;
    const t = setTimeout(() => {
      if (JSON.stringify(values) !== JSON.stringify(previewValues)) {
        setPreviewValues(values);
        setPreviewVersion((v) => v + 1);
      }
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const create = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/admin/deals/${dealId}/documents/from-template`, { templateId, title: title.trim(), values: values ?? {} })).json() as Promise<
        DocumentDetail & { signersAdded: number; boxesPlaced: number; skippedBoxes: number }
      >,
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: [`/api/admin/deals/${dealId}`] });
      qc.invalidateQueries({ queryKey: ["/api/admin/deals"] });
      toast({
        title: "Document created",
        description: `${d.signersAdded} signer${d.signersAdded === 1 ? "" : "s"}, ${d.boxesPlaced} box${d.boxesPlaced === 1 ? "" : "es"} placed.${d.skippedBoxes ? ` ${d.skippedBoxes} box(es) skipped: their party was left blank.` : ""}`,
      });
      window.location.assign(`/admin/deals/${dealId}/documents/${d.id}`);
    },
    onError: (e) => toast({ title: "Couldn't create the document", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // Which blanks the form has, grouped, in a stable order.
  const specs = useMemo(() => {
    if (!prefill) return [] as FieldSpec[];
    const seen = new Set<string>();
    const out: FieldSpec[] = [];
    for (const f of prefill.template.fields) {
      if (f.kind !== "fill" || seen.has(f.name) || parsePartyKey(f.name)) continue;
      seen.add(f.name);
      const b: Binding | undefined = BINDING_BY_KEY[f.name];
      out.push({
        key: f.name,
        label: bindingLabel(f.name, (f as FormFillBox).label),
        type: b?.type ?? (f as FormFillBox).dataType,
        group: b ? b.group : "custom",
        hint: b?.hint,
        readOnly: b?.source === "agent" || b?.source === "auto",
      });
    }
    return out;
  }, [prefill]);

  if (isLoading || !prefill || !values) {
    return (
      <AppShell pageTitle="New document">
        <div className="p-6 text-[13px] text-muted-foreground flex items-center gap-2">
          {error ? apiErrorMessage(error) : <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>}
        </div>
      </AppShell>
    );
  }

  const token = getAuthToken();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const set = (k: string, v: string) => setValues((vals) => ({ ...(vals ?? {}), [k]: v }));
  const sourceOf = (k: string): PrefillSource | undefined => (prefill.values[k] !== undefined && prefill.values[k] === values[k] ? prefill.sources[k] : undefined);
  const groups = [...GROUP_ORDER, "custom" as const].map((g) => ({ group: g, items: specs.filter((s) => s.group === g) })).filter((g) => g.items.length);

  const partyBlock = (role: PartyRole, index: number) => (
    <Card key={`${role}${index}`}>
      <CardContent className="p-3 space-y-2">
        <div className="text-[12px] font-medium">
          {ORDINAL[index - 1]} {role}
          {index > 1 ? <span className="text-muted-foreground font-normal"> · leave blank if there is no {ORDINAL[index - 1].toLowerCase()} {role}</span> : null}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {PARTY_ATTRS.map((attr) => {
            const k = partyKey(role, index, attr);
            const src = sourceOf(k);
            return (
              <div key={attr} className={`space-y-0.5 ${attr === "address" ? "col-span-2" : ""}`}>
                <Label className="text-[10px] text-muted-foreground">
                  {ATTR_LABELS[attr]}
                  {src && src !== "auto" ? ` · ${SOURCE_LABELS[src]}` : ""}
                </Label>
                <Input className="h-8 text-[12px]" type={attr === "email" ? "email" : "text"} value={values[k] ?? ""} onChange={(e) => set(k, e.target.value)} data-testid={`input-${k}`} />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <AppShell
      pageTitle={`New: ${prefill.template.name}`}
      pageActions={
        <div className="flex items-center gap-2">
          <Link href={`/admin/deals/${dealId}`} className="inline-flex items-center text-[12px] text-muted-foreground hover:text-foreground mr-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> {deal?.title ?? "Deal"}
          </Link>
          <Button size="sm" variant="outline" onClick={() => { setPreviewValues(values); setPreviewVersion((v) => v + 1); }}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh preview
          </Button>
          <Button size="sm" disabled={create.isPending || !title.trim()} onClick={() => create.mutate()} data-testid="button-create-document">
            {create.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FilePlus2 className="h-4 w-4 mr-1" />} Create document
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-[1fr_420px] h-full min-h-0">
        <div className="overflow-auto bg-secondary/40 p-8">
          <PdfPages
            url={apiUrl(`/api/admin/form-templates/${templateId}/preview`)}
            headers={headers}
            init={{ method: "POST", body: JSON.stringify({ values: previewValues }) }}
            version={previewVersion}
            pageSizes={prefill.template.pageSizes}
            width={PAGE_WIDTH}
          />
        </div>

        <div className="border-l border-border overflow-auto p-4 space-y-5 bg-background">
          <section className="space-y-2">
            <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">DOCUMENT</div>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-[13px]" placeholder="Document title" />
            {prefill.carriedFrom ? (
              <div className="text-[11px] text-muted-foreground">
                Answers carried forward from <span className="font-medium text-foreground">{prefill.carriedFrom.title}</span> ({fmtDateTime(prefill.carriedFrom.createdAt)}). Change anything that differs.
              </div>
            ) : null}
            {prefill.listing ? (
              <div className="text-[11px] text-muted-foreground">
                Property details from MLS® {prefill.listing.mlsNumber}: {prefill.listing.address}.
              </div>
            ) : deal?.mlsNumber ? (
              <div className="text-[11px] text-amber-700">MLS® {deal.mlsNumber} is not in the listing mirror; property details come from the deal only.</div>
            ) : null}
          </section>

          {prefill.slots.buyer || prefill.slots.seller ? (
            <section className="space-y-2">
              <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">PARTIES</div>
              <div className="text-[11px] text-muted-foreground">Each party with a name and email becomes a signer and is emailed their private link when you send.</div>
              {Array.from({ length: prefill.slots.buyer }, (_, i) => partyBlock("buyer", i + 1))}
              {Array.from({ length: prefill.slots.seller }, (_, i) => partyBlock("seller", i + 1))}
            </section>
          ) : null}

          {groups.map((g) => (
            <section key={g.group} className="space-y-2">
              <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">{g.group === "custom" ? "OTHER BLANKS" : BINDING_GROUP_LABELS[g.group].toUpperCase()}</div>
              {g.items.map((s) => {
                const src = sourceOf(s.key);
                const v = values[s.key] ?? "";
                return (
                  <div key={s.key} className="space-y-0.5">
                    <Label className="text-[11px]">
                      {s.label}
                      {src ? <span className="text-muted-foreground font-normal"> · {SOURCE_LABELS[src]}</span> : null}
                    </Label>
                    {s.readOnly ? (
                      <div className="text-[12px] text-muted-foreground px-1">{formatFillValue(s.type, v) || "—"}</div>
                    ) : s.type === "multiline" ? (
                      <Textarea rows={3} className="text-[12px]" value={v} onChange={(e) => set(s.key, e.target.value)} data-testid={`input-${s.key}`} />
                    ) : s.type === "checkbox" ? (
                      <div className="flex items-center gap-2 py-1">
                        <Switch checked={v === "true"} onCheckedChange={(c) => set(s.key, c ? "true" : "")} />
                        <span className="text-[12px] text-muted-foreground">{v === "true" ? "Checked" : "Not checked"}</span>
                      </div>
                    ) : s.type === "date" ? (
                      <Input type="date" className="h-8 text-[12px]" value={v} onChange={(e) => set(s.key, e.target.value)} data-testid={`input-${s.key}`} />
                    ) : s.type === "money" ? (
                      <div className="relative">
                        <span className="absolute left-2 top-1.5 text-[12px] text-muted-foreground">$</span>
                        <Input className="h-8 pl-5 text-[12px]" inputMode="decimal" value={v} onChange={(e) => set(s.key, e.target.value)} placeholder="0.00" data-testid={`input-${s.key}`} />
                        {v.trim() ? <div className="text-[10px] text-muted-foreground mt-0.5">Prints as {formatFillValue("money", v)}</div> : null}
                      </div>
                    ) : (
                      <Input className="h-8 text-[12px]" value={v} onChange={(e) => set(s.key, e.target.value)} data-testid={`input-${s.key}`} />
                    )}
                    {s.hint && !s.readOnly ? <div className="text-[10px] text-muted-foreground">{s.hint}</div> : null}
                  </div>
                );
              })}
            </section>
          ))}

          {specs.length === 0 && !prefill.slots.buyer && !prefill.slots.seller ? (
            <div className="text-[12px] text-muted-foreground">
              This form has no boxes yet.{" "}
              <Link href={`/admin/forms/${templateId}`} className="underline underline-offset-2">
                Set it up
              </Link>{" "}
              first.
            </div>
          ) : null}

          <Button className="w-full" disabled={create.isPending || !title.trim()} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FilePlus2 className="h-4 w-4 mr-1" />} Create document
          </Button>
          <div className="text-[11px] text-muted-foreground">
            The filled form becomes a draft on the deal with its signers and signature boxes in place. Nothing is emailed until you send it.
          </div>
        </div>
      </div>
    </AppShell>
  );
}
