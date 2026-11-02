// The Instagram carousel panel on a listing's asset page (pages/my-listing.tsx):
// 1080×1350 slides in the editorial look of the open house carousel designed in
// Cowork, drawn on the server (server/listing-carousel.ts). Claude can plan the
// slides and write the caption; every slide's words and photos can be edited
// here, and the carousel is saved per listing as it changes.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, ArrowRight, CopyPlus, Download, ExternalLink, Instagram, Loader2, Plus, RotateCcw, Send, Sparkles, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ListingPhoto, type MyListing } from "@/components/my-mls-listings";

interface Slide {
  layout: string;
  eyebrow: string;
  headline: string;
  body: string;
  points: string[];
  photos: number[];
}

interface Spec {
  occasion: string;
  slides: Slide[];
}

interface CarouselResponse {
  spec: Spec;
  saved: boolean;
  model: string | null;
  updatedAt: string | null;
  layouts: Record<string, { label: string; photos: number; points: string }>;
  copy: { ok: boolean; reason?: string };
}

const MAX_SLIDES = 10;

function fileSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "listing";
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One slide drawn by the server, redrawn a moment after it changes. */
function useSlideImage(base: string, spec: Spec, index: number) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const specRef = useRef(spec);
  const urlRef = useRef<string | null>(null);
  specRef.current = spec;
  const key = JSON.stringify([spec.slides[index], index, spec.slides.length]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      apiRequest("POST", `${base}/carousel/slide`, { spec: specRef.current, index, width: 540 })
        .then((r) => r.blob())
        .then((b) => {
          if (cancelled) return;
          const made = URL.createObjectURL(b);
          const old = urlRef.current;
          if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
          urlRef.current = made;
          setUrl(made);
          setError(null);
        })
        .catch((e) => !cancelled && setError(apiErrorMessage(e)))
        .finally(() => !cancelled && setLoading(false));
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [base, key, index]);
  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), []);
  return { url, loading, error };
}

