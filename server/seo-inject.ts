/**
 * Per-route SEO meta-tag injection for the React SPA.
 *
 * Problem: the React app is pure CSR. Express serves the raw index.html
 * (which has a generic <title> and no canonical) for every URL, then React
 * renders the actual content client-side. Googlebot has to execute JS to
 * see anything, and the render-budget for 5000+ URLs gets exhausted —
 * leaving most pages stuck in "Discovered – currently not indexed".
 *
 * Solution: at the catch-all, look up the requested URL, build a metadata
 * envelope (title, description, canonical, og tags), and inject those into
 * the <head> of index.html before sending. Googlebot now sees full HEAD
 * metadata immediately, without needing to render. The client-side React
 * still mounts and renders the body content as before.
 *
 * For dynamic routes (/condos/:slug, /neighbourhoods/:slug, /blog/:slug,
 * /mls/:id) we hit the storage layer to look up the actual page data.
 */
import { storage } from "./storage";
import { buildGraph, IDS, type SchemaNode } from "./schema/entities";
import { getPublicPageContent } from "./page-content";

const ORIGIN = (process.env.PUBLIC_ORIGIN || "https://riversrealestate.ca").replace(
  /\/$/,
  "",
);
const SITE_NAME = "Rivers Real Estate";
const BRAND_TAGLINE = "Spencer Rivers — Luxury Homes Calgary";
// Brand OG/Twitter card (1200×630, built from the Rivers Real Estate logo —
// see client/public/img/og-default.jpg). Never a stock photo: link previews
// are brand surface.
const DEFAULT_IMAGE = `${ORIGIN}/img/og-default.jpg`;

