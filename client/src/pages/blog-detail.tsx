import { Link, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Clock, Phone, Mail } from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  SPENCER_PHONE,
  SPENCER_PHONE_HREF,
  SPENCER_EMAIL,
  SPENCER_EMAIL_HREF,
} from "@/lib/format";
import type { PublicBlogPost } from "@/lib/mls-types";
import { parseVideoUrl } from "@shared/video";
import { VideoEmbed } from "@/components/video-embed";

const BLOG_FALLBACK_HERO =
  "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1600&h=900&fit=crop&q=80";
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

// Render the blog body. Posts may be plain text with double-newline paragraphs,
// or simple markdown-flavored content (## headings, **bold**, etc).
// We support: paragraphs, h2 (## ), h3 (### ), a blockquote (> ), and a
// video URL on its own line (YouTube / Vimeo / .mp4), which becomes an
// embedded player. The server emits VideoObject schema for exactly these —
// keep the paragraph split and parseVideoUrl in step with shared/video.ts.
function renderBody(body: string, postTitle: string) {
  const blocks = body.split(/\n\s*\n/);
  return blocks.map((raw, i) => {
    const block = raw.trim();
    if (!block) return null;
    const video = parseVideoUrl(block);
    if (video) {
      return (
        <figure key={i} className="my-10">
          <VideoEmbed video={video} title={postTitle} className="shadow-lg" />
        </figure>
      );
    }
    if (block.startsWith("## ")) {
      return (
        <h2
          key={i}
          className="mt-12 mb-4 font-serif text-3xl lg:text-4xl leading-[1.15]"
        >
          {inline(block.slice(3))}
        </h2>
      );
    }
    if (block.startsWith("### ")) {
      return (
        <h3
          key={i}
          className="mt-10 mb-3 font-serif text-2xl leading-[1.2]"
        >
          {inline(block.slice(4))}
        </h3>
      );
    }
    if (block.startsWith("> ")) {
      return (
        <blockquote
          key={i}
          className="my-8 pl-6 border-l-2 border-foreground italic font-serif text-[20px] lg:text-[22px] leading-[1.55] text-foreground/85"
        >
          {inline(block.slice(2))}
        </blockquote>
      );
    }
    // List? simple bullets
    if (block.split("\n").every((l) => /^[-•]\s/.test(l.trim()))) {
      return (
        <ul key={i} className="my-5 list-disc pl-6 space-y-2 text-[16px] lg:text-[17px] leading-[1.7]">
          {block.split("\n").map((line, j) => (
            <li key={j}>{inline(line.replace(/^[-•]\s/, ""))}</li>
          ))}
        </ul>
      );
    }
    return (
      <p
        key={i}
        className="my-5 text-[16px] lg:text-[17px] leading-[1.75] text-foreground/85"
      >
        {inline(block)}
      </p>
    );
  });
}

// Tiny inline-format helper for **bold** and *italic*.
function inline(text: string): React.ReactNode {
  // Bold first
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {p.slice(2, -2)}
        </strong>
      );
    }
    // Italic in this segment
    const italicParts = p.split(/(\*[^*]+\*)/g);
    return italicParts.map((q, j) => {
      if (q.startsWith("*") && q.endsWith("*")) {
        return (
          <em key={`${i}-${j}`} className="italic">
            {q.slice(1, -1)}
          </em>
        );
      }
      return <span key={`${i}-${j}`}>{q}</span>;
    });
  });
}

