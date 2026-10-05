import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Clock } from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicBlogPost } from "@/lib/mls-types";

// Fallback hero — used when a post has no heroImage (e.g. some of the
// WP-migrated posts arrived with empty/broken image URLs). Brand-aligned
// neutral Calgary architecture shot.
const BLOG_FALLBACK_HERO =
  "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&h=900&fit=crop&q=80";
function heroFor(post: { heroImage?: string | null }): string {
  const h = (post.heroImage || "").trim();
  if (!h) return BLOG_FALLBACK_HERO;
  return h;
}

function fmtDate(iso: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-CA", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function BlogIndexPage() {
  const { data, isLoading } = useQuery<PublicBlogPost[]>({
    queryKey: ["/api/public/blog"],
  });

  const posts = data ?? [];
  const [feature, ...rest] = posts;

  return (
    <PublicLayout>
      {/* Page header */}
      <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pt-12 lg:pt-20 pb-10">
        <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
          THE JOURNAL
        </div>
        <h1 className="mt-5 font-serif text-[44px] lg:text-[72px] leading-[1.02] max-w-[1000px]">
          Calgary luxury real estate, from someone who actually works it.
        </h1>
        <p className="mt-5 max-w-2xl text-muted-foreground text-[15px] leading-relaxed">
          Start here:{" "}
          <Link href="/blog/how-to-choose-a-luxury-real-estate-agent-in-calgary">
            how to choose a luxury real estate agent in Calgary
          </Link>{" "}
          — the seven criteria, ten interview questions and red flags Spencer
          Rivers, REALTOR®, CLHMS uses himself.
        </p>
        <p className="mt-5 max-w-2xl text-muted-foreground text-[15px] leading-relaxed">
          Pricing strategy, neighbourhood intelligence, market data, and the
          occasional opinion — written by Spencer for buyers and sellers in
          Calgary's most established communities.
        </p>
      </section>

      {/* Featured */}
      {isLoading ? (
        <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pb-12">
          <Skeleton className="aspect-[16/9] w-full rounded-sm" />
        </section>
      ) : feature ? (
        <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pb-16">
          <Link href={`/blog/${feature.slug}`} className="group grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center"
              data-testid={`feature-post-${feature.slug}`}>
              <div className="relative aspect-[4/3] lg:aspect-[5/4] rounded-sm overflow-hidden bg-secondary">
                <img
                  src={heroFor(feature)}
                  onError={(e) => ((e.target as HTMLImageElement).src = BLOG_FALLBACK_HERO)}
                  alt={feature.heroImageAlt || feature.title}
                  loading="lazy"
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
                />
              </div>
              <div>
                <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                  {feature.category.toUpperCase()} · FEATURED
                </div>
                <h2 className="mt-4 font-serif text-3xl lg:text-5xl leading-[1.08]">
                  {feature.title}
                </h2>
                <p className="mt-5 text-[15px] lg:text-[16px] leading-[1.7] text-foreground/80">
                  {feature.excerpt}
                </p>
                <div className="mt-7 flex items-center gap-4 text-[12px] text-muted-foreground">
                  <span>{fmtDate(feature.publishedAt)}</span>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="w-3 h-3" strokeWidth={1.8} />
                    {feature.readMinutes} min read
                  </span>
                </div>
                <span className="mt-7 inline-flex items-center gap-1.5 font-display text-[11px] tracking-[0.22em] underline-offset-4 group-hover:underline">
                  READ THE FULL PIECE
                  <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} />
                </span>
              </div>
            
          </Link>
        </section>
      ) : null}

      {/* Grid */}
      <section className="border-t border-border bg-secondary/30 py-16">
        <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
          <div className="font-display text-xs tracking-[0.22em] text-muted-foreground mb-10">
            ALL ENTRIES
          </div>

          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-12">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i}>
                  <Skeleton className="aspect-[4/3]" />
                  <Skeleton className="h-6 w-2/3 mt-4" />
                  <Skeleton className="h-4 w-full mt-2" />
                </div>
              ))}
            </div>
          ) : rest.length === 0 ? (
            <div className="border border-dashed border-border rounded-sm py-16 text-center">
              <p className="text-muted-foreground">No more posts yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-12">
              {rest.map((post) => (
                <Link key={post.slug} href={`/blog/${post.slug}`} className="group block"
                    data-testid={`post-card-${post.slug}`}>
                    <div className="relative aspect-[4/3] rounded-sm overflow-hidden bg-secondary">
                      <img
                        src={heroFor(post)}
                        onError={(e) => ((e.target as HTMLImageElement).src = BLOG_FALLBACK_HERO)}
                        alt={post.heroImageAlt || post.title}
                        loading="lazy"
                        className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                      />
                    </div>
                    <div className="mt-5">
                      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                        {post.category.toUpperCase()}
                      </div>
                      <h3 className="mt-2.5 font-serif text-2xl leading-[1.15] group-hover:underline underline-offset-4 decoration-[1px]">
                        {post.title}
                      </h3>
                      <p className="mt-3 text-[14px] text-muted-foreground line-clamp-2 leading-relaxed">
                        {post.excerpt}
                      </p>
                      <div className="mt-4 flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
                        <span>{fmtDate(post.publishedAt)}</span>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1.5">
                          <Clock className="w-3 h-3" strokeWidth={1.8} />
                          {post.readMinutes} min
                        </span>
                      </div>
                    </div>
                  
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </PublicLayout>
  );
}
