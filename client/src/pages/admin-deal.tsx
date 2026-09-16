// /admin/deals/:id — one transaction: its details and its documents.
//
// Documents arrive as PDFs (exported from CREA WEBForms). Uploading one opens
// its workspace (/admin/deals/:id/documents/:docId) where signers and
// signature boxes are set up and the document is sent.

import { useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, CheckCircle2, Clock, Copy, ExternalLink, FileText, Inbox, Loader2, Mail, Plus, RefreshCw, Save, Search, Trash2, Upload, X, XCircle } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  fmtBytes,
  fmtDateTime,
  type CrmContactLite,
  type CrmDealLite,
  type DealView,
  type DocumentDetail,
  type DocumentSummary,
  type InboxStatus,
} from "@/lib/esign-types";
import type { Lead } from "@shared/schema";

export const DOC_STATUS_STYLES: Record<DocumentSummary["status"], string> = {
  draft: "bg-secondary text-secondary-foreground border-border",
  sent: "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900",
  completed: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-900",
  declined: "bg-red-100 text-red-900 border-red-200 dark:bg-red-950 dark:text-red-100 dark:border-red-900",
  voided: "bg-secondary/40 text-muted-foreground border-border",
};

export const DOC_STATUS_LABELS: Record<DocumentSummary["status"], string> = {
  draft: "Draft",
  sent: "Out for signature",
  completed: "Completed",
  declined: "Declined",
  voided: "Voided",
};

