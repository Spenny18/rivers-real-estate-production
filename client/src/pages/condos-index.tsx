import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PublicLayout } from "@/components/public-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, Building2 } from "lucide-react";

interface CondoBuilding {
  slug: string;
  name: string;
  tagline: string;
  address: string;
  neighbourhood: string;
  neighbourhoodSlug: string;
  quadrant: string;
  units: number | null;
  stories: number | null;
  builtIn: number | null;
  heroImage: string;
  featured: boolean;
}

const NEIGHBOURHOOD_GROUPS = [
  { label: "Beltline", slug: "beltline" },
  { label: "Eau Claire", slug: "eau-claire" },
  { label: "Downtown West End", slug: "eau-claire" },
  { label: "Downtown East Village", slug: "beltline" },
];

const CONDO_GUIDES = [
  { text: "Calgary's top luxury condo districts compared", href: "/blog/calgarys-top-luxury-condo-districts-mission-eau-claire-and-east-village-compared" },
  { text: "Eau Claire luxury condos: buildings, views and price per square foot", href: "/blog/eau-claire-luxury-condos-buildings-views-and-price-per-square-foot" },
  { text: "East Village luxury condos and the true cost of ownership", href: "/blog/east-village-luxury-condos-modern-towers-and-the-true-cost-of-ownership" },
  { text: "The best condo buildings in Calgary", href: "/blog/the-9-best-luxury-condos-in-calgary" },
  { text: "Calgary new construction condos", href: "/blog/calgary-new-construction-guide" },
  { text: "Calgary luxury penthouses", href: "/blog/calgary-luxury-penthouses" },
  { text: "Calgary condo assignment sales", href: "/assignments" },
];

const INLINE_LINK = "text-foreground underline underline-offset-4 hover:text-muted-foreground transition-colors";