export interface SeoMeta {
  title: string;
  description: string;
  canonical: string;
  ogImage?: string;
  ogType?: "website" | "article" | "profile";
  noindex?: boolean;
  // Page-specific schema.org nodes (BlogPosting, Place, BreadcrumbList...).
  // Emitted as ONE JSON-LD block per page: buildGraph() wraps these together
  // with the core entity graph (WebSite/agent/person/brokerage/communities,
  // see server/schema/entities.ts) in a single @graph, deduped by @id.
  // Reference shared entities by @id — never restate them inline.
  jsonLd?: SchemaNode[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the metadata for a given URL path. Returns null if the path looks
 * like a JSON/asset/api request that shouldn't go through this pipeline.
 */
// Audience-segment landing pages (/work-with/:slug). Titles/descriptions must
// stay in sync with client/src/pages/work-with.tsx, which owns the full page
// content. (All schema — breadcrumbs included — is server-emitted here.)
const WORK_WITH_META: Record<
  string,
  { title: string; description: string; image: string }
> = {
  "luxury-properties": {
    title:
      "Luxury Home Buyers | Calgary Estates, Penthouses & Villas | Spencer Rivers",
    description:
      "Buy in Calgary's $1M+ market with Spencer Rivers, CLHMS. Private showings, off-market access, and data-driven negotiation across Springbank Hill, Aspen Woods, Mount Royal, and more.",
    image:
      `${ORIGIN}/img/work-with/luxury-properties.jpg`,
  },
  "first-time-home-sellers": {
    title: "First-Time Home Sellers in Calgary | Spencer Rivers, Rivers Real Estate",
    description:
      "Selling your first home in Calgary? Spencer Rivers handles pricing, prep, marketing, and every form — with a written plan and a net-proceeds estimate before you list.",
    image:
      `${ORIGIN}/img/work-with/first-time-home-sellers.jpg`,
  },
  "expired-listings": {
    title: "Expired Listings in Calgary | Relist Your Luxury Home | Spencer Rivers",
    description:
      "Expired Calgary luxury listing? Spencer Rivers, CLHMS listing agent, diagnoses list price, photography, and exposure — then re-prices, re-markets, and relists.",
    image:
      `${ORIGIN}/img/work-with/luxury-properties.jpg`,
  },
  "empty-nesters": {
    title: "Downsizing & Empty Nesters in Calgary | Spencer Rivers, Rivers Real Estate",
    description:
      "Right-size without compromise. Spencer Rivers, Certified Condo Specialist, coordinates the sale of the family home and the move into a luxury condo, villa, or bungalow — one plan, one move.",
    image:
      `${ORIGIN}/img/work-with/empty-nesters.jpg`,
  },
  "first-time-home-buyers": {
    title: "First-Time Home Buyers in Calgary | Spencer Rivers, Rivers Real Estate",
    description:
      "Buy your first Calgary home with a coach, not a salesperson. Spencer Rivers guides financing, inspections, and neighbourhood choice — data first, pressure never.",
    image:
      `${ORIGIN}/img/work-with/first-time-home-buyers.jpg`,
  },
  "innercity-properties": {
    title:
      "Inner-City Calgary Real Estate | Mount Royal, Elbow Park, Mission | Spencer Rivers",
    description:
      "Buy or sell in Calgary's inner city with Spencer Rivers. Block-level expertise across Upper Mount Royal, Elbow Park, Roxboro, Mission, and Beltline — estates, infills, and condos.",
    image:
      `${ORIGIN}/img/neighbourhoods/upper-mount-royal.jpg`,
  },
  "move-ups": {
    title:
      "Move-Up Buyers in Calgary | Sell & Buy Without Two Mortgages | Spencer Rivers",
    description:
      "Trading up to your forever home? Spencer Rivers coordinates the sell-and-buy sequence — pricing, bridge financing, and possession dates — so you move once, without carrying two mortgages.",
    image:
      `${ORIGIN}/img/work-with/move-ups.jpg`,
  },
  "family-focused-properties": {
    title:
      "Family Homes in Calgary | School Zones, Lots & Communities | Spencer Rivers",
    description:
      "Find the Calgary communities built for growing families. Spencer Rivers verifies school zones, walks the streets, and matches your family to the right home in Springbank Hill, Aspen Woods, Mahogany, and more.",
    image:
      `${ORIGIN}/img/work-with/family-focused-properties.jpg`,
  },
  "urban-properties": {
    title: "Urban Condos, Lofts & Townhomes in Calgary | Spencer Rivers",
    description:
      "Buy urban Calgary with a Certified Condo Specialist. Spencer Rivers vets buildings — reserve funds, boards, construction — across Beltline, Mission, Kensington, Inglewood, and East Village.",
    image:
      `${ORIGIN}/img/neighbourhoods/beltline.jpg`,
  },
};

/** BreadcrumbList node. Every page except the homepage emits one (a
 * single-crumb list on "/" is noise, so home is skipped by convention). */
const HOME_CRUMB: [string, string] = ["Home", `${ORIGIN}/`];
function crumbs(...items: Array<[name: string, url: string]>): SchemaNode {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, item], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item,
    })),
  };
}

/** Map a Pillar 9 property (sub)type string to the schema.org residence type. */
function residenceType(subOrType: string | null | undefined): string {
  const s = (subOrType || "").toLowerCase();
  if (s.includes("apartment") || s.includes("condo")) return "Apartment";
  if (s.includes("detached") && !s.includes("semi")) return "SingleFamilyResidence";
  if (
    s.includes("semi") ||
    s.includes("row") ||
    s.includes("town") ||
    s.includes("duplex") ||
    s.includes("house")
  )
    return "House";
  return "Residence";
}

/** RealEstateListing node wrapping the residence + Offer, provider → #agent.
 * Every property is optional-guarded: emit only what the page really shows —
 * mismatched or invented markup is treated as misleading. */
