import { Link } from "wouter";
import {
  Award,
  ShieldCheck,
  Globe,
  Sparkles,
  Phone,
  Mail,
  ArrowRight,
} from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { Button } from "@/components/ui/button";
import {
  SPENCER_PHONE,
  SPENCER_PHONE_HREF,
  SPENCER_EMAIL,
  SPENCER_EMAIL_HREF,
} from "@/lib/format";

// Real photo of Spencer (was an Unsplash stock portrait of a stranger).
// Source: Copy of DSC_5711.JPG from the Dec 2023 shoot, resized to 1400w.
const PORTRAIT = "/img/top-realtor-in-calgary-spencer-rivers.jpg";

const CREDENTIALS = [
  {
    abbr: "CLHMS",
    logo: "/img/designations/clhms-guild.png",
    logoAlt: "CLHMS Million Dollar Guild — Certified Luxury Home Marketing Specialist seal",
    name: "Certified Luxury Home Marketing Specialist",
    blurb:
      "International credential held by the top 3% of agents working the luxury tier — Spencer has earned the Million Dollar Guild distinction for repeat performance above $1M.",
  },
  {
    abbr: "CIPS",
    logo: "/img/designations/cips.png",
    logoAlt: "CIPS — Certified International Property Specialist logo",
    name: "Certified International Property Specialist",
    blurb:
      "Designed for agents working with international clients. Helpful when out-of-province or out-of-country buyers move into Calgary's executive market.",
  },
  {
    abbr: "CNE",
    logo: "/img/designations/cne.png",
    logoAlt: "CNE — Certified Negotiation Expert logo",
    name: "Certified Negotiation Expert",
    blurb:
      "Specialist negotiation training that focuses on protecting client outcomes when offers, conditions, and competing buyers get complicated.",
  },
  {
    abbr: "CCS",
    logo: "/img/designations/ccs.jpg",
    logoAlt: "CREB C.C.S. — Certified Condominium Specialist badge",
    name: "Certified Condo Specialist",
    blurb:
      "Condominium documents and reserve fund studies require their own discipline — particularly in Calgary's high-rise inner-city buildings.",
  },
  {
    abbr: "LLS",
    logo: "/img/designations/luxe.png",
    logoAlt: "LUXE — Luxury Listing Specialist logo",
    name: "Luxury Listing Specialist",
    blurb:
      "Targeted training in pricing, photography, staging, and marketing of properties at the upper end of the local market.",
  },
];

const PHILOSOPHY = [
  {
    icon: ShieldCheck,
    title: "Data over drama",
    body:
      "Calgary's luxury tier is small enough that one agent's gut feel can move a list price by a hundred grand. Spencer brings comparable sales, days-on-market trends, and absorption rates to every conversation — and writes them down so clients can see the math.",
  },
  {
    icon: Sparkles,
    title: "The home before the deal",
    body:
      "Photography, staging, and copy run through the same brand standard you'd expect from a magazine. The goal isn't to dress the home up — it's to show buyers what's actually there.",
  },
  {
    icon: Award,
    title: "Off-market is part of the market",
    body:
      "Some of the best homes in Aspen Woods or Mount Royal never hit the public MLS. Spencer maintains a private network of estate sellers and developers whose properties move through introductions, not listings.",
  },
  {
    icon: Globe,
    title: "Calgary, fully local",
    body:
      "Spencer was raised in Calgary and raised his family here. He's not a generalist who happens to live in the city — he is the city.",
  },
];

const STATS = [
  { value: "$340M+", label: "Lifetime sales volume" },
  { value: "97%", label: "List-to-sale ratio" },
  { value: "18 days", label: "Average time on market" },
  { value: "12 yrs", label: "Calgary luxury practice" },
];

