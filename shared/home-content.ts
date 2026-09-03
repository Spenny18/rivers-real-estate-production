/**
 * Home page content model — the schema behind /admin/home.
 *
 * The public homepage is a list of BLOCKS. Each block has a `type` (which
 * picks the React section that renders it), a `data` bag of editable
 * content, and style/visibility settings. This file is the single source of
 * truth for:
 *
 *   1. what block types exist (BLOCK_TYPES)
 *   2. which fields each type exposes, and how the admin renders an input
 *      for them (FieldDef — the admin editor is generated from this, so a
 *      new field here shows up in the CMS with no admin-side code)
 *   3. the factory defaults (DEFAULT_HOME_PAGE), transcribed verbatim from
 *      the hand-built homepage so a fresh database renders exactly what
 *      shipped before the CMS existed
 *
 * Imported by the client (renderer + editor) AND the server (seeding,
 * validation, SEO injection), so keep it free of React and Node APIs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldType =
  | "text"
  | "textarea"
  | "paragraphs"
  | "image"
  | "url"
  | "number"
  | "switch"
  | "select"
  | "icon"
  | "list";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  help?: string;
  rows?: number;
  min?: number;
  max?: number;
  /** select only */
  options?: Array<{ value: string; label: string }>;
  /** list only — when set, each item is an object with these fields */
  itemFields?: FieldDef[];
  /** list only — singular noun used on the "Add" button */
  itemLabel?: string;
  /** list only — the field whose value titles the collapsed row */
  itemTitleKey?: string;
  /** list only — plain string items instead of objects */
  itemType?: "text";
  max_items?: number;
}

export type BlockCategory =
  | "Hero"
  | "Content"
  | "Listings & areas"
  | "Social proof"
  | "Conversion";

export interface BlockTypeDef {
  type: string;
  label: string;
  description: string;
  /** lucide-react icon name, resolved by the admin's ICONS map */
  icon: string;
  category: BlockCategory;
  /** Blocks that only make sense once on a page (hero, contact form…). */
  singleton?: boolean;
  /** Note shown in the editor when the block pulls live data from an API. */
  dataSource?: string;
  /** Full-bleed blocks own their background/padding — no style controls. */
  noStyleControls?: boolean;
  fields: FieldDef[];
  defaults: Record<string, any>;
}

export interface PageBlock {
  id: string;
  type: string;
  enabled: boolean;
  data: Record<string, any>;
}

export interface PageSeo {
  title: string;
  description: string;
  keywords: string;
  ogImage: string;
  canonical: string;
  noindex: boolean;
}

export interface PageContent {
  slug: string;
  name: string;
  seo: PageSeo;
  blocks: PageBlock[];
  updatedAt?: string;
  updatedBy?: string | null;
}

// ---------------------------------------------------------------------------
// Style fields — appended to every block type that isn't full-bleed
// ---------------------------------------------------------------------------

export const STYLE_FIELDS: FieldDef[] = [
  {
    key: "bg",
    label: "Background",
    type: "select",
    options: [
      { value: "default", label: "Page background" },
      { value: "muted", label: "Soft grey (bordered)" },
      { value: "dark", label: "Black / inverted" },
    ],
  },
  {
    key: "spacing",
    label: "Vertical spacing",
    type: "select",
    options: [
      { value: "compact", label: "Compact" },
      { value: "normal", label: "Normal" },
      { value: "spacious", label: "Spacious" },
    ],
  },
  {
    key: "visibility",
    label: "Show on",
    type: "select",
    options: [
      { value: "all", label: "All devices" },
      { value: "desktop", label: "Desktop only" },
      { value: "mobile", label: "Mobile only" },
    ],
  },
  {
    key: "anchor",
    label: "Anchor ID",
    type: "text",
    placeholder: "e.g. recent-sales",
    help: "Lets you link straight to this section with /#anchor.",
  },
];

export const STYLE_DEFAULTS = {
  bg: "default",
  spacing: "normal",
  visibility: "all",
  anchor: "",
};

/** Icon names offered by the icon picker (must exist in the client ICONS map). */
export const ICON_CHOICES = [
  "Award",
  "ShieldCheck",
  "Eye",
  "Sparkles",
  "Home",
  "Heart",
  "Compass",
  "Building2",
  "TrendingUp",
  "Users",
  "Briefcase",
  "MapPin",
  "Star",
  "Check",
  "Key",
  "Phone",
  "Mail",
  "Clock",
  "LineChart",
  "Handshake",
] as const;

// Reusable field fragments -------------------------------------------------

const EYEBROW: FieldDef = {
  key: "eyebrow",
  label: "Eyebrow (small caps line)",
  type: "text",
  placeholder: "ON THE MARKET",
};
const HEADING: FieldDef = {
  key: "heading",
  label: "Heading",
  type: "textarea",
  rows: 2,
};
const BODY: FieldDef = {
  key: "body",
  label: "Body copy",
  type: "textarea",
  rows: 4,
};
const CTA: FieldDef[] = [
  { key: "ctaLabel", label: "Link label", type: "text" },
  { key: "ctaHref", label: "Link URL", type: "url", placeholder: "/mls" },
];

// ---------------------------------------------------------------------------
// Block type registry
// ---------------------------------------------------------------------------

