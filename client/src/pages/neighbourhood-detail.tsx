import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, Marker, Polygon, useMap } from "react-leaflet";
import { useEffect } from "react";
import type * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ArrowRight, ChevronLeft, MapPin, Home as HomeIcon } from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { ListingCard } from "@/components/listing-card";
import { FaqAccordion } from "@/components/faq-accordion";
import { NeighbourhoodPois } from "@/components/neighbourhood-pois";
import { ClientOnly } from "@/components/client-only";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatPriceCompact } from "@/lib/format";
import {
  parseJsonArray,
  type PublicNeighbourhoodDetail,
} from "@/lib/mls-types";
import {
  RIVERS_TILE_URL,
  RIVERS_TILE_SUBDOMAINS,
  RIVERS_TILE_ATTRIBUTION,
  buildPricePill,
  buildSubjectPin,
  FitBoundsOnce,
} from "@/components/rivers-map";
import { SeoHead } from "@/components/seo-head";
import { mlsPropertyPath } from "@shared/mls-url";

export default function NeighbourhoodDetailPage() {
  const [, params] = useRoute<{ slug: string }>("/neighbourhoods/:slug");
  const slug = params?.slug;

  const { data, isLoading } = useQuery<PublicNeighbourhoodDetail>({
    queryKey: ["/api/public/neighbourhoods", slug],
    enabled: !!slug,
  });

  if (isLoading) {
    return (
      <PublicLayout>
        <Skeleton className="h-[60vh] w-full" />
        <div className="max-w-[1200px] mx-auto px-6 py-12 space-y-4">
          <Skeleton className="h-12 w-2/3" />
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PublicLayout>
    );
  }

  if (!data) {
    return (
      <PublicLayout>
        <div className="max-w-[800px] mx-auto px-6 py-32 text-center">
          <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
            NEIGHBOURHOOD NOT FOUND
          </div>
          <h1 className="mt-4 font-serif text-4xl">
            That community isn't on the list yet
          </h1>
          <Link href="/neighbourhoods" className="inline-block mt-8 font-display text-[11px] tracking-[0.22em] underline">
              ← BACK TO NEIGHBOURHOODS
            
          </Link>
        </div>
      </PublicLayout>
    );
  }

  const story = parseJsonArray(data.story);
  const galleryImgs = parseJsonArray(data.gallery);
  const listings = data.listings ?? [];
  const condoBuildings = data.condoBuildings ?? [];
  const schools = ((data as any).schools ?? []) as Array<{
    name: string;
    level?: string;
  }>;
  const heroCredit = data.heroCredit ?? null;

  const seoTitle = `${data.name} Homes for Sale - Luxury Homes Calgary`;
  const seoDesc = `Browse luxury homes for sale in ${data.name}, Calgary. Active MLS listings, neighbourhood guide, schools, and lifestyle.`;
  const canonicalUrl = `https://riversrealestate.ca/neighbourhoods/${data.slug}`;
  // Visible on-page FAQ content (rendered in <FaqAccordion> below). No longer
  // emitted as FAQPage JSON-LD — Google dropped FAQ rich results in May 2026,
  // and all schema is server-emitted now.
  const seoFaq = [
    {
      question: `Where is ${data.name} in Calgary?`,
      answer: `${data.name} is a Calgary neighbourhood${(data as any).quadrant ? ` in the ${(data as any).quadrant} quadrant` : ""}. ${story[0]?.slice(0, 220) ?? ""}`,
    },
    {
      question: `How many homes are for sale in ${data.name} right now?`,
      answer: `There are currently ${(data as any).activeCount ?? "multiple"} active MLS listings in ${data.name}. View them all on this page or contact Spencer Rivers for off-market opportunities.`,
    },
    (data as any).avgPrice
      ? {
          question: `What's the average home price in ${data.name}?`,
          answer: `The average asking price across active listings in ${data.name} is approximately $${Math.round(((data as any).avgPrice as number) / 1000).toLocaleString()}K.`,
        }
      : null,
    condoBuildings.length > 0
      ? {
          question: `What condo buildings are in ${data.name}?`,
          answer: `Condo and townhome buildings in ${data.name} include ${condoBuildings
            .slice(0, 12)
            .map((b) => b.name)
            .join(", ")}${condoBuildings.length > 12 ? ", and more" : ""}.`,
        }
      : null,
    schools.length > 0
      ? {
          question: `What schools are in ${data.name}?`,
          answer: `Schools serving ${data.name} include ${schools
            .slice(0, 6)
            .map((s) => (s.level ? `${s.name} (${s.level})` : s.name))
            .join(", ")}.`,
        }
      : null,
    {
      question: `Who can help me buy or sell a home in ${data.name}?`,
      answer: `Spencer Rivers of Rivers Real Estate specializes in ${data.name} and Calgary's luxury communities, representing both buyers and sellers — including off-market opportunities that never reach the public MLS. Call or text +1 (403) 966-9237.`,
    },
  ].filter(Boolean) as Array<{ question: string; answer: string }>;

  return (
    <PublicLayout transparentHeader>
      {/* Schema (Place, breadcrumbs) is server-emitted by metaForPath —
          this only keeps title/meta current on SPA nav. Keep these strings
          in sync with the /neighbourhoods/:slug branch there. */}
      <SeoHead
        title={seoTitle}
        description={seoDesc}
        canonical={canonicalUrl}
        ogImage={(data as any).heroImage}
        ogType="place"
      />
      {/* Hero */}
      <section className="relative h-[80vh] min-h-[560px] w-full overflow-hidden -mt-16 lg:-mt-20">
        <img
          src={data.heroImage}
          alt={`${data.name} homes for sale`}
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/40 to-black/85" />
        <div className="relative h-full flex flex-col justify-end max-w-[1400px] mx-auto px-6 lg:px-10 pb-20 lg:pb-28 text-white">
          <Link href="/neighbourhoods" className="inline-flex items-center gap-1.5 font-display text-[11px] tracking-[0.22em] text-white/70 hover:text-white mb-8 self-start"
              data-testid="link-back-to-neighbourhoods">
              <ChevronLeft className="w-3 h-3" strokeWidth={1.8} />
              ALL NEIGHBOURHOODS
            
          </Link>
          <div className="font-display text-[11px] tracking-[0.32em] text-white/70 inline-flex items-center gap-2">
            <MapPin className="w-3 h-3" strokeWidth={1.8} />
            CALGARY · ALBERTA
          </div>
          <h1 className="mt-4 font-serif text-[52px] lg:text-[88px] leading-[0.98] max-w-[1100px]">
            {data.name}
          </h1>
          <div className="mt-5 max-w-2xl font-serif italic text-[20px] lg:text-[26px] text-white/85">
            {data.tagline}
          </div>

          <div className="mt-10 flex flex-wrap gap-x-12 gap-y-4 pt-8 border-t border-white/20">
            <Stat label="Average price" value={formatPriceCompact(data.avgPrice)} />
            <Stat label="Active listings" value={String(data.activeCount)} />
            <Stat label="Community" value={data.name} />
          </div>
        </div>

        {/* CC photo attribution — required by the licenses on curated heroes */}
        {heroCredit && heroCredit.author && (
          <a
            href={heroCredit.sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="absolute bottom-3 right-4 z-10 text-[10px] tracking-wide text-white/45 hover:text-white/75 transition-colors"
            data-testid="hero-credit"
          >
            Photo: {heroCredit.author.split(",")[0]} · {heroCredit.license}
          </a>
        )}
      </section>

      {/* Story body */}
      <section className="max-w-[1100px] mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
          THE STORY
        </div>
        <div className="mt-6 space-y-6 font-serif text-[20px] lg:text-[22px] leading-[1.55] text-foreground/90">
          {story.length > 0 ? (
            story.map((p, i) => <p key={i}>{p}</p>)
          ) : (
            <p>{data.tagline}</p>
          )}
        </div>
      </section>

      {/* Three columns */}
      <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pb-20 grid grid-cols-1 md:grid-cols-3 gap-10 lg:gap-14">
        <CopyBlock label="Outside" body={data.outsideCopy} />
        <CopyBlock label="Amenities" body={data.amenitiesCopy} />
        <CopyBlock label="Shop & dine" body={data.shopDineCopy} />
      </section>

      {/* Gallery strip (if available) */}
      {galleryImgs.length > 0 && (
        <section className="max-w-[1600px] mx-auto px-4 lg:px-8 pb-20">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 lg:gap-3">
            {galleryImgs.slice(0, 4).map((src, i) => (
              <div
                key={i}
                className="relative aspect-[3/4] overflow-hidden rounded-sm bg-secondary"
              >
                <img
                  src={src}
                  alt={`${data.name} homes for sale`}
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover"
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Map */}
      <section className="max-w-[1400px] mx-auto px-4 lg:px-8 pb-20">
        <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
          ON THE MAP
        </div>
        <h2 className="mt-3 font-serif text-3xl lg:text-4xl">
          Where {data.name} sits
        </h2>
        <NeighbourhoodAirbnbMap data={data} listings={listings} />

        {/* What's nearby — schools, restaurants, parks, transit overlaid on
            the map, centered on the neighbourhood. Same component used on the
            MLS detail + condo pages. */}
        {Number.isFinite(data.centerLat) && Number.isFinite(data.centerLng) && (
          <NeighbourhoodPois
            lat={data.centerLat}
            lng={data.centerLng}
            poiUrl={`/api/public/neighbourhoods/${data.slug}/pois`}
            cacheKey={`neighbourhood:${data.slug}`}
            eyebrow="WHAT'S NEARBY"
            caption={`Schools, restaurants, parks, and transit around ${data.name}.`}
          />
        )}
      </section>

      {/* Condo & townhome buildings */}
      {condoBuildings.length > 0 && (
        <section className="max-w-[1400px] mx-auto px-4 lg:px-8 pb-20">
          <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
            CONDO LIVING
          </div>
          <h2 className="mt-3 font-serif text-3xl lg:text-4xl">
            Condo buildings in {data.name}
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground text-[15px] leading-[1.7]">
            The condominium and townhome buildings that call {data.name} home.
            Buildings with a full profile link through to floor plans, amenities,
            and current listings.
          </p>
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {condoBuildings.map((b) =>
              b.slug ? (
                <Link key={b.slug} href={`/condos/${b.slug}`} className="group flex items-center justify-between gap-4 border border-border p-5 transition-colors duration-300 hover:border-foreground"
                    data-testid={`link-condo-building-${b.slug}`}>
                    <div className="min-w-0">
                      <div className="font-serif text-lg leading-snug transition-transform duration-300 group-hover:translate-x-2">
                        {b.name}
                      </div>
                      <div className="mt-1 font-display text-[10px] tracking-[0.22em] text-muted-foreground uppercase truncate">
                        {b.address || "BUILDING PROFILE"}
                      </div>
                    </div>
                    <ArrowRight
                      className="w-4 h-4 shrink-0 text-muted-foreground transition-colors duration-300 group-hover:text-foreground"
                      strokeWidth={1.8}
                    />
                  
                </Link>
              ) : (
                <div
                  key={b.name}
                  className="border border-border p-5"
                  data-testid={`condo-building-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                >
                  <div className="font-serif text-lg leading-snug">{b.name}</div>
                  {b.address && (
                    <div className="mt-1 font-display text-[10px] tracking-[0.22em] text-muted-foreground uppercase truncate">
                      {b.address}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        </section>
      )}

      {/* Active listings */}
      <section className="bg-secondary/40 py-20">
        <div className="max-w-[1400px] mx-auto px-4 lg:px-8">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
                ACTIVE IN {data.name.toUpperCase()}
              </div>
              <h2 className="mt-3 font-serif text-3xl lg:text-4xl">
                Properties on the market today
              </h2>
            </div>
            <Link
              href={`/mls?neighbourhood=${encodeURIComponent(data.name)}`} className="inline-flex items-center gap-1.5 font-display text-[11px] tracking-[0.22em]"
                data-testid="link-search-neighbourhood">
                SEE ALL
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} />
              
            </Link>
          </div>

          {listings.length === 0 ? (
            <div className="mt-10 border border-dashed border-border rounded-sm p-12 text-center">
              <HomeIcon
                className="w-8 h-8 mx-auto text-muted-foreground"
                strokeWidth={1.4}
              />
              <h3 className="mt-4 font-serif text-2xl">
                Nothing currently listed here
              </h3>
              <p className="mt-2 text-muted-foreground max-w-md mx-auto text-sm">
                Inventory turns over quickly in {data.name}. Reach out and
                Spencer will share off-market homes that match what you're
                looking for.
              </p>
              <Link href="/contact">
                  <Button className="mt-6" data-testid="button-contact-spencer">
                    Get in touch
                  </Button>
                
              </Link>
            </div>
          ) : (
            <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {listings.slice(0, 8).map((l) => (
                <ListingCard key={l.id} listing={l} variant="compact" />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* FAQ — visible content only; no FAQPage JSON-LD (Google dropped FAQ
          rich results May 2026). */}
      <FaqAccordion
        items={seoFaq.map((f) => ({ q: f.question, a: f.answer }))}
        eyebrow={`FAQ · ${data.name.toUpperCase()}`}
      />

      {/* CTA */}
      <section className="max-w-[1100px] mx-auto px-6 lg:px-10 py-24 lg:py-32 text-center">
        <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
          THINKING {data.name.toUpperCase()}?
        </div>
        <h2 className="mt-4 font-serif text-4xl lg:text-5xl leading-[1.05]">
          The right home in this community starts with the right conversation.
        </h2>
        <p className="mt-5 max-w-xl mx-auto text-muted-foreground text-[15px]">
          Spencer represents both buyers and sellers in {data.name} and can
          share off-market opportunities that never make the public MLS.
        </p>
        <Link href="/contact">
            <Button
              className="mt-8 h-12 px-8 rounded-sm font-display text-[11px] tracking-[0.22em]"
              data-testid="button-detail-cta-contact"
            >
              CALL OR TEXT SPENCER DIRECTLY
            </Button>
          
        </Link>
      </section>
    </PublicLayout>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-display text-[10px] tracking-[0.22em] text-white/55">
        {label.toUpperCase()}
      </div>
      <div className="mt-1.5 font-serif text-2xl tabular-nums">{value}</div>
    </div>
  );
}

function CopyBlock({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground pb-3 border-b border-border">
        {label.toUpperCase()}
      </div>
      <p className="mt-5 text-[15px] leading-[1.7] text-foreground/85">
        {body}
      </p>
    </div>
  );
}

// =============================================================================
// Airbnb-style neighbourhood map. Listings render as price pills (white
// default, forest-green when selected, crimson when there's been a price
// reduction). Clicking a pill pops a hover card with photo + address +
// quick stats so visitors can browse the neighbourhood without leaving the
// page. Basemap configuration is shared with the other public maps.
// =============================================================================
type PolygonGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

// GeoJSON stores coordinates as [lng, lat]; Leaflet's <Polygon> expects
// [lat, lng]. Swaps and unwraps Polygon / MultiPolygon nesting into the
// array-of-rings shape Leaflet wants.
function geoJsonToLeafletRings(geom: PolygonGeometry): [number, number][][][] {
  const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  return polygons.map((rings) =>
    rings.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number])),
  );
}

// Fits the map to the polygon's bounding box on mount so the community
// always frames cleanly. Takes precedence over FitBoundsOnce when a
// boundary exists.
function FitToPolygon({ rings }: { rings: [number, number][][][] }) {
  const map = useMap();
  useEffect(() => {
    if (!rings.length) return;
    const all = rings.flat(2);
    if (!all.length) return;
    map.fitBounds(all as L.LatLngBoundsExpression, { padding: [24, 24], animate: false });
  }, [rings, map]);
  return null;
}

function NeighbourhoodAirbnbMap({
  data,
  listings,
}: {
  data: {
    name: string;
    centerLat: number;
    centerLng: number;
    polygon?: PolygonGeometry | null;
  };
  listings: Array<{
    id: string;
    fullAddress: string;
    listPrice: number;
    previousPrice?: number | null;
    lat?: number | null;
    lng?: number | null;
    beds?: number | null;
    baths?: number | null;
    sqft?: number | null;
    heroImage?: string | null;
    photoCount?: number | null;
  }>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const visible = listings.filter(
    (l) => typeof l.lat === "number" && typeof l.lng === "number",
  );
  const rings = data.polygon ? geoJsonToLeafletRings(data.polygon) : [];
  const points: Array<[number, number]> = [
    [data.centerLat, data.centerLng],
    ...visible.map((l) => [l.lat as number, l.lng as number] as [number, number]),
  ];
  const selectedListing = visible.find((l) => l.id === selected) ?? null;

  return (
    <div
      className="relative mt-6 aspect-[16/9] rounded-sm overflow-hidden border border-border bg-secondary"
      data-testid="neighbourhood-map"
    >
      {/* ClientOnly: Leaflet is browser-only; the sized parent div above is
          SSR'd so layout holds until the map mounts. */}
      <ClientOnly>
      <MapContainer
        center={[data.centerLat, data.centerLng]}
        zoom={14}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%", background: "#f5f5f5" }}
      >
        <TileLayer
          attribution={RIVERS_TILE_ATTRIBUTION}
          url={RIVERS_TILE_URL}
          subdomains={RIVERS_TILE_SUBDOMAINS}
        />
        {rings.length > 0 ? <FitToPolygon rings={rings} /> : <FitBoundsOnce points={points} />}

        {/* Community boundary from OSM, when available */}
        {rings.map((polygonRings, i) => (
          <Polygon
            key={i}
            positions={polygonRings}
            pathOptions={{
              color: "#23412d",
              weight: 2,
              opacity: 0.85,
              fillColor: "#23412d",
              fillOpacity: 0.08,
            }}
          />
        ))}

        {/* Subject pin = the neighbourhood center */}
        <Marker position={[data.centerLat, data.centerLng]} icon={buildSubjectPin()} />

        {/* Listing price pills */}
        {visible.map((l) => {
          const isSelected = selected === l.id;
          const reduced =
            typeof l.previousPrice === "number" && l.previousPrice > l.listPrice;
          const state = isSelected ? "selected" : reduced ? "reduced" : "default";
          return (
            <Marker
              key={l.id}
              position={[l.lat as number, l.lng as number]}
              icon={buildPricePill(l.listPrice, state)}
              zIndexOffset={isSelected ? 1000 : 0}
              eventHandlers={{ click: () => setSelected(l.id) }}
            />
          );
        })}
      </MapContainer>
      </ClientOnly>

      {/* Neighbourhood name chip — top-left, doesn't block map controls */}
      <div className="pointer-events-none absolute top-3 left-3 px-3 py-1.5 rounded-full bg-background/90 backdrop-blur border border-border text-xs font-display tracking-[0.18em] z-[400] flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full bg-foreground" />
        {data.name.toUpperCase()}
      </div>

      {/* Hover/click preview card for the selected listing */}
      {selectedListing && (
        <div className="absolute bottom-3 left-3 right-3 lg:left-auto lg:w-[300px] z-[450]">
          <div className="bg-background/95 backdrop-blur border border-border rounded-sm shadow-lg overflow-hidden">
            <div className="flex">
              {selectedListing.heroImage && (
                <img
                  src={selectedListing.heroImage}
                  alt=""
                  className="w-24 h-24 object-cover shrink-0"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                />
              )}
              <div className="flex-1 min-w-0 p-3">
                <div className="flex items-start justify-between gap-2">
                  <Link href={mlsPropertyPath(selectedListing as any)} className="font-serif text-sm leading-snug hover:underline truncate block">
                      {selectedListing.fullAddress}
                    
                  </Link>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(null);
                    }}
                    className="text-muted-foreground hover:text-foreground text-xs leading-none mt-0.5"
                    aria-label="Close preview"
                  >
                    ✕
                  </button>
                </div>
                <div className="font-serif text-base mt-1" style={{ letterSpacing: "-0.01em" }}>
                  {formatPriceCompact(selectedListing.listPrice)}
                  {selectedListing.previousPrice && selectedListing.previousPrice > selectedListing.listPrice && (
                    <span className="ml-2 text-[11px] text-muted-foreground line-through">
                      {formatPriceCompact(selectedListing.previousPrice)}
                    </span>
                  )}
                </div>
                <div className="font-display tracking-[0.14em] text-[10px] text-muted-foreground mt-1">
                  {selectedListing.beds ?? "—"} BD · {selectedListing.baths ?? "—"} BA
                  {selectedListing.sqft ? ` · ${selectedListing.sqft.toLocaleString("en-CA")} SQFT` : ""}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
