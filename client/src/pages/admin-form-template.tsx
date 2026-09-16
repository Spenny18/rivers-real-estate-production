// /admin/forms/:id — draw the boxes on a blank form, once.
//
// Two kinds of box. A fill box prints a value when a document is made from
// this form: a catalogue key (property address, first buyer's name, purchase
// price… see shared/form-bindings.ts) or a custom blank typed on the review
// screen. A sign box becomes a signature / initials / date box for a signer
// slot (first buyer, second buyer, first seller, agent) on the document.
//
// Same mechanics as the document editor: pick what to place, click the page,
// drag to move, corner to resize, Delete to remove.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Check, Loader2, Trash2 } from "lucide-react";
import { apiErrorMessage, apiRequest, apiUrl, getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PdfPages } from "@/components/pdf-pages";
import { PlacedBox } from "@/components/placed-box";
import {
  FIELD_DEFAULT_SIZE,
  FIELD_LABELS,
  FORM_KIND_LABELS,
  ROLE_LABELS,
  isAutoField,
  signerColour,
  type FieldType,
  type FormBox,
  type FormFillBox,
  type FormSignBox,
  type FormTemplateDetail,
  type FormTemplateKind,
  type SignerRole,
} from "@/lib/esign-types";
import { DATE_FORMATS, TIME_FORMATS, DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, formatStamp } from "@shared/esign-format";
import {
  BINDINGS,
  BINDING_GROUP_LABELS,
  BINDING_BY_KEY,
  DATE_FILL_FORMATS,
  DEFAULT_DATE_FILL_FORMAT,
  DEFAULT_MONEY_FORMAT,
  MAX_PARTIES,
  MONEY_FORMATS,
  bindingLabel,
  customKeyFor,
  isCustomKey,
  type BindingGroup,
  type FillType,
} from "@shared/form-bindings";

const PAGE_WIDTH = 720;
const FILL_COLOUR = "#1d4ed8";
const SIGN_TYPES: FieldType[] = ["signature", "initials", "date", "time", "text", "checkbox"];
const FILL_TYPE_LABELS: Record<FillType, string> = { text: "Text", multiline: "Paragraph", money: "Dollar amount", date: "Date", checkbox: "Checkbox" };
const FILL_DEFAULT_SIZE: Record<FillType, { w: number; h: number }> = {
  text: { w: 0.22, h: 0.022 },
  multiline: { w: 0.6, h: 0.08 },
  money: { w: 0.14, h: 0.022 },
  date: { w: 0.16, h: 0.022 },
  checkbox: { w: 0.02, h: 0.015 },
};
const ORDINAL = ["First", "Second", "Third", "Fourth"];
const GROUP_ORDER: BindingGroup[] = ["property", "buyer", "seller", "offer", "conveyancing", "amendment", "agreement", "listing", "agent", "document"];

type Arm = { kind: "fill"; name: string; label: string | null; dataType: FillType } | { kind: "sign"; role: SignerRole; roleIndex: number; type: FieldType };

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/** "First buyer", "Agent", "Witness 2" */
export function slotLabel(role: SignerRole, roleIndex: number): string {
  if (role === "buyer" || role === "seller") return `${ORDINAL[roleIndex] ?? `#${roleIndex + 1}`} ${role}`;
  return roleIndex === 0 ? ROLE_LABELS[role] : `${ROLE_LABELS[role]} ${roleIndex + 1}`;
}

/** Colour per signer slot, stable across the form. */
function slotColour(role: SignerRole, roleIndex: number): string {
  const order = role === "buyer" ? roleIndex : role === "seller" ? MAX_PARTIES + roleIndex : 2 * MAX_PARTIES + (role === "agent" ? 0 : role === "witness" ? 1 : 2) + roleIndex;
  return signerColour(order + 1); // 0 is gold; keep it for fill contrast
}