function listingSchema(o: {
  url: string;
  name: string;
  description?: string | null;
  streetAddress: string;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  yearBuilt?: number | null;
  image?: string | null;
  price?: number | null;
  active: boolean;
  datePosted?: string | null;
  subType?: string | null;
}): SchemaNode {
  return {
    "@type": "RealEstateListing",
    "@id": `${o.url}#listing`,
    url: o.url,
    name: o.name,
    ...(o.description ? { description: o.description } : {}),
    ...(o.datePosted ? { datePosted: o.datePosted } : {}),
    provider: { "@id": IDS.agent },
    mainEntity: {
      "@type": residenceType(o.subType),
      "@id": `${o.url}#home`,
      name: o.name,
      address: {
        "@type": "PostalAddress",
        streetAddress: o.streetAddress,
        addressLocality: o.city || "Calgary",
        addressRegion: o.region || "AB",
        ...(o.postalCode ? { postalCode: o.postalCode } : {}),
        addressCountry: "CA",
      },
      ...(o.lat && o.lng
        ? { geo: { "@type": "GeoCoordinates", latitude: o.lat, longitude: o.lng } }
        : {}),
      ...(o.beds ? { numberOfBedrooms: o.beds } : {}),
      ...(o.baths ? { numberOfBathroomsTotal: o.baths } : {}),
      ...(o.sqft
        ? {
            floorSize: {
              "@type": "QuantitativeValue",
              value: o.sqft,
              unitCode: "FTK",
              unitText: "sq ft",
            },
          }
        : {}),
      ...(o.yearBuilt ? { yearBuilt: o.yearBuilt } : {}),
      ...(o.image ? { image: o.image } : {}),
    },
    ...(o.price
      ? {
          offers: {
            "@type": "Offer",
            price: o.price,
            priceCurrency: "CAD",
            availability: o.active
              ? "https://schema.org/InStock"
              : "https://schema.org/SoldOut",
          },
        }
      : {}),
  };
}

