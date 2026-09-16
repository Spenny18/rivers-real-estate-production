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
import { ArrowLeft, CheckCircle2, Clock, FileText, Loader2, Plus, Save, Trash2, Upload, XCircle } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtBytes, fmtDateTime, type DealView, type DocumentDetail, type DocumentSummary } from "@/lib/esign-types";

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
          <div className="font-display text-[10px] tracking-[0.2em] text-muted-foreground">DETAILS</div>
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