export default function CondosIndexPage() {
  const { data: buildings = [], isLoading } = useQuery<CondoBuilding[]>({
    queryKey: ["/api/public/condos"],
  });

  const grouped = buildings.reduce<Record<string, CondoBuilding[]>>((acc, b) => {
    const key = b.neighbourhood;
    (acc[key] ||= []).push(b);
    return acc;
  }, {});

  return (
    <PublicLayout>
      {/* Hero */}
      <section className="bg-foreground text-background">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-16 lg:py-24">
          <div className="font-display text-[11px] tracking-[0.22em] text-background/70 mb-3">
            CALGARY · CONDO BUILDINGS
          </div>
          <h1
            className="font-serif text-4xl lg:text-6xl text-background"
            style={{ letterSpacing: "-0.015em" }}
          >
            Calgary Luxury Condos
          </h1>
          <p className="mt-5 max-w-[680px] text-background/80 leading-relaxed">
            Calgary luxury condos, building by building: 32 downtown and
            inner-city addresses with pricing, condo fees and resale history for
            each. Spencer Rivers is a Certified Condo Specialist, and listings
            on this site can appear up to 48 hours before Realtor.ca.
          </p>
        </div>
      </section>

      {/* Choosing a condo */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 pt-16 lg:pt-20">
        <h2 className="font-serif text-2xl lg:text-3xl" style={{ letterSpacing: "-0.01em" }}>
          Choosing a Calgary luxury condo
        </h2>
        <div className="mt-3 max-w-[680px] space-y-4 text-muted-foreground leading-relaxed">
          <p>
            Start with the district. Mission, Eau Claire and East Village price differently per square foot and suit different buyers — the{" "}
            <Link href="/blog/calgarys-top-luxury-condo-districts-mission-eau-claire-and-east-village-compared" className={INLINE_LINK}>
              district comparison
            </Link>{" "}
            sets the three side by side, with deeper reads on{" "}
            <Link href="/blog/eau-claire-luxury-condos-buildings-views-and-price-per-square-foot" className={INLINE_LINK}>
              Eau Claire luxury condos
            </Link>{" "}
            and{" "}
            <Link href="/blog/east-village-luxury-condos-modern-towers-and-the-true-cost-of-ownership" className={INLINE_LINK}>
              East Village luxury condos
            </Link>
            .
          </p>
          <p>
            Then the carrying cost.{" "}
            <Link href="/blog/calgary-condo-fees-what-they-cover" className={INLINE_LINK}>
              What Calgary condo fees cover
            </Link>{" "}
            explains the per-square-foot ranges and the reserve fund questions behind them, and{" "}
            <Link href="/blog/calgary-condo-document-review" className={INLINE_LINK}>
              the condo document review
            </Link>{" "}
            covers what to read before you remove conditions.
          </p>
          <p>
            If you want the top floor, see{" "}
            <Link href="/blog/calgary-luxury-penthouses" className={INLINE_LINK}>
              Calgary luxury penthouses
            </Link>
            . If you would rather buy new,{" "}
            <Link href="/blog/calgary-new-construction-guide" className={INLINE_LINK}>
              Calgary new construction condos
            </Link>{" "}
            covers what is being built and{" "}
            <Link href="/assignments" className={INLINE_LINK}>
              condo assignment sales
            </Link>{" "}
            explain how to take over a pre-construction contract before it completes.{" "}
            <Link href="/blog/the-9-best-luxury-condos-in-calgary" className={INLINE_LINK}>
              The nine best condo buildings in Calgary
            </Link>{" "}
            ranks the resale towers.
          </p>
        </div>
      </section>

      {/* Body */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 py-16 lg:py-20">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[320px] w-full" />
            ))}
          </div>
        ) : (
          Object.entries(grouped).map(([area, list]) => (
            <div key={area} className="mb-14">
              <div className="flex items-end justify-between mb-6 border-b border-border pb-3">
                <div>
                  <div className="font-display text-[11px] tracking-[0.22em] text-muted-foreground">
                    {area.toUpperCase()}
                  </div>
                  <h2 className="font-serif text-2xl lg:text-3xl mt-1" style={{ letterSpacing: "-0.01em" }}>
                    {area}
                  </h2>
                </div>
                <span className="text-[11px] font-display tracking-[0.16em] text-muted-foreground">
                  {list.length} {list.length === 1 ? "BUILDING" : "BUILDINGS"}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {list.map((b) => (
                  <Link key={b.slug} href={`/condos/${b.slug}`} className="group block">
                      <div className="relative aspect-[4/3] rounded-sm overflow-hidden bg-secondary">
                        <img
                          src={b.heroImage}
                          alt={`${b.name} condos for sale`}
                          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                        />
                        {b.featured && (
                          <div className="absolute top-3 left-3 px-2.5 py-1 bg-foreground text-background font-display text-[10px] tracking-[0.22em]">
                            FEATURED
                          </div>
                        )}
                      </div>
                      <div className="mt-3">
                        <div className="font-serif text-xl text-foreground" style={{ letterSpacing: "-0.005em" }}>
                          {b.name}
                        </div>
                        <div className="text-sm text-muted-foreground mt-0.5">{b.tagline}</div>
                        <div className="mt-2 flex items-center gap-3 text-[11px] font-display tracking-[0.14em] text-muted-foreground">
                          {b.units != null && <span>{b.units} UNITS</span>}
                          {b.stories != null && <span>{b.stories} STORIES</span>}
                          {b.builtIn != null && <span>{b.builtIn}</span>}
                        </div>
                      </div>
                    
                  </Link>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      {/* Guides */}
      <section className="max-w-[1400px] mx-auto px-6 lg:px-10 pb-16 lg:pb-20">
        <h2 className="font-serif text-2xl lg:text-3xl" style={{ letterSpacing: "-0.01em" }}>
          Condo buying guides
        </h2>
        <p className="mt-3 text-muted-foreground max-w-[680px] leading-relaxed">
          Start with the district comparison, then go deeper on the buildings, the costs and the new-build pipeline.
        </p>
        <ul className="mt-6 space-y-2">
          {CONDO_GUIDES.map((g) => (
            <li key={g.href}>
              <Link href={g.href} className="text-foreground underline underline-offset-4 hover:text-muted-foreground transition-colors">
                {g.text}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* CTA */}
      <section className="bg-secondary/40 border-t border-border">
        <div className="max-w-[1000px] mx-auto px-6 lg:px-10 py-16 text-center">
          <h2 className="font-serif text-3xl lg:text-4xl" style={{ letterSpacing: "-0.01em" }}>
            Looking for a specific building?
          </h2>
          <p className="mt-4 text-muted-foreground max-w-[640px] mx-auto leading-relaxed">
            I track inventory across every Calgary luxury condo building. If you
            don't see what you're looking for, ask — pre-list and pocket
            inventory regularly comes through.
          </p>
          <Link href="/contact" className="inline-flex items-center gap-2 mt-7 px-6 py-3 bg-foreground text-background font-display text-[11px] tracking-[0.22em] hover:bg-foreground/90 transition-colors">
              GET IN TOUCH
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.6} />
            
          </Link>
        </div>
      </section>
    </PublicLayout>
  );
}