export default function AboutPage() {
  return (
    <PublicLayout>
      {/* Editorial hero */}
      <section className="max-w-[1400px] mx-auto px-4 lg:px-8 pt-12 lg:pt-16 pb-16 lg:pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16">
          <div className="lg:col-span-7 lg:pt-12">
            {/* The kicker sits inside the H1 so the heading names the page's subject. */}
            <h1>
              <span className="block font-display text-[11px] tracking-[0.32em] text-muted-foreground uppercase">About Spencer Rivers, Calgary realtor</span>
              <span className="block mt-5 font-serif text-[44px] lg:text-[80px] leading-[0.98]">
              Calgary's most established
              <br />
              <em className="not-italic font-normal">luxury communities,</em>
              <br />
              represented properly.
              </span>
            </h1>
            <p className="mt-8 max-w-[620px] text-[17px] lg:text-[18px] leading-[1.7] text-foreground/85">
              Spencer Rivers leads Rivers Real Estate at Synterra Realty —
              representing buyers and sellers across Springbank Hill, Aspen
              Woods, Upper Mount Royal, Elbow Park, Britannia, and Bel-Aire.
              Twelve years in, he's built a practice on three things: doing
              the math, telling the truth, and treating every home as if it
              were his own listing.
            </p>
          </div>

          <div className="lg:col-span-5">
            <div className="aspect-[3/4] rounded-sm overflow-hidden bg-secondary">
              <img
                src={PORTRAIT}
                alt="top realtor in Calgary Spencer Rivers"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="mt-4 flex justify-between items-center text-[12px] text-muted-foreground">
              <div className="font-display tracking-[0.18em]">
                SPENCER RIVERS
              </div>
              <div className="italic">REALTOR® · Calgary, AB</div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="bg-foreground text-background py-14 lg:py-20">
        <div className="max-w-[1300px] mx-auto px-6 lg:px-10 grid grid-cols-2 lg:grid-cols-4 gap-y-10 gap-x-6">
          {STATS.map((s, i) => (
            <div
              key={i}
              className="border-l border-background/15 pl-6"
              data-testid={`about-stat-${i}`}
            >
              <div className="font-serif text-3xl lg:text-5xl tabular-nums leading-none">
                {s.value}
              </div>
              <div className="mt-3 font-display text-[10px] tracking-[0.22em] text-background/65">
                {s.label.toUpperCase()}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Philosophy */}
      <section className="max-w-[1300px] mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16">
          <div className="lg:col-span-4">
            <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
              PHILOSOPHY
            </div>
            <h2 className="mt-4 font-serif text-4xl lg:text-5xl leading-[1.05]">
              How Spencer works.
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">
              Four principles shape every transaction — whether it's a $1.2M
              townhome in Aspen Woods or a $7M estate on the ridge.
            </p>
          </div>
          <div className="lg:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-y-12 gap-x-10">
            {PHILOSOPHY.map((p) => {
              const Icon = p.icon;
              return (
                <div key={p.title}>
                  <div className="w-11 h-11 rounded-full border border-border flex items-center justify-center">
                    <Icon className="w-5 h-5" strokeWidth={1.4} />
                  </div>
                  <h3 className="mt-5 font-serif text-2xl">{p.title}</h3>
                  <p className="mt-3 text-[14.5px] leading-[1.7] text-foreground/80">
                    {p.body}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Credentials */}
      <section className="bg-secondary/40 py-20 lg:py-28">
        <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
          <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
            CREDENTIALS
          </div>
          <h2 className="mt-4 font-serif text-4xl lg:text-5xl leading-[1.05] max-w-[700px]">
            Letters that mean something — not letters that look good on a card.
          </h2>

          <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-y-10 gap-x-10 lg:gap-x-16">
            {CREDENTIALS.map((c) => (
              <div
                key={c.abbr}
                className="grid grid-cols-[100px_1fr] gap-6 items-start"
                data-testid={`credential-${c.abbr.toLowerCase()}`}
              >
                <div className="border-r border-border pr-4">
                  <div className="font-serif text-3xl tabular-nums text-foreground/85">
                    {c.abbr}
                  </div>
                  <img
                    src={c.logo}
                    alt={c.logoAlt}
                    loading="lazy"
                    className="mt-3 h-12 w-auto max-w-[80px] object-contain"
                  />
                </div>
                <div>
                  <div className="font-display text-[11px] tracking-[0.18em] text-foreground">
                    {c.name.toUpperCase()}
                  </div>
                  <p className="mt-2.5 text-[14px] leading-[1.7] text-muted-foreground">
                    {c.blurb}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Long-form bio */}
      <section className="max-w-[850px] mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
          THE LONG VERSION
        </div>
        <div className="mt-6 space-y-6 font-serif text-[20px] lg:text-[22px] leading-[1.6] text-foreground/90">
          <p>
            Spencer grew up on Calgary's west side, watching the city's luxury
            tier evolve from a handful of estate streets into the most
            interesting real estate market in Western Canada. He started his
            practice in 2012 representing entry-level buyers in inner-city
            Calgary — and within four years was working exclusively in homes
            above the million-dollar mark.
          </p>
          <p>
            That progression shaped how he runs his business today. Spencer
            still treats every listing the way he treated his first one — with
            the photographer who actually shoots architecture for magazines, a
            stager who understands what families in Aspen Woods actually want,
            and an offer strategy built on absorption data rather than wishful
            thinking.
          </p>
          <p>
            On the buying side, Spencer's network includes builders, estate
            attorneys, and divorce mediators across Calgary's prestige
            communities. A meaningful portion of his closings every year come
            from properties that never appear on the public MLS — homes that
            change hands through introductions Spencer has spent a decade
            earning.
          </p>
          <p>
            When he isn't showing properties, Spencer is at the Glencoe Club,
            on the bow with his kids, or somewhere in the foothills with his
            wife and the family golden. Calgary is home, and he intends to be
            here doing this for the next twenty years.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-[1300px] mx-auto px-6 lg:px-10 pb-24">
        <div className="bg-foreground text-background rounded-sm p-12 lg:p-16 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-10 items-center">
          <div>
            <div className="font-display text-[10px] tracking-[0.22em] text-background/65">
              GET IN TOUCH
            </div>
            <h2 className="mt-3 font-serif text-3xl lg:text-5xl leading-[1.05] max-w-[640px]">
              Have a property to sell — or a community in mind?
            </h2>
            <p className="mt-5 text-background/75 max-w-[560px]">
              Call or text Spencer directly. Every inquiry gets a personal
              reply within the day.
            </p>
          </div>

          <div className="flex flex-col gap-3 lg:items-end">
            <a
              href={SPENCER_PHONE_HREF}
              className="inline-flex items-center gap-3 px-5 py-3.5 border border-background/30 rounded-sm font-display text-[11px] tracking-[0.22em] hover:bg-background/10 transition-colors"
              data-testid="link-about-call"
            >
              <Phone className="w-3.5 h-3.5" strokeWidth={1.8} />
              {SPENCER_PHONE}
            </a>
            <a
              href={SPENCER_EMAIL_HREF}
              className="inline-flex items-center gap-3 px-5 py-3.5 border border-background/30 rounded-sm font-display text-[11px] tracking-[0.22em] hover:bg-background/10 transition-colors"
              data-testid="link-about-email"
            >
              <Mail className="w-3.5 h-3.5" strokeWidth={1.8} />
              {SPENCER_EMAIL.toUpperCase()}
            </a>
            <Link href="/contact">
                <Button
                  variant="outline"
                  className="bg-background text-foreground hover:bg-background/90 border-background h-11 rounded-sm font-display text-[11px] tracking-[0.22em] gap-2"
                  data-testid="button-about-contact-form"
                >
                  SEND A NOTE
                  <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} />
                </Button>
              
            </Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
