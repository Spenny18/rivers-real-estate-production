/**
 * Homepage block renderer.
 *
 * Every section of the public homepage is a block whose copy, images, links
 * and list items come from the CMS (/admin/home). The block-type registry
 * and factory defaults live in shared/home-content.ts; this file maps a
 * block's `type` to the React section that draws it.
 *
 * Design rules for adding a block type:
 *   - read every value out of `data` (it is normalised server-side, so all
 *     fields are present and correctly typed — no optional chaining needed)
 *   - honour the shared style settings by rendering inside <BlockSection>
 *   - keep the markup identical to what shipped by hand, so switching a
 *     hardcoded section over to the CMS is a no-op visually
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowRight,
  Award,
  Briefcase,
  Building2,
  Check,
  Clock,
  Compass,
  Eye,
  Handshake,
  Heart,
  Home,
  Instagram,
  Key,
  LineChart,
  Mail,
  MapPin,
  Phone,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ListingCard } from "@/components/listing-card";
import { YouTubeEmbed } from "@/components/youtube-embed";
import { youtubeIdFrom } from "@shared/youtube";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { formatPriceCompact } from "@/lib/format";
import type { PageBlock } from "@shared/home-content";
import type {
  PublicMlsListing,
  PublicNeighbourhood,
  PublicBlogPost,
  PublicTestimonial,
  PublicStats,
} from "@/lib/mls-types";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Icons offered by the CMS icon picker (ICON_CHOICES in shared/home-content). */
export const ICONS: Record<string, LucideIcon> = {
  Award,
  ShieldCheck,
  Eye,
  Sparkles,
  Home,
  Heart,
  Compass,
  Building2,
  TrendingUp,
  Users,
  Briefcase,
  MapPin,
  Star,
  Check,
  Key,
  Phone,
  Mail,
  Clock,
  LineChart,
  Handshake,
};

function iconFor(name: unknown): LucideIcon {
  return ICONS[String(name)] ?? Sparkles;
}

const SPACING: Record<string, string> = {
  compact: "py-16 lg:py-24",
  normal: "py-20 lg:py-32",
  spacious: "py-24 lg:py-36",
};

const VISIBILITY: Record<string, string> = {
  all: "",
  desktop: "hidden lg:block",
  mobile: "lg:hidden",
};

function backgroundClasses(bg: string): string {
  if (bg === "dark") return "bg-black text-white";
  if (bg === "muted") return "bg-secondary/30 border-y border-border";
  return "bg-background";
}

/** Colour choices that flip when a block sits on the black background. */
function tone(dark: boolean) {
  return {
    eyebrow: dark ? "text-white/55" : "text-muted-foreground",
    muted: dark ? "text-white/70" : "text-muted-foreground",
    subtle: dark ? "text-white/55" : "text-muted-foreground",
    border: dark ? "border-white/20" : "border-border",
    divide: dark ? "divide-white/15" : "divide-border",
    card: dark ? "bg-white/[0.04] border-white/15" : "bg-card border-border",
    plain: dark ? "bg-white/[0.04] border-white/15" : "bg-background border-border",
    solid: dark ? "bg-white text-black" : "bg-foreground text-background",
    outline: dark ? "border border-white text-white" : "border border-foreground",
    link: dark ? "text-white" : "text-foreground",
  };
}

interface BlockChrome {
  bg?: string;
  spacing?: string;
  visibility?: string;
  anchor?: string;
}