const SLOT_OPTIONS: Array<{ role: SignerRole; roleIndex: number }> = [
  ...Array.from({ length: MAX_PARTIES }, (_, i) => ({ role: "buyer" as SignerRole, roleIndex: i })),
  ...Array.from({ length: MAX_PARTIES }, (_, i) => ({ role: "seller" as SignerRole, roleIndex: i })),
  { role: "agent", roleIndex: 0 },
];

export default function AdminFormTemplatePage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = [`/api/admin/form-templates/${id}`];
  const { data: form, isLoading } = useQuery<FormTemplateDetail>({ queryKey: key, enabled: Number.isFinite(id) });

  const [boxes, setBoxes] = useState<FormBox[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [meta, setMeta] = useState<{ name: string; kind: FormTemplateKind } | null>(null);
  const [arm, setArm] = useState<Arm | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [customType, setCustomType] = useState<FillType>("text");

  useEffect(() => {
    if (!form) return;
    if (!dirty) setBoxes(form.fields);
    if (!meta) setMeta({ name: form.name, kind: form.kind });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  function fail(title: string) {
    return (e: unknown) => toast({ title, description: apiErrorMessage(e), variant: "destructive" });
  }

  const saveBoxes = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/admin/form-templates/${id}`, { fields: boxes ?? [] })).json() as Promise<FormTemplateDetail>,
    onSuccess: (t) => {
      qc.setQueryData(key, t);
      qc.invalidateQueries({ queryKey: ["/api/admin/form-templates"] });
      setDirty(false);
      setBoxes(t.fields);
      toast({ title: "Boxes saved", description: `${t.fillCount} fill, ${t.signCount} sign.` });
    },
    onError: fail("Boxes didn't save"),
  });

  const saveMeta = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/admin/form-templates/${id}`, { name: meta?.name, kind: meta?.kind })).json() as Promise<FormTemplateDetail>,
    onSuccess: (t) => {
      qc.setQueryData(key, t);
      qc.invalidateQueries({ queryKey: ["/api/admin/form-templates"] });
      setMeta({ name: t.name, kind: t.kind });
      toast({ title: "Form saved" });
    },
    onError: fail("Form didn't save"),
  });

  // ---- Placing ----------------------------------------------------------------------

  const addAt = (page: number, at: { x: number; y: number }) => {
    if (!arm || !form) return;
    const pageSize = form.pageSizes[page - 1];
    const scaleH = pageSize ? 792 / pageSize.h : 1;
    const size = arm.kind === "fill" ? FILL_DEFAULT_SIZE[arm.dataType] : FIELD_DEFAULT_SIZE[arm.type];
    const w = size.w;
    const h = size.h * scaleH;
    const geo = { key: uid(), page, x: clamp(at.x - w / 2, 0, 1 - w), y: clamp(at.y - h / 2, 0, 1 - h), w, h };
    const box: FormBox =
      arm.kind === "fill"
        ? { kind: "fill", ...geo, name: arm.name, label: arm.label, dataType: arm.dataType, align: "left", fontSize: null }
        : { kind: "sign", ...geo, role: arm.role, roleIndex: arm.roleIndex, type: arm.type, required: true, label: null, format: null };
    setBoxes((bs) => [...(bs ?? []), box]);
    setDirty(true);
    setSelected(box.key);
  };

  const update = (k: string, patch: Partial<FormFillBox> | Partial<FormSignBox>) => {
    setBoxes((bs) => (bs ?? []).map((b) => (b.key === k ? ({ ...b, ...patch } as FormBox) : b)));
    setDirty(true);
  };

  const remove = (k: string) => {
    setBoxes((bs) => (bs ?? []).filter((b) => b.key !== k));
    setDirty(true);
    if (selected === k) setSelected(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        remove(selected);
      }
      if (e.key === "Escape") {
        setArm(null);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const groupedBindings = useMemo(() => GROUP_ORDER.map((g) => ({ group: g, items: BINDINGS.filter((b) => b.group === g) })), []);

  // ---- Render -------------------------------------------------------------------------

  if (isLoading || !form || !boxes || !meta) {
    return (
      <AppShell pageTitle="Form">
        <div className="p-6 text-[13px] text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> {isLoading ? "Loading…" : "Form not found."}
        </div>
      </AppShell>
    );
  }

  const token = getAuthToken();
  const pdfHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const pdfUrl = apiUrl(`/api/admin/form-templates/${form.id}/file?v=${form.createdAt}`);
  const selectedBox = selected ? boxes.find((b) => b.key === selected) : undefined;
  const fillCount = boxes.filter((b) => b.kind === "fill").length;
  const signCount = boxes.filter((b) => b.kind === "sign").length;
  const usedSlots = Array.from(new Set(boxes.filter((b): b is FormSignBox => b.kind === "sign").map((b) => `${b.role}:${b.roleIndex}`)));
  const armText =
    arm?.kind === "fill" ? `a ${FILL_TYPE_LABELS[arm.dataType].toLowerCase()} box for "${bindingLabel(arm.name, arm.label)}"` : arm ? `a ${FIELD_LABELS[arm.type]} box for the ${slotLabel(arm.role, arm.roleIndex).toLowerCase()}` : "";

  const armFill = (name: string) => {
    if (name === "__custom") {
      setArm({ kind: "fill", name: customKeyFor(customLabel || "field"), label: customLabel || "Custom", dataType: customType });
    } else {
      const b = BINDING_BY_KEY[name];
      setArm({ kind: "fill", name, label: null, dataType: b?.type ?? "text" });
    }
  };

  return (
    <AppShell
      pageTitle={form.name}
      pageActions={
        <div className="flex items-center gap-2">
          <Link href="/admin/forms" className="inline-flex items-center text-[12px] text-muted-foreground hover:text-foreground mr-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> All forms
          </Link>
          <Button size="sm" disabled={!dirty || saveBoxes.isPending} onClick={() => saveBoxes.mutate()} data-testid="button-save-boxes">
            {saveBoxes.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />} Save boxes
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-[1fr_380px] h-full min-h-0">
        <div className="overflow-auto bg-secondary/40 p-8" style={{ cursor: arm ? "crosshair" : undefined }}>
          {arm ? (
            <div className="sticky top-0 z-10 mb-4 mx-auto w-fit bg-foreground text-background text-[12px] px-3 py-1.5 rounded-sm shadow flex items-center gap-2">
              Click on the page to place {armText}.
              <button className="underline underline-offset-2" onClick={() => setArm(null)}>
                Done
              </button>
            </div>
          ) : null}
          <PdfPages
            url={pdfUrl}
            headers={pdfHeaders}
            pageSizes={form.pageSizes}
            width={PAGE_WIDTH}
            onPageClick={(page, at) => {
              if (arm) addAt(page, at);
              else setSelected(null);
            }}
            overlay={(page) =>
              boxes
                .filter((b) => b.page === page)
                .map((b) =>
                  b.kind === "fill" ? (
                    <PlacedBox
                      key={b.key}
                      id={b.key}
                      box={b}
                      colour={FILL_COLOUR}
                      solid
                      tag={isCustomKey(b.name) ? "Typed" : BINDING_GROUP_LABELS[BINDING_BY_KEY[b.name]?.group ?? "document"]}
                      text={b.dataType === "checkbox" ? "☐" : bindingLabel(b.name, b.label)}
                      title={`${bindingLabel(b.name, b.label)} · ${FILL_TYPE_LABELS[b.dataType]}`}
                      editable
                      selected={selected === b.key}
                      onSelect={() => setSelected(b.key)}
                      onChange={(p) => update(b.key, p)}
                      onRemove={() => remove(b.key)}
                    />
                  ) : (
                    <PlacedBox
                      key={b.key}
                      id={b.key}
                      box={b}
                      colour={slotColour(b.role, b.roleIndex)}
                      tag={slotLabel(b.role, b.roleIndex)}
                      text={b.type === "signature" ? "Sign" : b.type === "initials" ? "Initials" : isAutoField(b.type) ? formatStamp(b.type as "date" | "time", b.format, new Date()) : b.type === "checkbox" ? "" : b.label || "Text"}
                      title={`${slotLabel(b.role, b.roleIndex)} · ${FIELD_LABELS[b.type]}`}
                      editable
                      selected={selected === b.key}
                      onSelect={() => setSelected(b.key)}
                      onChange={(p) => update(b.key, p)}
                      onRemove={() => remove(b.key)}
                    />
                  ),
                )
            }
          />
        </div>

        <div className="border-l border-border overflow-auto p-4 space-y-5 bg-background">
          {/* Form */}
          <section className="space-y-2">
            <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">FORM</div>
            <Input value={meta.name} className="h-8 text-[13px]" onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
            <Select value={meta.kind} onValueChange={(v) => setMeta({ ...meta, kind: v as FormTemplateKind })}>
              <SelectTrigger className="h-8 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FORM_KIND_LABELS) as FormTemplateKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {FORM_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {meta.name !== form.name || meta.kind !== form.kind ? (
              <Button size="sm" variant="outline" className="w-full h-8" disabled={saveMeta.isPending || !meta.name.trim()} onClick={() => saveMeta.mutate()}>
                Save name
              </Button>
            ) : null}
            <div className="text-[11px] text-muted-foreground">
              {form.pageCount} page{form.pageCount === 1 ? "" : "s"} · {fillCount} fill box{fillCount === 1 ? "" : "es"} · {signCount} sign box{signCount === 1 ? "" : "es"}
              {usedSlots.length ? ` · signed by ${usedSlots.map((s) => { const [r, i] = s.split(":"); return slotLabel(r as SignerRole, Number(i)).toLowerCase(); }).join(", ")}` : ""}
            </div>
          </section>

          {/* Selected */}
          {selectedBox ? (
            <SelectedBoxEditor
              box={selectedBox}
              onChange={(p) => update(selectedBox.key, p)}
              onRemove={() => remove(selectedBox.key)}
              groups={groupedBindings}
            />
          ) : null}

          {/* Fill boxes */}
          <section className="space-y-2">
            <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">FILL BOXES</div>
            <div className="text-[11px] text-muted-foreground leading-relaxed">
              A fill box prints deal data into a blank on the form. Choose what it fills with, then click the page where it goes.
            </div>
            <Select value={arm?.kind === "fill" ? (isCustomKey(arm.name) ? "__custom" : arm.name) : ""} onValueChange={armFill}>
              <SelectTrigger className="h-8 text-[12px]" data-testid="select-fill-binding">
                <SelectValue placeholder="Fills with…" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Typed on the review screen</SelectLabel>
                  <SelectItem value="__custom">Custom blank…</SelectItem>
                </SelectGroup>
                {groupedBindings.map((g) => (
                  <SelectGroup key={g.group}>
                    <SelectLabel className="text-[10px]">{BINDING_GROUP_LABELS[g.group]}</SelectLabel>
                    {g.items.map((b) => (
                      <SelectItem key={b.key} value={b.key}>
                        {b.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            {arm?.kind === "fill" && isCustomKey(arm.name) ? (
              <div className="grid grid-cols-[1fr_120px] gap-1.5">
                <Input
                  className="h-8 text-[12px]"
                  placeholder="Blank's label, e.g. Second deposit"
                  value={customLabel}
                  onChange={(e) => {
                    setCustomLabel(e.target.value);
                    setArm({ kind: "fill", name: customKeyFor(e.target.value || "field"), label: e.target.value || "Custom", dataType: customType });
                  }}
                />
                <Select
                  value={customType}
                  onValueChange={(v) => {
                    setCustomType(v as FillType);
                    setArm({ kind: "fill", name: customKeyFor(customLabel || "field"), label: customLabel || "Custom", dataType: v as FillType });
                  }}
                >
                  <SelectTrigger className="h-8 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(FILL_TYPE_LABELS) as FillType[]).map((t) => (
                      <SelectItem key={t} value={t}>
                        {FILL_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </section>

          {/* Sign boxes */}
          <section className="space-y-2">
            <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">SIGN BOXES</div>
            <div className="text-[11px] text-muted-foreground leading-relaxed">
              Who signs where. Each party named on the review screen becomes a signer with these boxes.
            </div>
            <Select
              value={arm?.kind === "sign" ? `${arm.role}:${arm.roleIndex}` : ""}
              onValueChange={(v) => {
                const [role, idx] = v.split(":");
                setArm({ kind: "sign", role: role as SignerRole, roleIndex: Number(idx), type: arm?.kind === "sign" ? arm.type : "signature" });
              }}
            >
              <SelectTrigger className="h-8 text-[12px]" data-testid="select-sign-slot">
                <SelectValue placeholder="Choose who" />
              </SelectTrigger>
              <SelectContent>
                {SLOT_OPTIONS.map((s) => (
                  <SelectItem key={`${s.role}:${s.roleIndex}`} value={`${s.role}:${s.roleIndex}`}>
                    {slotLabel(s.role, s.roleIndex)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="grid grid-cols-3 gap-1.5">
              {SIGN_TYPES.map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={arm?.kind === "sign" && arm.type === t ? "default" : "outline"}
                  className="h-8 text-[11px]"
                  onClick={() => setArm({ kind: "sign", role: arm?.kind === "sign" ? arm.role : "buyer", roleIndex: arm?.kind === "sign" ? arm.roleIndex : 0, type: t })}
                >
                  {FIELD_LABELS[t]}
                </Button>
              ))}
            </div>
          </section>

          {dirty ? (
            <Button size="sm" className="w-full" disabled={saveBoxes.isPending} onClick={() => saveBoxes.mutate()}>
              {saveBoxes.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />} Save boxes ({boxes.length})
            </Button>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function SelectedBoxEditor({
  box,
  onChange,
  onRemove,
  groups,
}: {
  box: FormBox;
  onChange: (p: Partial<FormFillBox> | Partial<FormSignBox>) => void;
  onRemove: () => void;
  groups: Array<{ group: BindingGroup; items: typeof BINDINGS }>;
}) {
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-medium">
            {box.kind === "fill" ? "Fill box" : `${slotLabel(box.role, box.roleIndex)} · ${FIELD_LABELS[box.type]}`} · page {box.page}
          </div>
          <Button size="sm" variant="ghost" className="h-7 text-[11px] text-muted-foreground" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
          </Button>
        </div>
        {box.kind === "fill" ? (
          <>
            <div className="space-y-1">
              <Label className="text-[11px]">Fills with</Label>
              <Select
                value={isCustomKey(box.name) ? "__custom" : box.name}
                onValueChange={(v) => {
                  if (v === "__custom") onChange({ name: customKeyFor(box.label || "field"), label: box.label || "Custom" });
                  else onChange({ name: v, label: null, dataType: BINDING_BY_KEY[v]?.type ?? "text" });
                }}
              >
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectGroup>
                    <SelectLabel className="text-[10px]">Typed on the review screen</SelectLabel>
                    <SelectItem value="__custom">Custom blank…</SelectItem>
                  </SelectGroup>
                  {groups.map((g) => (
                    <SelectGroup key={g.group}>
                      <SelectLabel className="text-[10px]">{BINDING_GROUP_LABELS[g.group]}</SelectLabel>
                      {g.items.map((b) => (
                        <SelectItem key={b.key} value={b.key}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isCustomKey(box.name) ? (
              <div className="grid grid-cols-[1fr_120px] gap-1.5">
                <Input className="h-8 text-[12px]" value={box.label ?? ""} placeholder="Label" onChange={(e) => onChange({ label: e.target.value || null, name: customKeyFor(e.target.value || "field") })} />
                <Select value={box.dataType} onValueChange={(v) => onChange({ dataType: v as FillType })}>
                  <SelectTrigger className="h-8 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(FILL_TYPE_LABELS) as FillType[]).map((t) => (
                      <SelectItem key={t} value={t}>
                        {FILL_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {box.dataType === "money" || box.dataType === "date" ? (
              <div className="space-y-1">
                <Label className="text-[11px]">Printed as</Label>
                <Select value={box.format ?? (box.dataType === "money" ? DEFAULT_MONEY_FORMAT : DEFAULT_DATE_FILL_FORMAT)} onValueChange={(v) => onChange({ format: v })}>
                  <SelectTrigger className="h-8 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(box.dataType === "money" ? MONEY_FORMATS : DATE_FILL_FORMATS).map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {box.dataType !== "checkbox" ? (
              <div className="grid grid-cols-2 gap-1.5">
                <div className="space-y-1">
                  <Label className="text-[11px]">Align</Label>
                  <Select value={box.align ?? "left"} onValueChange={(v) => onChange({ align: v as FormFillBox["align"] })}>
                    <SelectTrigger className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="left">Left</SelectItem>
                      <SelectItem value="center">Centre</SelectItem>
                      <SelectItem value="right">Right</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Text size (pt)</Label>
                  <Input
                    className="h-8 text-[12px]"
                    type="number"
                    min={4}
                    max={24}
                    step={0.5}
                    placeholder="fit"
                    value={box.fontSize ?? ""}
                    onChange={(e) => onChange({ fontSize: e.target.value ? Number(e.target.value) : null })}
                  />
                </div>
              </div>
            ) : null}
            <div className="text-[11px] text-muted-foreground">
              {isCustomKey(box.name) ? "Typed on the review screen each time; remembered for the next form on the same deal." : BINDING_BY_KEY[box.name]?.source === "manual" ? "Typed on the review screen; carried forward to the next form on the deal." : BINDING_BY_KEY[box.name]?.source === "party" ? "From the parties entered on the review screen." : "Filled from the deal automatically."}
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label className="text-[11px]">Who</Label>
              <Select value={`${box.role}:${box.roleIndex}`} onValueChange={(v) => { const [role, idx] = v.split(":"); onChange({ role: role as SignerRole, roleIndex: Number(idx) }); }}>
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLOT_OPTIONS.map((s) => (
                    <SelectItem key={`${s.role}:${s.roleIndex}`} value={`${s.role}:${s.roleIndex}`}>
                      {slotLabel(s.role, s.roleIndex)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isAutoField(box.type) ? (
              <div className="space-y-1">
                <Label className="text-[11px]">Printed as</Label>
                <Select value={box.format ?? (box.type === "date" ? DEFAULT_DATE_FORMAT : DEFAULT_TIME_FORMAT)} onValueChange={(v) => onChange({ format: v })}>
                  <SelectTrigger className="h-8 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(box.type === "date" ? DATE_FORMATS : TIME_FORMATS).map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {box.type === "text" || box.type === "checkbox" ? (
              <div className="space-y-1">
                <Label className="text-[11px]">Label</Label>
                <Input className="h-8 text-[12px]" value={box.label ?? ""} onChange={(e) => onChange({ label: e.target.value || null })} placeholder="e.g. Initial here" />
              </div>
            ) : null}
            {box.type === "text" ? (
              <div className="flex items-center justify-between">
                <Label className="text-[11px]">Required</Label>
                <Switch checked={box.required} onCheckedChange={(v) => onChange({ required: v })} />
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
