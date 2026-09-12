/**
 * 301 redirect map for legacy URLs — Phase 4 of the SSR/schema project.
 *
 * Sources (audited 2026-08-12):
 *   - GSC Search Analytics, 16 months of pages (127 URLs — every one of
 *     them resolves today; Google has already dropped the old WP URLs
 *     from active serving, so this map is about consolidating leftover
 *     backlink equity and index entries, not stopping live bleeding).
 *   - Wayback Machine CDX inventory of riversrealestate.ca (1,693 URLs →
 *     601 distinct paths → 457 return 404 today).
 *
 * The old site was WordPress, in two eras: a Chestermere/Airdrie-focused
 * era (town pages, /properties/* listing pages) and a Calgary luxury era
 * (neighbourhood guides, ~70 advice posts at root level). There was also
 * a spam infestation (essay-mill/casino pages) — those deliberately stay
 * 404: never redirect spam URLs onto real pages.
 *
 * Policy: redirect only where a genuinely close equivalent exists;
 * anything else keeps its honest 404 (blanket redirects to "/" get
 * treated as soft-404s by Google and pass nothing).
 */

// Old root-level WordPress advice-post slugs → /blog. Their content was not
// migrated 1:1; the journal index is the closest surviving equivalent.
// (Slugs with migrated equivalents get exact entries in EXACT instead.)
const LEGACY_POST_SLUGS = new Set([
  "are-the-holidays-the-best-time-to-buy-a-home",
  "can-you-make-a-mortgage-payment-with-a-credit-card-and-if-so-should-you",
  "choosing-which-type-of-home-loan-is-right-for-you",
  "do-you-have-problematic-neighbors-here-are-your-options",
  "does-a-sparkling-clean-home-fetch-more-money",
  "easy-home-diys-to-try-over-the-holidays",
  "everything-you-need-to-know-about-buying-a-home-in-your-50s",
  "getting-married-here-are-5-homebuying-tips-for-newlyweds",
  "gutter-maintenance-that-could-save-you-thousands",
  "have-bad-credit-here-is-how-you-can-still-buy",
  "having-buyers-remourse-dontt-worry-heres-what-to-do",
  "how-a-skilled-buyers-agent-can-give-you-a-competitive-edge",
  "how-down-payment-assistance-programs-first-time-help-buyers",
  "how-long-does-it-take-to-build-a-house",
  "how-often-can-you-refinance-your-mortgage",
  "how-to-afford-a-second-home",
  "how-to-avoid-a-delayed-closing",
  "how-to-avoid-renting-to-terrible-tenants",
  "how-to-buy-a-home-with-bad-credit",
  "how-to-choose-your-homeowners-insurance-and-why-you-should-definitely-have-one",
  "how-to-deal-with-noisy-upstairs-neighbours",
  "how-to-deal-with-unsolicited-offers-for-your-home",
  "how-to-find-a-good-subletter-for-your-apartment",
  "how-to-know-if-a-home-will-appreciate-in-value",
  "how-to-save-money-and-paint-like-a-pro",
  "how-to-sell-your-home-faster-with-the-perfect-home-inspection",
  "how-to-stage-a-bathroom-to-sell",
  "important-questions-to-ask-before-hiring-movers",
  "important-things-to-do-if-you-want-your-security-deposit-back",
  "mistakes-to-avoid-when-handling-a-family-members-estate",
  "pros-and-cons-of-buying-a-home-near-a-school",
  "pros-and-cons-of-getting-a-30-year-mortgage",
  "rent-buy-home",
  "should-you-buy-a-home-with-an-open-floor-plan",
  "should-you-diy-your-home-improvement-project-or-hire-a-professional",
  "should-you-go-for-an-adjustable-rate-mortgage-arm",
  "should-you-wait-until-spring-to-sell-your-home",
  "simple-shower-remodelling-ideas-for-your-homes-bathroom",
  "simple-upgrades-that-will-make-your-apartment-feel-luxurious",
  "simple-upgrades-you-should-do-to-a-messy-kids-room-before-selling",
  "the-best-custom-home-builders-in-calgary",
  "the-definitive-guide-on-how-to-upsize-into-a-new-home",
  "the-essential-guide-on-how-to-buy-like-a-pro",
  "the-pros-and-cons-of-buying-a-new-construction-home",
  "the-top-10-fall-home-decor-trends-for-2022",
  "the-top-10-things-to-avoid-with-your-listing-photos",
  "the-top-5-mistakes-first-time-home-buyers-make-after-moving-in",
  "things-shouldnt-buying-home",
  "thinking-about-selling-your-home-heres-what-you-need-to-know-about-capital-gains-taxes",
  "tips-for-buying-the-perfect-piece-of-land",
  "tips-for-creating-the-perfect-homework-zone",
  "tips-for-selling-your-home-during-a-slow-real-estate-market",
  "tips-on-how-you-can-make-your-move-stress-free",
  "tips-you-need-to-know-when-buying-a-home-while-renting",
  "top-real-estate-terms-you-need-to-know",
  "weird-packaging-tips-that-actually-work",
  "what-do-you-need-to-know-about-the-fair-housing-act-as-a-home-buyer",
  "what-exactly-goes-into-a-home-appraisal",
  "what-is-an-installment-real-estate-sale",
  "what-is-escrow-explaining-the-escrow-process",
  "what-to-do-when-a-contractor-doesnt-finish-the-job",
  "what-to-do-when-sellers-leave-their-junk-behind",
  "what-to-do-when-the-area-you-want-to-buy-in-has-poor-internet",
  "what-to-keep-in-mind-before-renting-out-your-home",
  "whats-the-difference-between-a-listing-agent-selling-agent-and-sellers-agent",
  "when-is-the-best-time-to-buy-a-home",
  "why-do-homebuyers-and-sellers-rarely-meet",
  "why-its-important-to-work-with-a-realtor",
  "why-you-still-need-an-agent-even-if-you-found-a-buyer-on-your-own",
  "10-condo-security-tips-to-keep-in-mind",
  "10-essential-tips-for-maintaining-indoor-plants",
  "10-lovely-paint-colors-to-brighten-your-bedroom-with",
  "10-things-you-should-do-after-you-sell-your-home",
  "10-top-renos-that-will-up-the-sale-price-of-your-home",
  "15-best-christmas-decorations-for-2022",
  "20-real-estate-acronyms-you-need-to-know",
  "4-factors-to-look-for-when-looking-at-an-offer",
  "4-myths-about-selling-your-home-today",
  "5-factors-you-cant-ignore-when-searching-for-your-home",
  "5-quick-ways-to-come-up-with-a-down-payment-for-a-home",
  "5-secrets-to-succeed-in-a-red-hot-market",
  "8-questions-to-ask-your-mortgage-broker-before-you-sign-anything",
]);