function SlideThumb({ base, spec, index, selected, onSelect }: { base: string; spec: Spec; index: number; selected: boolean; onSelect: () => void }) {
  const img = useSlideImage(base, spec, index);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative shrink-0 w-[132px] aspect-[4/5] rounded-sm overflow-hidden border-2 bg-secondary ${selected ? "border-foreground" : "border-transparent opacity-80 hover:opacity-100"}`}
      aria-label={`Slide ${index + 1}`}
      data-testid={`carousel-thumb-${index}`}
    >
      {img.url && <img src={img.url} alt="" className="w-full h-full object-cover" />}
      {img.error && !img.url && <span className="absolute inset-0 flex items-center justify-center p-2 text-[10px] text-destructive">{img.error}</span>}
      {img.loading && <Loader2 className="absolute right-1.5 top-1.5 w-3.5 h-3.5 animate-spin text-muted-foreground" />}
      <span className="absolute left-1 bottom-1 bg-background/85 text-[10px] px-1 rounded-sm tabular-nums">{index + 1}</span>
    </button>
  );
}

function SlidePreview({ base, spec, index }: { base: string; spec: Spec; index: number }) {
  const img = useSlideImage(base, spec, index);
  return (
    <div className="relative bg-secondary rounded-sm aspect-[4/5] w-full max-w-[420px] mx-auto flex items-center justify-center overflow-hidden">
      {img.url ? <img src={img.url} alt={`Slide ${index + 1} preview`} className={`w-full h-full object-contain ${img.loading ? "opacity-60" : ""}`} /> : null}
      {img.error && !img.url && <div className="text-sm text-destructive p-6 text-center">{img.error}</div>}
      {img.loading && <Loader2 className="absolute w-6 h-6 animate-spin text-muted-foreground" />}
    </div>
  );
}

function SlideEditor({
  slide,
  layouts,
  listing,
  onChange,
}: {
  slide: Slide;
  layouts: CarouselResponse["layouts"];
  listing: MyListing;
  onChange: (s: Slide) => void;
}) {
  // The points box keeps its own text so a half-typed blank line isn't swallowed.
  const [pointsText, setPointsText] = useState(slide.points.join("\n"));
  const [slot, setSlot] = useState(0);
  const layout = layouts[slide.layout];
  const slots = layout?.photos ?? 0;
  const photoCount = Math.min(listing.photoCount, 40);

  const set = (patch: Partial<Slide>) => onChange({ ...slide, ...patch });
  const pickPhoto = (i: number) => {
    const photos = [...slide.photos];
    while (photos.length < slots) photos.push(photos[photos.length - 1] ?? 0);
    photos[Math.min(slot, slots - 1)] = i;
    set({ photos: photos.slice(0, slots) });
    if (slots > 1) setSlot((slot + 1) % slots);
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Layout</Label>
          <Select value={slide.layout} onValueChange={(v) => set({ layout: v })}>
            <SelectTrigger className="rounded-sm" data-testid="select-slide-layout">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(layouts).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Eyebrow</Label>
          <Input
            value={slide.eyebrow}
            onChange={(e) => set({ eyebrow: e.target.value.slice(0, 80) })}
            placeholder={slide.layout === "overview" ? "Street address (default)" : "e.g. The Main Floor"}
            className="rounded-sm"
            data-testid="input-slide-eyebrow"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Headline</Label>
        <Textarea
          value={slide.headline}
          onChange={(e) => set({ headline: e.target.value.slice(0, 140) })}
          className="rounded-sm min-h-[56px] text-sm"
          data-testid="input-slide-headline"
        />
      </div>
      <div className="space-y-1.5">
        <Label>{slide.layout === "cta" ? "Address and price lines" : slide.layout === "cover" ? "Address line" : "Body line"}</Label>
        <Textarea
          value={slide.body}
          onChange={(e) => set({ body: e.target.value.slice(0, 400) })}
          className="rounded-sm min-h-[56px] text-sm"
          data-testid="input-slide-body"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Points</Label>
        <Textarea
          value={pointsText}
          onChange={(e) => {
            setPointsText(e.target.value);
            set({ points: e.target.value.split("\n").map((p) => p.trim()).filter(Boolean).slice(0, 6) });
          }}
          placeholder={layout?.points}
          className="rounded-sm min-h-[84px] text-sm"
          data-testid="input-slide-points"
        />
        {layout && <div className="text-[11px] text-muted-foreground">{layout.points}. One per line.</div>}
      </div>
      {slots > 0 && photoCount > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label>Photo{slots > 1 ? "s" : ""}</Label>
            {slots > 1 &&
              Array.from({ length: slots }, (_, i) => (
                <Button
                  key={i}
                  type="button"
                  size="sm"
                  variant={slot === i ? "default" : "outline"}
                  className="h-7 rounded-sm text-[11px] px-2"
                  onClick={() => setSlot(i)}
                >
                  {i === 0 ? "Left" : "Right"} · {(slide.photos[i] ?? 0) + 1}
                </Button>
              ))}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {Array.from({ length: photoCount }, (_, i) => {
              const on = slide.photos[Math.min(slot, slots - 1)] === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => pickPhoto(i)}
                  className={`shrink-0 rounded-sm overflow-hidden border-2 ${on ? "border-foreground" : "border-transparent opacity-70 hover:opacity-100"}`}
                  aria-label={`Use photo ${i + 1}`}
                >
                  <ListingPhoto listing={listing} index={i} className="w-20 h-14" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function CarouselPanel({
  listing,
  options,
  studioKey,
}: {
  listing: MyListing;
  options: { occasion: string; detail: string; showSoldPrice: boolean };
  studioKey: string[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const base = `/api/admin/my-listings/${encodeURIComponent(listing.id)}`;
  const q = new URLSearchParams({ occasion: options.occasion });
  if (options.detail) q.set("detail", options.detail);
  if (options.showSoldPrice) q.set("soldPrice", "1");
  const queryKey = [`${base}/carousel?${q}`];
  const { data, error } = useQuery<CarouselResponse>({ queryKey });

  const [spec, setSpec] = useState<Spec | null>(null);
  // Bumped whenever the spec is replaced from outside (load, Claude, start over), so editors reset.
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [notes, setNotes] = useState("");
  const [zipBusy, setZipBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState<{ posted: boolean; error: string | null } | null>(null);

  useEffect(() => {
    if (!data) return;
    // A saved carousel is kept as edited; an unsaved one follows the occasion and date line.
    if (dirty) return;
    setSpec(data.spec);
    setSaved(data.saved);
    setVersion((v) => v + 1);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save a moment after the last edit.
  useEffect(() => {
    if (!dirty || !spec) return;
    const t = setTimeout(() => {
      apiRequest("PUT", `${base}/carousel`, { spec })
        .then(() => {
          setDirty(false);
          setSaved(true);
        })
        .catch((e) => toast({ title: "Couldn't save the carousel", description: apiErrorMessage(e), variant: "destructive" }));
    }, 900);
    return () => clearTimeout(t);
  }, [spec, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const replace = (next: Spec) => {
    setSpec(next);
    setVersion((v) => v + 1);
    setSelected((i) => Math.min(i, next.slides.length - 1));
  };
  const edit = (next: Spec) => {
    setSpec(next);
    setDirty(true);
  };

  const write = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `${base}/carousel/write`, {
          occasion: options.occasion,
          detail: options.detail || undefined,
          showSoldPrice: options.showSoldPrice || undefined,
          notes: notes || undefined,
        })
      ).json(),
    onSuccess: (r: { carousel: { spec: Spec } }) => {
      setDirty(false);
      setSaved(true);
      replace(r.carousel.spec);
      setSelected(0);
      qc.invalidateQueries({ queryKey: studioKey });
      qc.invalidateQueries({ queryKey });
      toast({ title: "Carousel planned", description: "The caption is with your copy below." });
    },
    onError: (e) => toast({ title: "Couldn't plan the carousel", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // To Marketing's social posts, and from there the auto-poster (Make → Instagram).
  const social = useMutation({
    mutationFn: async (postNow: boolean) =>
      (await apiRequest("POST", `${base}/carousel/social`, { spec, channels: ["instagram"], postNow })).json() as Promise<{
        dispatched: boolean;
        webhookError?: string | null;
      }>,
    onSuccess: (r, postNow) => {
      setDirty(false);
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["/api/social-posts"] });
      if (!postNow) {
        setSent({ posted: false, error: null });
        toast({ title: "Carousel saved as a draft in Marketing" });
      } else if (r.dispatched) {
        setSent({ posted: true, error: null });
        toast({ title: "Sent to Instagram", description: "The auto-poster is publishing the carousel." });
      } else {
        setSent({ posted: false, error: r.webhookError ?? "The auto-poster didn't accept it" });
        toast({ title: "Couldn't send it to Instagram", description: r.webhookError ?? undefined, variant: "destructive" });
      }
    },
    onError: (e) => toast({ title: "Couldn't make the social post", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const reset = useMutation({
    mutationFn: async () => apiRequest("DELETE", `${base}/carousel`),
    onSuccess: async () => {
      setDirty(false);
      setSaved(false);
      const fresh = await (await apiRequest("GET", queryKey[0])).json();
      qc.setQueryData(queryKey, fresh);
      replace(fresh.spec);
      setSelected(0);
    },
    onError: (e) => toast({ title: "Couldn't start over", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (!spec || !data) {
    return (
      <Card className="rounded-sm">
        <CardContent className="p-5 text-sm text-muted-foreground">{error ? apiErrorMessage(error) : "Loading the carousel…"}</CardContent>
      </Card>
    );
  }

  const slides = spec.slides;
  const cur = Math.min(selected, slides.length - 1);
  const slug = `${fileSlug(listing.address.split(",")[0])}-carousel`;

  const updateSlide = (s: Slide) => edit({ ...spec, slides: slides.map((x, i) => (i === cur ? s : x)) });
  const move = (d: -1 | 1) => {
    const j = cur + d;
    if (j < 0 || j >= slides.length) return;
    const next = [...slides];
    [next[cur], next[j]] = [next[j], next[cur]];
    edit({ ...spec, slides: next });
    setSelected(j);
    setVersion((v) => v + 1);
  };
  const insert = (s: Slide) => {
    if (slides.length >= MAX_SLIDES) return;
    const next = [...slides.slice(0, cur + 1), s, ...slides.slice(cur + 1)];
    edit({ ...spec, slides: next });
    setSelected(cur + 1);
    setVersion((v) => v + 1);
  };
  const remove = () => {
    if (slides.length <= 1) return;
    edit({ ...spec, slides: slides.filter((_, i) => i !== cur) });
    setSelected(Math.max(0, cur - 1));
    setVersion((v) => v + 1);
  };

  const downloadZip = async () => {
    setZipBusy(true);
    try {
      saveBlob(await (await apiRequest("POST", `${base}/carousel/zip`, { spec })).blob(), `${slug}.zip`);
    } catch (e) {
      toast({ title: "Download failed", description: apiErrorMessage(e), variant: "destructive" });
    } finally {
      setZipBusy(false);
    }
  };
  const downloadSlide = async () => {
    try {
      const blob = await (await apiRequest("POST", `${base}/carousel/slide`, { spec, index: cur })).blob();
      saveBlob(blob, `${slug}-${String(cur + 1).padStart(2, "0")}.png`);
    } catch (e) {
      toast({ title: "Download failed", description: apiErrorMessage(e), variant: "destructive" });
    }
  };

  return (
    <Card className="rounded-sm" data-testid="carousel-panel">
      <CardContent className="p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="eyebrow text-muted-foreground">INSTAGRAM CAROUSEL</div>
            <div className="text-xs text-muted-foreground mt-1">
              1080×1350 portrait slides · {slides.length} of {MAX_SLIDES}
              {dirty ? " · saving…" : saved ? " · saved" : " · built from the listing facts"}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="rounded-sm text-xs" onClick={() => reset.mutate()} disabled={reset.isPending} data-testid="button-carousel-reset">
              <RotateCcw className="w-3.5 h-3.5 mr-1" /> Start over
            </Button>
            <Button className="rounded-sm font-display tracking-[0.14em] text-[11px]" onClick={downloadZip} disabled={zipBusy} data-testid="button-carousel-zip">
              {zipBusy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Download className="w-4 h-4 mr-1.5" />} DOWNLOAD ALL (ZIP)
            </Button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, 2000))}
            placeholder="Notes for Claude (optional): what to feature, the suite, the open house times…"
            className="rounded-sm text-sm"
            data-testid="input-carousel-notes"
          />
          <Button
            variant="outline"
            className="rounded-sm text-xs shrink-0"
            onClick={() => write.mutate()}
            disabled={!data.copy.ok || write.isPending}
            data-testid="button-carousel-write"
          >
            {write.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
            {write.isPending ? "Planning…" : "Plan with Claude"}
          </Button>
        </div>
        {!data.copy.ok && <div className="text-xs text-destructive">{data.copy.reason}</div>}

        <div className="border border-border rounded-sm p-3 flex flex-col md:flex-row md:items-center gap-3" data-testid="carousel-autopost">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <Instagram className="w-4 h-4" /> Auto-post
            </div>
            <div className="text-xs text-muted-foreground">
              Publishes the slides as images and makes an Instagram carousel post with your newest Instagram caption for this listing (write one under Copy, or
              "Plan with Claude" writes it).
            </div>
            {sent && (
              <div className={`text-xs mt-1 ${sent.error ? "text-destructive" : "text-muted-foreground"}`}>
                {sent.error ? `Not posted: ${sent.error}. It's saved in Marketing to retry. ` : sent.posted ? "Sent to the auto-poster. " : "Draft saved. "}
                <Link href="/admin/marketing" className="underline underline-offset-2 inline-flex items-center gap-0.5">
                  Open Marketing <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            <Button
              variant="outline"
              className="rounded-sm text-xs"
              onClick={() => social.mutate(false)}
              disabled={social.isPending || slides.length < 2}
              data-testid="button-carousel-draft"
            >
              {social.isPending && social.variables === false ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
              Save to Marketing
            </Button>
            <Button
              className="rounded-sm text-xs"
              onClick={() => {
                if (window.confirm(`Post this ${slides.length}-slide carousel to Instagram now?`)) social.mutate(true);
              }}
              disabled={social.isPending || slides.length < 2}
              data-testid="button-carousel-post"
            >
              {social.isPending && social.variables === true ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Instagram className="w-3.5 h-3.5 mr-1" />}
              Post to Instagram now
            </Button>
          </div>
        </div>
        {write.isPending && <div className="text-xs text-muted-foreground">Claude is looking through the photos and writing each slide. This takes up to a minute.</div>}

        <div className="flex gap-2 overflow-x-auto pb-1">
          {slides.map((_, i) => (
            <SlideThumb key={i} base={base} spec={spec} index={i} selected={i === cur} onSelect={() => setSelected(i)} />
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <div className="space-y-2">
            <SlidePreview base={base} spec={spec} index={cur} />
            <div className="flex flex-wrap justify-center gap-1.5">
              <Button size="sm" variant="outline" className="rounded-sm" onClick={() => move(-1)} disabled={cur === 0} aria-label="Move slide left">
                <ArrowLeft className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="outline" className="rounded-sm" onClick={() => move(1)} disabled={cur === slides.length - 1} aria-label="Move slide right">
                <ArrowRight className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="outline" className="rounded-sm text-xs" onClick={() => insert({ ...slides[cur] })} disabled={slides.length >= MAX_SLIDES}>
                <CopyPlus className="w-3.5 h-3.5 mr-1" /> Duplicate
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-sm text-xs"
                onClick={() => insert({ layout: "dark-list", eyebrow: "", headline: "New slide.", body: "", points: [], photos: [Math.min(cur + 1, Math.max(0, listing.photoCount - 1))] })}
                disabled={slides.length >= MAX_SLIDES}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add
              </Button>
              <Button size="sm" variant="outline" className="rounded-sm text-xs" onClick={downloadSlide}>
                <Download className="w-3.5 h-3.5 mr-1" /> PNG
              </Button>
              <Button size="sm" variant="ghost" className="rounded-sm text-muted-foreground" onClick={remove} disabled={slides.length <= 1} aria-label="Delete slide">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
          <SlideEditor key={`${version}-${cur}`} slide={slides[cur]} layouts={data.layouts} listing={listing} onChange={updateSlide} />
        </div>
      </CardContent>
    </Card>
  );
}