export default function BlogDetailPage() {
  const [, params] = useRoute<{ slug: string }>("/blog/:slug");
  const slug = params?.slug;

  const { data: post, isLoading } = useQuery<PublicBlogPost>({
    queryKey: ["/api/public/blog", slug],
    enabled: !!slug,
  });

  const { data: allPosts } = useQuery<PublicBlogPost[]>({
    queryKey: ["/api/public/blog"],
    enabled: !!post,
  });

  if (isLoading) {
    return (
      <PublicLayout>
        <div className="max-w-[800px] mx-auto px-6 py-16 space-y-4">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="aspect-[16/9] w-full" />
        </div>
      </PublicLayout>
    );
  }

  if (!post) {
    return (
      <PublicLayout>
        <div className="max-w-[700px] mx-auto px-6 py-32 text-center">
          <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
            POST NOT FOUND
          </div>
          <h1 className="mt-4 font-serif text-4xl">
            That post has been moved or unpublished
          </h1>
          <Link href="/blog" className="inline-block mt-8 font-display text-[11px] tracking-[0.22em] underline">
              ← BACK TO THE JOURNAL
            
          </Link>
        </div>
      </PublicLayout>
    );
  }

  const related = (allPosts ?? [])
    .filter((p) => p.slug !== post.slug)
    .slice(0, 3);
  // An attached video takes the hero slot, with the hero image as its poster.
  const heroVideo = parseVideoUrl(post.videoUrl);

  return (
    <PublicLayout>
      <article>
        {/* Editorial header */}
        <section className="max-w-[800px] mx-auto px-6 pt-12 lg:pt-16">
          <Link href="/blog" className="inline-flex items-center gap-1.5 font-display text-[11px] tracking-[0.22em] text-muted-foreground hover:text-foreground"
              data-testid="link-back-to-journal">
              <ChevronLeft className="w-3 h-3" strokeWidth={1.8} />
              BACK TO THE JOURNAL
            
          </Link>
          <div className="mt-8 font-display text-[11px] tracking-[0.32em] text-muted-foreground">
            {post.category.toUpperCase()}
          </div>
          <h1
            className="mt-4 font-serif text-[40px] lg:text-[64px] leading-[1.05]"
            data-testid="text-blog-title"
          >
            {post.title}
          </h1>
          <p className="mt-6 font-serif text-[20px] lg:text-[22px] leading-[1.5] text-foreground/75 italic">
            {post.excerpt}
          </p>
          <div className="mt-8 pt-6 border-t border-border flex items-center gap-4 text-[13px] text-muted-foreground">
            <div className="font-medium text-foreground">{post.authorName}</div>
            <span>·</span>
            <span>{fmtDate(post.publishedAt)}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="w-3 h-3" strokeWidth={1.8} />
              {post.readMinutes} min read
            </span>
          </div>
        </section>

        {/* Hero image, or the attached video with the hero image as poster */}
        <section className="max-w-[1100px] mx-auto px-4 lg:px-8 mt-12">
          {heroVideo ? (
            <VideoEmbed
              video={heroVideo}
              title={post.title}
              poster={heroFor(post)}
              className="shadow-2xl"
            />
          ) : (
            <div className="aspect-[16/9] rounded-sm overflow-hidden bg-secondary">
              <img
                src={heroFor(post)}
                onError={(e) => ((e.target as HTMLImageElement).src = BLOG_FALLBACK_HERO)}
                alt={post.heroImageAlt || post.title}
                className="w-full h-full object-cover"
              />
            </div>
          )}
        </section>

        {/* Body */}
        <section className="max-w-[720px] mx-auto px-6 mt-14 lg:mt-20">
          <div data-testid="blog-body">{renderBody(post.body, post.title)}</div>
        </section>

        {/* Author / CTA */}
        <section className="max-w-[800px] mx-auto px-6 mt-16">
          <div className="bg-secondary/40 rounded-sm p-8 lg:p-10">
            <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
              ABOUT THE AUTHOR
            </div>
            <div className="mt-3 font-serif text-2xl">{post.authorName}</div>
            <p className="mt-3 text-[14.5px] leading-[1.7] text-foreground/85">
              REALTOR® at Rivers Real Estate · Synterra Realty. Spencer
              represents buyers and sellers across Calgary's luxury communities
              — Springbank Hill, Aspen Woods, Upper Mount Royal, Elbow Park,
              Britannia, and Bel-Aire.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <a
                href={SPENCER_PHONE_HREF}
                className="inline-flex items-center gap-2 px-4 py-2.5 border border-border rounded-sm font-display text-[11px] tracking-[0.22em] hover:bg-background transition-colors"
              >
                <Phone className="w-3.5 h-3.5" strokeWidth={1.8} />
                {SPENCER_PHONE}
              </a>
              <a
                href={SPENCER_EMAIL_HREF}
                className="inline-flex items-center gap-2 px-4 py-2.5 border border-border rounded-sm font-display text-[11px] tracking-[0.22em] hover:bg-background transition-colors"
              >
                <Mail className="w-3.5 h-3.5" strokeWidth={1.8} />
                EMAIL SPENCER
              </a>
              <Link href="/contact">
                  <Button
                    className="h-[42px] rounded-sm font-display text-[11px] tracking-[0.22em]"
                    data-testid="button-blog-cta-contact"
                  >
                    GET IN TOUCH
                  </Button>
                
              </Link>
            </div>
          </div>
        </section>
      </article>

      {/* Related */}
      {related.length > 0 && (
        <section className="max-w-[1300px] mx-auto px-6 lg:px-10 py-20 lg:py-28">
          <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">
            KEEP READING
          </div>
          <h2 className="mt-3 font-serif text-3xl lg:text-4xl">
            More from the journal
          </h2>
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-12">
            {related.map((p) => (
              <Link key={p.slug} href={`/blog/${p.slug}`} className="group block"
                  data-testid={`related-post-${p.slug}`}>
                  <div className="relative aspect-[4/3] rounded-sm overflow-hidden bg-secondary">
                    <img
                      src={heroFor(p)}
                      onError={(e) => ((e.target as HTMLImageElement).src = BLOG_FALLBACK_HERO)}
                      alt={p.heroImageAlt || p.title}
                      loading="lazy"
                      className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                    />
                  </div>
                  <div className="mt-5">
                    <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                      {p.category.toUpperCase()}
                    </div>
                    <h3 className="mt-2 font-serif text-xl leading-[1.2]">
                      {p.title}
                    </h3>
                  </div>
                
              </Link>
            ))}
          </div>
        </section>
      )}
    </PublicLayout>
  );
}
