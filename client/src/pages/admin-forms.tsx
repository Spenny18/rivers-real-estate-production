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
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<FormTemplateKind>("other");
  const fileInput = useRef<HTMLInputElement>(null);
  const file = files[0] ?? null;

  type Uploaded = FormTemplateDetail & { matched: { id: string; name: string; code: string; sameRevision: boolean; boxes: number } | null; detected: number };

  const upload = useMutation({
    mutationFn: async () => {
      if (!files.length) throw new Error("Choose the blank form PDF");
      const out: Uploaded[] = [];
      const failed: string[] = [];
      for (const f of files) {
        try {
          const dataUrl = await readAsDataUrl(f);
          const res = await apiRequest("POST", "/api/admin/form-templates", { name: files.length === 1 ? name.trim() : "", filename: f.name, kind, dataUrl });
          out.push((await res.json()) as Uploaded);
        } catch (e) {
          failed.push(`${f.name}: ${apiErrorMessage(e)}`);
        }
      }
      return { out, failed };
    },
    onSuccess: ({ out, failed }) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/form-templates"] });
      setAdding(false);
      setFiles([]);
      setName("");
      if (failed.length) toast({ title: `${failed.length} file(s) failed`, description: failed.join(" · "), variant: "destructive" });
      if (out.length === 1) {
        const t = out[0];
        toast({
          title: t.matched ? `Recognised: AREA ${t.matched.name}` : t.detected ? `${t.detected} blanks found` : "Form added",
          description: t.matched
            ? `${t.matched.boxes} boxes placed from the built-in layout${t.matched.sameRevision ? "" : " (a different revision of the form — check them)"}.`
            : t.detected
              ? "Each underscored blank is a typed box. Bind the ones the deal knows, delete the rest."
              : "Draw the boxes on it.",
        });
        window.location.assign(`/admin/forms/${t.id}`);
      } else if (out.length) {
        const recognised = out.filter((t) => t.matched).length;
        toast({ title: `${out.length} forms added`, description: `${recognised} recognised with boxes pre-placed; ${out.length - recognised} with blanks detected or left to draw.` });
      }
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
            <DialogDescription>The unfilled AREA forms as PDFs, up to 10 MB each. Password-protected exports from WEBForms are fine.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div
              className="border border-dashed border-border rounded-sm p-6 text-center cursor-pointer hover:border-foreground/40"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const fs = Array.from(e.dataTransfer.files ?? []).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
                if (fs.length) setFiles(fs);
              }}
            >
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="hidden"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-2" strokeWidth={1.5} />
              {files.length > 1 ? (
                <div className="text-[13px]">
                  <span className="font-medium">{files.length} PDFs</span> · {fmtBytes(files.reduce((a, f) => a + f.size, 0))}
                  <div className="text-[11px] text-muted-foreground mt-1 max-h-24 overflow-auto">{files.map((f) => f.name).join(" · ")}</div>
                </div>
              ) : file ? (
                <div className="text-[13px]">
                  <span className="font-medium">{file.name}</span> · {fmtBytes(file.size)}
                </div>
              ) : (
                <div className="text-[13px] text-muted-foreground">Drop one or more blank PDFs here, or click to choose</div>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              AREA forms are recognised by their footer code and get their boxes placed for you: the Residential Purchase Contract, Amendment, Addendum,
              Notice and Exclusive Buyer Representation Agreement. Other forms get a typed box on every underscored blank.
            </div>
            {files.length <= 1 ? (
              <div className="space-y-1.5">
                <Label>Form name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave blank to use the recognised name or the file name" />
              </div>
            ) : null}
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
            <Button disabled={!files.length || upload.isPending} onClick={() => upload.mutate()} data-testid="button-upload-forms">
              {upload.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              {files.length > 1 ? `Upload ${files.length} forms` : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