function StatusIcon({ status }: { status: DocumentSummary["status"] }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (status === "sent") return <Clock className="h-4 w-4 text-amber-600" />;
  if (status === "declined" || status === "voided") return <XCircle className="h-4 w-4 text-muted-foreground" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default function AdminDealPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = [`/api/admin/deals/${id}`];
  const { data: deal, isLoading } = useQuery<DealView>({ queryKey: key, enabled: Number.isFinite(id) });

  const [edit, setEdit] = useState<Partial<DealView> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [docTitle, setDocTitle] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/admin/deals/${id}`, edit);
      return (await res.json()) as DealView;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      qc.invalidateQueries({ queryKey: ["/api/admin/deals"] });
      setEdit(null);
      toast({ title: "Deal saved" });
    },
    onError: (e) => toast({ title: "Didn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/admin/deals/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/deals"] });
      window.location.assign("/admin/deals");
    },
    onError: (e) => toast({ title: "Couldn't delete", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a PDF");
      const dataUrl = await readAsDataUrl(file);
      const res = await apiRequest("POST", `/api/admin/deals/${id}/documents`, {
        title: docTitle.trim() || file.name.replace(/\.pdf$/i, ""),
        filename: file.name,
        dataUrl,
      });
      return (await res.json()) as DocumentDetail;
    },
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["/api/admin/deals"] });
      setUploading(false);
      setFile(null);
      setDocTitle("");
      window.location.assign(`/admin/deals/${id}/documents/${doc.id}`);
    },
    onError: (e) => toast({ title: "Upload failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const deleteDoc = useMutation({
    mutationFn: async (docId: number) => apiRequest("DELETE", `/api/admin/documents/${docId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["/api/admin/deals"] });
      toast({ title: "Document deleted" });
    },
    onError: (e) => toast({ title: "Couldn't delete", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (isLoading || !deal) {
    return (
      <AppShell pageTitle="Deal">
        <div className="p-6 text-[13px] text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> {isLoading ? "Loading…" : "Deal not found."}
        </div>
      </AppShell>
    );
  }

  const form = edit ?? deal;

  return (
    <AppShell
      pageTitle={deal.title}
      pageActions={
        <div className="flex items-center gap-2">
          <Link href="/admin/deals" className="inline-flex items-center text-[12px] text-muted-foreground hover:text-foreground mr-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> All deals
          </Link>
          <Button size="sm" onClick={() => setUploading(true)} data-testid="button-upload-document">
            <Plus className="h-4 w-4 mr-1" /> Add document
          </Button>
        </div>
      }
    >
      <div className="p-6 grid gap-6 lg:grid-cols-[1fr_340px] max-w-6xl">
        {/* Documents */}
        <div className="space-y-3">
          <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">DOCUMENTS</div>
          {deal.documents.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center">
                <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-3" strokeWidth={1.4} />
                <div className="font-serif text-[20px] mb-1">No documents yet</div>
                <p className="text-[13px] text-muted-foreground max-w-md mx-auto">
                  In CREA WEBForms open the transaction, choose the forms and use <em>Print / Save as PDF</em>. Upload that PDF here, place the
                  signature boxes, and send.
                </p>
                <Button className="mt-5" size="sm" onClick={() => setUploading(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Add document
                </Button>
              </CardContent>
            </Card>
          ) : (
            deal.documents.map((d) => (
              <Card key={d.id}>
                <CardContent className="p-4 flex items-center gap-4">
                  <StatusIcon status={d.status} />
                  <div className="flex-1 min-w-0">
                    <Link href={`/admin/deals/${deal.id}/documents/${d.id}`} className="font-medium text-[14px] hover:underline underline-offset-4 truncate block">
                      {d.title}
                    </Link>
                    <div className="text-[12px] text-muted-foreground">
                      {d.pageCount} {d.pageCount === 1 ? "page" : "pages"} · {fmtBytes(d.originalBytes)}
                      {d.source === "email" ? " · arrived by email" : ""}
                      {d.signerCount ? ` · ${d.signedCount}/${d.signerCount} signed` : " · no signers yet"}
                      {d.status === "sent" && d.sentAt ? ` · sent ${fmtDateTime(d.sentAt)}` : ""}
                      {d.status === "completed" && d.completedAt ? ` · completed ${fmtDateTime(d.completedAt)}` : ""}
                    </div>
                  </div>
                  <Badge variant="outline" className={`text-[10px] ${DOC_STATUS_STYLES[d.status]}`}>
                    {DOC_STATUS_LABELS[d.status]}
                  </Badge>
                  <Link href={`/admin/deals/${deal.id}/documents/${d.id}`}>
                    <Button size="sm" variant="outline">
                      {d.status === "draft" ? "Set up & send" : "Open"}
                    </Button>
                  </Link>
                  {d.status === "draft" || d.status === "voided" || d.status === "declined" ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground"
                      onClick={() => {
                        if (window.confirm(`Delete "${d.title}"? This cannot be undone.`)) deleteDoc.mutate(d.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Details */}
        <div className="space-y-3">
          <InboxCard deal={deal} />
          <ClientCard deal={deal} onSaved={(d) => qc.setQueryData(key, d)} />
          <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground pt-2">DETAILS</div>
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="space-y-1.5">
                <Label>Deal name</Label>
                <Input value={form.title ?? ""} onChange={(e) => setEdit({ ...form, title: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Property address</Label>
                <Input value={form.address ?? ""} onChange={(e) => setEdit({ ...form, address: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select value={form.kind} onValueChange={(v) => setEdit({ ...form, kind: v as DealView["kind"] })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="purchase">Purchase</SelectItem>
                      <SelectItem value="listing">Listing</SelectItem>
                      <SelectItem value="lease">Lease</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <Select value={form.status} onValueChange={(v) => setEdit({ ...form, status: v as DealView["status"] })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="closed">Closed</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>MLS® number</Label>
                <Input value={form.mlsNumber ?? ""} onChange={(e) => setEdit({ ...form, mlsNumber: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Textarea rows={4} value={form.notes ?? ""} onChange={(e) => setEdit({ ...form, notes: e.target.value })} />
              </div>
              <div className="flex items-center justify-between pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => {
                    if (window.confirm("Delete this deal and its draft documents?")) remove.mutate();
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-1" /> Delete
                </Button>
                <Button size="sm" disabled={!edit || save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>
          <div className="text-[11px] text-muted-foreground px-1">
            Created {fmtDateTime(deal.createdAt)}
            {deal.leadName ? ` · Lead: ${deal.leadName}` : ""}
          </div>
        </div>
      </div>

      <Dialog open={uploading} onOpenChange={(o) => !o && setUploading(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a document</DialogTitle>
            <DialogDescription>A PDF exported from CREA WEBForms, up to 10 MB. It is stored privately, never at a public URL.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div
              className="border border-dashed border-border rounded-sm p-6 text-center cursor-pointer hover:border-foreground/40"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) {
                  setFile(f);
                  if (!docTitle) setDocTitle(f.name.replace(/\.pdf$/i, ""));
                }
              }}
            >
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f && !docTitle) setDocTitle(f.name.replace(/\.pdf$/i, ""));
                }}
              />
              <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-2" strokeWidth={1.5} />
              {file ? (
                <div className="text-[13px]">
                  <span className="font-medium">{file.name}</span> · {fmtBytes(file.size)}
                </div>
              ) : (
                <div className="text-[13px] text-muted-foreground">Drop a PDF here or click to choose</div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Document title</Label>
              <Input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="e.g. Residential Purchase Contract" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploading(false)}>
              Cancel
            </Button>
            <Button disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}


// ---- Inbox: the deal's email address for WEBForms ------------------------------------------

function InboxCard({ deal }: { deal: DealView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: status } = useQuery<InboxStatus>({ queryKey: ["/api/admin/deals/inbox/status"] });
  const check = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/deals/inbox/check", {})).json() as Promise<{ result: NonNullable<InboxStatus["lastPoll"]> }>,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/deals/inbox/status"] });
      qc.invalidateQueries({ queryKey: [`/api/admin/deals/${deal.id}`] });
    },
    onSuccess: (r) =>
      toast({
        title: r.result.imported ? `Imported ${r.result.documents} PDF(s) from ${r.result.imported} email(s)` : "Inbox checked",
        description: r.result.imported ? undefined : `${r.result.checked} new email(s) looked at, nothing for this deal yet.`,
      }),
    onError: (e) => toast({ title: "Couldn't check the inbox", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const address = deal.inboxAddress;
  return (
    <>
      <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">SEND FORMS HERE</div>
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-start gap-2">
            <Inbox className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] text-muted-foreground leading-snug">
                In CREA WEBForms, email the finished forms to this address and they appear above as drafts.
              </div>
              {address ? (
                <div className="mt-2 flex items-center gap-1">
                  <code className="text-[12px] bg-secondary px-2 py-1 rounded-sm break-all">{address}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    title="Copy address"
                    onClick={() => {
                      navigator.clipboard?.writeText(address);
                      toast({ title: "Address copied" });
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          {status ? (
            status.ready ? (
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  Reading {status.accountEmail ?? status.mailbox}
                  {status.lastPoll ? ` · checked ${fmtDateTime(status.lastPoll.at)}` : " · not checked yet"}
                  {status.lastPoll && !status.lastPoll.ok ? <span className="text-destructive"> · {status.lastPoll.error}</span> : null}
                </span>
                <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={check.isPending || status.polling} onClick={() => check.mutate()}>
                  {check.isPending || status.polling ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />} Check now
                </Button>
              </div>
            ) : (
              <div className="text-[11px] text-amber-700">{status.reason}</div>
            )
          ) : null}
          {deal.inbound.length ? (
            <div className="pt-1 space-y-1">
              {deal.inbound.map((m) => (
                <div key={m.id} className="text-[11px] border-l-2 border-border pl-2 leading-snug">
                  <Mail className="inline h-3 w-3 mr-1 text-muted-foreground" />
                  <span className="font-medium">{m.subject || "(no subject)"}</span>
                  <div className="text-muted-foreground">
                    {m.from} · {fmtDateTime(m.receivedAt)} ·{" "}
                    {m.status === "imported" ? (
                      <span className="text-emerald-700">{m.documentIds.length} PDF(s) imported</span>
                    ) : (
                      <span className="text-destructive">{m.status}{m.detail ? `: ${m.detail}` : ""}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

// ---- Client: Follow Up Boss person + deal, and the site lead -------------------------------

function ClientCard({ deal, onSaved }: { deal: DealView; onSaved: (d: DealView) => void }) {
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [leadQ, setLeadQ] = useState("");
  const [pickingLead, setPickingLead] = useState(false);
  const { data: matches = [] } = useQuery<CrmContactLite[]>({
    queryKey: [`/api/admin/crm/contacts?q=${encodeURIComponent(q.trim())}&limit=8`],
    enabled: q.trim().length >= 2,
  });
  const { data: fubDeals = [] } = useQuery<CrmDealLite[]>({
    queryKey: [`/api/admin/crm-deals?contactFubId=${encodeURIComponent(deal.crmContactFubId ?? "")}`],
    enabled: !!deal.crmContactFubId,
  });
  const { data: leads = [] } = useQuery<Lead[]>({ queryKey: ["/api/leads"], enabled: pickingLead });

  const link = useMutation({
    mutationFn: async (patch: { crmContactFubId?: string | null; crmDealFubId?: string | null; leadId?: number | null }) =>
      (await apiRequest("PATCH", `/api/admin/deals/${deal.id}`, patch)).json() as Promise<DealView>,
    onSuccess: (d) => {
      onSaved(d);
      setQ("");
      setPickingLead(false);
    },
    onError: (e) => toast({ title: "Didn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const leadMatches = leads
    .filter((l) => {
      const needle = leadQ.trim().toLowerCase();
      return !needle || l.name.toLowerCase().includes(needle) || l.email.toLowerCase().includes(needle);
    })
    .slice(0, 8);

  return (
    <>
      <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground pt-2">CLIENT</div>
      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Follow Up Boss person */}
          {deal.crmContact ? (
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate">{deal.crmContact.name || deal.crmContact.email}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {deal.crmContact.email}
                  {deal.crmContact.phone ? ` · ${deal.crmContact.phone}` : ""}
                  {deal.crmContact.stage ? ` · ${deal.crmContact.stage}` : ""}
                </div>
                <a href={deal.crmContact.url} target="_blank" rel="noreferrer" className="text-[11px] inline-flex items-center gap-1 underline underline-offset-2 mt-1">
                  Open in Follow Up Boss <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <Button size="icon" variant="ghost" className="h-7 w-7" title="Unlink" onClick={() => link.mutate({ crmContactFubId: null })}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-[11px]">Follow Up Boss contact</Label>
              <div className="relative">
                <Search className="h-3.5 w-3.5 absolute left-2 top-2.5 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or phone" className="h-8 pl-7 text-[12px]" />
              </div>
              {q.trim().length >= 2 ? (
                <div className="border border-border rounded-sm divide-y divide-border">
                  {matches.length === 0 ? <div className="text-[11px] text-muted-foreground p-2">No matches in the CRM mirror.</div> : null}
                  {matches.map((c) => (
                    <button key={c.fubId} className="w-full text-left p-2 hover:bg-secondary text-[12px]" onClick={() => link.mutate({ crmContactFubId: c.fubId })}>
                      <div className="font-medium">{c.name || c.email}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {c.email}
                        {c.phone ? ` · ${c.phone}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {/* Follow Up Boss deal */}
          {deal.crmContact ? (
            <div className="space-y-1.5">
              <Label className="text-[11px]">Follow Up Boss deal</Label>
              <Select value={deal.crmDealFubId ?? "none"} onValueChange={(v) => link.mutate({ crmDealFubId: v === "none" ? null : v })}>
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {fubDeals.map((d) => (
                    <SelectItem key={d.fubId} value={d.fubId}>
                      {d.name || `Deal ${d.fubId}`}
                      {d.stageName ? ` · ${d.stageName}` : ""}
                      {d.value ? ` · $${Math.round(d.value).toLocaleString("en-CA")}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {deal.crmDeal ? (
                <div className="text-[11px] text-muted-foreground">
                  {deal.crmDeal.stageName ?? "—"}
                  {deal.crmDeal.value ? ` · $${Math.round(deal.crmDeal.value).toLocaleString("en-CA")}` : ""}
                  {deal.crmDeal.status ? ` · ${deal.crmDeal.status}` : ""}
                </div>
              ) : null}
              <div className="text-[11px] text-muted-foreground">Completed and declined signings post a note on this person in FUB.</div>
            </div>
          ) : null}

          {/* Site lead */}
          <div className="space-y-1.5">
            <Label className="text-[11px]">Website lead</Label>
            {deal.leadName && !pickingLead ? (
              <div className="flex items-center gap-2 text-[12px]">
                <span className="flex-1 truncate">
                  {deal.leadName} <span className="text-muted-foreground">{deal.leadEmail}</span>
                </span>
                <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setPickingLead(true)}>
                  Change
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" title="Unlink" onClick={() => link.mutate({ leadId: null })}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : pickingLead ? (
              <div className="space-y-1.5">
                <Input value={leadQ} onChange={(e) => setLeadQ(e.target.value)} placeholder="Search leads" className="h-8 text-[12px]" autoFocus />
                <div className="border border-border rounded-sm divide-y divide-border max-h-48 overflow-auto">
                  {leadMatches.map((l) => (
                    <button key={l.id} className="w-full text-left p-2 hover:bg-secondary text-[12px]" onClick={() => link.mutate({ leadId: l.id })}>
                      <div className="font-medium">{l.name}</div>
                      <div className="text-[11px] text-muted-foreground">{l.email}</div>
                    </button>
                  ))}
                  {leadMatches.length === 0 ? <div className="text-[11px] text-muted-foreground p-2">No leads match.</div> : null}
                </div>
                <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setPickingLead(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={() => setPickingLead(true)}>
                Link a lead
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