// Exact path → target. Grouped by destination.
const EXACT: Record<string, string> = {
  "/home": "/",
  "/thank-you": "/",

  "/whats-my-home-worth": "/home-evaluation",

  "/meet-spencer-rivers": "/about",
  "/meet-the-founder": "/about",
  "/meet-the-team": "/about",
  "/spencer-rivers": "/about",
  "/why-choose-me": "/about",
  "/home-team": "/about",
  "/success-stories": "/about",

  "/newsletter": "/contact",
  "/buyer-enrolment": "/contact",
  "/affiliates": "/contact",

  "/buyers-guide": "/work-with",
  "/sellers-guide": "/work-with",
  "/seller-strategy": "/work-with",

  "/new-builds": "/assignments",

  "/ultra-modern-luxury-condo-calgary": "/condos",
  "/development": "/condos",
  "/area/6th-and-tenth": "/condos/6th-and-tenth",
  "/area/le-germain": "/condos/le-germain",
  "/development/1010-6-street-sw-unit-2506": "/condos/6th-and-tenth",
  "/development/108-9-avenue-sw-unit-2002": "/condos/le-germain",

  "/aspen-luxury": "/neighbourhoods/aspen-woods",
  "/aspen-woods-luxury-homes": "/neighbourhoods/aspen-woods",
  "/aspen-woods-calgary-neighborhood-guide-2022": "/neighbourhoods/aspen-woods",
  "/springbank-hill": "/neighbourhoods/springbank-hill",
  "/springbank-hill-calgary-neighborhood-guide-2022": "/neighbourhoods/springbank-hill",
  "/upper-mount-royal-calgary-neighbourhood-guide": "/neighbourhoods/upper-mount-royal",
  "/seton-calgary-neighborhood-guide-2022": "/neighbourhoods", // Seton page doesn't exist (yet)
  "/lakeview": "/neighbourhoods/lakeview",
  "/nieghbourhood": "/neighbourhoods", // sic — the typo really was live
  "/communities": "/neighbourhoods",
  "/featured-areas": "/neighbourhoods",
  "/calgary": "/neighbourhoods",
  "/calgary/aspen-woods": "/neighbourhoods/aspen-woods",
  "/calgary/west": "/neighbourhoods",
  "/featured-blog": "/blog",

  // Old WP /blog/* posts whose content WAS migrated under a shorter slug.
  "/blog/discover-your-dream-home-with-the-top-luxury-realtor-in-upper-mount-royal-calgary":
    "/blog/luxury-realtor-in-upper-mount-royal",
  "/blog/exploring-luxury-homes-in-aspen-woods-calgary-your-gateway-to-elegance-and-comfort":
    "/blog/exploring-luxury-homes-in-aspen-woods",
  "/blog/finding-your-dream-luxury-home-in-west-springs-with-the-right-realtor":
    "/blog/luxury-home-in-west-springs",
  "/blog/westside-recreation-centre-a-focal-point-of-calgarys-upper-westside":
    "/blog/westside-recreation-centre-calgary",
  "/2023/10/06/westside-recreation-centre-a-focal-point-of-calgarys-upper-westside":
    "/blog/westside-recreation-centre-calgary",
};

