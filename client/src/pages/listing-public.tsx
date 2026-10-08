import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Logo } from "@/components/logo";
import { NeighbourhoodMap } from "@/components/neighbourhood-map";
import {
  Bed,
  Bath,
  Maximize,
  CalendarDays,
  Phone,
  Mail,
  ArrowLeft,
  Check,
  Heart,
  Share2,
  Calendar,
  Loader2,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatPrice, getAmenitiesAround } from "@/lib/mock-data";
import type { PublicListing } from "@/lib/types";
import NotFound from "./not-found";
import { PrivacyNote } from "@/components/privacy-link";


export default function ListingPublicPage() {
  const [, params] = useRoute("/p/:slug");
  const slug = params?.slug ?? "";
  const { toast } = useToast();

  const { data: listing, isLoading, error } = useQuery<PublicListing>({
    queryKey: ["/api/listings/by-slug", slug],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/listings/by-slug/${slug}`);
      return res.json();
    },
    enabled: !!slug,
  });

  // Inquiry form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const inquiryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/inquiry", {
        listingId: listing?.id,
        name,
        email,
        phone: phone || undefined,
        message,
        source: "Property page",
      });
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      setName("");
      setEmail("");
      setPhone("");
      setMessage("");
      toast({
        title: "Message received",
        description: "Spencer typically responds within an hour. Chat soon.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not send",
        description: err?.message || "Please try again or call Spencer directly.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !listing) return <NotFound />;

  const amenities = getAmenitiesAround(listing.lat, listing.lng, listing.neighbourhood);
  const allImages = [listing.heroImage, ...(listing.gallery || [])];

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-30 bg-background/85 backdrop-blur border-b border-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
          <Link href="/" data-testid="link-home" className="flex items-center gap-3">
              <Logo />
              <span className="hidden md:inline-flex items-center text-xs text-muted-foreground gap-1.5 ml-2 pl-3 border-l border-border eyebrow">
                Luxury Homes Calgary
              </span>
            
          </Link>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="rounded-full" data-testid="button-favorite">
              <Heart className="w-4 h-4 mr-1.5" /> Save
            </Button>
            <Button variant="ghost" size="sm" className="rounded-full" data-testid="button-share">
              <Share2 className="w-4 h-4 mr-1.5" /> Share
            </Button>
            <a href="#inquire" data-testid="link-inquire-header">
              <Button size="sm" className="rounded-full hidden md:inline-flex">
                <Calendar className="w-4 h-4 mr-1.5" /> Request a private tour
              </Button>
            </a>
          </div>
        </div>
      </header>

      {/* Hero gallery */}
      <section className="max-w-7xl mx-auto px-6 lg:px-10 pt-6">
        <div className="grid grid-cols-4 gap-2 rounded-2xl overflow-hidden h-[440px] sm:h-[520px]">
          <div className="col-span-4 sm:col-span-2 row-span-2 relative bg-secondary">
            <img
              src={listing.heroImage}
              alt={listing.title}
              className="w-full h-full object-cover"
            />
          </div>
          {allImages.slice(1, 5).map((img, i) => (
            <div key={i} className="hidden sm:block relative bg-secondary">
              <img src={img} alt="" className="w-full h-full object-cover" />
              {i === 3 && allImages.length > 5 && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-sm font-medium">
                  +{allImages.length - 5} photos
                </div>
              )}
            </div>
          ))}
          {allImages.length < 5 &&
            Array.from({ length: 4 - (allImages.length - 1) }).map((_, i) => (
              <div
                key={`pl-${i}`}
                className="hidden sm:block bg-gradient-to-br from-secondary to-muted"
              />
            ))}
        </div>
      </section>

      {/* Title */}
      <section className="max-w-7xl mx-auto px-6 lg:px-10 mt-8">
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <div className="eyebrow">
              {listing.neighbourhood} · {listing.city}
            </div>
            <h1
              className="font-serif text-foreground mt-1"
              style={{
                fontSize: "clamp(2rem, 1.5rem + 2vw, 3.25rem)",
                letterSpacing: "-0.02em",
                lineHeight: 1.05,
              }}
              data-testid="text-listing-title"
            >
              {listing.title}
            </h1>
            <p className="text-muted-foreground mt-2 text-base">{listing.address}</p>
          </div>
          <div className="text-right">
            <div className="eyebrow">Asking</div>
            <div
              className="font-serif text-4xl tabular-nums text-foreground"
              style={{ letterSpacing: "-0.02em" }}
              data-testid="text-listing-price"
            >
              {formatPrice(listing.price)}
            </div>
          </div>
        </div>

        {/* Quick stats */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden border border-border">
          {[
            { icon: Bed, label: "Bedrooms", value: listing.beds },
            { icon: Bath, label: "Bathrooms", value: listing.baths },
            { icon: Maximize, label: "Square feet", value: listing.sqft.toLocaleString() },
            { icon: CalendarDays, label: "Year built", value: listing.yearBuilt },
          ].map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="bg-card p-5 flex items-center gap-3">
                <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
                <div>
                  <div className="eyebrow">{s.label}</div>
                  <div className="font-serif text-xl tabular-nums" style={{ letterSpacing: "-0.01em" }}>
                    {s.value}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Body */}
      <section className="max-w-7xl mx-auto px-6 lg:px-10 mt-12 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-10">
        <div className="space-y-12">
          {/* Description */}
          <div>
            <h2 className="font-display text-sm tracking-[0.22em] text-foreground mb-4">
              ABOUT THIS HOME
            </h2>
            <p className="text-base leading-relaxed text-foreground/90 max-w-2xl whitespace-pre-line">
              {listing.description}
            </p>
          </div>

          {/* Features */}
          {listing.features && listing.features.length > 0 && (
            <div>
              <h2 className="font-display text-sm tracking-[0.22em] text-foreground mb-4">
                FEATURES & FINISHES
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2.5 gap-x-6 max-w-2xl">
                {listing.features.map((f, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <div className="w-5 h-5 rounded-full bg-foreground/5 border border-border flex items-center justify-center mt-0.5 shrink-0">
                      <Check className="w-3 h-3 text-foreground" />
                    </div>
                    <span className="text-sm">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Neighbourhood */}
          <div>
            <h2 className="font-display text-sm tracking-[0.22em] text-foreground mb-1">
              THE NEIGHBOURHOOD
            </h2>
            <p className="text-sm text-muted-foreground mb-5 max-w-xl mt-3">
              {neighbourhoodBlurb(listing.neighbourhood)}
            </p>
            <NeighbourhoodMap
              amenities={amenities}
              centerLat={listing.lat}
              centerLng={listing.lng}
              propertyAddress={listing.address}
            />
          </div>

          {/* CTA strip */}
          <div
            id="inquire"
            className="rounded-2xl bg-foreground text-background p-8 md:p-10"
          >
            <div className="grid md:grid-cols-2 gap-6 items-center">
              <div>
                <div className="eyebrow opacity-60 text-background">Private showings</div>
                <h3
                  className="font-serif text-2xl mt-2 text-background"
                  style={{ letterSpacing: "-0.01em" }}
                >
                  Tour this home
                </h3>
                <p className="text-sm opacity-80 mt-2 max-w-md text-background">
                  In-person or virtual. I typically respond within the hour.
                  Send a note below or call or text me directly at (403) 966-9237.
                </p>
                <p className="text-xs opacity-60 mt-4 italic font-serif text-background">
                  "No one pays full price for a stale donut."
                </p>
              </div>
              <div className="rounded-xl bg-background/5 border border-background/15 p-5">
                <div className="text-xs uppercase tracking-[0.18em] text-background/70 mb-3">
                  Contact Spencer
                </div>
                <div className="space-y-2 text-background">
                  <a
                    href="tel:+14039669237"
                    className="flex items-center gap-2 text-sm hover:opacity-80"
                  >
                    <Phone className="w-4 h-4" />
                    (403) 966-9237
                  </a>
                  <a
                    href="mailto:spencer@riversrealestate.ca"
                    className="flex items-center gap-2 text-sm hover:opacity-80"
                  >
                    <Mail className="w-4 h-4" />
                    spencer@riversrealestate.ca
                  </a>
                  <div className="flex items-center gap-2 text-sm opacity-70">
                    <Calendar className="w-4 h-4" />
                    Mon – Sat, by appointment
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar — agent + contact form */}
        <aside className="lg:sticky lg:top-24 self-start space-y-4">
          <div className="rounded-2xl bg-card border border-card-border overflow-hidden">
            <div className="p-5 flex items-center gap-3 border-b border-border">
              <Avatar className="w-12 h-12">
                <AvatarFallback className="bg-foreground text-background font-display text-xs">
                  SR
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">Spencer Rivers</div>
                <div className="text-xs text-muted-foreground">
                  REALTOR® | CLHMS, CIPS
                </div>
                <div className="text-xs text-muted-foreground">
                  Rivers Real Estate · Synterra Realty
                </div>
              </div>
            </div>

            {submitted ? (
              <div className="p-5 text-center space-y-2">
                <div className="w-10 h-10 rounded-full bg-foreground text-background flex items-center justify-center mx-auto">
                  <Check className="w-5 h-5" />
                </div>
                <div className="font-serif text-base">Message received</div>
                <p className="text-xs text-muted-foreground">
                  I'll be in touch shortly.
                  <br />
                  Contact Spencer 🤵
                  <br />
                  <span className="font-serif italic">— Spencer</span>
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full text-xs mt-2"
                  onClick={() => setSubmitted(false)}
                  data-testid="button-send-another"
                >
                  Send another message
                </Button>
              </div>
            ) : (
              <form
                className="p-5 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name || !email || !message) {
                    toast({
                      title: "Missing details",
                      description: "Name, email, and a short message please.",
                      variant: "destructive",
                    });
                    return;
                  }
                  inquiryMutation.mutate();
                }}
              >
                <div className="eyebrow">Request more information</div>
                <div className="space-y-2.5">
                  <div>
                    <Label className="text-xs">Full name</Label>
                    <Input
                      placeholder="Your name"
                      className="mt-1"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      data-testid="input-contact-name"
                      required
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Email</Label>
                    <Input
                      type="email"
                      placeholder="you@email.com"
                      className="mt-1"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      data-testid="input-contact-email"
                      required
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Phone (optional)</Label>
                    <Input
                      placeholder="(403) 555-0000"
                      className="mt-1"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      data-testid="input-contact-phone"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Message</Label>
                    <Textarea
                      rows={3}
                      placeholder={`I'd like to know more about ${listing.title}…`}
                      className="mt-1"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      data-testid="input-contact-message"
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full rounded-full"
                    disabled={inquiryMutation.isPending}
                    data-testid="button-send-inquiry"
                  >
                    {inquiryMutation.isPending ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        Sending
                      </>
                    ) : (
                      "Send inquiry"
                    )}
                  </Button>
                  <PrivacyNote className="text-center" />
                </div>
              </form>
            )}

            <div className="px-5 py-3 border-t border-border bg-secondary/30 flex items-center justify-around text-xs">
              <a
                href="tel:+14039669237"
                className="flex items-center gap-1.5 hover:text-foreground text-muted-foreground transition-colors"
                data-testid="link-call"
              >
                <Phone className="w-3 h-3" /> Call
              </a>
              <a
                href="mailto:spencer@riversrealestate.ca"
                className="flex items-center gap-1.5 hover:text-foreground text-muted-foreground transition-colors"
                data-testid="link-email"
              >
                <Mail className="w-3 h-3" /> Email
              </a>
              <a
                href="#inquire"
                className="flex items-center gap-1.5 hover:text-foreground text-muted-foreground transition-colors"
              >
                <Calendar className="w-3 h-3" /> Tour
              </a>
            </div>
          </div>

          <div className="rounded-2xl bg-secondary/40 border border-border p-5 text-xs text-muted-foreground">
            <div className="text-foreground font-medium text-sm mb-1 font-serif">
              Listed by Rivers Real Estate
            </div>
            Independently owned and operated under Synterra Realty.
            Square footage approximate. Information from sources deemed reliable but not guaranteed.
          </div>
        </aside>
      </section>

      <footer className="mt-20 border-t border-border py-8 text-center text-xs text-muted-foreground">
        © 2026 Rivers Real Estate · Calgary, AB ·{" "}
        <a
          href="https://riversrealestate.ca"
          className="hover:text-foreground transition-colors"
        >
          riversrealestate.ca
        </a>
      </footer>
    </div>
  );
}

