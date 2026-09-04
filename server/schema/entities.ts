/**
 * The site's schema.org entity graph, defined once as typed objects.
 *
 * Pages emit ONE JSON-LD block: { "@context", "@graph": [...] } containing
 * these core nodes plus any page-specific nodes (BlogPosting, Place,
 * BreadcrumbList...), cross-referenced by @id — never duplicated inline.
 * Assembly + dedupe lives in buildGraph() below; seo-inject.ts calls it.
 *
 * @id stability matters more than anything else in this file:
 *   #website and #agent predate this module and may already be crawled —
 *   NEVER rename them. #spencer is the Person node. Place nodes reuse the
 *   /neighbourhoods/<slug>#place ids that the neighbourhood pages emit, so
 *   the areaServed stubs and the page's full node merge into one entity.
 *
 * riversrealestate.ca is the canonical home of these entities.
 * luxuryhomescalgary.ca (WordPress) will reference these same @id strings
 * rather than mint its own — keep that in mind before changing anything.
 */

import { publicOrigin } from "../origin";

// Every @id below is built from this, and those ids are crawled and
// referenced by luxuryhomescalgary.ca — so it reads the same shared origin as
// the rest of the server rather than keeping a private copy that could drift
// away from it. Same env var and same default as before; publicOrigin() only
// additionally trims whitespace and repeated trailing slashes, which would
// have produced malformed ids.
const ORIGIN = publicOrigin();

export type SchemaNode = Record<string, unknown> & { "@id"?: string };

export const IDS = {
  website: `${ORIGIN}/#website`,
  agent: `${ORIGIN}/#agent`,
  person: `${ORIGIN}/#spencer`,
  brokerage: `${ORIGIN}/#brokerage`,
  calgary: `${ORIGIN}/#calgary`,
  place: (slug: string) => `${ORIGIN}/neighbourhoods/${slug}#place`,
} as const;

/** Owner-verified external profiles (2026-08). The maps.google.com/?cid=
 * link is the stable Google Business Profile entity URL (CID
 * 14326037006691820499 = ftid 0xc6d04ec146f763d3, KG mid /g/11nnvl15kj),
 * resolved from Spencer's share.google link and verified to open "Spencer
 * Rivers Top Calgary REALTOR - Luxury Homes Calgary". LinkedIn
 * intentionally absent — not yet verified. */
const SAME_AS = [
  "https://luxuryhomescalgary.ca/",
  "https://www.facebook.com/SpencerRiversRealEstate",
  "https://www.instagram.com/riversrealtor/",
  "https://www.youtube.com/@riversrealtor",
  "https://www.rew.ca/agents/230822/spencer-rivers",
  "https://www.realtor.ca/agent/2135685/spencer-rivers-700-1816-crowchild-trail-nw-calgary-alberta-t2m3y7",
  "https://maps.google.com/?cid=14326037006691820499",
];

/** The six marquee communities (slugs must match the neighbourhoods table). */
export const MARQUEE_COMMUNITIES: Array<{ slug: string; name: string }> = [
  { slug: "springbank-hill", name: "Springbank Hill" },
  { slug: "aspen-woods", name: "Aspen Woods" },
  { slug: "upper-mount-royal", name: "Upper Mount Royal" },
  { slug: "elbow-park", name: "Elbow Park" },
  { slug: "britannia", name: "Britannia" },
  { slug: "bel-aire", name: "Bel-Aire" },
];

const CALGARY: SchemaNode = {
  "@type": "City",
  "@id": IDS.calgary,
  name: "Calgary",
  containedInPlace: {
    "@type": "AdministrativeArea",
    name: "Alberta",
    containedInPlace: { "@type": "Country", name: "Canada" },
  },
};

const COMMUNITY_PLACES: SchemaNode[] = MARQUEE_COMMUNITIES.map(({ slug, name }) => ({
  "@type": "Place",
  "@id": IDS.place(slug),
  name: `${name}, Calgary`,
  url: `${ORIGIN}/neighbourhoods/${slug}`,
  containedInPlace: { "@id": IDS.calgary },
}));

const BROKERAGE: SchemaNode = {
  "@type": "Organization",
  "@id": IDS.brokerage,
  name: "Synterra Realty",
  address: {
    "@type": "PostalAddress",
    streetAddress: "700-1816 Crowchild Trail NW",
    addressLocality: "Calgary",
    addressRegion: "AB",
    postalCode: "T2M 3Y7",
    addressCountry: "CA",
  },
};

