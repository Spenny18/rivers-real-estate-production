// /admin/listings/mls/:id — the asset studio for one of Spencer's Pillar 9
// listings: branded social graphics, a feature sheet PDF, and copy written by
// Claude (server/listing-assets.ts).

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Copy, Download, ExternalLink, FileText, Loader2, Save, Send, Sparkles, Trash2 } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { downloadAuthed, useAuthedImage } from "@/lib/authed-blob";
import { formatPrice, timeAgoShort } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { ListingPhoto, MY_STATUS_STYLES, ROLE_LABEL, placeOf, streetOf, type MyListing } from "@/components/my-mls-listings";

interface Asset {
  id: number;
  listingId: string;
  kind: string;
  occasion: string;
  content: string;
  model: string | null;
  createdAt: string;
}

interface Studio {
  listing: MyListing;
  publicUrl: string | null;
  defaultOccasion: string;
  assets: Asset[];
  copy: { ok: boolean; reason?: string };
  occasions: Record<string, string>;
  formats: Record<string, string>;
  copyKinds: Record<string, string>;
}

// Copy that can go straight into the social composer as a draft.
const SOCIAL_KINDS: Record<string, string> = { instagram: "instagram", facebook: "facebook", linkedin: "linkedin" };

function fileSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "listing";
}

export default function MyListingPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const key = [`/api/admin/my-listings/${encodeURIComponent(id)}`];
  const { data, isLoading, error } = useQuery<Studio>({ queryKey: key });

  if (isLoading || !data) {
    return (
      <AppShell pageTitle="Listing assets">
        <div className="px-8 py-7 space-y-4">
          {error ? (
            <Card>
              <CardContent className="p-10 text-center text-sm text-muted-foreground">{apiErrorMessage(error)}</CardContent>
            </Card>
          ) : (
            <>
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-64 w-full" />
            </>
          )}
        </div>
      </AppShell>
    );
  }
  return <StudioView data={data} queryKey={key} />;
}