export const BLOCK_TYPES: BlockTypeDef[] = [
  {
    type: "hero",
    label: "Hero",
    description: "Full-height header with the page H1 and MLS search bar.",
    icon: "Sparkles",
    category: "Hero",
    singleton: true,
    noStyleControls: true,
    fields: [
      EYEBROW,
      {
        key: "headline",
        label: "H1 headline",
        type: "textarea",
        rows: 3,
        help: "This is the page's only H1 — the single strongest on-page SEO signal.",
      },
      { key: "subheadline", label: "Sub-headline", type: "textarea", rows: 4 },
      { key: "backgroundImage", label: "Background image URL", type: "image" },
      {
        key: "backgroundAlt",
        label: "Background image alt text",
        type: "text",
        help: "Leave empty if the image is purely decorative.",
      },
      {
        key: "overlay",
        label: "Dark overlay strength (%)",
        type: "number",
        min: 0,
        max: 100,
      },
      { key: "showSearch", label: "Show MLS search bar", type: "switch" },
      { key: "searchPlaceholder", label: "Search placeholder", type: "text" },
      { key: "searchButtonLabel", label: "Search button label", type: "text" },
      { key: "footnote", label: "Footnote under the search bar", type: "text" },
      { key: "anchor", label: "Anchor ID", type: "text" },
    ],
    defaults: {
      eyebrow: "CALGARY · ALBERTA",
      headline: "A quieter way to buy and sell Calgary's most prestigious homes.",
      subheadline:
        "Spencer Rivers represents buyers and sellers in Springbank Hill, Aspen Woods, Upper Mount Royal, Elbow Park, Britannia, and Bel-Aire — Calgary's six luxury markets — with discretion, data, and direct conversation.",
      backgroundImage:
        "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=2400&h=1600&fit=crop",
      backgroundAlt: "",
      overlay: 50,
      showSearch: true,
      searchPlaceholder: "Address, neighbourhood, or MLS#",
      searchButtonLabel: "SEARCH MLS",
      footnote: "LIVE PILLAR 9 FEED · CALGARY MLS®",
      anchor: "",
    },
  },

  {
    type: "recentSales",
    label: "Recent sales",
    description: "Three-up grid of sold properties with photos.",
    icon: "Home",
    category: "Social proof",
    fields: [
      EYEBROW,
      HEADING,
      ...CTA,
      {
        key: "items",
        label: "Sales",
        type: "list",
        itemLabel: "sale",
        itemTitleKey: "address",
        itemFields: [
          { key: "address", label: "Address", type: "text" },
          { key: "image", label: "Photo URL", type: "image" },
          { key: "caption", label: "Caption", type: "text" },
          { key: "badge", label: "Corner badge", type: "text" },
        ],
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "SELECTED · SOLD",
      heading: "Recent sales.",
      ctaLabel: "VIEW MORE RECENT SALES",
      ctaHref: "/contact",
      items: [
        {
          address: "102 Malibou Road SW",
          image:
            "https://luxuryhomescalgary.ca/wp-content/uploads/2024/12/005-102-Malibou-rd-TW-2-scaled-1.jpg",
          caption: "Sold · Mayfair / Bel-Aire",
          badge: "SOLD",
        },
        {
          address: "1105 East Chestermere Drive",
          image:
            "https://luxuryhomescalgary.ca/wp-content/uploads/2025/12/029-1105-E-chestermere-DR-14-scaled-1-scaled.jpg",
          caption: "Sold · East Chestermere",
          badge: "SOLD",
        },
        {
          address: "43 Red Willow Crescent West",
          image: "https://luxuryhomescalgary.ca/wp-content/uploads/2025/12/dg_006.jpeg",
          caption: "Sold · Heritage Pointe",
          badge: "SOLD",
        },
      ],
      ...STYLE_DEFAULTS,
      spacing: "compact",
    },
  },

  {
    type: "authority",
    label: "Authority split",
    description: "Portrait beside a headline, paragraph, and two buttons.",
    icon: "Award",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      { key: "image", label: "Image URL", type: "image" },
      { key: "imageAlt", label: "Image alt text", type: "text" },
      {
        key: "imagePosition",
        label: "Image position",
        type: "select",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
      },
      { key: "primaryLabel", label: "Primary button label", type: "text" },
      { key: "primaryHref", label: "Primary button URL", type: "url" },
      { key: "secondaryLabel", label: "Secondary button label", type: "text" },
      { key: "secondaryHref", label: "Secondary button URL", type: "url" },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "SPENCER RIVERS",
      heading: "Calgary luxury real estate guidance, grounded in local experience.",
      body: "Since 2015, Spencer has helped buyers and sellers navigate Calgary's luxury market with responsive communication, careful analysis, and a primary focus on six prestige communities.",
      image: "/img/spencer-arriva.jpg",
      imageAlt: "Spencer Rivers taking a client call in a Calgary high-rise",
      imagePosition: "left",
      primaryLabel: "ABOUT SPENCER",
      primaryHref: "/about",
      secondaryLabel: "CONTACT SPENCER",
      secondaryHref: "/contact",
      ...STYLE_DEFAULTS,
      bg: "muted",
    },
  },

  {
    type: "checklist",
    label: "Checklist / process",
    description: "Headline plus a two-column list of ticked promises.",
    icon: "Check",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      {
        key: "items",
        label: "Checklist items",
        type: "list",
        itemLabel: "item",
        itemType: "text",
      },
      ...CTA,
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "OUR STRESS-FREE BUYING / SELLING PROCESS",
      heading: "No fluff, just results.",
      body: "From market volatility to final closing — we handle every detail.",
      items: [
        "Honest market assessment with no pressure to decide quickly",
        "Regular feedback after every showing — you'll always know where you stand",
        "We organize lawyers, inspections, and all complex details",
        "Responsive communication because timely responses are crucial",
      ],
      ctaLabel: "CONTACT SPENCER",
      ctaHref: "/contact",
      ...STYLE_DEFAULTS,
    },
  },

  {
    type: "statsBand",
    label: "Stat band",
    description: "Slim four-up row of numbers. Can pull live listing counts.",
    icon: "LineChart",
    category: "Social proof",
    fields: [
      {
        key: "items",
        label: "Stats",
        type: "list",
        itemLabel: "stat",
        itemTitleKey: "label",
        itemFields: [
          { key: "value", label: "Value", type: "text" },
          { key: "label", label: "Label", type: "text" },
          {
            key: "source",
            label: "Value source",
            type: "select",
            options: [
              { value: "manual", label: "Typed value" },
              { value: "activeListings", label: "Live: active MLS listings" },
            ],
          },
        ],
      },
      ...STYLE_FIELDS,
    ],
    dataSource: "Stats marked “live” read from /api/public/stats.",
    defaults: {
      items: [
        { value: "—", label: "Active Listings", source: "activeListings" },
        { value: "Since 2015", label: "Serving Calgary", source: "manual" },
        { value: "6", label: "Core Luxury Markets", source: "manual" },
        { value: "98.4%", label: "Avg. Sale-to-List", source: "manual" },
      ],
      ...STYLE_DEFAULTS,
      bg: "muted",
      spacing: "compact",
    },
  },

  {
    type: "featuredListings",
    label: "Featured MLS listings",
    description: "Live grid of featured listings from the Pillar 9 feed.",
    icon: "Building2",
    category: "Listings & areas",
    dataSource: "Listings come live from /api/public/mls/featured.",
    fields: [
      EYEBROW,
      HEADING,
      ...CTA,
      { key: "limit", label: "How many listings", type: "number", min: 1, max: 12 },
      { key: "emptyHeading", label: "Empty-state heading", type: "text" },
      { key: "emptyBody", label: "Empty-state copy", type: "textarea", rows: 3 },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "ON THE MARKET",
      heading: "Featured Calgary luxury listings.",
      ctaLabel: "VIEW ALL LISTINGS",
      ctaHref: "/mls",
      limit: 6,
      emptyHeading: "NO ACTIVE LISTINGS",
      emptyBody:
        "Spencer's current inventory is moving — call directly for off-market opportunities.",
      ...STYLE_DEFAULTS,
    },
  },

  {
    type: "neighbourhoodCards",
    label: "Neighbourhood cards",
    description: "Photo cards for every neighbourhood in the CMS.",
    icon: "MapPin",
    category: "Listings & areas",
    dataSource: "Cards come from the Neighbourhoods CMS.",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      { key: "limit", label: "Max cards (0 = all)", type: "number", min: 0, max: 60 },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "CALGARY · LUXURY MARKETS",
      heading: "Six core luxury markets. One advisor who knows them block by block.",
      body: "Each of Calgary's prestige communities has its own character, inventory rhythm, and pricing logic. Spencer's primary focus is these six markets, alongside select communities across Calgary and the surrounding area.",
      limit: 0,
      ...STYLE_DEFAULTS,
      bg: "muted",
    },
  },

  {
    type: "neighbourhoodLinks",
    label: "Neighbourhood link grid",
    description: "Dense three-column list of community links (SEO surface).",
    icon: "Compass",
    category: "Listings & areas",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      {
        key: "items",
        label: "Neighbourhoods",
        type: "list",
        itemLabel: "neighbourhood",
        itemTitleKey: "name",
        itemFields: [
          { key: "name", label: "Name", type: "text" },
          { key: "slug", label: "Slug", type: "text", placeholder: "aspen-woods" },
        ],
      },
      ...CTA,
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "CALGARY NEIGHBOURHOOD EXPERT",
      heading: "Some of Calgary's best neighbourhoods.",
      body: "Find local expertise and discover each neighbourhood's dynamic market.",
      items: [
        { name: "Altadore", slug: "altadore" },
        { name: "Aspen Woods", slug: "aspen-woods" },
        { name: "Bearspaw", slug: "bearspaw" },
        { name: "Beltline", slug: "beltline" },
        { name: "Bel-Aire", slug: "bel-aire" },
        { name: "Britannia", slug: "britannia" },
        { name: "Edgemont", slug: "edgemont" },
        { name: "Elbow Park", slug: "elbow-park" },
        { name: "Evanston", slug: "evanston" },
        { name: "Mahogany", slug: "mahogany" },
        { name: "McKenzie Lake", slug: "mckenzie-lake" },
        { name: "Rosedale", slug: "rosedale" },
        { name: "Roxboro", slug: "roxboro" },
        { name: "Springbank Hill", slug: "springbank-hill" },
        { name: "Upper Mount Royal", slug: "upper-mount-royal" },
      ],
      ctaLabel: "VIEW ALL AREAS",
      ctaHref: "/neighbourhoods",
      ...STYLE_DEFAULTS,
      spacing: "compact",
    },
  },

  {
    type: "numberedList",
    label: "Numbered list",
    description: "Intro column beside a numbered 01/02/03 list of entries.",
    icon: "Compass",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      ...CTA,
      {
        key: "items",
        label: "Entries",
        type: "list",
        itemLabel: "entry",
        itemTitleKey: "name",
        itemFields: [
          { key: "name", label: "Title", type: "text" },
          { key: "summary", label: "Summary", type: "textarea", rows: 3 },
        ],
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "CALGARY NEIGHBOURHOOD EXPERT",
      heading: "Every zone, every community.",
      body: "Calgary's diversity across zones requires deep local knowledge. We know them all — from the prestige streets of the inner southwest to the new-construction communities of the northeast.",
      ctaLabel: "VIEW ALL AREAS",
      ctaHref: "/neighbourhoods",
      items: [
        {
          name: "Southwest Established Prestige",
          summary:
            "Springbank Hill, Aspen Woods, Bel-Aire, Britannia, Mayfair — Calgary's deepest concentration of $2M+ inventory.",
        },
        {
          name: "City Centre Urban Luxury",
          summary:
            "Upper Mount Royal, Elbow Park, Roxboro, Rideau Park, Mission, Beltline — historic estates and new-build penthouses.",
        },
        {
          name: "Northwest Family Communities",
          summary:
            "Edgemont, Hidden Valley, Tuscany, Varsity, Bearspaw acreage — established neighbourhoods near top schools.",
        },
        {
          name: "Southeast Value & Community",
          summary:
            "Mahogany, Auburn Bay, Cranston, McKenzie Lake — newer lake communities with strong amenity premiums.",
        },
        {
          name: "Northeast Rising Communities",
          summary:
            "Skyview Ranch, Redstone, Cityscape — growth markets with the best $/sq-ft for new construction.",
        },
      ],
      ...STYLE_DEFAULTS,
      bg: "muted",
    },
  },

  {
    type: "video",
    label: "Video",
    description: "Centred YouTube embed with a click-to-play poster frame.",
    icon: "Play",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      {
        key: "youtubeId",
        label: "YouTube video ID",
        type: "text",
        placeholder: "TV0Rm0fZxI8",
        help: "The part after watch?v= in the YouTube URL.",
      },
      {
        key: "thumbnail",
        label: "Poster image URL",
        type: "image",
        help: "Leave blank to use YouTube's own maxres thumbnail.",
      },
      { key: "videoTitle", label: "Embed title (accessibility)", type: "text" },
      BODY,
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "MEET SPENCER",
      heading: "Why Spencer Rivers is the best luxury realtor in Calgary.",
      youtubeId: "TV0Rm0fZxI8",
      thumbnail: "",
      videoTitle: "Why Spencer Rivers is the best luxury realtor in Calgary",
      body: "With nearly 8,500 REALTORS® in Calgary, choosing the right one for your luxury home sale or purchase matters. Spencer has worked in Calgary real estate since 2015, with a primary focus on the city's prestige market and the local details that shape value.",
      ...STYLE_DEFAULTS,
    },
  },

  {
    type: "bigStats",
    label: "Big stats band",
    description: "Oversized headline numbers with labels and sub-labels.",
    icon: "TrendingUp",
    category: "Social proof",
    fields: [
      EYEBROW,
      HEADING,
      {
        key: "items",
        label: "Stats",
        type: "list",
        itemLabel: "stat",
        itemTitleKey: "label",
        itemFields: [
          { key: "value", label: "Big number", type: "text" },
          { key: "label", label: "Label", type: "text" },
          { key: "sub", label: "Sub-label", type: "text" },
        ],
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "BY THE NUMBERS",
      heading:
        "Calgary luxury real estate experience, local market knowledge, and direct advice.",
      items: [
        { value: "$100M+", label: "In personal sales", sub: "Top Luxury Realtor in Calgary" },
        { value: "Ranked #3", label: "Top Realtor in Calgary", sub: "Best in Calgary" },
        {
          value: "98.4%",
          label: "Average sale-to-list ratio",
          sub: "Personal listing results",
        },
        { value: "100s", label: "Clients helped", sub: "Since 2015" },
        { value: "Top Agent", label: "In Canada", sub: "Dream Homes of Canada" },
      ],
      ...STYLE_DEFAULTS,
      bg: "dark",
    },
  },

  {
    type: "buyerSellerTabs",
    label: "Buyer / seller tabs",
    description: "Tabbed problem-and-solution cards plus a results panel.",
    icon: "Users",
    category: "Conversion",
    fields: [
      EYEBROW,
      HEADING,
      { key: "buyerTabLabel", label: "First tab label", type: "text" },
      { key: "sellerTabLabel", label: "Second tab label", type: "text" },
      {
        key: "buyerCards",
        label: "First tab cards",
        type: "list",
        itemLabel: "card",
        itemTitleKey: "title",
        itemFields: [
          { key: "title", label: "Card title", type: "text" },
          { key: "problem", label: "Quoted problem", type: "textarea", rows: 2 },
          { key: "solution", label: "Solution", type: "textarea", rows: 4 },
        ],
      },
      {
        key: "sellerCards",
        label: "Second tab cards",
        type: "list",
        itemLabel: "card",
        itemTitleKey: "title",
        itemFields: [
          { key: "title", label: "Card title", type: "text" },
          { key: "problem", label: "Quoted problem", type: "textarea", rows: 2 },
          { key: "solution", label: "Solution", type: "textarea", rows: 4 },
        ],
      },
      { key: "resultsEyebrow", label: "Results panel eyebrow", type: "text" },
      { key: "resultsHeading", label: "Results panel heading", type: "textarea", rows: 2 },
      {
        key: "results",
        label: "Results stats",
        type: "list",
        itemLabel: "result",
        itemTitleKey: "label",
        itemFields: [
          { key: "value", label: "Value", type: "text" },
          { key: "label", label: "Label", type: "text" },
          { key: "sub", label: "Sub-label", type: "text" },
        ],
      },
      ...CTA,
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "HOW WE WORK",
      heading: "How we'll get the best deal for you.",
      buyerTabLabel: "FOR BUYERS",
      sellerTabLabel: "FOR SELLERS",
      buyerCards: [
        {
          title: "Competitive market navigation",
          problem:
            "Multiple offers and bidding wars make it impossible to get a fair deal.",
          solution:
            "Experience built since 2015 helps Spencer position competitive offers carefully — with clear comparable data, practical terms, and advice designed to protect your budget.",
        },
        {
          title: "Current market advantages",
          problem: "Is now the right time to buy?",
          solution:
            "Real-time read on inventory, mortgage rates, and seasonal price patterns by community. Buy when YOUR target is soft, not when the headline market is.",
        },
        {
          title: "Property discovery & access",
          problem: "The best properties seem to sell before I even see them.",
          solution:
            "A private buyer database and established agent network can provide visibility into relevant opportunities beyond public search portals.",
        },
        {
          title: "Neighbourhood expertise",
          problem: "I need to understand the community, schools, investment potential.",
          solution:
            "Block-by-block knowledge of Calgary's six prestige communities — lot characteristics, neighbour history, rebuild patterns, and which streets hold value.",
        },
        {
          title: "Due diligence & protection",
          problem: "How do I avoid costly mistakes and hidden problems?",
          solution:
            "We organize lawyers, inspections, environmental reports, and every complex detail. You make the decision; we surface the risks.",
        },
      ],
      sellerCards: [
        {
          title: "Stress & anxiety relief",
          problem: "Selling feels overwhelming — too many moving pieces.",
          solution:
            "A clear process, regular updates, and one direct line help make a complex sale more manageable from preparation through closing.",
        },
        {
          title: "Market volatility navigation",
          problem: "Rates, inventory, and prices keep shifting — when do I list?",
          solution:
            "Pricing built on data, not opinion: comparable sales, days-on-market trends, and the specific lot characteristics that drive value in your community.",
        },
        {
          title: "Communication & transparency",
          problem: "Agents disappear after the sign goes up.",
          solution:
            "Regular feedback after every showing. You'll always know where you stand, who saw the home, and what they said.",
        },
        {
          title: "Neighbourhood expertise authority",
          problem:
            "Generalists pricing a luxury home in a market they don't actually work in.",
          solution:
            "Spencer's primary focus is Calgary's six prestige communities, supported by experience across the city and surrounding area.",
        },
      ],
      resultsEyebrow: "OUR PROVEN RESULTS FORMULA",
      resultsHeading: "What “no fluff, just results” actually looks like.",
      results: [
        { value: "50% Faster", label: "Than the industry average", sub: "Average time to sell" },
        { value: "98.4%", label: "Sale-to-list ratio", sub: "On average" },
        { value: "Hands-on", label: "Seller support", sub: "Clear updates from preparation to closing" },
        {
          value: "100%",
          label: "Detail management",
          sub: "Lawyers, inspections, every step",
        },
      ],
      ctaLabel: "GET YOUR CUSTOM HOME VALUATION",
      ctaHref: "/home-evaluation",
      ...STYLE_DEFAULTS,
    },
  },

  {
    type: "iconPoints",
    label: "Icon points",
    description: "Intro column beside stacked icon + heading + copy panels.",
    icon: "ShieldCheck",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      ...CTA,
      {
        key: "items",
        label: "Points",
        type: "list",
        itemLabel: "point",
        itemTitleKey: "title",
        itemFields: [
          { key: "icon", label: "Icon", type: "icon" },
          { key: "title", label: "Title", type: "text" },
          { key: "body", label: "Body", type: "textarea", rows: 4 },
        ],
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "THE RIVERS APPROACH",
      heading: "Quieter, sharper, fewer surprises.",
      body: "Most luxury sellers in Calgary aren't looking for billboards or branded swag — they want a transaction handled with judgment, by someone who actually answers the phone. That's what I do.",
      ctaLabel: "READ MORE ABOUT SPENCER",
      ctaHref: "/about",
      items: [
        {
          icon: "Award",
          title: "12 years in the prestige market",
          body: "Working exclusively in Calgary's six luxury communities — the same streets, year over year — means I know the lots, the neighbours, and the rebuild history of every listing.",
        },
        {
          icon: "ShieldCheck",
          title: "Discretion as the default",
          body: "I maintain a private buyer database and an established agent network for clients who want a more discreet sale process or broader visibility beyond public search portals.",
        },
        {
          icon: "Eye",
          title: "Pricing built on data, not opinion",
          body: "Every pricing recommendation is anchored to comparable sales, days-on-market trends, and the specific lot characteristics that drive value in your community.",
        },
      ],
      ...STYLE_DEFAULTS,
    },
  },

  {
    type: "cardGrid",
    label: "Linked card grid",
    description: "Four-across icon cards that link to landing pages.",
    icon: "Briefcase",
    category: "Conversion",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      {
        key: "columns",
        label: "Columns",
        type: "select",
        options: [
          { value: "3", label: "Three" },
          { value: "4", label: "Four" },
        ],
      },
      { key: "linkLabel", label: "Card link label", type: "text" },
      {
        key: "items",
        label: "Cards",
        type: "list",
        itemLabel: "card",
        itemTitleKey: "title",
        itemFields: [
          { key: "icon", label: "Icon", type: "icon" },
          { key: "title", label: "Title", type: "text" },
          { key: "body", label: "Body", type: "textarea", rows: 3 },
          { key: "href", label: "Link URL", type: "url" },
        ],
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "WHO WE WORK WITH",
      heading: "We are your team for buying or selling.",
      body: "",
      columns: "4",
      linkLabel: "LEARN MORE",
      items: [
        {
          icon: "Sparkles",
          title: "Luxury Properties",
          body: "Shop Calgary's finest estates, penthouses, and villas. Private showings, VIP off-market access, and expert negotiation for $1M+ buyers.",
          href: "/work-with/luxury-properties",
        },
        {
          icon: "Home",
          title: "First-Time Home Sellers",
          body: "Sell your first home with confidence. We walk you through pricing, timing, prep, and every form so nothing gets missed.",
          href: "/work-with/first-time-home-sellers",
        },
        {
          icon: "Heart",
          title: "Empty Nesters",
          body: "Right-size without compromise. Downsize into a luxury condo, lock-and-leave bungalow, or curated build — without losing equity in the move.",
          href: "/work-with/empty-nesters",
        },
        {
          icon: "Compass",
          title: "First-Time Home Buyers",
          body: "Buy smart, not fast. We coach you through financing, inspections, and the Calgary submarkets where your budget goes furthest.",
          href: "/work-with/first-time-home-buyers",
        },
        {
          icon: "Building2",
          title: "Innercity Properties",
          body: "Upper Mount Royal, Elbow Park, Roxboro, Mission, Beltline — Calgary's most walkable luxury submarkets.",
          href: "/work-with/innercity-properties",
        },
        {
          icon: "TrendingUp",
          title: "Move-Ups",
          body: "Trading up to your forever home? We coordinate the sell-and-buy sequence so you're not stuck between two mortgages.",
          href: "/work-with/move-ups",
        },
        {
          icon: "Users",
          title: "Family-Focused Properties",
          body: "School zones, cul-de-sacs, oversized lots, basement suites — the Calgary submarkets built for growing families.",
          href: "/work-with/family-focused-properties",
        },
        {
          icon: "Briefcase",
          title: "Urban Properties",
          body: "Loft condos, executive townhomes, and walkable inner-city neighbourhoods for professionals and downsizers.",
          href: "/work-with/urban-properties",
        },
      ],
      ...STYLE_DEFAULTS,
    },
  },

  {
    type: "awards",
    label: "Awards strip",
    description: "Row of bordered credential chips.",
    icon: "Award",
    category: "Social proof",
    fields: [
      EYEBROW,
      HEADING,
      {
        key: "items",
        label: "Awards",
        type: "list",
        itemLabel: "award",
        itemType: "text",
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "SPENCER RIVERS",
      heading: "Awards and accolades.",
      items: [
        "Ranked #3 Top Realtor in Calgary — Best in Calgary",
        "Top Agent in Canada — Dream Homes of Canada",
        "$100M+ in Career Sales",
        "Certified Luxury Home Specialist",
        "Synterra Realty",
        "Calgary Real Estate Board",
        "REALTOR®",
      ],
      ...STYLE_DEFAULTS,
      bg: "muted",
      spacing: "compact",
    },
  },

  {
    type: "resourceCards",
    label: "Resource cards",
    description: "Centred intro, plain info cards, and a row of buttons.",
    icon: "Compass",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      {
        key: "items",
        label: "Cards",
        type: "list",
        itemLabel: "card",
        itemTitleKey: "title",
        itemFields: [
          { key: "title", label: "Title", type: "text" },
          { key: "body", label: "Body", type: "textarea", rows: 3 },
        ],
      },
      {
        key: "buttons",
        label: "Buttons",
        type: "list",
        itemLabel: "button",
        itemTitleKey: "label",
        itemFields: [
          { key: "label", label: "Label", type: "text" },
          { key: "href", label: "URL", type: "url" },
          {
            key: "variant",
            label: "Style",
            type: "select",
            options: [
              { value: "solid", label: "Solid" },
              { value: "outline", label: "Outline" },
            ],
          },
        ],
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "CALGARY REAL ESTATE RESOURCES",
      heading: "Luxury market overview.",
      body: "Calgary's luxury market moves on its own clock — different inventory cycles, different buyer pools, different pricing logic. Here's how to read it.",
      items: [
        {
          title: "Market Condition Updates",
          body: "Current Calgary trends, inventory levels, and the price moves shaping each prestige submarket.",
        },
        {
          title: "Stress-Free Selling Guide",
          body: "Step-by-step process from pre-list prep through closing — every detail Spencer handles for you.",
        },
        {
          title: "Neighbourhood Market Analysis",
          body: "Area-specific insights: which streets are selling, which are sitting, and why.",
        },
        {
          title: "Buyer's Market Insight",
          body: "An honest read on when and where today's buyers have leverage in the Calgary market.",
        },
      ],
      buttons: [
        { label: "ACCESS VIP LISTINGS", href: "/mls", variant: "solid" },
        { label: "OFF-MARKET LISTINGS", href: "/contact", variant: "outline" },
        { label: "GET CUSTOM MARKET INSIGHT", href: "/home-evaluation", variant: "outline" },
      ],
      ...STYLE_DEFAULTS,
      bg: "muted",
    },
  },

  {
    type: "blogTeaser",
    label: "Blog teaser",
    description: "Latest published journal entries.",
    icon: "FileText",
    category: "Content",
    dataSource: "Posts come live from the Blog CMS.",
    fields: [
      EYEBROW,
      HEADING,
      ...CTA,
      { key: "limit", label: "How many posts", type: "number", min: 1, max: 12 },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "JOURNAL",
      heading: "Notes from the Calgary luxury market.",
      ctaLabel: "ALL ENTRIES",
      ctaHref: "/blog",
      limit: 6,
      ...STYLE_DEFAULTS,
      bg: "muted",
    },
  },

  {
    type: "testimonials",
    label: "Testimonials",
    description: "Rotating client quote with star rating.",
    icon: "Star",
    category: "Social proof",
    dataSource: "Quotes come from the testimonials table.",
    fields: [
      EYEBROW,
      { key: "limit", label: "How many quotes in rotation", type: "number", min: 1, max: 12 },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "CLIENT VOICES",
      limit: 6,
      ...STYLE_DEFAULTS,
      bg: "dark",
      spacing: "spacious",
    },
  },

  {
    type: "instagram",
    label: "Instagram strip",
    description: "Eight-tile grid of the latest Instagram posts.",
    icon: "Instagram",
    category: "Social proof",
    dataSource: "Tiles come live from /api/public/instagram.",
    fields: [
      EYEBROW,
      HEADING,
      { key: "buttonLabel", label: "Button label", type: "text" },
      { key: "profileUrl", label: "Instagram profile URL", type: "url" },
      { key: "limit", label: "How many tiles", type: "number", min: 4, max: 16 },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "@RIVERSREALTOR",
      heading: "Follow Spencer on Instagram.",
      buttonLabel: "FOLLOW SPENCER",
      profileUrl: "https://instagram.com/riversrealtor",
      limit: 8,
      ...STYLE_DEFAULTS,
      spacing: "compact",
    },
  },

  {
    type: "contactCta",
    label: "Contact form",
    description: "Contact details beside the homepage inquiry form.",
    icon: "Mail",
    category: "Conversion",
    singleton: true,
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      { key: "phone", label: "Phone number", type: "text" },
      { key: "phoneNote", label: "Phone caption", type: "text" },
      { key: "email", label: "Email address", type: "text" },
      { key: "emailNote", label: "Email caption", type: "text" },
      { key: "office", label: "Brokerage", type: "text" },
      { key: "officeNote", label: "Brokerage caption", type: "text" },
      { key: "formHeading", label: "Message field label", type: "text" },
      { key: "submitLabel", label: "Submit button label", type: "text" },
      { key: "successMessage", label: "Success toast copy", type: "text" },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "START THE CONVERSATION",
      heading: "Considering a move? Let's talk.",
      body: "The best conversations start three to six months before a listing goes live. Whether you're a year out or testing the market this week, send a note — every inquiry gets a personal reply.",
      phone: "(403) 966-9237",
      phoneNote: "Direct line",
      email: "spencer@riversrealestate.ca",
      emailNote: "Replied within 1 business day",
      office: "Synterra Realty",
      officeNote: "Calgary, Alberta",
      formHeading: "WHAT CAN I HELP WITH?",
      submitLabel: "SEND MESSAGE",
      successMessage: "I'll be in touch within one business day.",
      ...STYLE_DEFAULTS,
    },
  },

  // ---- Generic building blocks (not part of the shipped default page) ----

  {
    type: "richText",
    label: "Text block",
    description: "Free-form heading and paragraphs. Use it anywhere.",
    icon: "FileText",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      {
        key: "body",
        label: "Paragraphs",
        type: "paragraphs",
        rows: 8,
        help: "One paragraph per blank line.",
      },
      {
        key: "align",
        label: "Alignment",
        type: "select",
        options: [
          { value: "left", label: "Left" },
          { value: "center", label: "Centred" },
        ],
      },
      {
        key: "headingLevel",
        label: "Heading level",
        type: "select",
        options: [
          { value: "h2", label: "H2" },
          { value: "h3", label: "H3" },
        ],
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "",
      heading: "A new section",
      body: [
        "Replace this copy with whatever the page needs — the block renders one paragraph per blank line.",
      ],
      align: "left",
      headingLevel: "h2",
      ...STYLE_DEFAULTS,
    },
  },

  {
    type: "ctaBanner",
    label: "CTA banner",
    description: "Short centred headline with up to two buttons.",
    icon: "Sparkles",
    category: "Conversion",
    fields: [
      EYEBROW,
      HEADING,
      BODY,
      { key: "primaryLabel", label: "Primary button label", type: "text" },
      { key: "primaryHref", label: "Primary button URL", type: "url" },
      { key: "secondaryLabel", label: "Secondary button label", type: "text" },
      { key: "secondaryHref", label: "Secondary button URL", type: "url" },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "",
      heading: "Thinking about a move this year?",
      body: "Send a note and get a straight answer on timing, pricing, and what your home would do in today's market.",
      primaryLabel: "BOOK A CALL",
      primaryHref: "/contact",
      secondaryLabel: "GET A HOME VALUATION",
      secondaryHref: "/home-evaluation",
      ...STYLE_DEFAULTS,
      bg: "dark",
      spacing: "compact",
    },
  },

  {
    type: "imageText",
    label: "Image + text",
    description: "A picture on one side, copy and a button on the other.",
    icon: "Image",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      { key: "body", label: "Paragraphs", type: "paragraphs", rows: 6 },
      { key: "image", label: "Image URL", type: "image" },
      { key: "imageAlt", label: "Image alt text", type: "text" },
      {
        key: "imagePosition",
        label: "Image position",
        type: "select",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
      },
      {
        key: "ratio",
        label: "Image shape",
        type: "select",
        options: [
          { value: "portrait", label: "Portrait (4:5)" },
          { value: "landscape", label: "Landscape (4:3)" },
          { value: "square", label: "Square" },
        ],
      },
      ...CTA,
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "",
      heading: "A headline beside a photo",
      body: ["Swap the image and copy for whatever this section needs to say."],
      image: "",
      imageAlt: "",
      imagePosition: "left",
      ratio: "landscape",
      ctaLabel: "",
      ctaHref: "",
      ...STYLE_DEFAULTS,
    },
  },

  {
    type: "faq",
    label: "FAQ",
    description: "Question-and-answer list. Also emitted as FAQ schema.",
    icon: "Compass",
    category: "Content",
    fields: [
      EYEBROW,
      HEADING,
      {
        key: "items",
        label: "Questions",
        type: "list",
        itemLabel: "question",
        itemTitleKey: "question",
        itemFields: [
          { key: "question", label: "Question", type: "text" },
          { key: "answer", label: "Answer", type: "textarea", rows: 4 },
        ],
      },
      ...STYLE_FIELDS,
    ],
    defaults: {
      eyebrow: "COMMON QUESTIONS",
      heading: "Frequently asked questions.",
      items: [
        {
          question: "What areas of Calgary do you work in?",
          answer:
            "Springbank Hill, Aspen Woods, Upper Mount Royal, Elbow Park, Britannia, and Bel-Aire — plus the inner-city and southeast communities those buyers move between.",
        },
      ],
      ...STYLE_DEFAULTS,
      bg: "muted",
    },
  },

  {
    type: "spacer",
    label: "Spacer / divider",
    description: "Breathing room, with an optional hairline rule.",
    icon: "Minus",
    category: "Content",
    fields: [
      {
        key: "size",
        label: "Height",
        type: "select",
        options: [
          { value: "sm", label: "Small" },
          { value: "md", label: "Medium" },
          { value: "lg", label: "Large" },
        ],
      },
      { key: "divider", label: "Show a divider line", type: "switch" },
      {
        key: "visibility",
        label: "Show on",
        type: "select",
        options: [
          { value: "all", label: "All devices" },
          { value: "desktop", label: "Desktop only" },
          { value: "mobile", label: "Mobile only" },
        ],
      },
      { key: "anchor", label: "Anchor ID", type: "text" },
    ],
    defaults: { size: "md", divider: false, visibility: "all", anchor: "" },
  },
];

