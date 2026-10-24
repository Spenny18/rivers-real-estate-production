import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MapPin } from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPriceCompact } from "@/lib/format";
import type { PublicNeighbourhood } from "@/lib/mls-types";

const HERO_IMAGE =
  "https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=2400&h=1200&fit=crop";

// Display order for zone sections on the page. Zones not in this list fall to
// the bottom in alpha order. Calgary city zones first, then surrounding
// municipalities (Rural Rocky View County, Foothills MD, Airdrie, Chestermere,
// Canmore).
const ZONE_ORDER = [
  "City Centre",
  "West",
  "South",
  "Southeast",
  "Northwest",
  "Northeast",
  "Rural Rocky View County",
  "Foothills MD",
  "Airdrie",
  "Chestermere",
  "Canmore",
];

// Each zone needs a short blurb under its heading so the section feels
// intentional rather than just a label.
const ZONE_BLURBS: Record<string, string> = {
  "City Centre": "Calgary's most established inner-city blocks — heritage character, walkability, and quick access to downtown.",
  "West": "West-side family + estate communities paired with the Bow River escarpment, Edworthy Park, and Westside commuter routes.",
  "South": "South-side family communities along the Glenmore Reservoir, Fish Creek Park, and the Macleod / Bow Bottom corridors — including Calgary's lake communities and newest south-edge master-plans.",
  "Southeast": "SE communities anchored by Mahogany Lake, Auburn Bay, and the Bow River escarpment.",
  "Northwest": "Established NW family communities, golf-course addresses, and the U of C / Foothills corridor.",
  "Northeast": "Established NE family communities with strong school catchments and quick airport access.",
  "Rural Rocky View County": "Acreage estate communities west of Calgary — Bearspaw, Springbank, and the Elbow Valley.",
  "Foothills MD": "Country-residential parcels south of Calgary, paired with the Foothills commuter routes.",
  "Airdrie": "Calgary's largest commuter city — newer master-planned communities 20 minutes north on the QE2.",
  "Chestermere": "Lakefront luxury 20 minutes east of Calgary on Chestermere Lake.",
  "Canmore": "Mountain residences in Canmore, paired with Banff National Park and the Bow Valley.",
};

const NEIGHBOURHOOD_GUIDES: Array<{ href: string; label: string }> = [
  { href: "/blog/best-calgary-luxury-neighbourhoods-2026", label: "Calgary's most prestigious neighbourhoods, one winner per category" },
  { href: "/blog/top-20-best-calgary-neighbourhoods-2026", label: "Top 20 Calgary neighbourhoods to live in 2026" },
  { href: "/blog/living-in-britannia-the-calgary-luxury-buyers-guide", label: "Living in Britannia" },
  { href: "/blog/britannia-calgary-neighbourhood-guide-2024", label: "Britannia neighbourhood guide" },
  { href: "/blog/living-in-aspen-woods-the-calgary-luxury-buyers-guide", label: "Living in Aspen Woods" },
  { href: "/blog/why-families-love-living-in-aspen-woods-calgary", label: "Aspen Woods for families" },
  { href: "/blog/living-in-bel-aire-and-mayfair-calgarys-quietest-estate-enclave", label: "Living in Bel-Aire and Mayfair" },
  { href: "/blog/bel-aire-calgary-neighbourhood-guide-2024", label: "Bel-Aire neighbourhood guide" },
  { href: "/blog/elbow-park-vs-upper-mount-royal-which-heritage-calgary-neighbourhood-suits-you", label: "Elbow Park vs Upper Mount Royal" },
  { href: "/blog/rideau-park-ultimate-neighborhood-guide", label: "Rideau Park neighbourhood guide" },
  { href: "/blog/ultimate-guide-to-living-in-chestermere-lake", label: "Living on Chestermere Lake" },
  { href: "/blog/canmore-neighborhood-guide-2022", label: "Canmore neighbourhood guide" },
];