function neighbourhoodBlurb(name: string): string {
  const map: Record<string, string> = {
    "Springbank Hill":
      "Springbank Hill sits on Calgary's western ridge — newer estate homes on larger lots, quick access to Aspen Landing and Highway 8 toward the mountains.",
    "Aspen Woods":
      "Aspen Woods is the city's young-luxury anchor in the southwest — Webber Academy, Aspen Landing, and walkable to the Calgary Academy corridor.",
    "Upper Mount Royal":
      "Upper Mount Royal is Calgary's traditional address — mature trees, character estates, and a five-minute reach to 17th Avenue and downtown.",
    "Elbow Park":
      "Elbow Park curves along the river south of downtown — stately family homes, the Glencoe Club, and one of the city's most established school catchments.",
    "Britannia":
      "Britannia is a small bluff-top enclave above the Elbow River — unobstructed downtown views and the Britannia Plaza shops at its centre.",
    "Bel-Aire":
      "Bel-Aire is Calgary's smallest luxury enclave — fewer than 200 homes overlooking the Glenmore Reservoir, neighbouring Mayfair and the Calgary Golf & Country Club.",
  };
  return (
    map[name] ||
    `${name} is one of Calgary's most established luxury communities — distinct character, mature streetscapes, and quiet proximity to the city's best schools and amenities.`
  );
}