export const BLOCK_TYPE_MAP: Record<string, BlockTypeDef> = Object.fromEntries(
  BLOCK_TYPES.map((b) => [b.type, b]),
);

export function getBlockType(type: string): BlockTypeDef | undefined {
  return BLOCK_TYPE_MAP[type];
}

/** Label for a block instance, preferring its own heading over the type name. */
export function blockTitle(block: PageBlock): string {
  const def = getBlockType(block.type);
  const raw =
    (typeof block.data?.headline === "string" && block.data.headline) ||
    (typeof block.data?.heading === "string" && block.data.heading) ||
    "";
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return def?.label ?? block.type;
  return trimmed.length > 46 ? `${trimmed.slice(0, 46)}…` : trimmed;
}

// ---------------------------------------------------------------------------
// Defaults for the page as a whole
// ---------------------------------------------------------------------------

export const DEFAULT_HOME_SEO: PageSeo = {
  title: "Spencer Rivers — Luxury Homes Calgary | Rivers Real Estate",
  description:
    "Spencer Rivers is a top Calgary luxury Realtor representing buyers and sellers in Springbank Hill, Aspen Woods, Upper Mount Royal, Elbow Park, Britannia, and Bel-Aire.",
  keywords: "",
  ogImage: "",
  canonical: "",
  noindex: false,
};

