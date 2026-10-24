// Links between detail pages, chosen server-side in server/related-links.ts.
// Plain text links on purpose: they are for readers deciding where to go next
// and for crawlers following the site's structure, not another image grid.
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import type { PlaceLink, PostLink } from "@/lib/mls-types";

export const placeHref = (p: PlaceLink) =>
  p.kind === "condo" ? `/condos/${p.slug}` : `/neighbourhoods/${p.slug}`;

/** "More to explore" for neighbourhood and condo pages: nearby places on the
 *  left, journal posts about this one on the right. Renders nothing when
 *  both lists are empty. */
export function ExploreMore({
  eyebrow,
  placesTitle,
  places = [],
  postsTitle,
  posts = [],
}: {
  eyebrow: string;
  placesTitle: string;
  places?: PlaceLink[];
  postsTitle: string;
  posts?: PostLink[];
}) {
  if (!places.length && !posts.length) return null;
  return (
    <section className="max-w-[1300px] mx-auto px-6 lg:px-10 py-16 lg:py-20 border-t border-border"
      data-testid="section-explore-more">
      <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">{eyebrow}</div>
      <div className={`mt-8 grid gap-12 ${places.length && posts.length ? "lg:grid-cols-2" : ""}`}>
        {places.length > 0 && (
          <div>
            <h2 className="font-serif text-2xl lg:text-3xl">{placesTitle}</h2>
            <ul className="mt-6 divide-y divide-border border-y border-border">
              {places.map((p) => (
                <li key={`${p.kind}-${p.slug}`}>
                  <Link href={placeHref(p)} className="group flex items-center justify-between gap-4 py-4"
                    data-testid={`link-explore-${p.slug}`}>
                    <span>
                      <span className="font-serif text-lg group-hover:underline underline-offset-4">{p.name}</span>
                      {p.context && (
                        <span className="block text-[11px] font-display tracking-[0.18em] text-muted-foreground mt-0.5">
                          {p.context.toUpperCase()}
                        </span>
                      )}
                    </span>
                    <ArrowRight className="w-4 h-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" strokeWidth={1.6} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {posts.length > 0 && <PostList title={postsTitle} posts={posts} />}
      </div>
    </section>
  );
}

function PostList({ title, posts }: { title: string; posts: PostLink[] }) {
  return (
    <div>
      <h2 className="font-serif text-2xl lg:text-3xl">{title}</h2>
      <ul className="mt-6 divide-y divide-border border-y border-border">
        {posts.map((p) => (
          <li key={p.slug}>
            <Link href={`/blog/${p.slug}`} className="group block py-4" data-testid={`link-journal-${p.slug}`}>
              <span className="block text-[11px] font-display tracking-[0.18em] text-muted-foreground">
                {p.category.toUpperCase()}
              </span>
              <span className="block font-serif text-lg leading-snug mt-1 group-hover:underline underline-offset-4">
                {p.title}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