const PERSON: SchemaNode = {
  "@type": "Person",
  "@id": IDS.person,
  name: "Spencer Rivers",
  jobTitle: "Luxury Real Estate Agent",
  telephone: "+1-403-966-9237",
  email: "spencer@riversrealestate.ca",
  url: `${ORIGIN}/about`,
  worksFor: { "@id": IDS.brokerage },
  memberOf: { "@id": IDS.agent },
  hasCredential: [
    "CLHMS — Certified Luxury Home Marketing Specialist, Million Dollar Guild",
    "CIPS — Certified International Property Specialist",
    "CNE — Certified Negotiation Expert",
    "CCS — Certified Condominium Specialist",
    "LLS — Luxury Listing Specialist",
  ].map((name) => ({
    "@type": "EducationalOccupationalCredential",
    name,
  })),
};

const AGENT: SchemaNode = {
  "@type": "RealEstateAgent",
  "@id": IDS.agent,
  name: "Rivers Real Estate — Spencer Rivers",
  url: `${ORIGIN}/`,
  telephone: "+1-403-966-9237",
  email: "spencer@riversrealestate.ca",
  priceRange: "$1M+",
  image: `${ORIGIN}/img/og-default.jpg`,
  address: {
    "@type": "PostalAddress",
    streetAddress: "38 Elmont Cove SW",
    addressLocality: "Calgary",
    addressRegion: "AB",
    postalCode: "T3H 6A5",
    addressCountry: "CA",
  },
  founder: { "@id": IDS.person },
  memberOf: { "@id": IDS.brokerage },
  sameAs: SAME_AS,
  areaServed: [
    { "@id": IDS.calgary },
    ...MARQUEE_COMMUNITIES.map(({ slug }) => ({ "@id": IDS.place(slug) })),
  ],
  knowsAbout: [
    "Calgary luxury real estate",
    "Luxury condominium buildings in Calgary",
    "Pre-construction condo assignments",
    "Calgary home valuation",
    ...MARQUEE_COMMUNITIES.map(({ name }) => `${name} real estate`),
  ],
};

// The site name Google may show in place of the bare domain in search
// results. Google reads WebSite.name here, og:site_name (seo-inject.ts), the
// manifest name (client/public/site.webmanifest), and the homepage <title>,
// and only uses a name it sees consistently across them — so change all four
// together or Google falls back to "riversrealestate.ca". alternateName gives
// it the accepted shorthand; both must be names the brand actually uses.
const WEBSITE: SchemaNode = {
  "@type": "WebSite",
  "@id": IDS.website,
  url: `${ORIGIN}/`,
  name: "Rivers Real Estate",
  alternateName: ["Luxury Homes Calgary", "Rivers Real Estate Calgary"],
  inLanguage: "en-CA",
  publisher: { "@id": IDS.agent },
  potentialAction: {
    "@type": "SearchAction",
    target: `${ORIGIN}/mls?q={search_term_string}`,
    "query-input": "required name=search_term_string",
  },
};

/** Nodes present in every indexable page's @graph. */
const CORE_NODES: SchemaNode[] = [
  WEBSITE,
  AGENT,
  PERSON,
  BROKERAGE,
  CALGARY,
  ...COMMUNITY_PLACES,
];

/**
 * Assemble one @graph: core entities + page nodes, deduped by @id. When a
 * page node shares an @id with a core node (e.g. a neighbourhood page's full
 * Place vs the areaServed stub), the two are merged with the page node's
 * fields winning — one entity, richest data.
 */
export function buildGraph(pageNodes: SchemaNode[] = []): Record<string, unknown> {
  const byId = new Map<string, SchemaNode>();
  const anonymous: SchemaNode[] = [];
  for (const raw of [...CORE_NODES, ...pageNodes]) {
    // Page nodes historically carried their own @context; strip it — the
    // graph wrapper owns it.
    const { ["@context"]: _ctx, ...node } = raw as Record<string, unknown>;
    const id = (node as SchemaNode)["@id"];
    if (typeof id === "string") {
      byId.set(id, { ...(byId.get(id) ?? {}), ...(node as SchemaNode) });
    } else {
      anonymous.push(node as SchemaNode);
    }
  }
  return {
    "@context": "https://schema.org",
    "@graph": [...Array.from(byId.values()), ...anonymous],
  };
}

export { ORIGIN as SCHEMA_ORIGIN };