export function metaForPath(path: string): SeoMeta | null {
  if (!path || path.startsWith("/api/") || path.startsWith("/assets/")) return null;
  if (/\.[a-z0-9]{1,8}$/i.test(path) && !path.endsWith(".html")) return null;

  // Strip trailing slash for matching (but keep canonical without it).
  const p = path === "/" ? "/" : path.replace(/\/$/, "");
  const canonical = `${ORIGIN}${p === "/" ? "/" : p}`;

  // ---- Static pages ----
  if (p === "/") {
    // Title/description/OG come from the home page CMS (/admin/home), which
    // falls back to the factory copy when nothing has been saved yet. Any
    // FAQ block on the page also contributes FAQPage markup.
    const home = getPublicPageContent("home");
    const faqBlock = home.blocks.find((b) => b.type === "faq");
    const faqItems = Array.isArray(faqBlock?.data?.items)
      ? (faqBlock!.data.items as Array<{ question?: string; answer?: string }>).filter(
          (q) => q?.question && q?.answer,
        )
      : [];
    const jsonLd: SchemaNode[] = [];
    if (faqItems.length > 0) {
      jsonLd.push({
        "@type": "FAQPage",
        "@id": `${ORIGIN}/#faq`,
        mainEntity: faqItems.map((q) => ({
          "@type": "Question",
          name: q.question,
          acceptedAnswer: { "@type": "Answer", text: q.answer },
        })),
      });
    }
    return {
      title: home.seo.title,
      description: home.seo.description,
      canonical: home.seo.canonical || `${ORIGIN}/`,
      ogImage: home.seo.ogImage || undefined,
      ogType: "website",
      noindex: home.seo.noindex,
      // WebSite + agent + person all live in the core graph — nothing else
      // page-specific to add.
      jsonLd,
    };
  }
  if (p === "/mls") {
    return {
      title: "MLS Search — Live Calgary Luxury Listings | Rivers Real Estate",
      description:
        "Browse live Calgary MLS® listings from the Pillar 9 feed. Filter by neighbourhood, price, type. Spencer Rivers represents buyers across the city.",
      canonical: `${ORIGIN}/mls`,
      jsonLd: [crumbs(HOME_CRUMB, ["MLS Search", `${ORIGIN}/mls`])],
    };
  }
  if (p === "/neighbourhoods") {
    return {
      title: "Calgary Luxury Neighbourhoods | Rivers Real Estate",
      description:
        "Block-by-block expertise across Calgary's prestige communities: Upper Mount Royal, Elbow Park, Britannia, Aspen Woods, Springbank Hill, Bel-Aire, and more.",
      canonical: `${ORIGIN}/neighbourhoods`,
      jsonLd: [crumbs(HOME_CRUMB, ["Neighbourhoods", `${ORIGIN}/neighbourhoods`])],
    };
  }
  if (p === "/condos") {
    return {
      title: "Calgary Luxury Condos | Rivers Real Estate",
      description:
        "Calgary's most-asked-about luxury condo buildings — The Royal, The Concord, The River, Eau Claire, Belle Aire — pricing, inventory, and resale insight.",
      canonical: `${ORIGIN}/condos`,
      jsonLd: [crumbs(HOME_CRUMB, ["Condo Buildings", `${ORIGIN}/condos`])],
    };
  }
  if (p === "/about") {
    return {
      title: `About Spencer Rivers — ${SITE_NAME}`,
      description:
        "12 years in Calgary's luxury market. Top 1% in Canada, $100M+ in career sales. Discretion, data, and direct conversation.",
      canonical: `${ORIGIN}/about`,
      ogType: "profile",
      jsonLd: [
        {
          "@type": "ProfilePage",
          "@id": `${ORIGIN}/about#page`,
          url: `${ORIGIN}/about`,
          mainEntity: { "@id": IDS.person },
        },
        crumbs(HOME_CRUMB, ["About Spencer Rivers", `${ORIGIN}/about`]),
      ],
    };
  }
  if (p === "/contact") {
    return {
      title: `Contact Spencer Rivers — ${SITE_NAME}`,
      description:
        "Get in touch with Spencer Rivers — direct line (403) 966-9237. Every inquiry gets a personal reply within one business day.",
      canonical: `${ORIGIN}/contact`,
      jsonLd: [crumbs(HOME_CRUMB, ["Contact", `${ORIGIN}/contact`])],
    };
  }
  // ---- Booking pages ----
  // /book and /book/<meeting-type> are indexable. A manage link
  // (/book/manage/<uid>) is one person's private booking — noindex, and never
  // a soft-404 even after the booking is gone.
  if (p === "/book") {
    return {
      title: `Book a Time with Spencer Rivers — ${SITE_NAME}`,
      description:
        "See Spencer Rivers' live availability and book a buyer consultation, listing appointment, or private showing in Calgary. Instant confirmation, no phone tag.",
      canonical: `${ORIGIN}/book`,
      jsonLd: [
        crumbs(HOME_CRUMB, ["Book a Time", `${ORIGIN}/book`]),
        {
          "@type": "ReservationPackage",
          "@id": `${ORIGIN}/book#booking`,
          name: "Book an appointment with Spencer Rivers",
          url: `${ORIGIN}/book`,
          provider: { "@id": IDS.person },
        },
      ],
    };
  }
  if (p.startsWith("/book/manage/")) {
    return {
      title: `Your Booking — ${SITE_NAME}`,
      description: "",
      canonical: `${ORIGIN}${p}`,
      noindex: true,
    };
  }
  if (p.startsWith("/book/")) {
    const slug = p.slice("/book/".length);
    try {
      // The event type owns the copy, so the crawler sees the same words the
      // page renders. An unknown slug falls through to the soft-404.
      const et = storage.getBookingEventTypeBySlug(slug);
      if (!et || !et.active) return null;
      return {
        title: `Book a ${et.name} with Spencer Rivers — ${SITE_NAME}`,
        description:
          (et.description || "").replace(/\s+/g, " ").trim().slice(0, 300) ||
          `Book a ${et.durationMinutes}-minute ${et.name.toLowerCase()} with Calgary REALTOR® Spencer Rivers.`,
        canonical: `${ORIGIN}/book/${et.slug}`,
        jsonLd: [
          crumbs(HOME_CRUMB, ["Book a Time", `${ORIGIN}/book`], [et.name, `${ORIGIN}/book/${et.slug}`]),
        ],
      };
    } catch {
      return null;
    }
  }
  if (p === "/home-evaluation") {
    return {
      // Must match client/src/pages/home-evaluation.tsx <SeoHead> strings.
      title: "What's your Calgary home worth? | Rivers Real Estate",
      description:
        "Free instant home valuation for Calgary properties — powered by Gnowise AVM with property-detail refinement — plus a hand-prepared market analysis from Spencer Rivers.",
      canonical: `${ORIGIN}/home-evaluation`,
      jsonLd: [crumbs(HOME_CRUMB, ["Home Valuation", `${ORIGIN}/home-evaluation`])],
    };
  }
  if (p === "/blog") {
    return {
      title: `Calgary Luxury Real Estate Journal — ${SITE_NAME}`,
      description:
        "Notes, market analyses, and neighbourhood deep-dives from Calgary's top luxury real estate agent.",
      canonical: `${ORIGIN}/blog`,
      jsonLd: [crumbs(HOME_CRUMB, ["Journal", `${ORIGIN}/blog`])],
    };
  }
  if (p === "/sold" || p === "/sold-listings") {
    return {
      title: `Recently Sold — ${SITE_NAME}`,
      description:
        "Selected recently sold Calgary luxury homes represented by Spencer Rivers.",
      canonical: `${ORIGIN}/sold`,
      jsonLd: [crumbs(HOME_CRUMB, ["Recently Sold", `${ORIGIN}/sold`])],
    };
  }
  if (p === "/assignments") {
    // Must stay in sync with client/src/pages/assignments.tsx (SEO_TITLE /
    // SEO_DESCRIPTION), which owns the full page content and FAQ schema.
    return {
      title:
        "Calgary Condo Assignment Sales | Buy or Sell a Pre-Construction Assignment | Spencer Rivers",
      description:
        "Buy or sell a pre-construction condo assignment in Calgary with Spencer Rivers. Current assignments at the Lincoln (Beltline) and Sovereign (Mission), plus developer consent, deposits, and GST handled properly.",
      canonical: `${ORIGIN}/assignments`,
      ogImage: `${ORIGIN}/img/assignments/lincoln-exterior.jpg`,
      jsonLd: [crumbs(HOME_CRUMB, ["Assignment Sales", `${ORIGIN}/assignments`])],
    };
  }
  if (p === "/work-with") {
    return {
      title: `Who We Work With | Spencer Rivers, ${SITE_NAME} Calgary`,
      description:
        "Luxury buyers, first-time sellers, expired listings, empty nesters, move-up families, and urban professionals — see how Spencer Rivers works with each, across Calgary's best communities.",
      canonical: `${ORIGIN}/work-with`,
      jsonLd: [crumbs(HOME_CRUMB, ["Who We Work With", `${ORIGIN}/work-with`])],
    };
  }
  if (p.startsWith("/work-with/")) {
    const m = WORK_WITH_META[p.slice("/work-with/".length)];
    if (!m) return null;
    return {
      title: m.title,
      description: m.description,
      canonical,
      // Per-segment brand photography (real listings/community shots as of
      // 2026-08) — safe for OG cards again.
      ogImage: m.image,
      jsonLd: [
        crumbs(
          HOME_CRUMB,
          ["Who We Work With", `${ORIGIN}/work-with`],
          [m.title.split("|")[0].trim(), canonical],
        ),
      ],
    };
  }

  // ---- Dynamic: blog post ----
  if (p.startsWith("/blog/")) {
    const slug = p.slice("/blog/".length);
    try {
      const post = storage.getBlogBySlug(slug) as any;
      if (!post) return null;
      if (post.status === "draft") {
        return {
          title: `${post.title} — ${SITE_NAME}`,
          description: post.excerpt || "",
          canonical: `${ORIGIN}/blog/${slug}`,
          noindex: true,
        };
      }
      const blogUrl = `${ORIGIN}/blog/${slug}`;
      const heroImage = post.heroImage || DEFAULT_IMAGE;
      return {
        title: `${post.title} — ${SITE_NAME}`,
        description:
          post.excerpt ||
          `Calgary luxury real estate insight from Spencer Rivers.`,
        canonical: blogUrl,
        ogImage: heroImage,
        ogType: "article",
        jsonLd: [
          {
            "@type": "BlogPosting",
            "@id": `${blogUrl}#article`,
            headline: post.title,
            description: post.excerpt || "",
            image: heroImage,
            // publishedAt is the only real timestamp the CMS stores — no
            // dateModified rather than a synthesized one.
            datePublished: post.publishedAt,
            inLanguage: "en-CA",
            url: blogUrl,
            mainEntityOfPage: { "@type": "WebPage", "@id": blogUrl },
            articleSection: post.category || "Calgary Real Estate",
            wordCount: typeof post.body === "string" ? post.body.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length : undefined,
            // Single-author site; guard in case a guest byline ever appears.
            author:
              !post.authorName || post.authorName === "Spencer Rivers"
                ? { "@id": IDS.person }
                : { "@type": "Person", name: post.authorName },
            publisher: { "@id": IDS.agent },
          },
          {
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
              { "@type": "ListItem", position: 2, name: "Journal", item: `${ORIGIN}/blog` },
              { "@type": "ListItem", position: 3, name: post.title, item: blogUrl },
            ],
          },
        ],
      };
    } catch {
      return null;
    }
  }

  // ---- Dynamic: neighbourhood detail ----
  if (p.startsWith("/neighbourhoods/")) {
    const slug = p.slice("/neighbourhoods/".length);
    try {
      const n = storage.getNeighbourhoodBySlug(slug) as any;
      if (!n) return null;
      const nUrl = `${ORIGIN}/neighbourhoods/${slug}`;
      return {
        // Must match client/src/pages/neighbourhood-detail.tsx <SeoHead>
        // strings (WP-inherited title format that carries the rankings).
        title: `${n.name} Homes for Sale - Luxury Homes Calgary`,
        description: `Browse luxury homes for sale in ${n.name}, Calgary. Active MLS listings, neighbourhood guide, schools, and lifestyle.`,
        canonical: nUrl,
        ogImage: n.heroImage || DEFAULT_IMAGE,
        jsonLd: [
          {
            // Same @id the areaServed stubs use for marquee communities —
            // buildGraph merges this richer node over the stub.
            "@type": "Place",
            "@id": `${nUrl}#place`,
            name: `${n.name}, Calgary`,
            description: n.tagline || `${n.name} neighbourhood in Calgary, Alberta.`,
            url: nUrl,
            image: n.heroImage || DEFAULT_IMAGE,
            ...(n.centerLat && n.centerLng
              ? { geo: { "@type": "GeoCoordinates", latitude: n.centerLat, longitude: n.centerLng } }
              : {}),
            containedInPlace: { "@id": IDS.calgary },
          },
          {
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
              { "@type": "ListItem", position: 2, name: "Neighbourhoods", item: `${ORIGIN}/neighbourhoods` },
              { "@type": "ListItem", position: 3, name: n.name, item: nUrl },
            ],
          },
        ],
      };
    } catch {
      return null;
    }
  }

  // ---- Dynamic: condo detail ----
  if (p.startsWith("/condos/")) {
    const slug = p.slice("/condos/".length);
    try {
      const c = storage.getCondoBuildingBySlug(slug) as any;
      if (!c) return null;
      const cUrl = `${ORIGIN}/condos/${slug}`;
      return {
        // Must match client/src/pages/condo-detail.tsx <SeoHead> strings
        // (WP-inherited title format that carries the rankings).
        title: `${c.name} Condos Calgary - Luxury Homes Calgary`,
        description: `Find the latest condos for sale in ${c.name} in ${c.neighbourhood}. Get access to MLS Listings up to 48 hours before Realtor.ca!`,
        canonical: cUrl,
        ogImage: c.heroImage || DEFAULT_IMAGE,
        jsonLd: [
          {
            "@type": "Place",
            "@id": `${cUrl}#building`,
            name: c.name,
            description: c.tagline || undefined,
            url: cUrl,
            image: c.heroImage || undefined,
            address: {
              "@type": "PostalAddress",
              streetAddress: c.address,
              addressLocality: "Calgary",
              addressRegion: "AB",
              addressCountry: "CA",
            },
            ...(c.lat && c.lng
              ? { geo: { "@type": "GeoCoordinates", latitude: c.lat, longitude: c.lng } }
              : {}),
            containedInPlace: { "@id": IDS.calgary },
          },
          crumbs(HOME_CRUMB, ["Condo Buildings", `${ORIGIN}/condos`], [c.name, cUrl]),
        ],
      };
    } catch {
      return null;
    }
  }

  // ---- Dynamic: MLS listing detail ----
  if (p.startsWith("/mls/")) {
    const id = p.slice("/mls/".length);
    try {
      const l: any = storage.getMlsListingBySeoSlug(id) ?? storage.getMlsListingById(id);
      if (!l) return null;
      const lUrl = `${ORIGIN}/mls/${storage.getMlsSeoSlug(l)}`;
      const addr = l.fullAddress || "Calgary";
      const heroImg = l.heroImage
        ? l.heroImage.startsWith("http")
          ? l.heroImage
          : `${ORIGIN}${l.heroImage}`
        : undefined;
      // Must match client/src/pages/mls-detail.tsx <SeoHead> strings —
      // including the description strip/fallback — so JS-executing and
      // non-JS crawlers see identical metadata.
      const desc = l.description
        ? String(l.description)
            .replace(/<[^>]+>/g, "")
            .replace(/&[#a-zA-Z0-9]+;/g, "")
            .slice(0, 200)
        : `${l.beds ?? "—"} bed · ${l.baths ?? "—"} bath · ${l.sqft ? l.sqft.toLocaleString("en-CA") + " sqft" : ""} home for sale at ${addr}, Calgary.`;
      return {
        title: l.listPrice
          ? `${addr} - $${(l.listPrice / 1000).toFixed(0)}K | Luxury Homes Calgary`
          : `${addr} | Luxury Homes Calgary`,
        description: desc,
        canonical: lUrl,
        ogImage: heroImg || DEFAULT_IMAGE,
        ogType: "article",
        jsonLd: [
          listingSchema({
            url: lUrl,
            name: addr,
            description: desc,
            streetAddress: addr,
            city: l.city,
            region: l.province,
            postalCode: l.postalCode,
            lat: l.lat,
            lng: l.lng,
            beds: l.beds,
            baths: l.baths,
            sqft: l.sqft,
            yearBuilt: l.yearBuilt,
            image: heroImg,
            price: l.listPrice,
            active: l.status === "Active",
            datePosted: l.listDate,
            subType: l.propertySubType || l.propertyType,
          }),
          crumbs(HOME_CRUMB, ["MLS Search", `${ORIGIN}/mls`], [addr, lUrl]),
        ],
      };
    } catch {
      return null;
    }
  }

  // Public listing page (/p/:slug — the agent's own listings, shared by
  // link). Returning null here used to fall through to the 404 handler, so
  // every shared listing URL served HTTP 404 + noindex to crawlers and link
  // unfurlers. Look the listing up properly instead.
  if (p.startsWith("/p/")) {
    const slug = p.slice("/p/".length);
    try {
      const l = storage.getListingBySlug(slug) as any;
      if (!l) return null;
      const pUrl = `${ORIGIN}/p/${slug}`;
      const price =
        typeof l.price === "number" ? `$${Number(l.price).toLocaleString()}` : null;
      const name = l.title || l.address;
      return {
        title: `${name} — ${SITE_NAME}`,
        description: [l.address, price, l.beds ? `${l.beds} bed` : null, l.baths ? `${l.baths} bath` : null]
          .filter(Boolean)
          .join(" · ") || `Calgary listing represented by Spencer Rivers.`,
        canonical: pUrl,
        ogImage: l.heroImage || (Array.isArray(l.photos) && l.photos[0]) || undefined,
        jsonLd: [
          listingSchema({
            url: pUrl,
            name,
            description: typeof l.description === "string" ? l.description.slice(0, 300) : undefined,
            streetAddress: l.address,
            lat: l.lat,
            lng: l.lng,
            beds: l.beds,
            baths: l.baths,
            sqft: l.sqft,
            yearBuilt: l.yearBuilt,
            image: l.heroImage,
            price: l.price,
            active: l.status === "active",
            subType: l.type,
          }),
          crumbs(HOME_CRUMB, [name, pUrl]),
        ],
      };
    } catch {
      return null;
    }
  }

  // Account & admin pages — noindex (they are user-private flows)
  if (p.startsWith("/account") || p.startsWith("/admin")) {
    return {
      title: SITE_NAME,
      description: "",
      canonical: `${ORIGIN}${p}`,
      noindex: true,
    };
  }

  // Unknown path — signal to caller to return a soft-404 (real 404).
  return null;
}

/**
 * Inject the SEO metadata into a raw HTML string by replacing the existing
 * <title> and <meta name="description"> tags, and inserting canonical +
 * og + twitter tags. Idempotent — runs on the template output every
 * request, so the page-specific tags are always fresh.
 */
export function injectMetaIntoHtml(html: string, meta: SeoMeta): string {
  const title = escapeHtml(meta.title);
  const desc = escapeHtml(meta.description);
  const canonical = escapeHtml(meta.canonical);
  const ogImage = escapeHtml(meta.ogImage || DEFAULT_IMAGE);
  const ogType = meta.ogType || "website";

  const tags = [
    `<link rel="canonical" href="${canonical}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
    `<meta property="og:type" content="${ogType}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${desc}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
  ];
  if (meta.noindex) {
    tags.push(`<meta name="robots" content="noindex,nofollow" />`);
  }

  // JSON-LD structured data: exactly ONE script tag per page holding a
  // single @graph — core entity nodes + page nodes, deduped by @id (see
  // server/schema/entities.ts). noindex pages (drafts, account/admin
  // shells) describe entities we don't want indexed from those URLs, so
  // they emit no schema at all.
  // Escaping `</` inside JSON prevents a closing-script sequence in the
  // payload from prematurely terminating the tag.
  if (!meta.noindex) {
    try {
      const graph = buildGraph(meta.jsonLd ?? []);
      const json = JSON.stringify(graph).replace(/<\/(script)/gi, "<\\/$1");
      tags.push(`<script type="application/ld+json">${json}</script>`);
    } catch {
      // Skip malformed schema rather than failing the whole page.
    }
  }

  let out = html;
  // Replace the static <title> with the page-specific one.
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
  // Replace the static description.
  out = out.replace(
    /<meta\s+name=["']description["'][^>]*>/i,
    `<meta name="description" content="${desc}" />`,
  );
  // Inject the rest just before </head>.
  out = out.replace(/<\/head>/i, `${tags.join("\n    ")}\n  </head>`);
  return out;
}

export { ORIGIN as SEO_ORIGIN, BRAND_TAGLINE };
