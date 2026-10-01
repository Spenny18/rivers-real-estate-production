import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
// (Leaflet imports moved to @/components/neighbourhood-pois — only the
// shared component renders maps on this page now.)
import {
  Bed,
  Bath,
  Square,
  Calendar,
  Car,
  MapPin,
  ChevronLeft,
  ChevronRight,
  X,
  Phone,
  Mail,
  Calculator,
  Send,
  Maximize2,
  Check,
  Home as HomeIcon,
} from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { ListingCard } from "@/components/listing-card";
import { NeighbourhoodPois } from "@/components/neighbourhood-pois";
import { useAccount, useNote, useSaveNote, useRequestTour } from "@/lib/account";
import { Lock, FileText, CalendarPlus } from "lucide-react";
import { SeoHead } from "@/components/seo-head";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, apiUrl } from "@/lib/queryClient";
import {
  formatPrice,
  formatSqft,
  SPENCER_PHONE,
  SPENCER_PHONE_HREF,
  SPENCER_EMAIL,
} from "@/lib/format";
import type { PublicMlsListing, PublicMlsListingDetail } from "@/lib/mls-types";

const FALLBACK_HERO =
  "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=2400&h=1600&fit=crop";

const showingSchema = z.object({
  name: z.string().min(2, "Please share your name"),
  email: z.string().email("Please share a valid email"),
  phone: z.string().optional(),
  message: z.string().min(5, "A short note helps me prepare"),
});
type ShowingForm = z.infer<typeof showingSchema>;

