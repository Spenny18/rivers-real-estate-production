// /admin/forms — the form templates: blank AREA forms with their boxes
// drawn once. Upload a blank here, set it up at /admin/forms/:id, and every
// deal can produce a filled copy from "New from form".

import { useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, FileStack, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FORM_KIND_LABELS, fmtBytes, fmtDateTime, type FormTemplateDetail, type FormTemplateKind, type FormTemplateSummary } from "@/lib/esign-types";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default function AdminFormsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: forms = [], isLoading } = useQuery<FormTemplateSummary[]>({ queryKey: ["/api/admin/form-templates"] });
  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<FormTemplateKind>("purchase");
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose the blank form PDF");
      const dataUrl = await readAsDataUrl(file);
      const res = await apiRequest("POST", "/api/admin/form-templates", { name: name.trim() || file.name.replace(/\.pdf$/i, ""), kind, dataUrl });
      return (await res.json()) as FormTemplateDetail;
    },
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/form-templates"] });
      setAdding(false);
      setFile(null);
      setName("");
      window.location.assign(`/admin/forms/${t.id}`);
    },
    onError: (e) => toast({ title: "Upload failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/form-templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/form-templates"] });
      toast({ title: "Form deleted" });
    },
    onError: (e) => toast({ title: "Couldn't delete", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <AppShell
      pageTitle="Forms"
      pageActions={
        <div className="flex items-center gap-2">
          <Link href="/admin/deals" className="inline-flex items-center text-[12px] text-muted-foreground hover:text-foreground mr-2">
            <ArrowLeft className="h-4 w-4 mr-1" /> Deals
          </Link>
          <Button size="sm" onClick={() => setAdding(true)} data-testid="button-add-form">
            <Plus className="h-4 w-4 mr-1" /> Add a blank form
          </Button>
        </div>
      }
    >
      <div className="p-6 max-w-4xl space-y-4">
        <p className="text-[13px] text-muted-foreground max-w-2xl">
          A form template is a blank AREA form with its boxes drawn on once: which blanks fill from the deal (names, address, price) and where each
          party signs. From then on a deal produces the filled contract in one step, no WEBForms needed.
        </p>
        {isLoading ? (
          <div className="text-[13px] text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : forms.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center">
              <FileStack className="h-8 w-8 mx-auto text-muted-foreground mb-3" strokeWidth={1.4} />
              <div className="font-serif text-[20px] mb-1">No forms yet</div>
              <p className="text-[13px] text-muted-foreground max-w-md mx-auto">
                Start with the Residential Purchase Contract and the Amendment. In WEBForms, open a transaction with nothing filled in and{" "}
                <em>Print / Save as PDF</em> the blank form, then add it here.
              </p>
              <Button className="mt-5" size="sm" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4 mr-1" /> Add a blank form
              </Button>
            </CardContent>
          </Card>
        ) : (
          forms.map((f) => (
            <Card key={f.id}>
              <CardContent className="p-4 flex items-center gap-4">
                <FileStack className="h-5 w-5 text-muted-foreground shrink-0" strokeWidth={1.5} />
                <div className="flex-1 min-w-0">
                  <Link href={`/admin/forms/${f.id}`} className="font-medium text-[14px] hover:underline underline-offset-4 truncate block">
                    {f.name}
                  </Link>
                  <div className="text-[12px] text-muted-foreground">
                    {f.pageCount} {f.pageCount === 1 ? "page" : "pages"} · {fmtBytes(f.bytes)} · {f.fillCount} fill box{f.fillCount === 1 ? "" : "es"} ·{" "}
                    {f.signCount} sign box{f.signCount === 1 ? "" : "es"}
                    {f.slots.buyer || f.slots.seller ? ` · ${f.slots.buyer} buyer${f.slots.buyer === 1 ? "" : "s"}, ${f.slots.seller} seller${f.slots.seller === 1 ? "" : "s"}` : ""}
                    {" · "}updated {fmtDateTime(f.updatedAt)}
                  </div>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  {FORM_KIND_LABELS[f.kind] ?? f.kind}
                </Badge>
                <Link href={`/admin/forms/${f.id}`}>
                  <Button size="sm" variant="outline">
                    {f.fillCount + f.signCount === 0 ? "Set up" : "Edit boxes"}
                  </Button>
                </Link>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground"
                  onClick={() => {
                    if (window.confirm(`Delete the form "${f.name}"? Documents already made from it are kept.`)) remove.mutate(f.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Dialog open={adding} onOpenChange={(o) => !o && setAdding(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a blank form</DialogTitle>
            <DialogDescription>The unfilled AREA form as a PDF, up to 10 MB. You will draw its boxes next.</DialogDescription>
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
                  if (!name) setName(f.name.replace(/\.pdf$/i, ""));
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
                  if (f && !name) setName(f.name.replace(/\.pdf$/i, ""));
                }}
              />
              <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-2" strokeWidth={1.5} />
              {file ? (
                <div className="text-[13px]">
                  <span className="font-medium">{file.name}</span> · {fmtBytes(file.size)}
                </div>
              ) : (
                <div className="text-[13px] text-muted-foreground">Drop the blank PDF here or click to choose</div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Form name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Residential Purchase Contract (AREA)" />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as FormTemplateKind)}>
                <SelectTrigger>
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
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
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