function StudioView({ data, queryKey }: { data: Studio; queryKey: string[] }) {
  const { toast } = useToast();
  const l = data.listing;
  const base = `/api/admin/my-listings/${encodeURIComponent(l.id)}`;
  const street = streetOf(l.address);

  const [occasion, setOccasion] = useState(data.defaultOccasion);
  const [detailDraft, setDetailDraft] = useState("");
  const [detail, setDetail] = useState("");
  const [showSoldPrice, setShowSoldPrice] = useState(false);
  const [photo, setPhoto] = useState(0);
  const [format, setFormat] = useState("square");
  const [sheetBusy, setSheetBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDetail(detailDraft.trim()), 500);
    return () => clearTimeout(t);
  }, [detailDraft]);

  const canShowSoldPrice = l.status === "Sold" && !!l.closePrice;
  const optionQuery = useMemo(() => {
    const q = new URLSearchParams({ occasion });
    if (detail) q.set("detail", detail);
    if (showSoldPrice && canShowSoldPrice) q.set("soldPrice", "1");
    return q;
  }, [occasion, detail, showSoldPrice, canShowSoldPrice]);
  const graphicPath = `${base}/graphic?${new URLSearchParams({ ...Object.fromEntries(optionQuery), format, photo: String(photo) })}`;
  const graphic = useAuthedImage(graphicPath);

  const download = async (path: string, name: string) => {
    try {
      await downloadAuthed(path, name);
    } catch (e) {
      toast({ title: "Download failed", description: apiErrorMessage(e), variant: "destructive" });
    }
  };

  const previewSheet = async () => {
    setSheetBusy(true);
    // Open the tab now, while the click still counts as a user gesture.
    const win = window.open("", "_blank");
    try {
      const blob = await (await apiRequest("GET", `${base}/feature-sheet?${optionQuery}`)).blob();
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (e) {
      win?.close();
      toast({ title: "Feature sheet failed", description: apiErrorMessage(e), variant: "destructive" });
    } finally {
      setSheetBusy(false);
    }
  };

  const price = l.status === "Sold" && l.closePrice ? l.closePrice : l.listPrice;
  const photoCount = Math.min(l.photoCount, 24);

  return (
    <AppShell
      pageTitle="Listing assets"
      pageActions={
        <Link href="/admin/listings">
          <Button variant="outline" className="rounded-sm font-display tracking-[0.14em] text-[11px]">
            <ArrowLeft className="w-4 h-4 mr-1.5" /> LISTINGS
          </Button>
        </Link>
      }
    >
      <div className="px-4 sm:px-8 py-7 space-y-6">
        {/* Listing header */}
        <Card className="rounded-sm overflow-hidden">
          <div className="flex flex-col md:flex-row">
            <ListingPhoto listing={l} className="w-full md:w-72 aspect-[4/3] md:aspect-auto md:h-auto shrink-0" />
            <CardContent className="p-5 space-y-2 flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={`rounded-sm font-display tracking-[0.14em] text-[10px] px-2 py-0.5 ${MY_STATUS_STYLES[l.status] ?? "bg-muted text-muted-foreground border-border"}`}>
                  {l.status.toUpperCase()}
                </Badge>
                <Badge variant="outline" className="rounded-sm text-[10px]">{ROLE_LABEL[l.role]}</Badge>
                <span className="text-xs text-muted-foreground">MLS® {l.id}</span>
              </div>
              <div className="font-serif text-2xl truncate">{street}</div>
              <div className="text-sm text-muted-foreground">{placeOf(l, [l.postalCode])}</div>
              <div className="text-sm">
                <span className="font-serif text-lg">{price ? formatPrice(price) : "—"}</span>
                {l.status === "Sold" && l.closeDate && <span className="text-muted-foreground"> · sold {l.closeDate}</span>}
                {l.originalListPrice && l.listPrice && l.originalListPrice > l.listPrice && l.status !== "Sold" && (
                  <span className="text-muted-foreground"> · was {formatPrice(l.originalListPrice)}</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {[
                  l.beds != null && `${l.beds} bed`,
                  l.baths != null && `${l.baths} bath`,
                  l.sqft && `${l.sqft.toLocaleString()} sq ft`,
                  l.yearBuilt && `built ${l.yearBuilt}`,
                  l.daysOnMarket != null && `${l.daysOnMarket} DOM`,
                  `${l.photoCount} photos`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {data.publicUrl && (
                <a href={data.publicUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-2">
                  Public listing page <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </CardContent>
          </div>
        </Card>

        {/* Options shared by every asset */}
        <Card className="rounded-sm">
          <CardContent className="p-5 grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Occasion</Label>
              <Select value={occasion} onValueChange={setOccasion}>
                <SelectTrigger className="rounded-sm" data-testid="select-occasion">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(data.occasions).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{occasion === "open-house" ? "Date and time" : "Extra line (optional)"}</Label>
              <Input
                value={detailDraft}
                onChange={(e) => setDetailDraft(e.target.value.slice(0, 80))}
                placeholder={occasion === "open-house" ? "Saturday, Nov 2 · 1–3 PM" : "e.g. Backs onto the ravine"}
                className="rounded-sm"
                data-testid="input-detail"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Sold price</Label>
              <div className="flex items-center gap-2 h-10">
                <Switch checked={showSoldPrice && canShowSoldPrice} onCheckedChange={setShowSoldPrice} disabled={!canShowSoldPrice} data-testid="switch-sold-price" />
                <span className="text-xs text-muted-foreground">
                  {canShowSoldPrice ? "Show it on graphics and in copy (only with your client's consent)" : "Only for sold listings"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* Graphics */}
          <Card className="rounded-sm">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="eyebrow text-muted-foreground">SOCIAL GRAPHICS</div>
                <Select value={format} onValueChange={setFormat}>
                  <SelectTrigger className="w-[230px] rounded-sm" data-testid="select-format">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(data.formats).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {photoCount > 1 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">Photo</div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {Array.from({ length: photoCount }, (_, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setPhoto(i)}
                        className={`shrink-0 rounded-sm overflow-hidden border-2 ${photo === i ? "border-foreground" : "border-transparent opacity-70 hover:opacity-100"}`}
                        aria-label={`Use photo ${i + 1}`}
                        data-testid={`photo-${i}`}
                      >
                        <ListingPhoto listing={l} index={i} className="w-20 h-14" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="relative bg-secondary rounded-sm flex items-center justify-center min-h-[260px]">
                {graphic.url ? (
                  <img src={graphic.url} alt="Graphic preview" className={`max-h-[560px] w-auto max-w-full ${graphic.loading ? "opacity-50" : ""}`} />
                ) : graphic.error ? (
                  <div className="text-sm text-destructive p-6 text-center">{graphic.error}</div>
                ) : null}
                {graphic.loading && <Loader2 className="absolute w-6 h-6 animate-spin text-muted-foreground" />}
              </div>

              <Button
                className="w-full rounded-sm font-display tracking-[0.14em] text-[11px]"
                onClick={() => download(`${graphicPath}&download=1`, `${fileSlug(street)}-${occasion}-${format}.png`)}
                data-testid="button-download-graphic"
              >
                <Download className="w-4 h-4 mr-1.5" /> DOWNLOAD PNG
              </Button>

              <div className="border-t border-border pt-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium flex items-center gap-1.5"><FileText className="w-4 h-4" /> Feature sheet</div>
                  <div className="text-xs text-muted-foreground">One-page PDF: photos, facts, remarks and your contact block.</div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="rounded-sm text-xs" onClick={previewSheet} disabled={sheetBusy} data-testid="button-preview-sheet">
                    {sheetBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Preview"}
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-sm text-xs"
                    onClick={() => download(`${base}/feature-sheet?${optionQuery}&download=1`, `${fileSlug(street)}-feature-sheet.pdf`)}
                    data-testid="button-download-sheet"
                  >
                    <Download className="w-4 h-4 mr-1" /> PDF
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Copy */}
          <CopyPanel data={data} queryKey={queryKey} options={{ occasion, detail, showSoldPrice: showSoldPrice && canShowSoldPrice }} />
        </div>
      </div>
    </AppShell>
  );
}

function CopyPanel({
  data,
  queryKey,
  options,
}: {
  data: Studio;
  queryKey: string[];
  options: { occasion: string; detail: string; showSoldPrice: boolean };
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const base = `/api/admin/my-listings/${encodeURIComponent(data.listing.id)}`;
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: async (kind: string) => {
      setPending(kind);
      return (await apiRequest("POST", `${base}/copy`, { kind, ...options, detail: options.detail || undefined, notes: notes || undefined })).json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (e) => toast({ title: "Couldn't write that", description: apiErrorMessage(e), variant: "destructive" }),
    onSettled: () => setPending(null),
  });

  return (
    <Card className="rounded-sm">
      <CardContent className="p-5 space-y-4">
        <div className="eyebrow text-muted-foreground">COPY</div>
        {!data.copy.ok && <div className="text-xs text-destructive">{data.copy.reason}</div>}
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes for this piece (optional): what to lead with, tone, anything not in the MLS® data…"
          className="rounded-sm min-h-[70px] text-sm"
          data-testid="input-copy-notes"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-2">
          {Object.entries(data.copyKinds).map(([k, label]) => (
            <Button
              key={k}
              variant="outline"
              className="rounded-sm text-xs justify-start"
              disabled={!data.copy.ok || generate.isPending}
              onClick={() => generate.mutate(k)}
              data-testid={`button-copy-${k}`}
            >
              {pending === k ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
              <span className="truncate">{label}</span>
            </Button>
          ))}
        </div>
        <div className="space-y-3">
          {data.assets.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">Nothing written yet. Pick a format above.</div>
          ) : (
            data.assets.map((a) => <AssetCard key={a.id} asset={a} data={data} queryKey={queryKey} />)
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AssetCard({ asset, data, queryKey }: { asset: Asset; data: Studio; queryKey: string[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState(asset.content);
  useEffect(() => setText(asset.content), [asset.content]);
  const dirty = text !== asset.content;

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/admin/my-listings/assets/${asset.id}`, { content: text })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (e) => toast({ title: "Save failed", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/admin/my-listings/assets/${asset.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (e) => toast({ title: "Delete failed", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const draft = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/social-posts", {
          caption: text,
          channels: [SOCIAL_KINDS[asset.kind]],
          linkUrl: data.publicUrl,
          status: "draft",
        })
      ).json(),
    onSuccess: () => toast({ title: "Saved as a draft in Marketing" }),
    onError: (e) => toast({ title: "Couldn't save the draft", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <div className="border border-border rounded-sm p-3 space-y-2" data-testid={`asset-${asset.id}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium">{data.copyKinds[asset.kind] ?? asset.kind}</span>
          <span className="text-muted-foreground truncate">· {data.occasions[asset.occasion] ?? asset.occasion} · {timeAgoShort(asset.createdAt)}</span>
        </div>
        <span className="text-muted-foreground tabular-nums">{text.length.toLocaleString()} chars</span>
      </div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} className="rounded-sm min-h-[160px] text-sm" />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="rounded-sm text-xs"
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => toast({ title: "Copied" }),
              () => toast({ title: "Couldn't copy", variant: "destructive" }),
            )
          }
        >
          <Copy className="w-3.5 h-3.5 mr-1" /> Copy
        </Button>
        {dirty && (
          <Button size="sm" variant="outline" className="rounded-sm text-xs" onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="w-3.5 h-3.5 mr-1" /> Save edits
          </Button>
        )}
        {SOCIAL_KINDS[asset.kind] && (
          <Button size="sm" variant="outline" className="rounded-sm text-xs" onClick={() => draft.mutate()} disabled={draft.isPending}>
            <Send className="w-3.5 h-3.5 mr-1" /> Social draft
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="rounded-sm text-xs text-muted-foreground ml-auto"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          aria-label="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