// Old /r-area/<slug> and /our-areas/**/<slug> leaves → current community pages.
const AREA_LEAF: Record<string, string> = {
  altadore: "altadore",
  roxboro: "roxboro",
  britannia: "britannia",
  "elbow-park": "elbow-park",
  "upper-mount-royal": "upper-mount-royal",
  mahogany: "mahogany",
  "springbank-hill": "springbank-hill",
  "elbow-park-real-estate-facts": "elbow-park",
  "hounsfield-heights-briar-hill-real-estate-facts": "hounsfield-heights-briar-hill",
  "mahogany-real-estate-facts": "mahogany",
  "parkdale-real-estate-facts": "parkdale",
  "rideau-park-real-estate-facts": "rideau-park",
  "rosedale-real-estate-facts": "rosedale",
};

// Old search/listing-browse pages → the live MLS search.
const MLS_PAGES = new Set([
  "/mls-search", "/map-search", "/advanced-search", "/area-search",
  "/search-results", "/calgary-search", "/featured-listings",
  "/exclusive-listing", "/all-sales", "/compare-listings", "/luxury-homes",
  "/lakefront-homes", "/homes-under-500k", "/homes-between-500k-and-750k",
  "/homes-between-750k-and-1000000", "/perfect-home-finder",
  "/property-submit-front", "/commercial-properties",
]);

// Quadrant/area index pages from the old IDX → neighbourhoods index.
const QUADRANTS = new Set([
  "/north", "/south", "/east", "/west", "/northwest", "/northeast",
  "/southeast", "/north-east", "/south-east", "/city-centre",
]);

// Chestermere/Airdrie-era town + subdivision pages. The MLS feed still
// covers these markets, so the search page is the honest equivalent.
const TOWN_PREFIX =
  /^\/(airdrie|chestermere|chesterview|cochrane|canmore|rural-|kinniburgh|east-chestermere|downtown-airdrie|north-east-airdrie|north-west-airdrie|south-east-airdrie|south-west-airdrie|lakepointe|lakeside-greens|lakeview-landing|rainbow-falls|skyview-ranch|west-creek|westmere|the-beaches|the-cove)/;

// Old per-listing URLs: /properties/listing/... and root-level address slugs
// like /135-evanston-view-nw. All long-expired MLS listings.
const ADDRESS_SLUG = /^\/\d+[a-z0-9]*(-[a-z0-9]+)+$/;

/**
 * Resolve a legacy path to its 301 target, or null (no redirect — serve
 * whatever the normal pipeline serves, including honest 404s for spam and
 * junk). Never returns the input path.
 */
export function redirectForPath(rawPath: string): string | null {
  let p = rawPath.toLowerCase();
  p = p.length > 1 ? p.replace(/\/+$/, "") : p;
  // WP appendages: /embed, /feed, /page/N — evaluate the base URL instead.
  for (;;) {
    const stripped = p.replace(/\/(embed|feed|page\/\d+)$/, "");
    if (stripped === p) break;
    p = stripped || "/";
  }
  // "/" itself never redirects.
  if (p === "/") return null;

  // The app's own pages under a legacy prefix. "/newsletter" was a WordPress
  // page and still 301s to /contact; "/newsletter/unsubscribe" is the link in
  // every issue we send, and the subpath rule at the bottom would otherwise
  // bounce it to the contact form.
  if (p.startsWith("/newsletter/")) return null;

  if (EXACT[p]) return EXACT[p];

  const segs = p.slice(1).split("/");
  const first = segs[0];
  const last = segs[segs.length - 1];

  // Explicit post-slug list beats the heuristics below — several old posts
  // start with digits ("/10-top-renos-…") and would otherwise false-match
  // the expired-listing address pattern.
  if (LEGACY_POST_SLUGS.has(first)) return "/blog";

  if (QUADRANTS.has(p)) return "/neighbourhoods";
  if (MLS_PAGES.has(p)) return "/mls";
  if (TOWN_PREFIX.test(p)) return "/mls";
  if (ADDRESS_SLUG.test(p)) return "/mls";

  switch (first) {
    case "properties":
      return "/mls";
    case "category":
    case "2023":
      return "/blog";
    case "author":
    case "testimonial":
      return "/about";
    case "communities":
      return "/neighbourhoods";
    case "development":
      return "/condos";
    case "our-areas":
    case "r-area":
    case "area": {
      const target = AREA_LEAF[last];
      return target ? `/neighbourhoods/${target}` : "/neighbourhoods";
    }
  }

  // Exact entries with subpaths (e.g. guide image-attachment pages).
  const firstAsPath = `/${first}`;
  if (EXACT[firstAsPath] && segs.length > 1) return EXACT[firstAsPath];

  return null;
}