function BlockSection({
  data,
  testid,
  className = "",
  children,
}: {
  data: BlockChrome;
  testid: string;
  className?: string;
  children: React.ReactNode;
}) {
  const bg = data.bg ?? "default";
  return (
    <section
      id={data.anchor || undefined}
      data-testid={testid}
      className={[
        SPACING[data.spacing ?? "normal"] ?? SPACING.normal,
        backgroundClasses(bg),
        VISIBILITY[data.visibility ?? "all"] ?? "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </section>
  );
}

const SHELL = "max-w-[1400px] mx-auto px-6 lg:px-10";

/** Eyebrow + heading + optional body — the header most blocks open with. */
function SectionHeader({
  eyebrow,
  heading,
  body,
  dark,
  center,
  className = "",
}: {
  eyebrow?: string;
  heading?: string;
  body?: string;
  dark: boolean;
  center?: boolean;
  className?: string;
}) {
  const t = tone(dark);
  if (!eyebrow && !heading && !body) return null;
  return (
    <div className={`${center ? "text-center mx-auto" : ""} ${className}`}>
      {eyebrow ? (
        <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
          {eyebrow}
        </div>
      ) : null}
      {heading ? (
        <h2 className="font-serif text-[36px] lg:text-[52px] leading-[1.05] tracking-tight">
          {heading}
        </h2>
      ) : null}
      {body ? (
        <p className={`mt-6 text-[15px] lg:text-[17px] ${t.muted} leading-relaxed`}>
          {body}
        </p>
      ) : null}
    </div>
  );
}

/** Text link with the sliding arrow used throughout the page. */
function ArrowLink({
  href,
  label,
  className = "",
  testid,
}: {
  href: string;
  label: string;
  className?: string;
  testid?: string;
}) {
  if (!label || !href) return null;
  return (
    <Link
      href={href}
      data-testid={testid}
      className={`inline-flex items-center gap-2 font-display text-[11px] tracking-[0.22em] hover:gap-3 transition-all ${className}`}
    >
      {label}
      <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.6} />
    </Link>
  );
}

/** Internal routes go through wouter; anything external gets a plain anchor. */
function SmartLink({
  href,
  className,
  children,
  testid,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
  testid?: string;
}) {
  const external = /^(https?:)?\/\//i.test(href) || href.startsWith("mailto:") || href.startsWith("tel:");
  if (external) {
    return (
      <a
        href={href}
        className={className}
        data-testid={testid}
        target={href.startsWith("http") ? "_blank" : undefined}
        rel={href.startsWith("http") ? "noreferrer" : undefined}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className} data-testid={testid}>
      {children}
    </Link>
  );
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// ---------------------------------------------------------------------------
// Data the blocks draw from — fetched once by HomePage and passed down
// ---------------------------------------------------------------------------

export interface BlockContext {
  listings: PublicMlsListing[];
  listingsLoading: boolean;
  neighbourhoods: PublicNeighbourhood[];
  posts: PublicBlogPost[];
  testimonials: PublicTestimonial[];
  stats: PublicStats | undefined;
}

type Data = Record<string, any>;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function HeroBlock({ data }: { data: Data }) {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [priceRange, setPriceRange] = useState<string>("any");
  const [propertyType, setPropertyType] = useState<string>("any");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (priceRange !== "any") {
      const [min, max] = priceRange.split("-");
      if (min) params.set("minPrice", min);
      if (max && max !== "+") params.set("maxPrice", max);
    }
    if (propertyType !== "any") params.set("propertyType", propertyType);
    setLocation(`/mls?${params.toString()}`);
  };

  // The overlay is a single dark wash whose strength the CMS controls; the
  // top/bottom falloff stays fixed so the headline always keeps contrast.
  const overlay = Math.min(100, Math.max(0, Number(data.overlay) || 0)) / 100;

  return (
    <section
      id={data.anchor || undefined}
      className="relative min-h-[88dvh] lg:min-h-[100dvh] flex flex-col"
      data-testid="section-hero"
    >
      <div className="absolute inset-0">
        {data.backgroundImage ? (
          <img
            src={data.backgroundImage}
            alt={data.backgroundAlt || ""}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-black" />
        )}
        <div
          className="absolute inset-0 bg-gradient-to-b from-black/65 via-black/40 to-black/85"
          style={{ opacity: 0.4 + overlay * 0.9 }}
        />
      </div>

      <div className="relative flex-1 flex flex-col justify-center max-w-[1400px] w-full mx-auto px-6 lg:px-10 pt-20 lg:pt-32 pb-16">
        {data.eyebrow ? (
          <div className="font-display text-[11px] tracking-[0.32em] text-white/80 mb-6">
            {data.eyebrow}
          </div>
        ) : null}

        <h1
          className="font-serif text-white max-w-3xl text-[44px] sm:text-[56px] lg:text-[80px] leading-[0.96] tracking-tight"
          data-testid="hero-headline"
        >
          {data.headline}
        </h1>

        {data.subheadline ? (
          <p className="mt-8 max-w-2xl text-white/85 text-[16px] lg:text-[18px] leading-relaxed">
            {data.subheadline}
          </p>
        ) : null}

        {data.showSearch ? (
          <form
            onSubmit={submit}
            className="mt-10 lg:mt-14 max-w-4xl bg-white/95 backdrop-blur-sm rounded-sm shadow-2xl border border-white/20 p-2 grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-2"
            data-testid="hero-search-form"
          >
            <div className="relative flex items-center">
              <Search
                className="absolute left-3 w-4 h-4 text-muted-foreground"
                strokeWidth={1.6}
              />
              <Input
                placeholder={data.searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-11 border-transparent bg-transparent focus-visible:bg-background focus-visible:ring-0 text-[14px]"
                data-testid="input-hero-search"
              />
            </div>
            <Select value={priceRange} onValueChange={setPriceRange}>
              <SelectTrigger
                className="h-11 border-transparent bg-transparent text-[13px] md:w-[160px]"
                data-testid="select-hero-price"
              >
                <SelectValue placeholder="Any price" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any price</SelectItem>
                <SelectItem value="0-1500000">Up to $1.5M</SelectItem>
                <SelectItem value="1500000-2500000">$1.5M – $2.5M</SelectItem>
                <SelectItem value="2500000-4000000">$2.5M – $4M</SelectItem>
                <SelectItem value="4000000-6000000">$4M – $6M</SelectItem>
                <SelectItem value="6000000-+">$6M +</SelectItem>
              </SelectContent>
            </Select>
            <Select value={propertyType} onValueChange={setPropertyType}>
              <SelectTrigger
                className="h-11 border-transparent bg-transparent text-[13px] md:w-[160px]"
                data-testid="select-hero-type"
              >
                <SelectValue placeholder="Any type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any type</SelectItem>
                <SelectItem value="Detached">Detached</SelectItem>
                <SelectItem value="Semi-Detached">Semi-Detached</SelectItem>
                <SelectItem value="Townhouse">Townhouse</SelectItem>
                <SelectItem value="Apartment">Apartment</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="submit"
              size="lg"
              className="h-11 font-display text-[11px] tracking-[0.18em] bg-black text-white hover:bg-black/90"
              data-testid="button-hero-search"
            >
              {data.searchButtonLabel}
            </Button>
          </form>
        ) : null}

        {data.footnote ? (
          <div className="mt-6 text-[12px] text-white/70 font-display tracking-[0.16em]">
            {data.footnote}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RecentSalesBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items);
  return (
    <BlockSection data={data} testid="section-recent-sales">
      <div className={SHELL}>
        <div className="flex items-end justify-between gap-6 mb-12 lg:mb-16">
          <div>
            {data.eyebrow ? (
              <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
                {data.eyebrow}
              </div>
            ) : null}
            <h2 className="font-serif text-[36px] lg:text-[52px] leading-[1.05] tracking-tight max-w-2xl">
              {data.heading}
            </h2>
          </div>
          <ArrowLink
            href={data.ctaHref}
            label={data.ctaLabel}
            className={`hidden md:inline-flex ${t.link}`}
            testid="link-view-more-sold"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {items.map((s, i) => (
            <div key={`${s.address}-${i}`} className="group">
              <div className="relative aspect-[4/3] overflow-hidden rounded-sm bg-secondary">
                {s.image ? (
                  <img
                    src={s.image}
                    alt={s.address}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                  />
                ) : null}
                {s.badge ? (
                  <div className="absolute top-4 left-4 px-3 py-1.5 bg-black/85 text-white font-display text-[10px] tracking-[0.22em] rounded-sm">
                    {s.badge}
                  </div>
                ) : null}
              </div>
              <div className="mt-5 font-serif text-[22px] lg:text-[24px] leading-tight">
                {s.address}
              </div>
              {s.caption ? (
                <div className={`mt-2 font-display text-[10px] tracking-[0.22em] ${t.eyebrow}`}>
                  {String(s.caption).toUpperCase()}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {data.ctaLabel && data.ctaHref ? (
          <div className="mt-10 md:hidden text-center">
            <ArrowLink href={data.ctaHref} label={data.ctaLabel} className={t.link} />
          </div>
        ) : null}
      </div>
    </BlockSection>
  );
}

function AuthorityBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const imageLeft = data.imagePosition !== "right";
  return (
    <BlockSection data={data} testid="section-authority">
      <div className={`${SHELL} grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-20 items-center`}>
        <div
          className={`lg:col-span-5 order-2 ${imageLeft ? "lg:order-1" : "lg:order-2"}`}
        >
          <div className="aspect-[4/5] overflow-hidden rounded-sm bg-secondary">
            {data.image ? (
              <img
                src={data.image}
                alt={data.imageAlt || ""}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            ) : null}
          </div>
        </div>
        <div
          className={`lg:col-span-7 order-1 ${imageLeft ? "lg:order-2" : "lg:order-1"}`}
        >
          {data.eyebrow ? (
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
              {data.eyebrow}
            </div>
          ) : null}
          <h2 className="font-serif text-[36px] lg:text-[56px] leading-[1.04] tracking-tight">
            {data.heading}
          </h2>
          {data.body ? (
            <p className={`mt-6 text-[15px] lg:text-[17px] ${t.muted} leading-relaxed`}>
              {data.body}
            </p>
          ) : null}
          <div className="mt-8 flex flex-wrap gap-4">
            {data.primaryLabel && data.primaryHref ? (
              <SmartLink
                href={data.primaryHref}
                className={`inline-flex items-center gap-2 px-6 h-12 ${t.solid} font-display text-[11px] tracking-[0.22em]`}
                testid="link-authority-primary"
              >
                {data.primaryLabel}
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.6} />
              </SmartLink>
            ) : null}
            {data.secondaryLabel && data.secondaryHref ? (
              <SmartLink
                href={data.secondaryHref}
                className={`inline-flex items-center gap-2 px-6 h-12 ${t.outline} font-display text-[11px] tracking-[0.22em]`}
                testid="link-authority-secondary"
              >
                {data.secondaryLabel}
              </SmartLink>
            ) : null}
          </div>
        </div>
      </div>
    </BlockSection>
  );
}

function ChecklistBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<string>(data.items);
  return (
    <BlockSection data={data} testid="section-checklist">
      <div className={SHELL}>
        <SectionHeader
          eyebrow={data.eyebrow}
          heading={data.heading}
          body={data.body}
          dark={dark}
          className="max-w-3xl mb-14 lg:mb-20"
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8 max-w-4xl">
          {items.map((p, i) => (
            <div key={`${p}-${i}`} className="flex items-start gap-4">
              <span
                className={`mt-1 w-7 h-7 flex-shrink-0 rounded-full ${t.solid} flex items-center justify-center`}
              >
                <Check className="w-3.5 h-3.5" strokeWidth={2.4} />
              </span>
              <p className="text-[15px] lg:text-[16px] leading-relaxed">{p}</p>
            </div>
          ))}
        </div>

        {data.ctaLabel && data.ctaHref ? (
          <div className="mt-12">
            <SmartLink
              href={data.ctaHref}
              className={`inline-flex items-center gap-2 px-6 h-12 ${t.solid} font-display text-[11px] tracking-[0.22em]`}
              testid="link-checklist-cta"
            >
              {data.ctaLabel}
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.6} />
            </SmartLink>
          </div>
        ) : null}
      </div>
    </BlockSection>
  );
}

function StatsBandBlock({ data, ctx }: { data: Data; ctx: BlockContext }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items);
  return (
    <BlockSection data={data} testid="section-stats" className="border-y border-border">
      <div className={`${SHELL} grid grid-cols-2 lg:grid-cols-4 gap-y-10 gap-x-6`}>
        {items.map((it, i) => {
          const value =
            it.source === "activeListings"
              ? (ctx.stats?.activeListings ?? it.value ?? "—")
              : it.value;
          return (
            <div key={`${it.label}-${i}`} className="text-center lg:text-left">
              <div
                className="font-serif text-[40px] lg:text-[56px] leading-none tabular-nums"
                data-testid={`stat-${String(it.label).toLowerCase().replace(/\s/g, "-")}`}
              >
                {value}
              </div>
              <div
                className={`mt-2 lg:mt-3 font-display text-[10px] lg:text-[11px] tracking-[0.22em] ${t.eyebrow}`}
              >
                {String(it.label).toUpperCase()}
              </div>
            </div>
          );
        })}
      </div>
    </BlockSection>
  );
}

function FeaturedListingsBlock({ data, ctx }: { data: Data; ctx: BlockContext }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const limit = Number(data.limit) || 6;
  const listings = ctx.listings.slice(0, limit);
  return (
    <BlockSection data={data} testid="section-featured">
      <div className={SHELL}>
        <div className="flex items-end justify-between gap-6 mb-12 lg:mb-16">
          <div>
            {data.eyebrow ? (
              <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
                {data.eyebrow}
              </div>
            ) : null}
            <h2 className="font-serif text-[36px] lg:text-[52px] leading-[1.05] tracking-tight max-w-2xl">
              {data.heading}
            </h2>
          </div>
          <ArrowLink
            href={data.ctaHref}
            label={data.ctaLabel}
            className={`hidden md:inline-flex ${t.link}`}
            testid="link-view-all-listings"
          />
        </div>

        {ctx.listingsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
            {Array.from({ length: limit }).map((_, i) => (
              <Skeleton key={i} className="aspect-[5/4]" />
            ))}
          </div>
        ) : listings.length === 0 ? (
          <div className={`border ${t.border} rounded-sm p-12 text-center`}>
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow}`}>
              {data.emptyHeading}
            </div>
            <p className={`mt-4 text-sm ${t.muted}`}>{data.emptyBody}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
            {listings.map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </div>
        )}

        {data.ctaLabel && data.ctaHref ? (
          <div className="mt-10 md:hidden text-center">
            <ArrowLink href={data.ctaHref} label={data.ctaLabel} className={t.link} />
          </div>
        ) : null}
      </div>
    </BlockSection>
  );
}

function NeighbourhoodCardsBlock({ data, ctx }: { data: Data; ctx: BlockContext }) {
  const dark = data.bg === "dark";
  const limit = Number(data.limit) || 0;
  const hoods = limit > 0 ? ctx.neighbourhoods.slice(0, limit) : ctx.neighbourhoods;
  return (
    <BlockSection data={data} testid="section-neighbourhoods">
      <div className={SHELL}>
        <SectionHeader
          eyebrow={data.eyebrow}
          heading={data.heading}
          body={data.body}
          dark={dark}
          className="max-w-3xl mb-14 lg:mb-20"
        />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
          {hoods.map((n) => (
            <Link
              key={n.slug}
              href={`/neighbourhoods/${n.slug}`}
              className="group relative block aspect-[5/6] overflow-hidden rounded-sm bg-black"
              data-testid={`card-neighbourhood-${n.slug}`}
            >
              <img
                src={n.heroImage}
                alt={`${n.name} homes for sale`}
                loading="lazy"
                className="w-full h-full object-cover opacity-75 transition-all duration-700 group-hover:scale-[1.04] group-hover:opacity-90"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 p-7 lg:p-8 text-white">
                <div className="font-display text-[10px] tracking-[0.22em] text-white/65 mb-2">
                  {formatPriceCompact(n.avgPrice)} AVG
                </div>
                <div className="font-serif text-[28px] lg:text-[32px] leading-none">
                  {n.name}
                </div>
                <div className="mt-3 text-[13px] text-white/80 leading-snug line-clamp-2">
                  {n.tagline}
                </div>
                <div className="mt-5 inline-flex items-center gap-2 font-display text-[10px] tracking-[0.22em] text-white">
                  EXPLORE
                  <ArrowRight
                    className="w-3 h-3 transition-transform group-hover:translate-x-1"
                    strokeWidth={1.8}
                  />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </BlockSection>
  );
}

function NeighbourhoodLinksBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items);
  return (
    <BlockSection data={data} testid="section-nbhd-grid">
      <div className={SHELL}>
        <SectionHeader
          eyebrow={data.eyebrow}
          heading={data.heading}
          body={data.body}
          dark={dark}
          className="max-w-3xl mb-12 lg:mb-16"
        />

        <div className={`grid grid-cols-1 md:grid-cols-3 gap-px ${dark ? "bg-white/15" : "bg-border"} border ${t.border}`}>
          {items.map((n, i) => (
            <Link
              key={`${n.slug}-${i}`}
              href={`/neighbourhoods/${n.slug}`}
              className={`group flex items-center justify-between px-6 py-5 lg:py-6 ${
                dark ? "bg-black hover:bg-white/5" : "bg-background hover:bg-secondary/40"
              } transition-colors`}
              data-testid={`link-nbhd-${n.slug}`}
            >
              <span className="font-serif text-[20px] lg:text-[22px]">{n.name}</span>
              <ArrowRight
                className={`w-4 h-4 ${t.subtle} group-hover:translate-x-1 transition-all`}
                strokeWidth={1.4}
              />
            </Link>
          ))}
        </div>

        {data.ctaLabel && data.ctaHref ? (
          <div className="mt-10 text-center">
            <ArrowLink
              href={data.ctaHref}
              label={data.ctaLabel}
              className={t.link}
              testid="link-view-all-nbhds"
            />
          </div>
        ) : null}
      </div>
    </BlockSection>
  );
}

function NumberedListBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items);
  return (
    <BlockSection data={data} testid="section-numbered-list">
      <div className={SHELL}>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-20">
          <div className="lg:col-span-5">
            <SectionHeader
              eyebrow={data.eyebrow}
              heading={data.heading}
              body={data.body}
              dark={dark}
            />
            {data.ctaLabel && data.ctaHref ? (
              <ArrowLink
                href={data.ctaHref}
                label={data.ctaLabel}
                className={`mt-8 ${t.link}`}
                testid="link-numbered-cta"
              />
            ) : null}
          </div>

          <div className={`lg:col-span-7 divide-y ${t.divide} border-y ${t.border}`}>
            {items.map((z, i) => (
              <div key={`${z.name}-${i}`} className="py-6 lg:py-7 grid grid-cols-[40px_1fr] gap-5">
                <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} pt-1.5`}>
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div>
                  <h3 className="font-serif text-[22px] lg:text-[24px] leading-tight">
                    {z.name}
                  </h3>
                  {z.summary ? (
                    <p className={`mt-2 text-[14px] ${t.muted} leading-relaxed`}>{z.summary}</p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </BlockSection>
  );
}

function VideoBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  // A pasted URL is as good as the bare id (the field asks for the id).
  const id = youtubeIdFrom(data.youtubeId) ?? "";
  return (
    <BlockSection data={data} testid="section-video">
      <div className="max-w-[1100px] mx-auto px-6 lg:px-10 text-center">
        {data.eyebrow ? (
          <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
            {data.eyebrow}
          </div>
        ) : null}
        <h2 className="font-serif text-[32px] lg:text-[48px] leading-[1.08] tracking-tight max-w-3xl mx-auto">
          {data.heading}
        </h2>

        {id ? (
          <YouTubeEmbed
            id={id}
            title={data.videoTitle || data.heading || "Video"}
            poster={data.thumbnail || undefined}
            className="mt-12 lg:mt-16 rounded-sm shadow-2xl"
            testid="section-video-embed"
          />
        ) : null}

        {data.body ? (
          <p className={`mt-10 lg:mt-12 max-w-2xl mx-auto text-[15px] ${t.muted} leading-relaxed`}>
            {data.body}
          </p>
        ) : null}
      </div>
    </BlockSection>
  );
}

function BigStatsBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items);
  return (
    <BlockSection data={data} testid="section-big-stats">
      <div className={SHELL}>
        <div className="text-center max-w-3xl mx-auto mb-16 lg:mb-20">
          {data.eyebrow ? (
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
              {data.eyebrow}
            </div>
          ) : null}
          <h2 className="font-serif text-[32px] lg:text-[48px] leading-[1.08] tracking-tight">
            {data.heading}
          </h2>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-y-14 gap-x-6 lg:gap-x-10">
          {items.map((s, i) => (
            <div key={`${s.label}-${i}`} className="text-center">
              <div className="font-serif text-[44px] lg:text-[72px] leading-none tabular-nums">
                {s.value}
              </div>
              <div
                className={`mt-4 font-display text-[10px] lg:text-[11px] tracking-[0.22em] ${
                  dark ? "text-white/75" : "text-muted-foreground"
                }`}
              >
                {String(s.label).toUpperCase()}
              </div>
              {s.sub ? (
                <div className={`mt-2 text-[12px] ${t.subtle} leading-relaxed`}>{s.sub}</div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </BlockSection>
  );
}

function TabCards({ cards, dark }: { cards: Data[]; dark: boolean }) {
  const t = tone(dark);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
      {cards.map((c, i) => (
        <div
          key={`${c.title}-${i}`}
          className={`border rounded-sm p-7 lg:p-8 ${t.card} hover:border-foreground/40 transition-colors`}
        >
          <div className={`font-display text-[10px] tracking-[0.22em] ${t.eyebrow}`}>
            {String(c.title).toUpperCase()}
          </div>
          {c.problem ? (
            <p className="mt-4 font-serif text-[18px] leading-snug italic text-foreground/85">
              “{c.problem}”
            </p>
          ) : null}
          {c.solution ? (
            <p className={`mt-5 text-[14px] ${t.muted} leading-relaxed`}>{c.solution}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function BuyerSellerTabsBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const results = asArray<Data>(data.results);
  return (
    <BlockSection data={data} testid="section-buyer-seller-tabs">
      <div className={SHELL}>
        <div className="text-center max-w-3xl mx-auto mb-12 lg:mb-16">
          {data.eyebrow ? (
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
              {data.eyebrow}
            </div>
          ) : null}
          <h2 className="font-serif text-[36px] lg:text-[56px] leading-[1.04] tracking-tight">
            {data.heading}
          </h2>
        </div>

        <Tabs defaultValue="buyer" className="w-full">
          <TabsList className="mx-auto flex w-fit bg-secondary/60 p-1 rounded-sm">
            <TabsTrigger
              value="buyer"
              className="px-8 py-2.5 font-display text-[11px] tracking-[0.22em] data-[state=active]:bg-foreground data-[state=active]:text-background"
              data-testid="tab-buyer"
            >
              {data.buyerTabLabel}
            </TabsTrigger>
            <TabsTrigger
              value="seller"
              className="px-8 py-2.5 font-display text-[11px] tracking-[0.22em] data-[state=active]:bg-foreground data-[state=active]:text-background"
              data-testid="tab-seller"
            >
              {data.sellerTabLabel}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="buyer" className="mt-12 lg:mt-16">
            <TabCards cards={asArray<Data>(data.buyerCards)} dark={dark} />
          </TabsContent>

          <TabsContent value="seller" className="mt-12 lg:mt-16">
            <TabCards cards={asArray<Data>(data.sellerCards)} dark={dark} />

            {results.length > 0 ? (
              <div className={`mt-16 lg:mt-20 border ${dark ? "border-white" : "border-foreground"} rounded-sm p-8 lg:p-12 ${t.card}`}>
                {data.resultsEyebrow ? (
                  <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-2`}>
                    {data.resultsEyebrow}
                  </div>
                ) : null}
                <h3 className="font-serif text-[26px] lg:text-[36px] leading-tight">
                  {data.resultsHeading}
                </h3>
                <div className="mt-10 grid grid-cols-2 lg:grid-cols-4 gap-y-8 gap-x-6">
                  {results.map((r, i) => (
                    <div key={`${r.label}-${i}`}>
                      <div className="font-serif text-[32px] lg:text-[44px] leading-none tabular-nums">
                        {r.value}
                      </div>
                      <div className={`mt-3 font-display text-[10px] tracking-[0.22em] ${t.eyebrow}`}>
                        {String(r.label).toUpperCase()}
                      </div>
                      {r.sub ? (
                        <div className={`mt-1 text-[12px] ${t.subtle}`}>{r.sub}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>

        {data.ctaLabel && data.ctaHref ? (
          <div className="mt-12 lg:mt-16 text-center">
            <SmartLink
              href={data.ctaHref}
              className={`inline-flex items-center gap-2 px-7 h-12 ${t.solid} font-display text-[11px] tracking-[0.22em]`}
              testid="link-tabs-cta"
            >
              {data.ctaLabel}
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.6} />
            </SmartLink>
          </div>
        ) : null}
      </div>
    </BlockSection>
  );
}

function IconPointsBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items);
  return (
    <BlockSection data={data} testid="section-icon-points">
      <div className={`${SHELL} grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-20`}>
        <div className="lg:col-span-5">
          {data.eyebrow ? (
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
              {data.eyebrow}
            </div>
          ) : null}
          <h2 className="font-serif text-[36px] lg:text-[52px] leading-[1.05] tracking-tight">
            {data.heading}
          </h2>
          {data.body ? (
            <p className={`mt-8 text-[15px] lg:text-[16px] ${t.muted} leading-relaxed`}>
              {data.body}
            </p>
          ) : null}
          {data.ctaLabel && data.ctaHref ? (
            <ArrowLink
              href={data.ctaHref}
              label={data.ctaLabel}
              className={`mt-10 ${t.link}`}
              testid="link-icon-points-cta"
            />
          ) : null}
        </div>

        <div className={`lg:col-span-7 grid gap-px ${dark ? "bg-white/15" : "bg-border"}`}>
          {items.map((point, i) => {
            const Icon = iconFor(point.icon);
            return (
              <div
                key={`${point.title}-${i}`}
                className={`${dark ? "bg-black" : "bg-background"} p-8 lg:p-10 ${
                  i === 0 ? "" : `border-t ${t.border}`
                }`}
              >
                <Icon className="w-6 h-6" strokeWidth={1.4} />
                <h3 className="mt-5 font-serif text-[22px] lg:text-[26px] leading-tight">
                  {point.title}
                </h3>
                {point.body ? (
                  <p className={`mt-4 text-[14px] ${t.muted} leading-relaxed`}>{point.body}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </BlockSection>
  );
}

function CardGridBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items);
  const cols = data.columns === "3" ? "lg:grid-cols-3" : "lg:grid-cols-4";
  return (
    <BlockSection data={data} testid="section-card-grid">
      <div className={SHELL}>
        <SectionHeader
          eyebrow={data.eyebrow}
          heading={data.heading}
          body={data.body}
          dark={dark}
          center
          className="max-w-3xl mb-14 lg:mb-20"
        />
        <div className={`grid grid-cols-1 md:grid-cols-2 ${cols} gap-5 lg:gap-6`}>
          {items.map((card, i) => {
            const Icon = iconFor(card.icon);
            return (
              <SmartLink
                key={`${card.title}-${i}`}
                href={card.href || "#"}
                className={`group block border rounded-sm p-7 lg:p-8 ${t.card} hover:border-foreground/40 transition-colors`}
                testid={`card-segment-${String(card.title).toLowerCase().replace(/\s/g, "-")}`}
              >
                <Icon className="w-6 h-6" strokeWidth={1.4} />
                <h3 className="mt-5 font-serif text-[20px] leading-tight">{card.title}</h3>
                {card.body ? (
                  <p className={`mt-3 text-[13px] ${t.muted} leading-relaxed`}>{card.body}</p>
                ) : null}
                {data.linkLabel ? (
                  <div className="mt-6 inline-flex items-center gap-2 font-display text-[10px] tracking-[0.22em] group-hover:gap-3 transition-all">
                    {data.linkLabel}
                    <ArrowRight className="w-3 h-3" strokeWidth={1.8} />
                  </div>
                ) : null}
              </SmartLink>
            );
          })}
        </div>
      </div>
    </BlockSection>
  );
}

function AwardsBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<string>(data.items);
  return (
    <BlockSection data={data} testid="section-awards">
      <div className={`${SHELL} text-center`}>
        {data.eyebrow ? (
          <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-3`}>
            {data.eyebrow}
          </div>
        ) : null}
        <h2 className="font-serif text-[28px] lg:text-[40px] leading-tight">{data.heading}</h2>
        <div className="mt-10 lg:mt-14 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-y-8 gap-x-6 items-center">
          {items.map((a, i) => (
            <div
              key={`${a}-${i}`}
              className={`border ${t.border} rounded-sm px-4 py-5 lg:py-6 text-center font-display text-[10px] tracking-[0.22em] ${t.eyebrow} hover:border-foreground/40 hover:text-foreground transition-colors`}
            >
              {a.toUpperCase()}
            </div>
          ))}
        </div>
      </div>
    </BlockSection>
  );
}

function ResourceCardsBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items);
  const buttons = asArray<Data>(data.buttons);
  return (
    <BlockSection data={data} testid="section-resource-cards">
      <div className={SHELL}>
        <SectionHeader
          eyebrow={data.eyebrow}
          heading={data.heading}
          body={data.body}
          dark={dark}
          center
          className="max-w-3xl mb-14 lg:mb-20"
        />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-6">
          {items.map((r, i) => (
            <div key={`${r.title}-${i}`} className={`border rounded-sm p-7 ${t.plain}`}>
              <h3 className="font-serif text-[20px] leading-tight">{r.title}</h3>
              {r.body ? (
                <p className={`mt-3 text-[13px] ${t.muted} leading-relaxed`}>{r.body}</p>
              ) : null}
            </div>
          ))}
        </div>

        {buttons.length > 0 ? (
          <div className="mt-14 lg:mt-20 flex flex-wrap justify-center gap-4">
            {buttons.map((b, i) => (
              <SmartLink
                key={`${b.label}-${i}`}
                href={b.href || "#"}
                className={`inline-flex items-center gap-2 px-6 h-12 font-display text-[11px] tracking-[0.22em] ${
                  b.variant === "outline" ? t.outline : t.solid
                }`}
                testid={`link-resource-${i}`}
              >
                {b.label}
                {b.variant === "outline" ? null : (
                  <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.6} />
                )}
              </SmartLink>
            ))}
          </div>
        ) : null}
      </div>
    </BlockSection>
  );
}

function BlogTeaserBlock({ data, ctx }: { data: Data; ctx: BlockContext }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const posts = ctx.posts.slice(0, Number(data.limit) || 6);
  if (!posts.length) return null;
  return (
    <BlockSection data={data} testid="section-blog-teaser">
      <div className={SHELL}>
        <div className="flex items-end justify-between gap-6 mb-12 lg:mb-16">
          <div>
            {data.eyebrow ? (
              <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
                {data.eyebrow}
              </div>
            ) : null}
            <h2 className="font-serif text-[36px] lg:text-[52px] leading-[1.05] tracking-tight max-w-2xl">
              {data.heading}
            </h2>
          </div>
          <ArrowLink
            href={data.ctaHref}
            label={data.ctaLabel}
            className={`hidden md:inline-flex ${t.link}`}
            testid="link-all-posts"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-10">
          {posts.map((p) => (
            <Link
              key={p.slug}
              href={`/blog/${p.slug}`}
              className="group block"
              data-testid={`card-blog-${p.slug}`}
            >
              <div className="aspect-[4/3] overflow-hidden rounded-sm bg-secondary">
                <img
                  src={p.heroImage}
                  alt={p.title}
                  loading="lazy"
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                />
              </div>
              <div className={`mt-6 font-display text-[10px] tracking-[0.22em] ${t.eyebrow}`}>
                {p.category.toUpperCase()} · {p.readMinutes} MIN
              </div>
              <h3 className="mt-3 font-serif text-[24px] lg:text-[28px] leading-[1.15] tracking-tight">
                {p.title}
              </h3>
              <p className={`mt-3 text-[14px] ${t.muted} leading-relaxed line-clamp-3`}>
                {p.excerpt}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </BlockSection>
  );
}

function TestimonialsBlock({ data, ctx }: { data: Data; ctx: BlockContext }) {
  const [idx, setIdx] = useState(0);
  const limit = Number(data.limit) || 6;
  const visible = useMemo(() => ctx.testimonials.slice(0, limit), [ctx.testimonials, limit]);
  const dark = data.bg === "dark";
  const t = tone(dark);
  if (!visible.length) return null;
  const item = visible[idx % visible.length];

  return (
    <BlockSection data={data} testid="section-testimonials">
      <div className="max-w-[1100px] mx-auto px-6 lg:px-10 text-center">
        {data.eyebrow ? (
          <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-6`}>
            {data.eyebrow}
          </div>
        ) : null}
        <div className="flex justify-center mb-8">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={`w-4 h-4 ${
                i < item.rating
                  ? dark
                    ? "fill-white text-white"
                    : "fill-foreground text-foreground"
                  : dark
                    ? "text-white/30"
                    : "text-muted-foreground/40"
              }`}
            />
          ))}
        </div>
        <blockquote
          className="font-serif text-[26px] lg:text-[40px] leading-[1.25] tracking-tight"
          data-testid="testimonial-body"
        >
          “{item.body}”
        </blockquote>
        <div
          className={`mt-10 font-display text-[11px] tracking-[0.22em] ${
            dark ? "text-white/75" : "text-muted-foreground"
          }`}
        >
          {item.authorName.toUpperCase()}
        </div>
        <div className={`mt-2 text-[13px] ${t.subtle}`}>{item.authorRole}</div>

        {visible.length > 1 ? (
          <div className="mt-12 flex justify-center gap-2">
            {visible.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className={`w-8 h-px transition-colors ${
                  i === idx % visible.length
                    ? dark
                      ? "bg-white"
                      : "bg-foreground"
                    : dark
                      ? "bg-white/25"
                      : "bg-muted-foreground/30"
                }`}
                aria-label={`Show testimonial ${i + 1}`}
                data-testid={`testimonial-dot-${i}`}
              />
            ))}
          </div>
        ) : null}
      </div>
    </BlockSection>
  );
}

interface InstagramPost {
  image: string;
  permalink: string;
  caption: string;
}

function InstagramBlock({ data }: { data: Data }) {
  // Server-prefetched, so the tiles are in the SSR HTML. If the feed is ever
  // empty the section renders nothing — better no strip than stock photos
  // pretending to be Instagram.
  const feed = useQuery<InstagramPost[]>({ queryKey: ["/api/public/instagram"] });
  const dark = data.bg === "dark";
  const t = tone(dark);
  const posts = (feed.data ?? [])
    .filter((p) => p.image && p.permalink)
    .slice(0, Number(data.limit) || 8);
  if (posts.length === 0) return null;
  return (
    <BlockSection data={data} testid="section-instagram">
      <div className={SHELL}>
        <div className="flex items-end justify-between gap-6 mb-10 lg:mb-14 flex-wrap">
          <div>
            {data.eyebrow ? (
              <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-3`}>
                {data.eyebrow}
              </div>
            ) : null}
            <h2 className="font-serif text-[30px] lg:text-[44px] leading-[1.08] tracking-tight">
              {data.heading}
            </h2>
          </div>
          {data.buttonLabel && data.profileUrl ? (
            <a
              href={data.profileUrl}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center gap-2 px-5 h-11 ${t.solid} font-display text-[11px] tracking-[0.22em]`}
              data-testid="link-ig-follow"
            >
              <Instagram className="w-4 h-4" strokeWidth={1.6} />
              {data.buttonLabel}
            </a>
          ) : null}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 lg:gap-3">
          {posts.map((post, i) => (
            <a
              key={post.permalink}
              href={post.permalink}
              target="_blank"
              rel="noreferrer"
              className="group relative aspect-square overflow-hidden rounded-sm bg-secondary"
              data-testid={`ig-tile-${i}`}
            >
              <img
                src={post.image}
                alt={post.caption ? post.caption.slice(0, 100) : "Instagram post"}
                loading="lazy"
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                <Instagram
                  className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  strokeWidth={1.6}
                />
              </div>
            </a>
          ))}
        </div>
      </div>
    </BlockSection>
  );
}

const inquirySchema = z.object({
  name: z.string().min(2, "Please share your name"),
  email: z.string().email("Please share a valid email"),
  phone: z.string().optional(),
  message: z.string().min(10, "Tell me a little about what you're looking for"),
});
type InquiryForm = z.infer<typeof inquirySchema>;

function ContactCtaBlock({ data }: { data: Data }) {
  const { toast } = useToast();
  const dark = data.bg === "dark";
  const t = tone(dark);
  const form = useForm<InquiryForm>({
    resolver: zodResolver(inquirySchema),
    defaultValues: { name: "", email: "", phone: "", message: "" },
  });

  const onSubmit = async (values: InquiryForm) => {
    try {
      await apiRequest("POST", "/api/inquiry", { ...values, source: "Homepage CTA" });
      toast({ title: "Message sent", description: data.successMessage });
      form.reset();
    } catch (err: any) {
      toast({
        title: "Couldn't send",
        description: err.message ?? "Please try again, or call directly.",
        variant: "destructive",
      });
    }
  };

  const digits = String(data.phone || "").replace(/[^\d+]/g, "");

  return (
    <BlockSection data={data} testid="section-contact-cta">
      <div className={`${SHELL} grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-20`}>
        <div className="lg:col-span-5">
          {data.eyebrow ? (
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
              {data.eyebrow}
            </div>
          ) : null}
          <h2 className="font-serif text-[36px] lg:text-[52px] leading-[1.05] tracking-tight">
            {data.heading}
          </h2>
          {data.body ? (
            <p className={`mt-8 text-[15px] ${t.muted} leading-relaxed`}>{data.body}</p>
          ) : null}

          <div className="mt-10 space-y-4 text-[14px]">
            {data.phone ? (
              <a
                href={`tel:${digits}`}
                className="flex items-center gap-3 hover:opacity-70 transition-opacity"
                data-testid="contact-phone"
              >
                <span className={`w-9 h-9 border ${t.border} rounded-full flex items-center justify-center`}>
                  <Phone className="w-3.5 h-3.5" strokeWidth={1.6} />
                </span>
                <div>
                  <div className="font-medium">{data.phone}</div>
                  <div className={`${t.subtle} text-[12px]`}>{data.phoneNote}</div>
                </div>
              </a>
            ) : null}
            {data.email ? (
              <a
                href={`mailto:${data.email}`}
                className="flex items-center gap-3 hover:opacity-70 transition-opacity"
                data-testid="contact-email"
              >
                <span className={`w-9 h-9 border ${t.border} rounded-full flex items-center justify-center`}>
                  <Mail className="w-3.5 h-3.5" strokeWidth={1.6} />
                </span>
                <div>
                  <div className="font-medium">{data.email}</div>
                  <div className={`${t.subtle} text-[12px]`}>{data.emailNote}</div>
                </div>
              </a>
            ) : null}
            {data.office ? (
              <div className="flex items-center gap-3">
                <span className={`w-9 h-9 border ${t.border} rounded-full flex items-center justify-center`}>
                  <MapPin className="w-3.5 h-3.5" strokeWidth={1.6} />
                </span>
                <div>
                  <div className="font-medium">{data.office}</div>
                  <div className={`${t.subtle} text-[12px]`}>{data.officeNote}</div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="lg:col-span-7">
          <div className={`border rounded-sm p-6 lg:p-10 ${t.card}`}>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-5"
                data-testid="form-home-inquiry"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`font-display text-[10px] tracking-[0.22em] ${t.eyebrow}`}>
                          NAME
                        </FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Jane Doe" data-testid="input-inquiry-name" />
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
                        <FormLabel className={`font-display text-[10px] tracking-[0.22em] ${t.eyebrow}`}>
                          EMAIL
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="email"
                            placeholder="jane@example.com"
                            data-testid="input-inquiry-email"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={`font-display text-[10px] tracking-[0.22em] ${t.eyebrow}`}>
                        PHONE (OPTIONAL)
                      </FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="(403) 555-0123" data-testid="input-inquiry-phone" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="message"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={`font-display text-[10px] tracking-[0.22em] ${t.eyebrow}`}>
                        {data.formHeading}
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          rows={5}
                          placeholder="Buying, selling, just exploring — tell me a bit about what you're thinking."
                          data-testid="textarea-inquiry-message"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  size="lg"
                  className="w-full md:w-auto h-12 px-8 font-display text-[11px] tracking-[0.22em] bg-black text-white hover:bg-black/90"
                  disabled={form.formState.isSubmitting}
                  data-testid="button-submit-inquiry"
                >
                  {form.formState.isSubmitting ? (
                    "SENDING..."
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5 mr-2" strokeWidth={1.6} />
                      {data.submitLabel}
                    </>
                  )}
                </Button>
              </form>
            </Form>
          </div>
        </div>
      </div>
    </BlockSection>
  );
}

function RichTextBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const paragraphs = asArray<string>(data.body);
  const center = data.align === "center";
  const Heading = data.headingLevel === "h3" ? "h3" : "h2";
  return (
    <BlockSection data={data} testid="section-rich-text">
      <div className={`${SHELL}`}>
        <div className={`max-w-3xl ${center ? "mx-auto text-center" : ""}`}>
          {data.eyebrow ? (
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
              {data.eyebrow}
            </div>
          ) : null}
          {data.heading ? (
            <Heading className="font-serif text-[32px] lg:text-[48px] leading-[1.08] tracking-tight">
              {data.heading}
            </Heading>
          ) : null}
          <div className="mt-6 space-y-5">
            {paragraphs.map((p, i) => (
              <p key={i} className={`text-[15px] lg:text-[17px] ${t.muted} leading-relaxed`}>
                {p}
              </p>
            ))}
          </div>
        </div>
      </div>
    </BlockSection>
  );
}

function CtaBannerBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  return (
    <BlockSection data={data} testid="section-cta-banner">
      <div className={`${SHELL} text-center max-w-3xl`}>
        <div className="mx-auto">
          {data.eyebrow ? (
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
              {data.eyebrow}
            </div>
          ) : null}
          <h2 className="font-serif text-[32px] lg:text-[48px] leading-[1.08] tracking-tight">
            {data.heading}
          </h2>
          {data.body ? (
            <p className={`mt-6 text-[15px] lg:text-[17px] ${t.muted} leading-relaxed`}>
              {data.body}
            </p>
          ) : null}
          <div className="mt-10 flex flex-wrap justify-center gap-4">
            {data.primaryLabel && data.primaryHref ? (
              <SmartLink
                href={data.primaryHref}
                className={`inline-flex items-center gap-2 px-6 h-12 ${t.solid} font-display text-[11px] tracking-[0.22em]`}
                testid="link-cta-primary"
              >
                {data.primaryLabel}
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.6} />
              </SmartLink>
            ) : null}
            {data.secondaryLabel && data.secondaryHref ? (
              <SmartLink
                href={data.secondaryHref}
                className={`inline-flex items-center gap-2 px-6 h-12 ${t.outline} font-display text-[11px] tracking-[0.22em]`}
                testid="link-cta-secondary"
              >
                {data.secondaryLabel}
              </SmartLink>
            ) : null}
          </div>
        </div>
      </div>
    </BlockSection>
  );
}

const RATIOS: Record<string, string> = {
  portrait: "aspect-[4/5]",
  landscape: "aspect-[4/3]",
  square: "aspect-square",
};

function ImageTextBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const paragraphs = asArray<string>(data.body);
  const imageLeft = data.imagePosition !== "right";
  return (
    <BlockSection data={data} testid="section-image-text">
      <div className={`${SHELL} grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center`}>
        <div className={imageLeft ? "order-1" : "order-1 lg:order-2"}>
          <div
            className={`${RATIOS[data.ratio] ?? RATIOS.landscape} overflow-hidden rounded-sm bg-secondary`}
          >
            {data.image ? (
              <img
                src={data.image}
                alt={data.imageAlt || ""}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            ) : null}
          </div>
        </div>
        <div className={imageLeft ? "order-2" : "order-2 lg:order-1"}>
          {data.eyebrow ? (
            <div className={`font-display text-[11px] tracking-[0.22em] ${t.eyebrow} mb-4`}>
              {data.eyebrow}
            </div>
          ) : null}
          <h2 className="font-serif text-[32px] lg:text-[44px] leading-[1.06] tracking-tight">
            {data.heading}
          </h2>
          <div className="mt-6 space-y-4">
            {paragraphs.map((p, i) => (
              <p key={i} className={`text-[15px] ${t.muted} leading-relaxed`}>
                {p}
              </p>
            ))}
          </div>
          {data.ctaLabel && data.ctaHref ? (
            <ArrowLink
              href={data.ctaHref}
              label={data.ctaLabel}
              className={`mt-8 ${t.link}`}
              testid="link-image-text-cta"
            />
          ) : null}
        </div>
      </div>
    </BlockSection>
  );
}

function FaqBlock({ data }: { data: Data }) {
  const dark = data.bg === "dark";
  const t = tone(dark);
  const items = asArray<Data>(data.items).filter((q) => q.question);
  if (!items.length) return null;
  return (
    <BlockSection data={data} testid="section-faq">
      <div className={`${SHELL} max-w-3xl`}>
        <SectionHeader eyebrow={data.eyebrow} heading={data.heading} dark={dark} />
        <Accordion type="single" collapsible className="mt-10">
          {items.map((q, i) => (
            <AccordionItem key={i} value={`faq-${i}`} className={t.border}>
              <AccordionTrigger className="text-left font-serif text-[18px] lg:text-[20px]">
                {q.question}
              </AccordionTrigger>
              <AccordionContent className={`text-[14px] ${t.muted} leading-relaxed`}>
                {q.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </BlockSection>
  );
}

const SPACER_SIZES: Record<string, string> = {
  sm: "h-10 lg:h-16",
  md: "h-16 lg:h-24",
  lg: "h-24 lg:h-36",
};

function SpacerBlock({ data }: { data: Data }) {
  return (
    <div
      id={data.anchor || undefined}
      data-testid="section-spacer"
      className={`${VISIBILITY[data.visibility ?? "all"] ?? ""} bg-background`}
    >
      <div className={`${SHELL} ${SPACER_SIZES[data.size] ?? SPACER_SIZES.md} flex items-center`}>
        {data.divider ? <div className="w-full h-px bg-border" /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function HomeBlock({ block, ctx }: { block: PageBlock; ctx: BlockContext }) {
  const data = block.data as Data;
  switch (block.type) {
    case "hero":
      return <HeroBlock data={data} />;
    case "recentSales":
      return <RecentSalesBlock data={data} />;
    case "authority":
      return <AuthorityBlock data={data} />;
    case "checklist":
      return <ChecklistBlock data={data} />;
    case "statsBand":
      return <StatsBandBlock data={data} ctx={ctx} />;
    case "featuredListings":
      return <FeaturedListingsBlock data={data} ctx={ctx} />;
    case "neighbourhoodCards":
      return <NeighbourhoodCardsBlock data={data} ctx={ctx} />;
    case "neighbourhoodLinks":
      return <NeighbourhoodLinksBlock data={data} />;
    case "numberedList":
      return <NumberedListBlock data={data} />;
    case "video":
      return <VideoBlock data={data} />;
    case "bigStats":
      return <BigStatsBlock data={data} />;
    case "buyerSellerTabs":
      return <BuyerSellerTabsBlock data={data} />;
    case "iconPoints":
      return <IconPointsBlock data={data} />;
    case "cardGrid":
      return <CardGridBlock data={data} />;
    case "awards":
      return <AwardsBlock data={data} />;
    case "resourceCards":
      return <ResourceCardsBlock data={data} />;
    case "blogTeaser":
      return <BlogTeaserBlock data={data} ctx={ctx} />;
    case "testimonials":
      return <TestimonialsBlock data={data} ctx={ctx} />;
    case "instagram":
      return <InstagramBlock data={data} />;
    case "contactCta":
      return <ContactCtaBlock data={data} />;
    case "richText":
      return <RichTextBlock data={data} />;
    case "ctaBanner":
      return <CtaBannerBlock data={data} />;
    case "imageText":
      return <ImageTextBlock data={data} />;
    case "faq":
      return <FaqBlock data={data} />;
    case "spacer":
      return <SpacerBlock data={data} />;
    default:
      // Unknown type (block added by a newer deploy, or a hand-edited row):
      // render nothing rather than crashing the page.
      return null;
  }
}