/** Order the homepage ships in. Every entry must name a real block type. */
const DEFAULT_BLOCK_ORDER: string[] = [
  "hero",
  "recentSales",
  "authority",
  "checklist",
  "statsBand",
  "featuredListings",
  "neighbourhoodCards",
  "neighbourhoodLinks",
  "numberedList",
  "video",
  "bigStats",
  "buyerSellerTabs",
  "iconPoints",
  "cardGrid",
  "awards",
  "resourceCards",
  "blogTeaser",
  "testimonials",
  "instagram",
  "contactCta",
];

function cloneDefaults(type: string): Record<string, any> {
  const def = getBlockType(type);
  return def ? JSON.parse(JSON.stringify(def.defaults)) : {};
}

/** A fresh copy of the factory homepage. Never mutate the return value. */
export function defaultHomeBlocks(): PageBlock[] {
  return DEFAULT_BLOCK_ORDER.map((type) => ({
    id: `${type}-1`,
    type,
    enabled: true,
    data: cloneDefaults(type),
  }));
}

export function defaultHomePage(): PageContent {
  return {
    slug: "home",
    name: "Home page",
    seo: { ...DEFAULT_HOME_SEO },
    blocks: defaultHomeBlocks(),
  };
}

/** A brand-new block of `type`, ready to append to a page. */
export function newBlock(type: string, idSuffix: string): PageBlock {
  return {
    id: `${type}-${idSuffix}`,
    type,
    enabled: true,
    data: cloneDefaults(type),
  };
}