export default function NeighbourhoodsIndexPage() {
  const { data, isLoading } = useQuery<PublicNeighbourhood[]>({
    queryKey: ["/api/public/neighbourhoods"],
  });

  // Group neighbourhoods by zone, ordered by ZONE_ORDER.
  const grouped = useMemo(() => {
    const map = new Map<string, PublicNeighbourhood[]>();
    for (const n of data ?? []) {
      const z = (n as any).zone || "City Centre & Inner-City";
      if (!map.has(z)) map.set(z, []);
      map.get(z)!.push(n);
    }
    // Within each zone, sort by sortOrder then name
    Array.from(map.values()).forEach((arr) => {
      arr.sort((a: PublicNeighbourhood, b: PublicNeighbourhood) => {
        const so = (a.sortOrder ?? 999) - (b.sortOrder ?? 999);
        return so !== 0 ? so : a.name.localeCompare(b.name);
      });
    });
    // Order the zones
    const ordered: Array<[string, PublicNeighbourhood[]]> = [];
    for (const z of ZONE_ORDER) {
      const list = map.get(z);
      if (list && list.length > 0) ordered.push([z, list]);
      map.delete(z);
    }
    // Append any leftover zones alpha-sorted
    Array.from(map.keys()).sort().forEach((z) => {
      ordered.push([z, map.get(z)!]);
    });
    return ordered;
  }, [data]);

  return (
    <PublicLayout>
      {/* Page hero */}
      <section className="relative bg-black text-white">
        <div className="absolute inset-0 opacity-50">
          <img src={HERO_IMAGE} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black" />
        </div>
        <div className="relative max-w-[1400px] mx-auto px-6 lg:px-10 py-24 lg:py-36">
          <div className="font-display text-[11px] tracking-[0.32em] text-white/65">
            CALGARY · LUXURY COMMUNITIES
          </div>
          <h1 className="mt-5 font-serif text-[44px] lg:text-[72px] leading-[1.02] max-w-[900px]">
            Calgary luxury neighbourhoods Spencer knows by street, not statistic.
          </h1>
          <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-white/75">
            This is the full directory of Calgary luxury neighbourhoods Spencer
            Rivers works in, from the heritage estate districts of Upper Mount
            Royal, Britannia and Elbow Park to the west side ridge communities of
            Aspen Woods and Springbank Hill and the southeast lake communities.
            Each page carries current homes for sale, and listings here can appear
            up to 48 hours before Realtor.ca.
          </p>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-white/75">
            Calgary's most established luxury enclaves are made of distinct blocks,
            schools, and cul-de-sacs. The right home depends on which community
            fits the way you actually live.
          </p>
        </div>
      </section>

      {/* Body */}
      <section className="max-w-[1400px] mx-auto px-4 lg:px-8 py-16 lg:py-20">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-sm" />
            ))}
          </div>
        ) : (
          grouped.map(([zone, list]) => (
            <div key={zone} className="mb-16 last:mb-0">
              {/* Zone heading */}
              <div className="flex items-end justify-between mb-6 border-b border-border pb-3 gap-4 flex-wrap">
                <div className="max-w-[800px]">
                  <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground">
                    {zone.toUpperCase()}
                  </div>
                  <h2
                    className="font-serif text-2xl lg:text-3xl mt-1"
                    style={{ letterSpacing: "-0.01em" }}
                  >
                    {zone}
                  </h2>
                  {ZONE_BLURBS[zone] && (
                    <p className="mt-2 text-[13px] text-muted-foreground leading-relaxed">
                      {ZONE_BLURBS[zone]}
                    </p>
                  )}
                </div>
                <span className="text-[11px] font-display tracking-[0.16em] text-muted-foreground shrink-0">
                  {list.length} {list.length === 1 ? "COMMUNITY" : "COMMUNITIES"}
                </span>
              </div>

              {/* Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {list.map((n) => (
                  <Link key={n.slug} href={`/neighbourhoods/${n.slug}`} className="group block"
                      data-testid={`card-neighbourhood-${n.slug}`}>
                      <div className="relative aspect-[4/3] overflow-hidden rounded-sm bg-secondary">
                        <img
                          src={n.heroImage}
                          alt={`${n.name} homes for sale — Calgary luxury neighbourhoods`}
                          loading="lazy"
                          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-transparent" />
                        <div className="absolute bottom-0 left-0 right-0 p-6">
                          <div className="font-display text-[10px] tracking-[0.22em] text-white/70 inline-flex items-center gap-1.5">
                            <MapPin className="w-3 h-3" strokeWidth={1.8} />
                            CALGARY
                          </div>
                          <div className="mt-2 font-serif text-3xl text-white">{n.name}</div>
                          <div className="mt-1 text-[13px] text-white/80 italic">{n.tagline}</div>
                        </div>
                      </div>

                      <div className="mt-4 flex items-center justify-between text-[12px]">
                        <div className="flex gap-6 tabular-nums">
                          <div>
                            <span className="text-muted-foreground">Avg price</span>
                            <span className="ml-2 font-medium text-foreground">
                              {formatPriceCompact(n.avgPrice)}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Active</span>
                            <span className="ml-2 font-medium text-foreground">{n.activeCount}</span>
                          </div>
                        </div>
                        <span className="inline-flex items-center gap-1 font-display text-[10px] tracking-[0.22em] text-foreground opacity-65 group-hover:opacity-100 transition-opacity">
                          EXPLORE
                          <ArrowRight className="w-3 h-3" strokeWidth={1.8} />
                        </span>
                      </div>
                    
                  </Link>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      {/* Editorial by-district section: contextual links down to the guides */}
      <section className="max-w-[1400px] mx-auto px-4 lg:px-8 pb-16 lg:pb-20">
        <div className="border-t border-border pt-10 max-w-[900px]">
          <h2
            className="font-serif text-2xl lg:text-3xl"
            style={{ letterSpacing: "-0.01em" }}
          >
            Calgary luxury neighbourhoods, district by district
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed">
            Every district below has its own price ladder, lot sizes and build era.
            These are the guides Spencer keeps current, grouped the way buyers
            actually shop.
          </p>

          <h3 className="mt-8 font-serif text-xl">Heritage estate districts</h3>
          <p className="mt-2 text-[15px] leading-relaxed">
            Mount Royal, Elbow Park, Britannia and Rideau Park are the city's oldest
            estate addresses, where lot and flood exposure matter more than
            finishes. Start with the{" "}
            <Link href="/blog/upper-mount-royal-and-elbow-park-a-buyers-guide-to-calgarys-heritage-estate-districts" className="underline underline-offset-4 hover:opacity-70">buyer's guide to the heritage estate districts</Link>,
            then go deeper on{" "}
            <Link href="/blog/upper-mount-royal-architecture-tudor-georgian-and-modern-estate-homes" className="underline underline-offset-4 hover:opacity-70">Upper Mount Royal architecture</Link>,{" "}
            <Link href="/blog/elbow-park-calgary-real-estate" className="underline underline-offset-4 hover:opacity-70">Elbow Park prices and streets</Link>,{" "}
            <Link href="/blog/britannia-real-estate-estate-lots-mid-century-homes-and-rebuild-economics" className="underline underline-offset-4 hover:opacity-70">Britannia estate lots and rebuild economics</Link>,{" "}
            <Link href="/blog/britannia-vs-elbow-park-which-calgary-estate-district-suits-you" className="underline underline-offset-4 hover:opacity-70">Britannia versus Elbow Park</Link>,{" "}
            <Link href="/blog/elbow-park-vs-upper-mount-royal-which-heritage-calgary-neighbourhood-suits-you" className="underline underline-offset-4 hover:opacity-70">Elbow Park versus Upper Mount Royal</Link>{" "}
            and the{" "}
            <Link href="/blog/rideau-park-ultimate-neighborhood-guide" className="underline underline-offset-4 hover:opacity-70">Rideau Park neighbourhood guide</Link>.
          </p>

          <h3 className="mt-8 font-serif text-xl">Glenmore Reservoir enclaves</h3>
          <p className="mt-2 text-[15px] leading-relaxed">
            The small pockets west and south of the reservoir trade on land, not
            square footage. Read{" "}
            <Link href="/blog/living-in-eagle-ridge-and-bayview-calgarys-glenmore-reservoir-estate-enclaves" className="underline underline-offset-4 hover:opacity-70">living in Eagle Ridge and Bayview</Link>,{" "}
            <Link href="/blog/eagle-ridge-calgary-inside-the-citys-smallest-and-most-private-estate-community" className="underline underline-offset-4 hover:opacity-70">Eagle Ridge, the city's smallest estate community</Link>,{" "}
            <Link href="/blog/bayview-calgary-real-estate-reservoir-lots-original-bungalows-and-the-rebuild-wave" className="underline underline-offset-4 hover:opacity-70">Bayview reservoir lots and the rebuild wave</Link>,{" "}
            <Link href="/blog/bel-aire-real-estate-half-acre-lots-golf-course-frontage-and-teardown-value" className="underline underline-offset-4 hover:opacity-70">Bel-Aire half-acre lots and golf course frontage</Link>,{" "}
            <Link href="/blog/living-in-bel-aire-and-mayfair-calgarys-quietest-estate-enclave" className="underline underline-offset-4 hover:opacity-70">living in Bel-Aire and Mayfair</Link>{" "}
            and{" "}
            <Link href="/blog/mayfair-real-estate-the-entry-point-to-calgarys-britannia-and-bel-aire-corridor" className="underline underline-offset-4 hover:opacity-70">Mayfair, the corridor's entry point</Link>.
            Current listings sit on the{" "}
            <Link href="/neighbourhoods/bayview" className="underline underline-offset-4 hover:opacity-70">Bayview</Link>,{" "}
            <Link href="/neighbourhoods/pump-hill" className="underline underline-offset-4 hover:opacity-70">Pump Hill</Link>,{" "}
            <Link href="/neighbourhoods/lakeview" className="underline underline-offset-4 hover:opacity-70">Lakeview</Link>{" "}
            and{" "}
            <Link href="/neighbourhoods/north-glenmore-park" className="underline underline-offset-4 hover:opacity-70">North Glenmore Park</Link>{" "}
            pages.
          </p>

          <h3 className="mt-8 font-serif text-xl">West side and the ridge</h3>
          <p className="mt-2 text-[15px] leading-relaxed">
            Aspen Woods, Springbank Hill, West Springs and Discovery Ridge are
            newer, view-driven and priced by lot position. See{" "}
            <Link href="/blog/aspen-woods-real-estate-price-points-build-era-and-architecture" className="underline underline-offset-4 hover:opacity-70">Aspen Woods price points, build era and architecture</Link>,{" "}
            <Link href="/blog/the-5-best-streets-in-aspen-woods-for-luxury-buyers" className="underline underline-offset-4 hover:opacity-70">the five best streets in Aspen Woods</Link>,{" "}
            <Link href="/blog/living-in-aspen-woods-the-calgary-luxury-buyers-guide" className="underline underline-offset-4 hover:opacity-70">living in Aspen Woods</Link>,{" "}
            <Link href="/blog/springbank-hill-estate-homes-lot-sizes-views-and-walk-outs" className="underline underline-offset-4 hover:opacity-70">Springbank Hill estate homes, lot sizes and walk-outs</Link>,{" "}
            <Link href="/blog/living-in-springbank-hill-the-calgary-luxury-buyers-guide" className="underline underline-offset-4 hover:opacity-70">living in Springbank Hill</Link>,{" "}
            <Link href="/blog/unveiling-the-charms-of-west-springs-calgary" className="underline underline-offset-4 hover:opacity-70">West Springs</Link>{" "}
            and{" "}
            <Link href="/blog/discovery-ridge-calgary" className="underline underline-offset-4 hover:opacity-70">Discovery Ridge</Link>.
          </p>

          <h3 className="mt-8 font-serif text-xl">Lake communities and outside the city</h3>
          <p className="mt-2 text-[15px] leading-relaxed">
            If water access is the brief, compare the options in{" "}
            <Link href="/blog/calgary-lake-communities-compared" className="underline underline-offset-4 hover:opacity-70">Calgary lake communities compared</Link>,
            then look at{" "}
            <Link href="/neighbourhoods/mahogany" className="underline underline-offset-4 hover:opacity-70">Mahogany</Link>,{" "}
            <Link href="/neighbourhoods/auburn-bay" className="underline underline-offset-4 hover:opacity-70">Auburn Bay</Link>,{" "}
            <Link href="/neighbourhoods/lake-bonavista" className="underline underline-offset-4 hover:opacity-70">Lake Bonavista</Link>{" "}
            and{" "}
            <Link href="/neighbourhoods/bayside" className="underline underline-offset-4 hover:opacity-70">Bayside in Airdrie</Link>.
            Further out, read the{" "}
            <Link href="/blog/ultimate-guide-to-living-in-chestermere-lake" className="underline underline-offset-4 hover:opacity-70">guide to living on Chestermere Lake</Link>{" "}
            and the{" "}
            <Link href="/blog/canmore-neighborhood-guide-2022" className="underline underline-offset-4 hover:opacity-70">Canmore neighbourhood guide</Link>,
            with listings on the{" "}
            <Link href="/neighbourhoods/chestermere" className="underline underline-offset-4 hover:opacity-70">Chestermere</Link>{" "}
            and{" "}
            <Link href="/neighbourhoods/spring-creek" className="underline underline-offset-4 hover:opacity-70">Spring Creek</Link>{" "}
            pages.
          </p>

          <h3 className="mt-8 font-serif text-xl">Rankings and price bands</h3>
          <p className="mt-2 text-[15px] leading-relaxed">
            For a view across the whole map, see{" "}
            <Link href="/blog/top-11-luxury-neighbourhoods-in-calgary" className="underline underline-offset-4 hover:opacity-70">Calgary's most expensive neighbourhoods</Link>,{" "}
            <Link href="/blog/top-20-best-calgary-neighbourhoods-2026" className="underline underline-offset-4 hover:opacity-70">the top 20 Calgary neighbourhoods to live in 2026</Link>,{" "}
            <Link href="/blog/best-calgary-luxury-neighbourhoods-2026" className="underline underline-offset-4 hover:opacity-70">Calgary's most prestigious neighbourhoods</Link>{" "}
            and{" "}
            <Link href="/blog/the-3m-to-4m-sweet-spot-inside-calgarys-hottest-micro-market" className="underline underline-offset-4 hover:opacity-70">the $3M to $4M micro-market</Link>.
          </p>
        </div>
      </section>

      {/* Neighbourhood guides: crawlable links down to the blog posts */}
      <section className="max-w-[1400px] mx-auto px-4 lg:px-8 pb-16 lg:pb-20">
        <div className="border-t border-border pt-10">
          <h2
            className="font-serif text-2xl lg:text-3xl"
            style={{ letterSpacing: "-0.01em" }}
          >
            Neighbourhood guides
          </h2>
          <p className="mt-2 text-[14px] text-muted-foreground leading-relaxed">
            Longer reads on the communities buyers ask about most.
          </p>
          <ul className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-[15px]">
            {NEIGHBOURHOOD_GUIDES.map((g) => (
              <li key={g.href}>
                <Link href={g.href} className="underline underline-offset-4 hover:opacity-70">
                  {g.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </PublicLayout>
  );
}