export default function MlsDetailPage() {
  const [, params] = useRoute<{ id: string }>("/mls/:id");
  const id = params?.id;

  // Wouter preserves the window's scroll position during client-side route
  // changes. Always start a newly selected property at the top of its page.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [id]);

  const { data, isLoading } = useQuery<PublicMlsListingDetail>({
    queryKey: ["/api/public/mls", id],
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <PublicLayout>
        <div className="max-w-[1400px] mx-auto px-4 lg:px-8 py-10">
          <Skeleton className="aspect-[16/9] w-full rounded-sm" />
          <div className="mt-8 grid lg:grid-cols-[1fr_400px] gap-10">
            <div className="space-y-4">
              <Skeleton className="h-12 w-3/4" />
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
            <Skeleton className="h-96 w-full" />
          </div>
        </div>
      </PublicLayout>
    );
  }

  if (!data) {
    return (
      <PublicLayout>
        <div className="max-w-[1000px] mx-auto px-6 py-32 text-center">
          <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
            LISTING NOT FOUND
          </div>
          <h1 className="mt-4 font-serif text-4xl">
            This property is no longer available
          </h1>
          <p className="mt-4 text-muted-foreground">
            It may have been sold or removed from the MLS.
          </p>
          <Link href="/mls" className="inline-block mt-8 font-display text-[11px] tracking-[0.22em] underline">
              ← BROWSE ACTIVE LISTINGS
            
          </Link>
        </div>
      </PublicLayout>
    );
  }

  const seoTitle = `${data.fullAddress} - $${(data.listPrice / 1000).toFixed(0)}K | Luxury Homes Calgary`;
  const seoDesc = data.description
    ? data.description.replace(/<[^>]+>/g, "").replace(/&[#a-zA-Z0-9]+;/g, "").slice(0, 200)
    : `${data.beds ?? "—"} bed · ${data.baths ?? "—"} bath · ${data.sqft ? data.sqft.toLocaleString("en-CA") + " sqft" : ""} home for sale at ${data.fullAddress}, Calgary.`;
  const canonicalUrl = `https://riversrealestate.ca/mls/${data.seoSlug}`;
  const heroImg = data.heroImage ? (data.heroImage.startsWith("http") ? data.heroImage : `https://riversrealestate.ca${data.heroImage}`) : undefined;

  return (
    <>
      {/* Schema (RealEstateListing, breadcrumbs) is server-emitted by
          metaForPath — this only keeps title/meta current on SPA nav. */}
      <SeoHead
        title={seoTitle}
        description={seoDesc}
        canonical={canonicalUrl}
        ogImage={heroImg}
        ogType="article"
      />
      <MlsDetailBody listing={data} />
    </>
  );
}

// =============================================================================
// Forced sign-up gate. Blocks listing details until the visitor submits First
// name, Last name, and Email. The unlock is sticky per device (localStorage)
// so visitors aren't re-prompted on subsequent listings. Submission creates a
// Lead with source=listing_unlock so Spencer sees the inbound signal.
// =============================================================================
const UNLOCK_KEY = "rivers.listings.unlocked";

function isUnlocked(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

/** Shared unlock-state hook: portal sign-in OR pre-existing localStorage flag
 *  (set by anyone who filled out the legacy quick-unlock form). */
function useIsUnlocked(): boolean {
  const { data: account } = useAccount();
  const [hasLocal, setHasLocal] = useState<boolean>(() => isUnlocked());
  useEffect(() => {
    const sync = () => setHasLocal(isUnlocked());
    window.addEventListener("storage", sync);
    // Also poll on focus so a sign-in / unlock in another tab is picked up.
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);
  return Boolean(account) || hasLocal;
}

/** Soft gate — inline card that appears between the stats strip and the
 *  full content on /mls/:id. Anonymous users see the hero, address, price,
 *  beds/baths/sqft and the gate; the content underneath is rendered (for
 *  SEO crawlers) but visually blurred and non-interactive for humans.
 *  Two unlock paths: sign in to the portal (preferred) OR fill the quick
 *  form (creates a lead with source=listing_unlock, same as the old gate). */
function ListingSoftGate({ listingId }: { listingId: string }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!firstName.trim()) return setError("Please share your first name.");
    if (!lastName.trim()) return setError("Please share your last name.");
    if (!email.includes("@")) return setError("Please share a valid email.");
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/public/leads/unlock", {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        listingId,
      });
      try {
        window.localStorage.setItem(UNLOCK_KEY, "1");
        // Trigger the useIsUnlocked hook in the parent to re-read.
        window.dispatchEvent(new StorageEvent("storage", { key: UNLOCK_KEY }));
      } catch {}
      toast({ title: "Welcome — listings unlocked." });
    } catch (err: any) {
      setError(err?.message ?? "Couldn't submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="my-10 relative z-10 max-w-[640px] mx-auto bg-background border border-border shadow-xl"
      style={{ borderRadius: "2px" }}
      data-testid="soft-gate"
    >
      <div className="px-8 pt-8 pb-3 text-center">
        <div
          className="inline-flex items-center gap-2 font-display text-[11px] tracking-[0.22em] mb-3"
          style={{ color: "#D4AF37" }}
        >
          <Lock className="w-3 h-3" strokeWidth={1.8} />
          MEMBERS ONLY
        </div>
        <h2
          className="font-serif text-3xl text-foreground"
          style={{ letterSpacing: "-0.01em", lineHeight: 1.15 }}
        >
          See every detail.
        </h2>
        <p className="mt-3 text-sm text-muted-foreground leading-relaxed max-w-md mx-auto">
          Sign in for full photo gallery, walk score, property facts, location
          data, mortgage estimate, and to request a tour.
        </p>
      </div>

      {/* Primary CTA: portal sign-in */}
      <div className="px-8 pt-2 pb-2">
        <a
          href="/account/login"
          className="block w-full text-center rounded-sm h-11 leading-[44px] font-display tracking-[0.18em] text-[11px] text-white"
          style={{ background: "#0a0a0a" }}
          data-testid="btn-soft-gate-signin"
        >
          SIGN IN TO YOUR ACCOUNT
        </a>
      </div>

      <div className="flex items-center gap-3 px-8 my-4 text-[10px] tracking-[0.22em] text-muted-foreground">
        <div className="flex-1 border-t border-border" />
        <span>OR UNLOCK INSTANTLY</span>
        <div className="flex-1 border-t border-border" />
      </div>

      <form onSubmit={submit} className="px-8 pb-8 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="First name"
            className="rounded-sm h-11"
            autoComplete="given-name"
            required
          />
          <Input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
            className="rounded-sm h-11"
            autoComplete="family-name"
            required
          />
        </div>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Best email"
          className="rounded-sm h-11"
          autoComplete="email"
          required
        />
        {error && (
          <div className="text-xs text-destructive pt-1">{error}</div>
        )}
        <Button
          type="submit"
          disabled={submitting}
          className="w-full mt-2 rounded-sm h-11 font-display tracking-[0.18em] text-[11px]"
          style={{ background: "#23412d", color: "#fff" }}
        >
          {submitting ? "UNLOCKING…" : "UNLOCK THIS LISTING"}
        </Button>
        <p className="text-[10px] text-muted-foreground text-center pt-2 leading-relaxed">
          By continuing, you agree to receive occasional listing updates from
          Spencer Rivers. Unsubscribe anytime.
        </p>
      </form>
    </div>
  );
}

/** Portal-only inline panel: private notes on this property. Auto-saves
 *  on blur. Renders only for signed-in users (anonymous users don't see
 *  this — the soft gate is what they'll hit first). */
function NotesPanel({ mlsId }: { mlsId: string }) {
  const { data: account } = useAccount();
  const { data: note, isLoading } = useNote(mlsId);
  const save = useSaveNote();
  const [draft, setDraft] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const lastSyncedRef = useRef<string>("");
  useEffect(() => {
    if (note && note.note !== lastSyncedRef.current) {
      setDraft(note.note);
      lastSyncedRef.current = note.note;
    } else if (!note && lastSyncedRef.current === "") {
      setDraft("");
    }
  }, [note]);
  if (!account) return null;
  function onBlur() {
    if (draft === lastSyncedRef.current) return;
    save.mutate(
      { mlsId, note: draft.trim() },
      {
        onSuccess: () => {
          lastSyncedRef.current = draft.trim();
          setSavedFlash(true);
          setTimeout(() => setSavedFlash(false), 1800);
        },
      },
    );
  }
  return (
    <div className="mt-12">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xs tracking-[0.22em] text-muted-foreground inline-flex items-center gap-2">
          <FileText className="w-3 h-3" strokeWidth={1.8} /> YOUR PRIVATE NOTES
        </h2>
        {savedFlash && (
          <span className="font-display text-[10px] tracking-[0.22em] text-muted-foreground inline-flex items-center gap-1">
            <Check className="w-3 h-3" /> SAVED
          </span>
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={onBlur}
        placeholder={isLoading ? "Loading…" : "Jot down what stands out, questions to ask, or how this compares to others you're considering. Only you see this."}
        rows={5}
        className="mt-4 w-full rounded-sm border border-border bg-background p-4 text-[14px] leading-relaxed focus:outline-none focus:border-foreground transition-colors resize-y"
        data-testid="textarea-property-note"
      />
    </div>
  );
}

/** Portal-only inline panel: request a private tour. Native datetime-local
 *  input — Spencer reviews each request via /admin/calendar and confirms. */
function TourRequestPanel({ mlsId }: { mlsId: string }) {
  const { data: account } = useAccount();
  const requestTour = useRequestTour();
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  if (!account) return null;
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!when) return;
    const iso = new Date(when).toISOString();
    requestTour.mutate(
      { mlsId, preferredAt: iso, notes: notes.trim() || undefined },
      {
        onSuccess: () => {
          setSubmitted(true);
          setWhen("");
          setNotes("");
        },
      },
    );
  }
  if (submitted) {
    return (
      <div className="rounded-sm border border-border p-5">
        <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground inline-flex items-center gap-1">
          <Check className="w-3 h-3" /> TOUR REQUESTED
        </div>
        <div className="mt-3 font-serif text-xl">Spencer will be in touch.</div>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          Your request is in the queue. You'll get an email when Spencer
          confirms a time. Track status anytime under{" "}
          <a href="/account/tours" className="underline">your tours</a>.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-sm border border-border p-5">
      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground inline-flex items-center gap-2">
        <CalendarPlus className="w-3 h-3" strokeWidth={1.8} /> REQUEST A PRIVATE TOUR
      </div>
      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <div>
          <label className="block font-display text-[10px] tracking-[0.22em] text-muted-foreground mb-1.5">
            PREFERRED DATE / TIME
          </label>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            required
            min={new Date(Date.now() + 3600_000).toISOString().slice(0, 16)}
            className="w-full rounded-sm border border-border bg-background h-10 px-3 text-[14px] focus:outline-none focus:border-foreground"
            data-testid="input-tour-when"
          />
        </div>
        <div>
          <label className="block font-display text-[10px] tracking-[0.22em] text-muted-foreground mb-1.5">
            ANYTHING TO MENTION? (OPTIONAL)
          </label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Specific questions, accessibility needs, scheduling flexibility…"
            className="w-full rounded-sm border border-border bg-background p-3 text-[14px] resize-y focus:outline-none focus:border-foreground"
            data-testid="textarea-tour-notes"
          />
        </div>
        <Button
          type="submit"
          disabled={!when || requestTour.isPending}
          className="w-full rounded-sm h-11 font-display tracking-[0.18em] text-[11px]"
          data-testid="btn-request-tour"
        >
          {requestTour.isPending ? "SENDING…" : "REQUEST TOUR"}
        </Button>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Spencer reviews every request personally and replies within one
          business day to confirm a time that works for both of you.
        </p>
      </form>
    </div>
  );
}

function MlsDetailBody({ listing }: { listing: PublicMlsListingDetail }) {
  const status = (listing.status ?? "").toLowerCase();
  const isSold = status === "sold";
  const isPending = status === "pending" || status === "conditional";
  // Soft-gate state: signed-in portal users + legacy quick-unlock users
  // see the full page. Everyone else gets a gated preview.
  const isPageUnlocked = useIsUnlocked();
  const { data: portalAccount } = useAccount();

  const gallery = useMemo(() => {
    // For RETS-sourced listings (those with photoCount), construct photo URLs
    // for every available photo. The proxy route returns 404 if a photo can't
    // be fetched and onError falls back to the placeholder.
    if (listing.photoCount && listing.photoCount > 0 && listing.id) {
      const max = Math.min(listing.photoCount, 30); // cap to avoid huge galleries
      const urls: string[] = [];
      for (let i = 0; i < max; i++) {
        urls.push(apiUrl(`/api/mls/${listing.id}/photo/${i}`));
      }
      return urls;
    }
    const arr = Array.isArray(listing.gallery) ? listing.gallery : [];
    if (listing.heroImage && !arr.includes(listing.heroImage)) {
      return [apiUrl(listing.heroImage), ...arr];
    }
    if (arr.length === 0 && listing.heroImage) return [apiUrl(listing.heroImage)];
    if (arr.length === 0) return [FALLBACK_HERO];
    return arr;
  }, [listing.gallery, listing.heroImage, listing.photoCount, listing.id]);

  const features = Array.isArray(listing.features) ? listing.features : [];
  const similar = Array.isArray(listing.similar) ? listing.similar : [];

  const [photoIdx, setPhotoIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Reset photo index if listing changes
  useEffect(() => {
    setPhotoIdx(0);
  }, [listing.id]);

  return (
    <PublicLayout>
      {/* Breadcrumb */}
      <div className="max-w-[1400px] mx-auto px-4 lg:px-8 pt-6">
        <Link href="/mls" className="inline-flex items-center gap-1.5 font-display text-[11px] tracking-[0.22em] text-muted-foreground hover:text-foreground"
            data-testid="link-back-to-search">
            <ChevronLeft className="w-3 h-3" strokeWidth={1.8} />
            BACK TO SEARCH
          
        </Link>
      </div>

      {/* Gallery */}
      <section className="max-w-[1400px] mx-auto px-4 lg:px-8 mt-4">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-2 lg:gap-3">
          {/* Main image */}
          <button
            className="relative col-span-1 lg:col-span-3 aspect-[16/10] overflow-hidden rounded-sm bg-secondary group"
            onClick={() => setLightboxOpen(true)}
            data-testid="button-open-lightbox"
          >
            <img
              src={gallery[0] || FALLBACK_HERO}
              alt={listing.fullAddress}
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.02]"
              onError={(e) => {
                (e.target as HTMLImageElement).src = FALLBACK_HERO;
              }}
            />
            {(isSold || isPending) && (
              <div className="absolute top-4 left-4 px-3 py-1.5 bg-black text-white font-display text-[11px] tracking-[0.22em]">
                {isSold ? "SOLD" : "PENDING"}
              </div>
            )}
            <div className="absolute bottom-4 right-4 inline-flex items-center gap-2 px-3 py-1.5 bg-black/70 backdrop-blur text-white font-display text-[10px] tracking-[0.22em]">
              <Maximize2 className="w-3 h-3" strokeWidth={1.8} />
              {gallery.length} PHOTOS
            </div>
          </button>

          {/* Thumb strip */}
          <div className="hidden lg:grid grid-rows-3 gap-3">
            {[1, 2, 3].map((i) => (
              <button
                key={i}
                onClick={() => {
                  setPhotoIdx(i);
                  setLightboxOpen(true);
                }}
                className="relative aspect-[4/3] overflow-hidden rounded-sm bg-secondary group"
                data-testid={`button-gallery-thumb-${i}`}
              >
                <img
                  src={gallery[i] || gallery[0] || FALLBACK_HERO}
                  alt={`${listing.fullAddress} photo ${i + 1}`}
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = FALLBACK_HERO;
                  }}
                />
                {i === 3 && gallery.length > 4 && (
                  <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px] flex items-center justify-center text-white font-display text-sm tracking-[0.18em]">
                    + {gallery.length - 4} MORE
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Header / vitals */}
      <section className="max-w-[1400px] mx-auto px-4 lg:px-8 mt-10">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-10">
          <div>
            <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground inline-flex items-center gap-2">
              <MapPin className="w-3 h-3" strokeWidth={1.8} />
              {(listing.neighbourhood || listing.city).toUpperCase()} · MLS #{" "}
              {listing.mlsNumber}
            </div>
            <h1
              className="mt-3 font-serif text-[40px] lg:text-[56px] leading-[1.05] text-foreground"
              data-testid="text-listing-address"
            >
              {listing.fullAddress}
            </h1>
            <div
              className="mt-5 font-serif text-[34px] lg:text-[44px] tabular-nums"
              data-testid="text-listing-price"
            >
              {formatPrice(listing.listPrice)}
            </div>

            <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-y-5 gap-x-4 border-t border-b border-border py-6">
              <Stat icon={Bed} label="Beds" value={String(listing.beds)} />
              <Stat icon={Bath} label="Baths" value={String(listing.baths)} />
              <Stat
                icon={Square}
                label="Interior"
                value={listing.sqft ? formatSqft(listing.sqft) : "—"}
              />
              <Stat
                icon={Calendar}
                label="Built"
                value={listing.yearBuilt ? String(listing.yearBuilt) : "—"}
              />
            </div>

            {/* Soft gate (appears between stats and the rest of the content
                when the visitor is not signed in or quick-unlocked). Full
                content is still rendered below — visually blurred — so
                Googlebot can index everything for SEO. */}
            {!isPageUnlocked && <ListingSoftGate listingId={listing.id} />}

            <div
              className={
                isPageUnlocked
                  ? ""
                  : "filter blur-[6px] select-none pointer-events-none transition"
              }
              aria-hidden={!isPageUnlocked || undefined}
            >
            {/* Description */}
            {listing.description && (
              <div className="mt-10">
                <h2 className="font-display text-xs tracking-[0.22em] text-muted-foreground">
                  ABOUT THIS PROPERTY
                </h2>
                <div className="mt-4 prose prose-neutral dark:prose-invert max-w-none text-[15px] leading-[1.75] text-foreground/85 whitespace-pre-line">
                  {listing.description}
                </div>
              </div>
            )}

            {/* Portal-only: private notes panel. Only renders when the user
                is signed in via the account portal. */}
            {portalAccount && <NotesPanel mlsId={listing.id} />}

            {/* Property facts */}
            <div className="mt-12">
              <h2 className="font-display text-xs tracking-[0.22em] text-muted-foreground">
                PROPERTY FACTS
              </h2>
              <dl className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-3 text-[14px]">
                <Fact label="Property type" value={listing.propertyType} />
                {listing.propertySubType && (
                  <Fact label="Style" value={listing.propertySubType} />
                )}
                <Fact label="Status" value={listing.status} />
                {listing.bedsAbove != null && (
                  <Fact
                    label="Beds above grade"
                    value={String(listing.bedsAbove)}
                  />
                )}
                {listing.bedsBelow != null && listing.bedsBelow > 0 && (
                  <Fact
                    label="Beds below grade"
                    value={String(listing.bedsBelow)}
                  />
                )}
                {listing.halfBaths != null && listing.halfBaths > 0 && (
                  <Fact
                    label="Half baths"
                    value={String(listing.halfBaths)}
                  />
                )}
                {listing.sqftBelow && (
                  <Fact
                    label="Below-grade sqft"
                    value={formatSqft(listing.sqftBelow)}
                  />
                )}
                {listing.lotSize && (
                  <Fact label="Lot size" value={listing.lotSize} />
                )}
                {listing.parking && (
                  <Fact label="Parking" value={listing.parking} />
                )}
                {listing.garageSpaces != null && (
                  <Fact
                    label="Garage spaces"
                    value={String(listing.garageSpaces)}
                  />
                )}
                {listing.daysOnMarket != null && (
                  <Fact
                    label="Days on market"
                    value={String(listing.daysOnMarket)}
                  />
                )}
                {listing.postalCode && (
                  <Fact label="Postal code" value={listing.postalCode} />
                )}
              </dl>
            </div>

            {/* Features */}
            {features.length > 0 && (
              <div className="mt-12">
                <h2 className="font-display text-xs tracking-[0.22em] text-muted-foreground">
                  FEATURES
                </h2>
                <ul className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-y-2.5 gap-x-8 text-[14px]">
                  {features.map((f, i) => (
                    <li
                      key={i}
                      className="inline-flex items-start gap-2.5 text-foreground/85"
                    >
                      <Check
                        className="w-4 h-4 mt-0.5 shrink-0 text-foreground/60"
                        strokeWidth={1.8}
                      />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Mortgage calculator */}
            <MortgageCalculator price={listing.listPrice} />

            {/* Map + POIs (schools, restaurants, parks, transit) */}
            {listing.lat != null && listing.lng != null && (
              <NeighbourhoodPois
                lat={listing.lat}
                lng={listing.lng}
                poiUrl={`/api/mls/${listing.id}/pois`}
                cacheKey={`mls:${listing.id}`}
              />
            )}

            {/* Listing source */}
            <div className="mt-12 pt-6 border-t border-border text-[11px] text-muted-foreground font-display tracking-[0.18em]">
              {listing.listOffice ? (
                <>LISTED BY {listing.listOffice.toUpperCase()}</>
              ) : (
                <>LISTED VIA PILLAR 9 MLS</>
              )}
              {listing.source === "rets" && (
                <span className="ml-3">· LIVE FROM PILLAR 9</span>
              )}
            </div>
            </div>{/* /soft-gate blur wrapper for left column */}
          </div>

          {/* Right column: contact / showing — also gated for anon users so
              the contact form doesn't capture before the user signs in. */}
          <aside
            className={`space-y-6 lg:sticky lg:top-28 self-start ${
              isPageUnlocked ? "" : "filter blur-[6px] select-none pointer-events-none"
            }`}
            aria-hidden={!isPageUnlocked || undefined}
          >
            <ContactCard listing={listing} />
            {/* Signed-in portal users get the structured tour-request form
                that creates a row in /account/tours. Everyone else (legacy
                quick-unlock users) sees the existing showing form which
                creates a lead via /api/contact. */}
            {portalAccount ? (
              <TourRequestPanel mlsId={listing.id} />
            ) : (
              <ShowingForm listing={listing} />
            )}
          </aside>
        </div>
      </section>

      {/* Similar listings */}
      {similar.length > 0 && (
        <section className="max-w-[1400px] mx-auto px-4 lg:px-8 mt-24 mb-20">
          <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
            SIMILAR PROPERTIES
          </div>
          <h2 className="mt-3 font-serif text-3xl lg:text-4xl">
            Other homes worth seeing
          </h2>
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {similar.map((s) => (
              <ListingCard key={s.id} listing={s} variant="compact" />
            ))}
          </div>
        </section>
      )}

      {/* Lightbox */}
      {lightboxOpen && (
        <Lightbox
          images={gallery}
          startIdx={photoIdx}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </PublicLayout>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: any;
  label: string;
  value: string;
}) {
  return (
    <div data-testid={`stat-${label.toLowerCase()}`}>
      <div className="inline-flex items-center gap-2 text-muted-foreground">
        <Icon className="w-4 h-4" strokeWidth={1.5} />
        <span className="font-display text-[10px] tracking-[0.22em]">
          {label.toUpperCase()}
        </span>
      </div>
      <div className="mt-1.5 font-serif text-2xl tabular-nums">{value}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 pb-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

function ContactCard({ listing }: { listing: PublicMlsListing }) {
  return (
    <div className="border border-border rounded-sm p-6 bg-card">
      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
        SHOWN BY
      </div>
      <div className="mt-2 font-serif text-2xl">Spencer Rivers</div>
      <div className="text-[12px] text-muted-foreground mt-1">
        REALTOR® · Rivers Real Estate
      </div>
      <div className="mt-5 space-y-2.5">
        <a
          href={SPENCER_PHONE_HREF}
          className="flex items-center gap-3 px-3 py-3 border border-border rounded-sm hover:bg-secondary/50 transition-colors text-[14px]"
          data-testid="link-detail-call"
        >
          <Phone className="w-4 h-4" strokeWidth={1.6} />
          {SPENCER_PHONE}
        </a>
        <a
          href={`mailto:${SPENCER_EMAIL}?subject=${encodeURIComponent(
            `MLS ${listing.mlsNumber} · ${listing.fullAddress}`,
          )}`}
          className="flex items-center gap-3 px-3 py-3 border border-border rounded-sm hover:bg-secondary/50 transition-colors text-[14px]"
          data-testid="link-detail-email"
        >
          <Mail className="w-4 h-4" strokeWidth={1.6} />
          {SPENCER_EMAIL}
        </a>
      </div>
    </div>
  );
}

function ShowingForm({ listing }: { listing: PublicMlsListing }) {
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<ShowingForm>({
    resolver: zodResolver(showingSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      message: `I'd like to see ${listing.fullAddress} (MLS ${listing.mlsNumber}). When could we set up a private showing?`,
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: ShowingForm) => {
      const r = await apiRequest("POST", "/api/inquiry", {
        ...data,
        source: "Listing detail · showing request",
      });
      return r.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      toast({
        title: "Showing request sent",
        description: "Spencer will reach out within the day.",
      });
      form.reset();
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't send",
        description: err?.message ?? "Please try again or call directly.",
        variant: "destructive",
      });
    },
  });

  if (submitted) {
    return (
      <div className="border border-border rounded-sm p-6 bg-card">
        <div className="w-10 h-10 rounded-full bg-foreground text-background flex items-center justify-center">
          <Check className="w-5 h-5" strokeWidth={2} />
        </div>
        <div className="mt-4 font-serif text-2xl">Request received</div>
        <p className="mt-2 text-[14px] text-muted-foreground leading-relaxed">
          Thanks for reaching out about {listing.fullAddress}. Spencer will be
          in touch within the day to confirm a time.
        </p>
        <a
          href={SPENCER_PHONE_HREF}
          className="mt-5 inline-flex items-center gap-2 font-display text-[10px] tracking-[0.22em] underline"
        >
          <Phone className="w-3 h-3" strokeWidth={1.8} />
          OR CALL DIRECTLY
        </a>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-sm p-6 bg-card">
      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
        REQUEST A SHOWING
      </div>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit((d) => mutation.mutate(d))}
          className="mt-4 space-y-3"
          data-testid="form-showing-request"
        >
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    placeholder="Your name"
                    {...field}
                    data-testid="input-showing-name"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    placeholder="Email"
                    type="email"
                    {...field}
                    data-testid="input-showing-email"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    placeholder="Phone (optional)"
                    {...field}
                    data-testid="input-showing-phone"
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="message"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    rows={4}
                    placeholder="What works for you?"
                    {...field}
                    data-testid="textarea-showing-message"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="submit"
            className="w-full h-11 rounded-sm gap-2"
            disabled={mutation.isPending}
            data-testid="button-submit-showing"
          >
            <Send className="w-4 h-4" strokeWidth={1.8} />
            {mutation.isPending ? "Sending…" : "Request showing"}
          </Button>
        </form>
      </Form>
    </div>
  );
}

function MortgageCalculator({ price }: { price: number }) {
  const [downPct, setDownPct] = useState(20);
  const [rate, setRate] = useState(5.25);
  const [years, setYears] = useState(25);

  const downPayment = (price * downPct) / 100;
  const principal = price - downPayment;
  const r = rate / 100 / 12;
  const n = years * 12;
  const monthly =
    r === 0 ? principal / n : (principal * r) / (1 - Math.pow(1 + r, -n));

  const totalInterest = monthly * n - principal;
  const totalPaid = monthly * n + downPayment;

  return (
    <div className="mt-12">
      <div className="inline-flex items-center gap-2 font-display text-xs tracking-[0.22em] text-muted-foreground">
        <Calculator className="w-3.5 h-3.5" strokeWidth={1.6} />
        MORTGAGE ESTIMATE
      </div>
      <div className="mt-5 border border-border rounded-sm p-6 lg:p-8 grid grid-cols-1 md:grid-cols-[1fr_280px] gap-8">
        <div className="space-y-7">
          <SliderRow
            label="Down payment"
            value={`${downPct}% · ${formatPrice(downPayment)}`}
            slider={
              <Slider
                value={[downPct]}
                min={5}
                max={50}
                step={1}
                onValueChange={(v) => setDownPct(v[0])}
                data-testid="slider-down-payment"
              />
            }
          />
          <SliderRow
            label="Interest rate"
            value={`${rate.toFixed(2)} %`}
            slider={
              <Slider
                value={[rate]}
                min={1}
                max={10}
                step={0.05}
                onValueChange={(v) => setRate(v[0])}
                data-testid="slider-interest-rate"
              />
            }
          />
          <SliderRow
            label="Amortization"
            value={`${years} years`}
            slider={
              <Slider
                value={[years]}
                min={5}
                max={30}
                step={1}
                onValueChange={(v) => setYears(v[0])}
                data-testid="slider-years"
              />
            }
          />
        </div>

        <div className="bg-foreground text-background p-6 rounded-sm flex flex-col justify-center">
          <div className="font-display text-[10px] tracking-[0.22em] text-background/65">
            ESTIMATED MONTHLY
          </div>
          <div
            className="mt-2 font-serif text-4xl tabular-nums"
            data-testid="text-monthly-payment"
          >
            ${Math.round(monthly).toLocaleString("en-CA")}
          </div>
          <div className="mt-5 pt-5 border-t border-background/20 space-y-2 text-[12px] text-background/75">
            <div className="flex justify-between">
              <span>Principal</span>
              <span className="tabular-nums">{formatPrice(principal)}</span>
            </div>
            <div className="flex justify-between">
              <span>Total interest</span>
              <span className="tabular-nums">
                ${Math.round(totalInterest).toLocaleString("en-CA")}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Total paid</span>
              <span className="tabular-nums">
                ${Math.round(totalPaid).toLocaleString("en-CA")}
              </span>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground max-w-2xl leading-relaxed">
        Estimate only. Property tax, insurance, condo fees, and HELOC products
        not included. Connect with your lender for a real pre-approval.
      </p>
    </div>
  );
}

function SliderRow({
  label,
  value,
  slider,
}: {
  label: string;
  value: string;
  slider: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
          {label.toUpperCase()}
        </div>
        <div className="font-serif text-base tabular-nums">{value}</div>
      </div>
      <div className="mt-3">{slider}</div>
    </div>
  );
}

function Lightbox({
  images,
  startIdx,
  onClose,
}: {
  images: string[];
  startIdx: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIdx);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIdx((i) => (i - 1 + images.length) % images.length);
      if (e.key === "ArrowRight") setIdx((i) => (i + 1) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length, onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/95 backdrop-blur flex items-center justify-center"
      data-testid="gallery-lightbox"
    >
      <button
        onClick={onClose}
        className="absolute top-5 right-5 text-white/85 hover:text-white p-2"
        aria-label="Close"
        data-testid="button-close-lightbox"
      >
        <X className="w-6 h-6" strokeWidth={1.6} />
      </button>
      <button
        onClick={() => setIdx((i) => (i - 1 + images.length) % images.length)}
        className="absolute left-3 lg:left-8 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-3 rounded-full bg-white/5 hover:bg-white/10"
        aria-label="Previous"
        data-testid="button-lightbox-prev"
      >
        <ChevronLeft className="w-6 h-6" strokeWidth={1.5} />
      </button>
      <button
        onClick={() => setIdx((i) => (i + 1) % images.length)}
        className="absolute right-3 lg:right-8 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-3 rounded-full bg-white/5 hover:bg-white/10"
        aria-label="Next"
        data-testid="button-lightbox-next"
      >
        <ChevronRight className="w-6 h-6" strokeWidth={1.5} />
      </button>
      <img
        src={images[idx]}
        alt={`Photo ${idx + 1}`}
        className="max-w-[95vw] max-h-[88vh] object-contain"
        onError={(e) => {
          (e.target as HTMLImageElement).src = FALLBACK_HERO;
        }}
      />
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 font-display text-[11px] tracking-[0.22em] text-white/70 tabular-nums">
        {idx + 1} / {images.length}
      </div>
    </div>
  );
}