// ---------------------------------------------------------------------------
// Normalisation — used by the API on read and write
// ---------------------------------------------------------------------------

function coerce(field: FieldDef, value: unknown, fallback: unknown): unknown {
  if (value === undefined || value === null) return fallback;
  switch (field.type) {
    case "switch":
      return typeof value === "boolean" ? value : value === "true" || value === 1;
    case "number": {
      const n = typeof value === "number" ? value : parseFloat(String(value));
      if (Number.isNaN(n)) return fallback;
      if (field.min !== undefined && n < field.min) return field.min;
      if (field.max !== undefined && n > field.max) return field.max;
      return n;
    }
    case "paragraphs":
      if (Array.isArray(value)) return value.map((p) => String(p));
      return String(value)
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
    case "list": {
      if (!Array.isArray(value)) return fallback;
      if (field.itemType === "text") {
        return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
      }
      const itemFields = field.itemFields ?? [];
      return value.map((item) => {
        const row: Record<string, unknown> = {};
        for (const f of itemFields) {
          row[f.key] = coerce(f, (item as any)?.[f.key], defaultForField(f));
        }
        return row;
      });
    }
    default:
      return typeof value === "string" ? value : String(value);
  }
}

function defaultForField(field: FieldDef): unknown {
  switch (field.type) {
    case "switch":
      return false;
    case "number":
      return field.min ?? 0;
    case "list":
    case "paragraphs":
      return [];
    case "select":
      return field.options?.[0]?.value ?? "";
    default:
      return "";
  }
}

