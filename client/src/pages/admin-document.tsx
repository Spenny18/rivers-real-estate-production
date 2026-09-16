// /admin/deals/:dealId/documents/:id — one document's workspace.
//
// Draft:  add signers, drop signature/initials/date/text/checkbox boxes on the
//         pages (click a page with a field type armed; drag to move, corner
//         to resize), choose the signing order, write a note, send.
// Sent:   watch who has opened and signed, remind, void.
// Done:   the signed copy with its certificate, the hashes, the audit trail.
//
// Field positions are fractions of the page, so what is placed here is what
// server/signing.ts stamps.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeft,
  Ban,
  BellRing,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  Loader2,
  Mail,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { apiErrorMessage, apiRequest, apiUrl, getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PdfPages } from "@/components/pdf-pages";
import {
  FIELD_DEFAULT_SIZE,
  FIELD_LABELS,
  ROLE_LABELS,
  fmtBytes,
  fmtDateTime,
  signerColour,
  type DocumentDetail,
  type FieldType,
  type FieldView,
  type SignerRole,
  type SignerView,
} from "@/lib/esign-types";
import { DOC_STATUS_LABELS, DOC_STATUS_STYLES } from "./admin-deal";

interface LocalField {
  key: string;
  id?: number;
  signerId: number;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  label: string | null;
}

interface LocalSigner {
  key: string;
  id?: number;
  name: string;
  email: string;
  role: SignerRole;
}

const PAGE_WIDTH = 720;
const FIELD_TYPES: FieldType[] = ["signature", "initials", "date", "text", "checkbox"];

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function fromServerFields(fields: FieldView[]): LocalField[] {
  return fields.map((f) => ({ key: `f${f.id}`, id: f.id, signerId: f.signerId, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label }));
}

function fromServerSigners(signers: SignerView[]): LocalSigner[] {
  return signers.map((s) => ({ key: `s${s.id}`, id: s.id, name: s.name, email: s.email, role: s.role }));
}

const SIGNER_STATUS_LABELS: Record<SignerView["status"], string> = {
  pending: "Not yet sent",
  sent: "Sent",
  viewed: "Opened",
  signed: "Signed",
  declined: "Declined",
};

const EVENT_LABELS: Record<string, string> = {
  created: "Document created",
  sent: "Sent for signature",
  email_sent: "Signing email sent",
  email_failed: "Signing email failed",
  reminder: "Reminder sent",
  viewed: "Opened the document",
  consented: "Agreed to sign electronically",
  signed: "Signed",
  declined: "Declined",
  voided: "Voided",
  completed: "Completed — all parties signed",
  downloaded: "Downloaded the signed copy",
  finalize_failed: "Building the signed PDF failed",
};