/**
 * Fill a block's data with its type defaults and drop unknown keys, so the
 * renderer can read every field without optional chaining and a malformed
 * payload can never reach the public page.
 */
export function normalizeBlock(block: PageBlock): PageBlock | null {
  const def = getBlockType(block?.type);
  if (!def) return null;
  const data: Record<string, unknown> = {};
  for (const field of def.fields) {
    data[field.key] = coerce(field, block.data?.[field.key], def.defaults[field.key]);
  }
  return {
    id: String(block.id || `${def.type}-${Math.random().toString(36).slice(2, 8)}`),
    type: def.type,
    enabled: block.enabled !== false,
    data,
  };
}

export function normalizeBlocks(blocks: unknown): PageBlock[] {
  if (!Array.isArray(blocks)) return defaultHomeBlocks();
  const out: PageBlock[] = [];
  const seenIds = new Set<string>();
  for (const raw of blocks) {
    const b = normalizeBlock(raw as PageBlock);
    if (!b) continue;
    // Ids address blocks in the editor and key the render — force uniqueness.
    let id = b.id;
    let n = 2;
    while (seenIds.has(id)) id = `${b.id}-${n++}`;
    seenIds.add(id);
    out.push({ ...b, id });
  }
  return out;
}

export function normalizeSeo(seo: unknown): PageSeo {
  const s = (seo ?? {}) as Partial<PageSeo>;
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" ? v : fallback;
  return {
    title: str(s.title, DEFAULT_HOME_SEO.title),
    description: str(s.description, DEFAULT_HOME_SEO.description),
    keywords: str(s.keywords, ""),
    ogImage: str(s.ogImage, ""),
    canonical: str(s.canonical, ""),
    noindex: s.noindex === true,
  };
}