export default function AdminDocumentPage() {
  const params = useParams<{ dealId: string; id: string }>();
  const id = Number(params.id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = [`/api/admin/documents/${id}`];
  const { data: doc, isLoading } = useQuery<DocumentDetail>({ queryKey: key, enabled: Number.isFinite(id) });

  // Local, editable copies (draft only).
  const [signers, setSigners] = useState<LocalSigner[] | null>(null);
  const [fields, setFields] = useState<LocalField[] | null>(null);
  const [signersDirty, setSignersDirty] = useState(false);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [settings, setSettings] = useState<{ signingOrder: "parallel" | "sequential"; message: string } | null>(null);
  const [arm, setArm] = useState<{ signerId: number; type: FieldType } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!doc) return;
    if (!signersDirty) setSigners(fromServerSigners(doc.signers));
    if (!fieldsDirty) setFields(fromServerFields(doc.fields));
    if (!settings) setSettings({ signingOrder: doc.signingOrder, message: doc.message ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const isDraft = doc?.status === "draft";
  const signerIndex = useCallback(
    (signerId: number) => Math.max(0, (doc?.signers ?? []).findIndex((s) => s.id === signerId)),
    [doc],
  );

  function fail(title: string) {
    return (e: unknown) => toast({ title, description: apiErrorMessage(e), variant: "destructive" });
  }

  // ---- Mutations ---------------------------------------------------------------

  const saveSigners = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "PUT",
        `/api/admin/documents/${id}/signers`,
        (signers ?? []).map((s) => ({ id: s.id, name: s.name, email: s.email, role: s.role })),
      );
      return (await res.json()) as DocumentDetail;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setSignersDirty(false);
      setSigners(fromServerSigners(d.signers));
      // Fields of removed signers vanished server-side; refresh the layout too.
      if (!fieldsDirty) setFields(fromServerFields(d.fields));
      else setFields((fs) => (fs ?? []).filter((f) => d.signers.some((s) => s.id === f.signerId)));
      toast({ title: "Signers saved" });
    },
    onError: fail("Signers didn't save"),
  });

  const saveFields = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "PUT",
        `/api/admin/documents/${id}/fields`,
        (fields ?? []).map((f) => ({ id: f.id, signerId: f.signerId, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label })),
      );
      return (await res.json()) as DocumentDetail;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setFieldsDirty(false);
      setFields(fromServerFields(d.fields));
      setSelected(null);
      toast({ title: "Layout saved" });
    },
    onError: fail("Layout didn't save"),
  });

  const saveSettings = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/admin/documents/${id}`, { signingOrder: settings?.signingOrder, message: settings?.message ?? "" });
      return (await res.json()) as DocumentDetail;
    },
    onSuccess: (d) => qc.setQueryData(key, d),
    onError: fail("Settings didn't save"),
  });

  const send = useMutation({
    mutationFn: async () => {
      if (signersDirty) await saveSigners.mutateAsync();
      if (fieldsDirty) await saveFields.mutateAsync();
      if (settings && (settings.signingOrder !== doc?.signingOrder || settings.message !== (doc?.message ?? ""))) await saveSettings.mutateAsync();
      const res = await apiRequest("POST", `/api/admin/documents/${id}/send`, {});
      return (await res.json()) as DocumentDetail;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      qc.invalidateQueries({ queryKey: [`/api/admin/deals/${d.dealId}`] });
      qc.invalidateQueries({ queryKey: ["/api/admin/deals"] });
      setSending(false);
      if (d.warning) toast({ title: "Sent, with a problem", description: d.warning, variant: "destructive" });
      else toast({ title: "Sent for signature", description: "Each signer has been emailed their private link." });
    },
    onError: (e) => {
      setSending(false);
      fail("Couldn't send")(e);
    },
  });

  const remind = useMutation({
    mutationFn: async (signerId?: number) => {
      const res = await apiRequest("POST", `/api/admin/documents/${id}/remind`, signerId ? { signerId } : {});
      return (await res.json()) as DocumentDetail & { sent: number };
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      toast({ title: `Reminder sent to ${d.sent} signer${d.sent === 1 ? "" : "s"}` });
    },
    onError: fail("Reminder didn't send"),
  });

  const voidDoc = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/documents/${id}/void`, { reason: voidReason });
      return (await res.json()) as DocumentDetail;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      qc.invalidateQueries({ queryKey: [`/api/admin/deals/${d.dealId}`] });
      setVoiding(false);
      toast({ title: "Document voided" });
    },
    onError: fail("Couldn't void"),
  });

  const finalize = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/documents/${id}/finalize`, {});
      return (await res.json()) as DocumentDetail;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      toast({ title: "Signed PDF built" });
    },
    onError: fail("Couldn't build the signed PDF"),
  });

  // ---- Field editing -------------------------------------------------------------

  const addFieldAt = (page: number, at: { x: number; y: number }) => {
    if (!arm || !isDraft) return;
    const size = FIELD_DEFAULT_SIZE[arm.type];
    const pageSize = doc?.pageSizes[page - 1];
    // Default sizes are Letter fractions; keep the box the same physical
    // size on a Legal page.
    const scaleH = pageSize ? 792 / pageSize.h : 1;
    const w = size.w;
    const h = size.h * scaleH;
    const f: LocalField = {
      key: uid(),
      signerId: arm.signerId,
      type: arm.type,
      page,
      x: clamp(at.x - w / 2, 0, 1 - w),
      y: clamp(at.y - h / 2, 0, 1 - h),
      w,
      h,
      required: true,
      label: null,
    };
    setFields((fs) => [...(fs ?? []), f]);
    setFieldsDirty(true);
    setSelected(f.key);
  };

  const updateField = (k: string, patch: Partial<LocalField>) => {
    setFields((fs) => (fs ?? []).map((f) => (f.key === k ? { ...f, ...patch } : f)));
    setFieldsDirty(true);
  };

  const removeField = (k: string) => {
    setFields((fs) => (fs ?? []).filter((f) => f.key !== k));
    setFieldsDirty(true);
    if (selected === k) setSelected(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isDraft) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        removeField(selected);
      }
      if (e.key === "Escape") {
        setArm(null);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, isDraft]);

  // ---- Render --------------------------------------------------------------------

  if (isLoading || !doc || !signers || !fields || !settings) {
    return (
      <AppShell pageTitle="Document">
        <div className="p-6 text-[13px] text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> {isLoading ? "Loading…" : "Document not found."}
        </div>
      </AppShell>
    );
  }

  const token = getAuthToken();
  const pdfHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const showSigned = doc.status === "completed" && !!doc.signedSha256;
  const pdfUrl = apiUrl(`/api/admin/documents/${doc.id}/file?which=${showSigned ? "signed" : "original"}&v=${doc.updatedAt}`);
  const pageSizesForView = showSigned ? [...doc.pageSizes, { w: 612, h: 792 }, { w: 612, h: 792 }] : doc.pageSizes;
  const missingSignature = signers.filter((s) => s.id && !fields.some((f) => f.signerId === s.id && f.type === "signature"));
  const unsavedSigners = signers.filter((s) => !s.id);
  const canSend = isDraft && signers.length > 0 && unsavedSigners.length === 0 && missingSignature.length === 0 && !signersDirty;

  const download = async (which: "original" | "signed") => {
    const res = await fetch(apiUrl(`/api/admin/documents/${doc.id}/file?which=${which}&download=1`), { credentials: "include", headers: pdfHeaders });
    if (!res.ok) return toast({ title: "Download failed", variant: "destructive" });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.title.replace(/[^\w.-]+/g, "-")}${which === "signed" ? "-signed" : ""}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  return (
    <AppShell
      pageTitle={doc.title}
      pageActions={
        <div className="flex items-center gap-2">
          <Link href={`/admin/deals/${doc.dealId}`} className="inline-flex items-center text-[12px] text-muted-foreground hover:text-foreground mr-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> {doc.deal.title}
          </Link>
          <Badge variant="outline" className={`text-[10px] ${DOC_STATUS_STYLES[doc.status]}`}>
            {DOC_STATUS_LABELS[doc.status]}
          </Badge>
          {isDraft ? (
            <Button size="sm" disabled={!canSend || send.isPending} onClick={() => setSending(true)} data-testid="button-send">
              <Send className="h-4 w-4 mr-1" /> Send for signature
            </Button>
          ) : null}
          {doc.status === "sent" ? (
            <>
              <Button size="sm" variant="outline" disabled={remind.isPending} onClick={() => remind.mutate(undefined)}>
                <BellRing className="h-4 w-4 mr-1" /> Remind
              </Button>
              <Button size="sm" variant="outline" onClick={() => setVoiding(true)}>
                <Ban className="h-4 w-4 mr-1" /> Void
              </Button>
            </>
          ) : null}
          {doc.status === "completed" ? (
            <Button size="sm" onClick={() => download("signed")}>
              <Download className="h-4 w-4 mr-1" /> Signed PDF
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => download("original")}>
            <Download className="h-4 w-4 mr-1" /> Original
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-[1fr_360px] h-full min-h-0">
        {/* Pages */}
        <div className="overflow-auto bg-secondary/40 p-8" style={{ cursor: arm && isDraft ? "crosshair" : undefined }}>
          {arm && isDraft ? (
            <div className="sticky top-0 z-10 mb-4 mx-auto w-fit bg-foreground text-background text-[12px] px-3 py-1.5 rounded-sm shadow flex items-center gap-2">
              Click on a page to place a <strong>{FIELD_LABELS[arm.type]}</strong> box for {signers.find((s) => s.id === arm.signerId)?.name ?? "the signer"}.
              <button className="underline underline-offset-2" onClick={() => setArm(null)}>
                Done
              </button>
            </div>
          ) : null}
          <PdfPages
            url={pdfUrl}
            headers={pdfHeaders}
            pageSizes={pageSizesForView}
            width={PAGE_WIDTH}
            onPageClick={(page, at) => {
              if (arm && isDraft) addFieldAt(page, at);
              else setSelected(null);
            }}
            overlay={(page) =>
              showSigned
                ? null
                : fields
                    .filter((f) => f.page === page)
                    .map((f) => (
                      <FieldBox
                        key={f.key}
                        field={f}
                        colour={signerColour(signerIndex(f.signerId))}
                        signerName={signers.find((s) => s.id === f.signerId)?.name ?? "?"}
                        editable={!!isDraft}
                        selected={selected === f.key}
                        filled={doc.fields.find((x) => x.id === f.id)?.value ?? null}
                        onSelect={() => setSelected(f.key)}
                        onChange={(patch) => updateField(f.key, patch)}
                        onRemove={() => removeField(f.key)}
                      />
                    ))
            }
          />
        </div>

        {/* Sidebar */}
        <div className="border-l border-border overflow-auto p-4 space-y-5 bg-background">
          {doc.status === "sent" && doc.signers.length > 0 && doc.signers.every((s) => s.status === "signed") ? (
            <Card className="border-amber-300">
              <CardContent className="p-3 text-[12px] space-y-2">
                Everyone has signed but the final PDF was not produced.
                <Button size="sm" className="w-full" disabled={finalize.isPending} onClick={() => finalize.mutate()}>
                  {finalize.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Build signed PDF
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {/* Signers */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">SIGNERS</div>
              {isDraft ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px]"
                  onClick={() => {
                    setSigners([...signers, { key: uid(), name: "", email: "", role: signers.length === 0 ? "buyer" : signers[signers.length - 1].role }]);
                    setSignersDirty(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add
                </Button>
              ) : null}
            </div>
            {signers.length === 0 ? <div className="text-[12px] text-muted-foreground">Add the people who need to sign.</div> : null}
            {signers.map((s, i) => {
              const saved = s.id ? doc.signers.find((x) => x.id === s.id) : undefined;
              const colour = signerColour(s.id ? signerIndex(s.id) : i);
              return (
                <Card key={s.key}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colour }} />
                      {isDraft ? (
                        <>
                          <Input
                            value={s.name}
                            placeholder="Full name"
                            className="h-8 text-[13px]"
                            onChange={(e) => {
                              setSigners(signers.map((x) => (x.key === s.key ? { ...x, name: e.target.value } : x)));
                              setSignersDirty(true);
                            }}
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 shrink-0 text-muted-foreground"
                            onClick={() => {
                              setSigners(signers.filter((x) => x.key !== s.key));
                              setSignersDirty(true);
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </>
                      ) : (
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium truncate">{s.name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {s.email} · {ROLE_LABELS[s.role]}
                          </div>
                        </div>
                      )}
                    </div>
                    {isDraft ? (
                      <div className="grid grid-cols-[1fr_110px] gap-2">
                        <Input
                          value={s.email}
                          placeholder="Email"
                          type="email"
                          className="h-8 text-[13px]"
                          onChange={(e) => {
                            setSigners(signers.map((x) => (x.key === s.key ? { ...x, email: e.target.value } : x)));
                            setSignersDirty(true);
                          }}
                        />
                        <Select
                          value={s.role}
                          onValueChange={(v) => {
                            setSigners(signers.map((x) => (x.key === s.key ? { ...x, role: v as SignerRole } : x)));
                            setSignersDirty(true);
                          }}
                        >
                          <SelectTrigger className="h-8 text-[12px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(ROLE_LABELS) as SignerRole[]).map((r) => (
                              <SelectItem key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                    {saved && !isDraft ? (
                      <div className="text-[11px] flex items-center justify-between gap-2">
                        <span className={saved.status === "signed" ? "text-emerald-700" : saved.status === "declined" ? "text-destructive" : "text-muted-foreground"}>
                          {saved.status === "signed" ? <CheckCircle2 className="inline h-3.5 w-3.5 mr-1" /> : saved.status === "viewed" ? <Eye className="inline h-3.5 w-3.5 mr-1" /> : <Mail className="inline h-3.5 w-3.5 mr-1" />}
                          {SIGNER_STATUS_LABELS[saved.status]}
                          {saved.signedAt ? ` · ${fmtDateTime(saved.signedAt)}` : saved.lastEmailAt ? ` · emailed ${fmtDateTime(saved.lastEmailAt)}` : ""}
                        </span>
                        <span className="flex gap-1">
                          {doc.status === "sent" && doc.canSignNow.includes(saved.id) ? (
                            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => remind.mutate(saved.id)}>
                              <BellRing className="h-3 w-3" />
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-[11px]"
                            title="Copy signing link"
                            onClick={() => {
                              navigator.clipboard?.writeText(saved.signUrl);
                              toast({ title: "Signing link copied", description: "Private to this signer — share it only with them." });
                            }}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </span>
                      </div>
                    ) : null}
                    {saved?.declineReason ? <div className="text-[11px] text-destructive">“{saved.declineReason}”</div> : null}
                  </CardContent>
                </Card>
              );
            })}
            {isDraft && signersDirty ? (
              <Button size="sm" className="w-full" disabled={saveSigners.isPending || signers.some((s) => !s.name.trim() || !s.email.trim())} onClick={() => saveSigners.mutate()}>
                {saveSigners.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />} Save signers
              </Button>
            ) : null}
          </section>

          {/* Fields */}
          {isDraft ? (
            <section className="space-y-2">
              <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">SIGNATURE BOXES</div>
              {doc.signers.length === 0 ? (
                <div className="text-[12px] text-muted-foreground">Save the signers first, then place their boxes.</div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-[11px]">For</Label>
                    <Select value={arm ? String(arm.signerId) : ""} onValueChange={(v) => setArm({ signerId: Number(v), type: arm?.type ?? "signature" })}>
                      <SelectTrigger className="h-8 text-[12px]">
                        <SelectValue placeholder="Choose a signer" />
                      </SelectTrigger>
                      <SelectContent>
                        {doc.signers.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {FIELD_TYPES.map((t) => (
                      <Button
                        key={t}
                        size="sm"
                        variant={arm?.type === t ? "default" : "outline"}
                        className="h-8 text-[11px]"
                        disabled={!arm && doc.signers.length === 0}
                        onClick={() => setArm({ signerId: arm?.signerId ?? doc.signers[0].id, type: t })}
                      >
                        {FIELD_LABELS[t]}
                      </Button>
                    ))}
                  </div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    Pick a type, then click on the page where it goes. Drag boxes to move them, drag the corner to resize, Delete to remove.
                  </div>
                  {missingSignature.length > 0 ? (
                    <div className="text-[11px] text-amber-700">Needs a signature box: {missingSignature.map((s) => s.name || "unnamed").join(", ")}</div>
                  ) : null}
                  {selected ? <SelectedFieldEditor field={fields.find((f) => f.key === selected)!} onChange={(p) => updateField(selected, p)} onRemove={() => removeField(selected)} /> : null}
                  {fieldsDirty ? (
                    <Button size="sm" className="w-full" disabled={saveFields.isPending} onClick={() => saveFields.mutate()}>
                      {saveFields.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />} Save layout ({fields.length})
                    </Button>
                  ) : (
                    <div className="text-[11px] text-muted-foreground">{fields.length} box{fields.length === 1 ? "" : "es"} placed.</div>
                  )}
                </>
              )}
            </section>
          ) : null}

          {/* Settings */}
          <section className="space-y-2">
            <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">SENDING</div>
            <div className="space-y-1.5">
              <Label className="text-[11px]">Signing order</Label>
              <Select
                value={settings.signingOrder}
                disabled={!isDraft}
                onValueChange={(v) => setSettings({ ...settings, signingOrder: v as "parallel" | "sequential" })}
              >
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="parallel">Everyone at once</SelectItem>
                  <SelectItem value="sequential">One at a time, in order</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px]">Note to signers</Label>
              <Textarea rows={3} disabled={!isDraft} value={settings.message} onChange={(e) => setSettings({ ...settings, message: e.target.value })} placeholder="Optional. Shown in the email and on the signing page." className="text-[13px]" />
            </div>
            {isDraft && (settings.signingOrder !== doc.signingOrder || settings.message !== (doc.message ?? "")) ? (
              <Button size="sm" variant="outline" className="w-full" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
                Save
              </Button>
            ) : null}
          </section>

          {/* Integrity */}
          {doc.status !== "draft" ? (
            <section className="space-y-1.5">
              <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">INTEGRITY</div>
              <div className="text-[11px] space-y-1">
                <div>
                  <span className="text-muted-foreground">Original SHA-256</span>
                  <div className="font-mono text-[10px] break-all">{doc.originalSha256}</div>
                </div>
                {doc.signedSha256 ? (
                  <div>
                    <span className="text-muted-foreground">Signed file SHA-256 · {fmtBytes(doc.signedBytes)}</span>
                    <div className="font-mono text-[10px] break-all">{doc.signedSha256}</div>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Audit trail */}
          <section className="space-y-1.5">
            <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">AUDIT TRAIL</div>
            <div className="space-y-1.5">
              {doc.events
                .slice()
                .reverse()
                .map((e) => {
                  const who = e.signerId ? doc.signers.find((s) => s.id === e.signerId)?.name : null;
                  return (
                    <div key={e.id} className="text-[11px] leading-snug border-l-2 border-border pl-2">
                      <div>
                        <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                        {who ? <span className="text-muted-foreground"> · {who}</span> : null}
                      </div>
                      <div className="text-muted-foreground">
                        {fmtDateTime(e.at)}
                        {e.ip ? ` · ${e.ip}` : ""}
                        {e.detail && e.type !== "email_sent" ? ` · ${e.detail}` : ""}
                      </div>
                    </div>
                  );
                })}
            </div>
          </section>
        </div>
      </div>

      {/* Send confirmation */}
      <Dialog open={sending} onOpenChange={(o) => !o && setSending(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send for signature?</DialogTitle>
            <DialogDescription>
              {signers.length === 1 ? signers[0].name : `${signers.length} signers`} will be emailed a private link
              {settings.signingOrder === "sequential" ? ", one at a time in the order listed" : ""}. Signers and boxes are locked once sent.
            </DialogDescription>
          </DialogHeader>
          <ul className="text-[13px] space-y-1">
            {signers.map((s) => (
              <li key={s.key}>
                <span className="font-medium">{s.name}</span> <span className="text-muted-foreground">{s.email}</span> ·{" "}
                {fields.filter((f) => f.signerId === s.id).length} box(es)
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSending(false)}>
              Cancel
            </Button>
            <Button onClick={() => send.mutate()} disabled={send.isPending}>
              {send.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />} Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Void */}
      <Dialog open={voiding} onOpenChange={(o) => !o && setVoiding(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void this document?</DialogTitle>
            <DialogDescription>Signing links stop working. Signatures already collected stay on record but the document is not completed.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Reason (optional)</Label>
            <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. Terms changed — re-sending" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoiding(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => voidDoc.mutate()} disabled={voidDoc.isPending}>
              Void
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

// ---- Field box on the page ------------------------------------------------------------

function FieldBox({
  field,
  colour,
  signerName,
  editable,
  selected,
  filled,
  onSelect,
  onChange,
  onRemove,
}: {
  field: LocalField;
  colour: string;
  signerName: string;
  editable: boolean;
  selected: boolean;
  filled: string | null;
  onSelect: () => void;
  onChange: (patch: Partial<LocalField>) => void;
  onRemove: () => void;
}) {
  const drag = useRef<{ mode: "move" | "resize"; startX: number; startY: number; orig: LocalField; rect: DOMRect } | null>(null);

  const onPointerDown = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-page]") as HTMLElement | null;
    const rect = (pageEl ?? (e.currentTarget as HTMLElement).parentElement!).getBoundingClientRect();
    drag.current = { mode, startX: e.clientX, startY: e.clientY, orig: { ...field }, rect };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.rect.width;
    const dy = (e.clientY - d.startY) / d.rect.height;
    if (d.mode === "move") {
      onChange({ x: clamp(d.orig.x + dx, 0, 1 - d.orig.w), y: clamp(d.orig.y + dy, 0, 1 - d.orig.h) });
    } else {
      const w = clamp(d.orig.w + dx, 0.01, 1 - d.orig.x);
      const h = clamp(d.orig.h + dy, 0.008, 1 - d.orig.y);
      onChange({ w, h });
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const label = field.type === "signature" ? "Sign" : field.type === "initials" ? "Initials" : field.type === "date" ? "Date" : field.type === "checkbox" ? "" : field.label || "Text";
  return (
    <div
      data-field={field.key}
      className={`absolute select-none ${editable ? "cursor-move" : ""}`}
      style={{
        left: `${field.x * 100}%`,
        top: `${field.y * 100}%`,
        width: `${field.w * 100}%`,
        height: `${field.h * 100}%`,
        background: `${colour}22`,
        border: `${selected ? 2 : 1.5}px ${selected ? "solid" : "dashed"} ${colour}`,
        boxShadow: selected ? `0 0 0 3px ${colour}33` : undefined,
        zIndex: selected ? 3 : 2,
      }}
      onPointerDown={onPointerDown("move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      title={`${signerName} · ${FIELD_LABELS[field.type]}${field.required ? "" : " (optional)"}`}
    >
      <div className="absolute inset-0 flex items-center px-1 overflow-hidden pointer-events-none">
        <span className="text-[10px] leading-none truncate" style={{ color: colour }}>
          {filled && field.type !== "signature" && field.type !== "initials" ? (field.type === "checkbox" ? (filled === "true" ? "✓" : "") : filled) : label}
        </span>
      </div>
      <div className="absolute -top-4 left-0 text-[9px] leading-none px-1 py-0.5 whitespace-nowrap pointer-events-none" style={{ background: colour, color: "#fff" }}>
        {signerName.split(" ")[0]}
      </div>
      {editable ? (
        <>
          <div
            className="absolute -right-1.5 -bottom-1.5 w-3 h-3 rounded-sm cursor-nwse-resize"
            style={{ background: colour }}
            onPointerDown={onPointerDown("resize")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          {selected ? (
            <button
              className="absolute -top-4 -right-1 w-4 h-4 rounded-sm bg-foreground text-background flex items-center justify-center"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <Trash2 className="h-2.5 w-2.5" />
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SelectedFieldEditor({ field, onChange, onRemove }: { field: LocalField; onChange: (p: Partial<LocalField>) => void; onRemove: () => void }) {
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-medium">
            {FIELD_LABELS[field.type]} · page {field.page}
          </div>
          <Button size="sm" variant="ghost" className="h-7 text-[11px] text-muted-foreground" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
          </Button>
        </div>
        {field.type === "text" || field.type === "checkbox" || field.type === "date" ? (
          <div className="space-y-1">
            <Label className="text-[11px]">Label</Label>
            <Input className="h-8 text-[12px]" value={field.label ?? ""} onChange={(e) => onChange({ label: e.target.value || null })} placeholder={field.type === "date" ? "Date signed" : "e.g. Deposit amount"} />
          </div>
        ) : null}
        {field.type === "text" || field.type === "date" ? (
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Required</Label>
            <Switch checked={field.required} onCheckedChange={(v) => onChange({ required: v })} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
