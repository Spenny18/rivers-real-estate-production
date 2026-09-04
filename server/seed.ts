// Seed the database with Spencer's user + the six luxury Calgary listings
// + nine sample leads. Idempotent — only runs when tables are empty.

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, storage } from "./storage";
import {
  users,
  listings,
  leads,
  blogPosts,
  neighbourhoods,
  testimonials,
  mlsListings,
  condoBuildings,
} from "@shared/schema";
import { MARQUEE_NEIGHBOURHOODS, MARQUEE_CONDOS } from "./seed-marquee";
import { NEIGHBOURHOOD_CONDO_BUILDINGS } from "./neighbourhood-condo-buildings";
import { applyNeighbourhoodImages } from "./neighbourhood-images";
import { MIGRATED_BLOG_POSTS } from "./seed-migrated-blog-posts";
import { CONDO_CONTENT_PATCHES } from "./seed-migrated-condos";

const SEED_LISTINGS = [
  {
    id: "l-001",
    slug: "82-aspen-summit-circle-sw",
    title: "Aspen Summit Estate",
    address: "82 Aspen Summit Circle SW",
    neighbourhood: "Aspen Woods",
    city: "Calgary, AB",
    price: 3275000,
    beds: 5,
    baths: 4.5,
    sqft: 4810,
    lotSize: "0.42 acres",
    yearBuilt: 2018,
    type: "Single Family",
    status: "active",
    description:
      "A craftsman-built estate at the western edge of Aspen Woods, with unobstructed Rocky Mountain views from the main floor and primary suite. Resort-grade amenities include an indoor sport court, infinity-edge pool, and a fully landscaped 0.42-acre lot with mature spruce.",
    features: [
      "Indoor sport court",
      "Infinity-edge pool",
      "Walkout lower level",
      "Heated 4-car garage",
      "Outdoor kitchen + pizza oven",
      "Mountain views from primary",
    ],
    heroImage:
      "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1600&h=1000&fit=crop",
    gallery: [
      "https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600573472556-e636c2acda88?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1605276374104-dee2a0ed3cd6?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600585154084-4e5fe7c39198?w=1200&h=800&fit=crop",
    ],
    lat: 51.0395,
    lng: -114.193,
    views: 2104,
  },
  {
    id: "l-002",
    slug: "1218-prospect-avenue-sw",
    title: "Upper Mount Royal Classical",
    address: "1218 Prospect Avenue SW",
    neighbourhood: "Upper Mount Royal",
    city: "Calgary, AB",
    price: 4950000,
    beds: 5,
    baths: 4,
    sqft: 5180,
    lotSize: "0.32 acres",
    yearBuilt: 1928,
    type: "Single Family",
    status: "active",
    description:
      "A landmark Upper Mount Royal home from 1928, restored with reverence — original mouldings, leaded glass, and reclaimed oak floors paired with a fully reimagined chef's kitchen and primary suite. One of the few remaining lots over 0.30 acres on Prospect.",
    features: [
      "Heritage character preserved",
      "Original millwork & leaded glass",
      "Modern chef's kitchen",
      "Mature gardens",
      "Wine cellar",
      "Detached double garage + carriage suite",
    ],
    heroImage:
      "https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1600&h=1000&fit=crop",
    gallery: [
      "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1200&h=800&fit=crop",
    ],
    lat: 51.0265,
    lng: -114.0905,
    views: 1872,
  },
  {
    id: "l-003",
    slug: "44-elbow-park-lane-sw",
    title: "Elbow Park Riverside Residence",
    address: "44 Elbow Park Lane SW",
    neighbourhood: "Elbow Park",
    city: "Calgary, AB",
    price: 3895000,
    beds: 4,
    baths: 3.5,
    sqft: 4220,
    lotSize: "0.28 acres",
    yearBuilt: 2020,
    type: "Single Family",
    status: "active",
    description:
      "A new-build in Calgary's most established riverside community, designed by McKinley Burkart. Walnut interiors, a south-facing courtyard, and direct access to the Elbow River pathway from the back gate. Steps to River Park and Glencoe Club.",
    features: [
      "South-facing courtyard",
      "Walnut + plaster interiors",
      "Heated triple garage",
      "Gym + sauna",
      "Smart home (Lutron + Control4)",
      "Steps to Elbow River pathway",
    ],
    heroImage:
      "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=1600&h=1000&fit=crop",
    gallery: [
      "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1616137466211-f939a420be84?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=1200&h=800&fit=crop",
    ],
    lat: 51.0233,
    lng: -114.0892,
    views: 1284,
  },
  {
    id: "l-004",
    slug: "215-britannia-crescent-sw",
    title: "Britannia Mid-Century",
    address: "215 Britannia Crescent SW",
    neighbourhood: "Britannia",
    city: "Calgary, AB",
    price: 2850000,
    beds: 4,
    baths: 3,
    sqft: 3460,
    lotSize: "0.22 acres",
    yearBuilt: 1962,
    type: "Single Family",
    status: "active",
    description:
      "An architect-owned mid-century on one of Britannia's most desirable interior crescents. Floor-to-ceiling glass, post-and-beam ceilings, and a private rear yard with a heated saltwater pool. A true entertainer's home, walkable to the Britannia Plaza.",
    features: [
      "Heated saltwater pool",
      "Post-and-beam ceilings",
      "Floor-to-ceiling glass",
      "Original Eichler-style millwork",
      "Walk to Britannia Plaza",
      "Double garage",
    ],
    heroImage:
      "https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1600&h=1000&fit=crop",
    gallery: [
      "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600585152220-90363fe7e115?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600210491892-03d54c0aaf87?w=1200&h=800&fit=crop",
    ],
    lat: 51.0146,
    lng: -114.085,
    views: 612,
  },
  {
    id: "l-005",
    slug: "18-bel-aire-place-sw",
    title: "Bel-Aire Reservoir View",
    address: "18 Bel-Aire Place SW",
    neighbourhood: "Bel-Aire",
    city: "Calgary, AB",
    price: 5750000,
    beds: 6,
    baths: 5.5,
    sqft: 6180,
    lotSize: "0.38 acres",
    yearBuilt: 2015,
    type: "Single Family",
    status: "active",
    description:
      "A Bel-Aire commission with direct sightlines to the Glenmore Reservoir. The lot rises gently to capture western light through a 28-foot great-room window wall. Indoor pool, six bedrooms, and a separately-titled 0.38-acre lot in Calgary's smallest luxury enclave.",
    features: [
      "Glenmore Reservoir views",
      "Indoor lap pool",
      "28-ft great-room window wall",
      "Separate guest wing",
      "5-car heated garage",
      "Geothermal heating + cooling",
    ],
    heroImage:
      "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=1600&h=1000&fit=crop",
    gallery: [
      "https://images.unsplash.com/photo-1600566753086-00f18fe6ba47?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=1200&h=800&fit=crop",
    ],
    lat: 51.0,
    lng: -114.1015,
    views: 0,
  },
  {
    id: "l-006",
    slug: "126-springbank-hill-rise",
    title: "Springbank Hill Modern",
    address: "126 Springbank Hill Rise SW",
    neighbourhood: "Springbank Hill",
    city: "Calgary, AB",
    price: 2199000,
    beds: 4,
    baths: 3.5,
    sqft: 3640,
    lotSize: "0.18 acres",
    yearBuilt: 2022,
    type: "Single Family",
    status: "sold",
    description:
      "A modern Springbank Hill build sold off-market in 11 days. Black-stained cedar exterior, Italian-tile interior, and a fully landscaped lot backing onto a private greenbelt.",
    features: [
      "Black-stained cedar exterior",
      "Italian tile throughout",
      "Backs onto greenbelt",
      "Heated triple garage",
      "Smart home automation",
    ],
    heroImage:
      "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=1600&h=1000&fit=crop",
    gallery: [],
    lat: 51.0245,
    lng: -114.196,
    views: 3221,
  },
];

const SEED_LEADS = [
  {
    listingId: "l-001",
    name: "Marcus Chen",
    email: "m.chen@email.com",
    phone: "(403) 555-2918",
    message:
      "Very interested in the Aspen Summit estate. Looking for a June 1 possession date — flexible. Could we book a private showing this weekend?",
    source: "Landing page",
    status: "qualified",
  },
  {
    listingId: "l-001",
    name: "Priya Anand",
    email: "priya.a@gmail.com",
    phone: "(587) 555-1102",
    message: "Is the pool heated year-round? Curious about geothermal load on this lot.",
    source: "Tour scheduler",
    status: "tour-booked",
  },
  {
    listingId: "l-002",
    name: "Daniel & Erin O'Connell",
    email: "doconnell@workmail.io",
    phone: "(403) 555-7745",
    message:
      "Relocating from Vancouver. Upper Mount Royal Classical is exactly what we're after. Could you send floor plans and confirm property tax?",
    source: "Realtor.ca",
    status: "contacted",
  },
  {
    listingId: "l-001",
    name: "Lina Park",
    email: "lina@parkdesign.studio",
    message: "Following on the Aspen listing — is the pool serviced year-round?",
    source: "Instagram",
    status: "new",
  },
  {
    listingId: "l-003",
    name: "James Whittaker",
    email: "jwhittaker@law.ca",
    phone: "(403) 555-5601",
    message: "Elbow Park looks great — open this Saturday for a private showing?",
    source: "Landing page",
    status: "tour-booked",
  },
  {
    listingId: "l-005",
    name: "Sofia Mendes",
    email: "sofia.m@designcollective.ca",
    message: "Could you confirm the lot orientation? Is the indoor pool a saltwater system?",
    source: "Tour scheduler",
    status: "qualified",
  },
  {
    listingId: "l-002",
    name: "Robert Tanaka",
    email: "rtanaka@bowmail.com",
    message: "Just browsing for now — beautiful property.",
    source: "Realtor.ca",
    status: "lost",
  },
  {
    listingId: "l-003",
    name: "Hannah Becker",
    email: "h.becker@homeagency.io",
    phone: "(587) 555-9911",
    message: "Buyer agent here — my client is keen, prepared to write at ask.",
    source: "Referral",
    status: "qualified",
  },
  {
    listingId: "l-001",
    name: "Kabir Singh",
    email: "ksingh.calgary@email.ca",
    message: "Sport court dimensions? Is it regulation full-court or three-quarter?",
    source: "Landing page",
    status: "new",
  },
];

export function seedDatabase() {
  // 1. Spencer's user
  let spencer = storage.getUserByEmail("spencer@riversrealestate.ca");
  if (!spencer) {
    const seedPassword = process.env.ADMIN_PASSWORD || "luxury2026";
    const passwordHash = bcrypt.hashSync(seedPassword, 10);
    spencer = storage.createUser({
      email: "spencer@riversrealestate.ca",
      passwordHash,
      name: "Spencer Rivers",
      title: "REALTOR® | CLHMS, CNE, CIPS",
      phone: "(403) 966-9237",
      avatar:
        "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&h=200&fit=crop&crop=faces",
    });
    console.log("[seed] Created Spencer Rivers user (id=" + spencer.id + ")");
  }

  // 2. Listings
  const existingListings = db.select().from(listings).all();
  if (existingListings.length === 0) {
    for (const l of SEED_LISTINGS) {
      storage.createListing(l, spencer.id);
    }
    // Set views explicitly (createListing won't honor views)
    for (const l of SEED_LISTINGS) {
      db.update(listings).set({ views: l.views }).where(eq(listings.id, l.id)).run();
    }
    console.log("[seed] Inserted " + SEED_LISTINGS.length + " listings");
  }

  // 3. Leads
  const existingLeads = db.select().from(leads).all();
  if (existingLeads.length === 0) {
    for (const ld of SEED_LEADS) {
      storage.createLead({
        listingId: ld.listingId,
        name: ld.name,
        email: ld.email,
        phone: ld.phone,
        message: ld.message,
        source: ld.source,
        status: ld.status,
      } as any);
    }
    console.log("[seed] Inserted " + SEED_LEADS.length + " leads");
  }

  // ---- One-time neighbourhood corrections (idempotent on each boot) ----
  // Spencer asked for several content cleanups after the initial roll-out:
  //   1. Slug renames (drop the location suffix that was a hint, not part of
  //      the canonical slug): spring-creek-canmore → spring-creek, etc.
  //   2. Lake Bonaventure isn't a real Calgary subdivision — delete the row.
  //   3. Zone migrations: consolidate "Southwest" into "South" and re-zone a
  //      couple of SE → South (handled by the zone backfill below).
  // These run on every boot but are no-ops once applied.
  try {
    const SLUG_RENAMES: Array<[string, string]> = [
      ["spring-creek-canmore", "spring-creek"],
      ["coopers-crossing-airdrie", "coopers-crossing"],
      ["bayside-airdrie", "bayside"],
      ["chestermere-lakefront", "chestermere"],
    ];
    for (const [oldSlug, newSlug] of SLUG_RENAMES) {
      const oldRow = db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, oldSlug)).get();
      if (!oldRow) continue;
      const newRow = db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, newSlug)).get();
      if (newRow) {
        // Both exist — drop the old one (the new one wins, was created by seed)
        db.delete(neighbourhoods).where(eq(neighbourhoods.slug, oldSlug)).run();
      } else {
        // Just the old exists — rename in place via UPDATE on the primary key.
        db.update(neighbourhoods).set({ slug: newSlug } as any).where(eq(neighbourhoods.slug, oldSlug)).run();
      }
      console.log(`[migration] renamed neighbourhood ${oldSlug} -> ${newSlug}`);
    }
    // Lake Bonaventure isn't a real subdivision — remove if it still exists
    const lb = db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, "lake-bonaventure")).get();
    if (lb) {
      db.delete(neighbourhoods).where(eq(neighbourhoods.slug, "lake-bonaventure")).run();
      console.log("[migration] deleted lake-bonaventure (not a real subdivision)");
    }
    // Consolidate any leftover "Southwest" zone rows into "South"
    const swRows = (db.select().from(neighbourhoods).all() as any[]).filter((n) => n.zone === "Southwest");
    if (swRows.length > 0) {
      for (const r of swRows) {
        db.update(neighbourhoods).set({ zone: "South" } as any).where(eq(neighbourhoods.slug, r.slug)).run();
      }
      console.log(`[migration] re-zoned ${swRows.length} Southwest -> South`);
    }
    // NOTE (July 2026): a since-removed "repair" migration briefly pointed 16
    // rows at WP/stock heroes while their real photos were missing from the
    // deployed bundle. The photos (curated CC photography, committed under
    // client/public/img/neighbourhoods/) are back in the tree, and the
    // HERO_RESTORES migration below moves those rows back to them.
    // Upgrade generic stock heroes to the real community heroes that already
    // exist in the luxuryhomescalgary.ca WP media library (found via the WP
    // REST media API, July 2026). The old Unsplash placeholders were visibly
    // wrong — several cards shared an identical palm-tree villa, Parkhill
    // showed a kitchen. Guarded so it only ever replaces an Unsplash URL
    // (or Elbow Park's 275px thumbnail) — never an admin-set hero.
    const WP = "https://luxuryhomescalgary.ca/wp-content/uploads/";
    const HERO_UPGRADES: Record<string, string> = {
      "bankview": WP + "2026/02/bankview-hero.png",
      "parkhill": WP + "2025/11/parkhill-hero.png",
      "rosedale": WP + "2025/02/rosedale-hero.png",
      "parkdale": WP + "2025/11/parkdale-hero.png",
      "south-calgary": WP + "2026/02/south-calgary-hero.png",
      "richmond": WP + "2026/02/richmond-hero.png",
      "kelvin-grove": WP + "2026/02/kelvin-grove-hero.png",
      "windsor-park": WP + "2026/02/windsor-park-hero.png",
      "elboya": WP + "2025/07/elboya-hero.png",
      "meadowlark-park": WP + "2026/02/meadowlark-park-hero.png",
      "ramsay": WP + "2025/11/ramsay-hero.png",
      "hamptons": WP + "2026/02/hamptons-hero.png",
      "evanston": WP + "2025/02/evanston-hero.png",
      "signal-hill": WP + "2026/02/signal-hill-hero.png",
      "north-glenmore-park": WP + "2026/02/north-glenmore-park-hero.png",
      "wildwood": WP + "2026/02/wildwood-hero.png",
      "canyon-meadows": WP + "2026/02/canyon-meadows-hero.png",
      "willow-park": WP + "2026/02/willow-park-hero.png",
      "lake-bonavista": WP + "2026/02/lake-bonavista-hero.png",
      "chaparral": WP + "2026/02/chaparral-hero.png",
      "cranston": WP + "2025/08/cranston-hero.png",
      "alpine-park": WP + "2026/02/alpine-park-hero.png",
      "pine-creek": WP + "2026/02/pine-creek-hero.png",
      "coopers-crossing": WP + "2026/02/coopers-crossing-hero.png",
      "bayside": WP + "2026/02/bayside-hero.png",
      "chestermere": WP + "2025/02/chestermere-hero.png",
      "st-andrews-heights": WP + "2025/12/st.-andrews-heights-hero.png",
      "hounsfield-heights-briar-hill": WP + "2026/02/hounsfield-heightsbriar-hill-hero.png",
      "bridgeland-riverside": WP + "2026/02/bridgelandriverside-hero.png",
      "varsity-estates": WP + "2026/02/varsity-hero.png",
      "lakeview": WP + "2026/02/lakeview-landing-hero.png",
      "mahogany": WP + "2025/02/lake-mahogany.png",
      "watermark": WP + "2025/11/watermark-bearspaw.png",
      "bearspaw": WP + "2025/02/bearspaw-acreage-home-1.jpeg",
      // No community-specific WP hero exists for these; swap the palm-villa /
      // kitchen stock for the neutral dusk-estate stock the neighbouring
      // communities already use. (beltline keeps its downtown-towers stock —
      // it suits the community.)
      "mckenzie-lake": "https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1600&h=900&fit=crop",
      "elbow-valley": "https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1600&h=900&fit=crop",
      "elbow-valley-west": "https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1600&h=900&fit=crop",
    };
    let heroesUpgraded = 0;
    for (const [slug, url] of Object.entries(HERO_UPGRADES)) {
      const row = db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, slug)).get() as any;
      const current = String(row?.heroImage || "");
      if (!row || !current.startsWith("https://images.unsplash.com/") || current === url) continue;
      db.update(neighbourhoods).set({ heroImage: url } as any).where(eq(neighbourhoods.slug, slug)).run();
      heroesUpgraded++;
    }
    // Elbow Park's WP image is a 275x183 thumbnail — swap for the full-size
    // render of the same subject that exists in the media library.
    const ep = db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, "elbow-park")).get() as any;
    if (ep && ep.heroImage === WP + "2024/06/elbow-park.jpg") {
      db.update(neighbourhoods)
        .set({ heroImage: WP + "2024/06/dalle-2024-06-02-132305-a-luxurious-modern-home-overlooking-the-elbow-river-valley-in-elbow-park-calgary-the-house-features-sleek-contemporary-architecture-with-large-glas.jpg" } as any)
        .where(eq(neighbourhoods.slug, "elbow-park"))
        .run();
      heroesUpgraded++;
    }
    if (heroesUpgraded > 0) {
      console.log(`[migration] upgraded ${heroesUpgraded} stock neighbourhood heroes to community images`);
    }
    // Curated real-photo heroes + CC attribution are applied by
    // applyNeighbourhoodImages() (server/neighbourhood-images.ts, ported from
    // the Neuroforge fork) at the end of seedDatabase(). Its isReplaceable
    // guard covers every interim state (unsplash, luxuryhomescalgary.ca WP
    // renders, /img/ paths) while leaving CMS-set heroes alone.
  } catch (err) {
    console.error("[migration] neighbourhood cleanups failed:", err);
  }

  // 4. Neighbourhoods — INSERT-IF-MISSING ONLY (same pattern as condos).
  // Once a neighbourhood exists in the db, the seed never overwrites it. This
  // is so future admin CMS edits to neighbourhood content are safe from being
  // clobbered when I add new neighbourhoods to the marquee in code. Only the
  // `zone` column is opportunistically backfilled if it's still the default
  // value (so the new zone-based grouping on /neighbourhoods works for
  // existing rows that pre-date the zone field).
  let nhoodsInserted = 0;
  let zonePatched = 0;
  for (const n of MARQUEE_NEIGHBOURHOODS) {
    const existing = db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, n.slug)).get();
    if (existing) {
      // Backfill / re-sync zone in two cases:
      // 1. Row still has the literal default "City Centre & Inner-City" (never
      //    seeded with a real zone yet).
      // 2. Row has one of the OLD zone labels from the first /neighbourhoods
      //    rollout (Spencer corrected the zone scheme to match real Calgary
      //    geography). One-time migration to map them to the new scheme.
      const OLD_ZONES = new Set([
        "City Centre & Inner-City",
        "Inner West",
        "Southwest Estates",
        "South Suburbs",
        "Southeast Lakes",
        "New & Acreage Communities",
        "Surrounding Towns",
      ]);
      const currentZone = (existing as any).zone as string | undefined;
      if (currentZone && OLD_ZONES.has(currentZone) && n.zone && n.zone !== currentZone) {
        db.update(neighbourhoods).set({ zone: n.zone } as any).where(eq(neighbourhoods.slug, n.slug)).run();
        zonePatched++;
      }
      continue;
    }
    const row = {
      slug: n.slug,
      name: n.name,
      tagline: n.tagline,
      story: JSON.stringify(n.story),
      outsideCopy: JSON.stringify(n.outsideCopy),
      amenitiesCopy: JSON.stringify(n.amenitiesCopy),
      shopDineCopy: JSON.stringify(n.shopDineCopy),
      realEstateCopy: JSON.stringify(n.realEstateCopy),
      lifeCopy: JSON.stringify(n.lifeCopy),
      quadrant: n.quadrant,
      zone: n.zone,
      borders: JSON.stringify(n.borders),
      schools: JSON.stringify(n.schools),
      heroImage: n.heroImage,
      gallery: JSON.stringify([]),
      centerLat: n.centerLat,
      centerLng: n.centerLng,
      avgPrice: n.avgPrice,
      activeCount: 0,
      sortOrder: n.sortOrder,
    };
    db.insert(neighbourhoods).values(row).run();
    nhoodsInserted++;
  }
  console.log(`[seed] Inserted ${nhoodsInserted} new neighbourhoods (${MARQUEE_NEIGHBOURHOODS.length - nhoodsInserted} skipped — already exist), patched zone on ${zonePatched}`);

  // 4a. Condo-buildings list — FILL-IF-EMPTY ONLY.
  // Backfill the researched building list into any neighbourhood whose
  // condo_buildings_list is still the '[]' default. Rows Spencer has edited
  // via the admin keep their value; rows he cleared on purpose would be
  // refilled, so clearing should be done by replacing with a placeholder in
  // the admin rather than emptying (documented in the admin field hint).
  try {
    let condoListFilled = 0;
    for (const [slug, buildings] of Object.entries(NEIGHBOURHOOD_CONDO_BUILDINGS)) {
      if (!buildings.length) continue;
      const row = db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, slug)).get() as any;
      if (!row) continue;
      const current = (row.condoBuildingsList ?? "[]").trim();
      let isEmpty = true;
      try { isEmpty = !Array.isArray(JSON.parse(current)) || JSON.parse(current).length === 0; } catch { isEmpty = true; }
      if (!isEmpty) continue;
      db.update(neighbourhoods)
        .set({ condoBuildingsList: JSON.stringify(buildings) } as any)
        .where(eq(neighbourhoods.slug, slug))
        .run();
      condoListFilled++;
    }
    if (condoListFilled > 0) {
      console.log(`[seed] Filled condo_buildings_list on ${condoListFilled} neighbourhoods`);
    }
  } catch (err) {
    console.error("[seed] condo_buildings_list backfill failed:", err);
  }

  // 4b. Condo buildings — INSERT-IF-MISSING ONLY.
  //
  // Once a condo exists in the database, the seed never overwrites it. Spencer
  // edits condo content via /admin/condos and the database is the source of
  // truth. The seed's only job is to introduce *new* condo slugs on first boot
  // (or when I add a slug to MARQUEE_CONDOS that wasn't in the db before).
  let inserted = 0;
  for (const c of MARQUEE_CONDOS) {
    const existing = db.select().from(condoBuildings).where(eq(condoBuildings.slug, c.slug)).get();
    if (existing) continue; // Skip — admin owns this condo's content now.
    const row: any = {
      slug: c.slug,
      name: c.name,
      tagline: c.tagline,
      intro: JSON.stringify(c.intro),
      residencesCopy: JSON.stringify(c.residencesCopy),
      architecturalCopy: JSON.stringify(c.architecturalCopy),
      locationCopy: JSON.stringify(c.locationCopy ?? []),
      diningCopy: JSON.stringify(c.diningCopy ?? []),
      shoppingCopy: JSON.stringify(c.shoppingCopy ?? []),
      communityCopy: JSON.stringify(c.communityCopy ?? []),
      schoolsCopy: JSON.stringify(c.schoolsCopy ?? []),
      amenities: JSON.stringify(c.amenities),
      address: c.address,
      addressAliases: c.addressAliases ?? null,
      neighbourhoodSlug: c.neighbourhoodSlug,
      neighbourhood: c.neighbourhood,
      quadrant: c.quadrant,
      units: c.units ?? null,
      stories: c.stories ?? null,
      builtIn: c.builtIn ?? null,
      developer: c.developer ?? null,
      architect: c.architect ?? null,
      lat: c.lat,
      lng: c.lng,
      heroImage: c.heroImage,
      gallery: JSON.stringify([]),
      sortOrder: c.sortOrder,
      featured: c.featured,
    };
    db.insert(condoBuildings).values(row).run();
    inserted++;
  }
  console.log(`[seed] Inserted ${inserted} new condo buildings (${MARQUEE_CONDOS.length - inserted} skipped — already exist; admin owns content)`);

  // Replace only the two legacy generic Unsplash placeholders with each
  // building's dedicated local hero. Custom/admin and building-specific
  // images remain untouched.
  const GENERIC_CONDO_HEROES = new Set([
    "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=1600&h=900&fit=crop",
    "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=1600&h=900&fit=crop",
  ]);
  let condoHeroesMigrated = 0;
  for (const condo of MARQUEE_CONDOS) {
    if (!condo.heroImage?.startsWith("/condo-heroes/")) continue;
    const existing = db.select().from(condoBuildings).where(eq(condoBuildings.slug, condo.slug)).get();
    if (!existing || !GENERIC_CONDO_HEROES.has(existing.heroImage)) continue;
    db.update(condoBuildings)
      .set({ heroImage: condo.heroImage })
      .where(eq(condoBuildings.slug, condo.slug))
      .run();
    condoHeroesMigrated++;
  }
  console.log(`[seed] Replaced ${condoHeroesMigrated} generic condo hero images`);

  // 4b. WP content patches — fill-only-empty-fields update for each condo
  //
  // CONDO_CONTENT_PATCHES is produced by `script/import-wp-condos.ts` from the
  // WP HTML. We apply each patch field ONLY when the corresponding DB column
  // is empty ([]). This protects content Spencer has already edited via
  // /admin/condos while back-filling the editorial sections (dining /
  // shopping / community / schools / gallery) that were missing on most
  // condos before the WP migration.
  const PATCH_FIELDS = [
    "intro",
    "residencesCopy",
    "architecturalCopy",
    "locationCopy",
    "diningCopy",
    "shoppingCopy",
    "communityCopy",
    "schoolsCopy",
    "gallery",
  ] as const;
  let patchedFields = 0;
  let patchedCondos = 0;
  for (const [slug, patch] of Object.entries(CONDO_CONTENT_PATCHES)) {
    const row = db.select().from(condoBuildings).where(eq(condoBuildings.slug, slug)).get();
    if (!row) continue;
    const updates: Record<string, string> = {};
    for (const field of PATCH_FIELDS) {
      const incoming = (patch as any)[field];
      if (!Array.isArray(incoming) || incoming.length === 0) continue;
      let existing: unknown = (row as any)[field];
      try {
        existing = typeof existing === "string" ? JSON.parse(existing) : existing;
      } catch {
        existing = null;
      }
      if (Array.isArray(existing) && existing.length > 0) continue; // admin filled this
      updates[field] = JSON.stringify(incoming);
      patchedFields++;
    }
    if (Object.keys(updates).length > 0) {
      db.update(condoBuildings).set(updates as any).where(eq(condoBuildings.slug, slug)).run();
      patchedCondos++;
    }
  }
  console.log(`[seed] Patched ${patchedFields} empty fields across ${patchedCondos} condos from WP migration`);

  // 5. Blog posts — per-slug upsert so new posts (e.g. the WP-migrated set
  // imported from luxuryhomescalgary.ca) get added on every deploy without
  // duplicating posts that already exist. SQL "INSERT OR IGNORE" via the
  // schema's unique slug constraint keeps this safe and idempotent.
  const existingSlugs = new Set(
    db.select({ slug: blogPosts.slug }).from(blogPosts).all().map((r) => r.slug),
  );
  const ALL_BLOG_POSTS = [...SEED_BLOG_POSTS, ...MIGRATED_BLOG_POSTS];
  let blogInserted = 0;
  for (const p of ALL_BLOG_POSTS) {
    if (existingSlugs.has(p.slug!)) continue;
    db.insert(blogPosts).values(p).run();
    blogInserted++;
  }
  console.log(
    `[seed] Inserted ${blogInserted} new blog posts (${ALL_BLOG_POSTS.length - blogInserted} skipped — already exist)`,
  );

  // Fill featured images only on posts that still have no image. This lands
  // newly generated editorial artwork without replacing any CMS-selected
  // image, and is safe to run on every boot.
  let blogImagesFilled = 0;
  for (const post of ALL_BLOG_POSTS) {
    if (!post.heroImage) continue;
    const existing = db.select().from(blogPosts).where(eq(blogPosts.slug, post.slug!)).get();
    if (!existing || existing.heroImage?.trim()) continue;
    db.update(blogPosts)
      .set({ heroImage: post.heroImage, heroImageAlt: existing.heroImageAlt || post.title })
      .where(eq(blogPosts.slug, post.slug!))
      .run();
    blogImagesFilled++;
  }
  console.log(`[seed] Filled ${blogImagesFilled} missing blog featured images`);

  // 6. Testimonials
  const existingTestimonials = db.select().from(testimonials).all();
  if (existingTestimonials.length === 0) {
    for (const t of SEED_TESTIMONIALS) {
      db.insert(testimonials).values(t).run();
    }
    console.log("[seed] Inserted " + SEED_TESTIMONIALS.length + " testimonials");
  }

  // 7. Fallback MLS listings — populated from the editorial six so the public
  //    site always has content even if the RETS sync hasn't run yet.
  const existingMls = db.select().from(mlsListings).all();
  if (existingMls.length === 0) {
    const POSTAL_BY_HOOD: Record<string, string> = {
      "Aspen Woods": "T3H 0V8",
      "Upper Mount Royal": "T2T 1J3",
      "Elbow Park": "T2S 0K6",
      "Britannia": "T2S 1J6",
      "Bel-Aire": "T2V 2C1",
      "Springbank Hill": "T3H 5K8",
    };
    for (const l of SEED_LISTINGS) {
      const id = `MLS-${l.id.toUpperCase()}`;
      db.insert(mlsListings)
        .values({
          id,
          mlsNumber: id,
          status: l.status === "sold" ? "Sold" : "Active",
          listPrice: l.price,
          soldPrice: l.status === "sold" ? l.price : null,
          fullAddress: `${l.address}, Calgary, AB`,
          neighbourhood: l.neighbourhood,
          city: "Calgary",
          province: "AB",
          postalCode: POSTAL_BY_HOOD[l.neighbourhood] ?? null,
          lat: l.lat,
          lng: l.lng,
          propertyType: l.type === "Single Family" ? "Detached" : l.type,
          beds: l.beds,
          baths: l.baths,
          sqft: l.sqft,
          lotSize: l.lotSize,
          yearBuilt: l.yearBuilt,
          description: l.description,
          features: JSON.stringify(l.features),
          heroImage: l.heroImage,
          gallery: JSON.stringify(l.gallery ?? []),
          photoCount: (l.gallery?.length ?? 0) + 1,
          source: "seed",
          listDate: new Date(Date.now() - Math.floor(Math.random() * 30) * 86400000).toISOString(),
        })
        .run();
    }
    console.log("[seed] Inserted " + SEED_LISTINGS.length + " fallback MLS listings");
    storage.refreshNeighbourhoodActiveCounts();
  }

  // Curated CC photo heroes + attribution (fill/repair only — never clobbers
  // a CMS-set hero; see server/neighbourhood-images.ts).
  try {
    applyNeighbourhoodImages();
  } catch (err) {
    console.error("[seed] applyNeighbourhoodImages failed:", err);
  }

  // Booking defaults — three meeting types and a Mon–Fri 9–5 schedule, so
  // /book works the moment the app boots. Only runs on an empty table; once
  // Spencer edits anything in /admin/scheduling this is never touched again.
  try {
    if (storage.listBookingEventTypes().length === 0) {
      for (const et of SEED_EVENT_TYPES) {
        storage.createBookingEventType({ ...et, userId: spencer.id });
      }
      storage.replaceBookingAvailability(
        null,
        [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startMinute: 9 * 60,
          endMinute: 17 * 60,
        })),
      );
      console.log("[seed] Created " + SEED_EVENT_TYPES.length + " booking event types");
    }
  } catch (err) {
    console.error("[seed] booking defaults failed:", err);
  }
}

const SEED_EVENT_TYPES = [
  {
    slug: "buyer-consultation",
    name: "Buyer Consultation",
    description:
      "A 30-minute call to talk through what you're looking for, which Calgary neighbourhoods fit, and what the current market means for your timing and budget.",
    durationMinutes: 30,
    locationType: "phone",
    minimumNoticeMinutes: 240,
    bufferAfterMinutes: 15,
    sortOrder: 0,
  },
  {
    slug: "listing-appointment",
    name: "Listing Appointment",
    description:
      "An in-person walkthrough of your home followed by a pricing strategy, a marketing plan, and a realistic timeline to sold. Please allow a full hour.",
    durationMinutes: 60,
    locationType: "in_person",
    locationDetail: "Your property — I'll come to you.",
    minimumNoticeMinutes: 1440,
    bufferAfterMinutes: 30,
    sortOrder: 1,
  },
  {
    slug: "private-showing",
    name: "Private Showing",
    description:
      "Book a private tour of a listing you've found on the site. Include the MLS® number or address in the notes and I'll confirm access with the listing brokerage.",
    durationMinutes: 45,
    locationType: "in_person",
    locationDetail: "The property address — confirmed by email once access is arranged.",
    minimumNoticeMinutes: 720,
    bufferAfterMinutes: 30,
    customQuestion: "Which property would you like to see? (MLS® number or address)",
    sortOrder: 2,
  },
];

// ---------------------------------------------------------------------------
// SEED DATA
// ---------------------------------------------------------------------------

const SEED_NEIGHBOURHOODS = [
  {
    slug: "upper-mount-royal",
    name: "Upper Mount Royal",
    tagline: "Calgary's most established prestige address.",
    story: JSON.stringify([
      "Upper Mount Royal sits on the high ground south of 17th Avenue, plotted at the start of the 20th century when the railway barons wanted a neighbourhood that looked over the city instead of into it. A century of careful zoning has preserved the original lot widths — 50 to 100 feet — which means the streetscape still feels generous in a city that increasingly does not.",
      "The architecture reads as a quiet anthology: surviving Edwardians on Prospect, restrained Tudors on Hope and Talon, and a thin layer of contemporary infill where the original homes could not be saved. Replacement value runs higher here than anywhere else in Calgary, and the inventory is correspondingly thin — most years see fewer than thirty arm's-length sales.",
    ]),
    outsideCopy: JSON.stringify([
      "Mature American elms shade most of the side streets, and the neighbourhood's elevation gives almost every south-facing lot a downtown skyline view. Mount Royal Park sits at the eastern edge with a maintained tennis facility and a winter rink.",
    ]),
    amenitiesCopy: JSON.stringify([
      "Western Canada High School, the public catchment, draws families who would otherwise consider private. Mount Royal Junior High covers grades 7-9. Calgary French & International School is a five-minute drive south.",
    ]),
    shopDineCopy: JSON.stringify([
      "4th Street and 17th Avenue are both walkable. Notable nearby: Cassis Bistro, Anju, Model Milk, Rouge — and the entire 17th Avenue retail strip from 4th to 14th Street SW.",
    ]),
    heroImage: "https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1600&h=900&fit=crop",
    gallery: JSON.stringify([
      "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&h=800&fit=crop",
    ]),
    centerLat: 51.0265,
    centerLng: -114.0905,
    avgPrice: 3850000,
    activeCount: 0,
    sortOrder: 1,
  },
  {
    slug: "elbow-park",
    name: "Elbow Park",
    tagline: "Riverside character on Calgary's most walkable inner streets.",
    story: JSON.stringify([
      "Elbow Park follows the curve of the Elbow River south of Mission, with most lots either backing onto the river itself or sitting two streets back from it. The rebuild after the 2013 flood reset the housing stock — roughly a third of the homes are now post-flood new builds, the rest are restored heritage.",
      "The neighbourhood's defining feature is its proximity: Glencoe Club, Calgary Golf & Country Club, and the Stanley Park pool are all reachable on foot, and the river pathway runs from Stanley Park north into downtown without a single road crossing.",
    ]),
    outsideCopy: JSON.stringify([
      "River Park and Stanley Park bookend the community. The off-leash trails through River Park are the closest serious off-leash space to downtown.",
    ]),
    amenitiesCopy: JSON.stringify([
      "Elbow Park Elementary is one of CBE's strongest community schools. Glencoe Club membership is the standard family amenity — a three-to-five-year wait, but transferable with most homes that already hold it.",
    ]),
    shopDineCopy: JSON.stringify([
      "Mission's 4th Street strip is a six-minute drive. Notable: Ten Foot Henry, Vendome, Pulcinella. Britannia Plaza is closer than Mission for everyday errands.",
    ]),
    heroImage: "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=1600&h=900&fit=crop",
    gallery: JSON.stringify([
      "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1616137466211-f939a420be84?w=1200&h=800&fit=crop",
    ]),
    centerLat: 51.0233,
    centerLng: -114.0892,
    avgPrice: 2950000,
    activeCount: 0,
    sortOrder: 2,
  },
  {
    slug: "britannia",
    name: "Britannia",
    tagline: "Mid-century lots and the city's tightest infill market.",
    story: JSON.stringify([
      "Britannia was platted in the 1950s as Calgary's first true post-war prestige community, with curved interior crescents instead of the grid that defined Mount Royal. The original mid-century housing stock has thinned considerably — roughly half the homes have been replaced or substantially renovated since 2010 — but the lot sizes (averaging 0.20 acres) remain a defining feature.",
      "Entry pricing is in the high $2M range for an original cottage on a teardown lot; finished rebuilds clear $5M on Britannia Drive. Inventory is famously tight: 8-15 transactions per year, often pre-MLS.",
    ]),
    outsideCopy: JSON.stringify([
      "Britannia Slopes drops west to the Elbow River pathway. The community greenbelt connects most of the interior crescents.",
    ]),
    amenitiesCopy: JSON.stringify([
      "Earl Grey School, Western Canada catchment, a short walk to the Glencoe Club. Mount Royal University is a six-minute drive.",
    ]),
    shopDineCopy: JSON.stringify([
      "The Britannia Plaza is the local centre — Sunterra Market, Village Ice Cream, Crowfoot Wine & Spirits, Britannia Kitchen & Wine. It anchors the daily life of the community in a way few other Calgary neighbourhoods replicate.",
    ]),
    heroImage: "https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1600&h=900&fit=crop",
    gallery: JSON.stringify([
      "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600585152220-90363fe7e115?w=1200&h=800&fit=crop",
    ]),
    centerLat: 51.0146,
    centerLng: -114.085,
    avgPrice: 3050000,
    activeCount: 0,
    sortOrder: 3,
  },
  {
    slug: "bel-aire",
    name: "Bel-Aire",
    tagline: "Calgary's smallest luxury enclave, on the Glenmore Reservoir.",
    story: JSON.stringify([
      "Bel-Aire is the smallest of Calgary's recognized luxury communities — fewer than 100 homes — wrapped along the north shore of the Glenmore Reservoir. Lots run 0.30 to 0.60 acres, most facing west toward the water. Several still hold their original 1970s and 80s homes, and the rebuild cycle here is slower than anywhere else in the southwest.",
      "Sales activity is sparse: under ten per year on average, and many transactions never reach the open market. Pricing has moved decisively above $5M for a finished new build over the past three years.",
    ]),
    outsideCopy: JSON.stringify([
      "The Glenmore Reservoir pathway is the dominant outdoor amenity — 16 km of paved pathway accessible directly from the community.",
    ]),
    amenitiesCopy: JSON.stringify([
      "Earl Grey School and Western Canada High School. The Calgary Canoe Club is the historic community institution.",
    ]),
    shopDineCopy: JSON.stringify([
      "Britannia Plaza is the closest retail. Chinook Centre is a six-minute drive for full-service shopping.",
    ]),
    heroImage: "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=1600&h=900&fit=crop",
    gallery: JSON.stringify([
      "https://images.unsplash.com/photo-1600566753086-00f18fe6ba47?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=1200&h=800&fit=crop",
    ]),
    centerLat: 51.0,
    centerLng: -114.1015,
    avgPrice: 5450000,
    activeCount: 0,
    sortOrder: 4,
  },
  {
    slug: "aspen-woods",
    name: "Aspen Woods",
    tagline: "The newest of Calgary's prestige communities, with mountain views.",
    story: JSON.stringify([
      "Aspen Woods sits at Calgary's western edge, where 17th Avenue rises into the foothills. The community was substantially built out between 2002 and 2018, which means the housing stock is uniformly newer than in the inner-city luxury communities — most homes are between 5 and 20 years old.",
      "The defining feature is the topography. The west-facing lots on the Aspen Summit ridge see the Rockies on a clear day; the east-facing lots see the city. Three private schools — Webber Academy, Calgary Academy, and Rundle College — all sit within the Aspen catchment, which is the single biggest driver of family demand.",
    ]),
    outsideCopy: JSON.stringify([
      "Aspen Estates Park and the 69th Street pathway connect through to West District. Edworthy Park and the Bow River pathway are a four-minute drive north.",
    ]),
    amenitiesCopy: JSON.stringify([
      "Webber Academy (K-12), Calgary Academy, Rundle College, Ambrose University. Calgary French & International School is a 12-minute drive south.",
    ]),
    shopDineCopy: JSON.stringify([
      "Aspen Landing — Blanco Cantina, Briggs Kitchen, Pie Junkie, Sunterra Market. West District (under construction) will add a second high-street precinct directly north.",
    ]),
    heroImage: "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1600&h=900&fit=crop",
    gallery: JSON.stringify([
      "https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600573472556-e636c2acda88?w=1200&h=800&fit=crop",
    ]),
    centerLat: 51.0395,
    centerLng: -114.193,
    avgPrice: 2750000,
    activeCount: 0,
    sortOrder: 5,
  },
  {
    slug: "springbank-hill",
    name: "Springbank Hill",
    tagline: "Acreage-feel lots in the foothills, ten minutes from downtown.",
    story: JSON.stringify([
      "Springbank Hill rises west of Aspen Woods, with lots that increase in size as you move toward the city limit. The neighbourhood's older sections — built in the 1990s — have larger lots (0.18 to 0.35 acres) and a mix of original and rebuilt homes. The newer sections feel more like Aspen.",
      "The price-to-square-foot ratio here is the most favourable in Calgary's prestige market: buyers consistently get more home for the dollar than equivalent square footage in Aspen or Britannia. The trade-off is a 10-15 minute longer commute to downtown.",
    ]),
    outsideCopy: JSON.stringify([
      "Griffith Woods, the protected wetland ravine, runs along the southern edge with off-leash trails. Edworthy Park is a six-minute drive north.",
    ]),
    amenitiesCopy: JSON.stringify([
      "Webber Academy, Rundle College, Ambrose University, Calgary Academy. The public catchment is Olympic Heights / Ernest Manning High School.",
    ]),
    shopDineCopy: JSON.stringify([
      "Aspen Landing is the closest retail (four minutes). The 85th Street commercial node is closer for groceries — Co-op, Shoppers, several restaurants.",
    ]),
    heroImage: "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=1600&h=900&fit=crop",
    gallery: JSON.stringify([
      "https://images.unsplash.com/photo-1600210491892-03d54c0aaf87?w=1200&h=800&fit=crop",
      "https://images.unsplash.com/photo-1600585154084-4e5fe7c39198?w=1200&h=800&fit=crop",
    ]),
    centerLat: 51.0245,
    centerLng: -114.196,
    avgPrice: 2200000,
    activeCount: 0,
    sortOrder: 6,
  },
];

const SEED_BLOG_POSTS = [
  {
    slug: "calgary-luxury-q1-2026-recap",
    title: "Q1 2026: Calgary Luxury Recap",
    excerpt:
      "Eighteen sales over $2M closed in the first quarter — half of them off-market. Here's what the data says about where the high end of the Calgary market is heading.",
    body: [
      "Eighteen homes priced over $2M closed in Calgary in Q1 2026. That's down two from Q1 2025, but the dollar volume rose 11% — the average sale price moved from $2.81M to $3.14M.",
      "Half of those sales never appeared on Realtor.ca. They moved through pocket listings, agent networks, or pre-list showings. The number of true off-market sales has roughly doubled since 2023, and that trend shows no sign of slowing.",
      "Days-on-market for homes that did list publicly averaged 41 days, down from 67 in Q1 2025. The cleanest, best-priced homes are still moving in under 30; the long sits are almost always a pricing problem rather than a market problem.",
      "Inventory is the single biggest constraint right now. Active listings over $2M sit at 84 across all of Calgary as of April 1 — that's roughly 4.6 months of supply at current absorption. Anything under 6 months is a seller's market.",
      "My read: pricing power continues to favour sellers in the $2-4M range, and the off-market trend will keep accelerating in the prestige communities. If you're considering selling in 2026, the conversation about strategy should start three to six months ahead.",
    ].join("\n\n"),
    category: "Market",
    heroImage: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=1600&h=900&fit=crop",
    readMinutes: 5,
  },
  {
    slug: "upper-mount-royal-buyers-guide",
    title: "A Buyer's Guide to Upper Mount Royal",
    excerpt:
      "How to read the streets, what the lot lines tell you, and where the real value sits in Calgary's most established prestige neighbourhood.",
    body: [
      "Upper Mount Royal isn't one neighbourhood — it's a half-dozen distinct streets with very different price profiles. Knowing the difference will save you six figures.",
      "Prospect Avenue, the spine of the community, holds the largest lots and the most consistent prestige inventory. Hope, Talon, and Premier follow. Sifton Boulevard sits at the western edge with strong views but smaller lots. The streets east of Mount Royal Crescent are the entry tier — still desirable, but lots tighten and the housing stock skews younger.",
      "Lot widths matter more here than in any other Calgary neighbourhood. A 75-foot lot on Prospect prices roughly 60% above an equivalent 50-foot lot one street over, even if the homes are similar. When you tour, count the steps from one side of the lot line to the other — if you can pace it in fewer than 25 steps, it's a 50-foot lot.",
      "Heritage status is a wildcard. Some homes are formally protected — meaningful renovation requires a heritage covenant amendment, which adds cost and time. Always ask for the lot's status before you write.",
      "Best value right now: a restored 1920s home on a 60-foot lot, north of Premier. Pricing has lagged the new builds, and the rebuild option remains intact for a buyer who wants flexibility down the road.",
    ].join("\n\n"),
    category: "Neighbourhood",
    heroImage: "https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1600&h=900&fit=crop",
    readMinutes: 6,
  },
  {
    slug: "pricing-a-luxury-listing",
    title: "Pricing a Luxury Listing in Calgary",
    excerpt:
      "The first 21 days set the trajectory for the entire sale. Here's how I think about pricing strategy at the top of the market.",
    body: [
      "At the high end of the market, pricing is the entire game. The first 21 days of a listing generate 80% of the qualified showings; what happens after that is largely a function of the price you set on day one.",
      "No one pays full price for a stale donut. A home that sits without offers for 60 days carries a perceptual penalty that no amount of staging or photography will erase. The market reads the days-on-market field.",
      "My approach: I price every luxury listing within 3% of the supportable comparable range. That gives the first wave of buyers a sense that the home is fairly priced, and it gives me room to negotiate without erasing the seller's position.",
      "The temptation to test the market with an aspirational price is real, and I understand it. But every week the home sits over its supportable price, the eventual sale price erodes by roughly 0.5%. Eight weeks of testing typically costs more than the would-be upside.",
      "The right price isn't the highest price. It's the price that gets the home in front of every qualified buyer in the first 21 days, and lets the strongest of them compete.",
    ].join("\n\n"),
    category: "Selling",
    heroImage: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1600&h=900&fit=crop",
    readMinutes: 5,
  },
  {
    slug: "off-market-luxury-listings",
    title: "The Rise of Off-Market Luxury Listings",
    excerpt:
      "Half of Calgary's $2M+ sales in Q1 2026 never hit Realtor.ca. Here's why, and what it means if you're buying or selling at the top of the market.",
    body: [
      "Off-market activity at the top of the Calgary market has roughly doubled since 2023. In Q1 2026, nine of the 18 sales over $2M closed without a public MLS listing.",
      "There are three drivers. First, sellers in prestige communities increasingly value privacy — they don't want photos of their interior on a public website. Second, the agent networks have professionalized: a small group of agents now share off-market inventory in structured ways. Third, qualified buyers in this segment have learned to ask for inventory that isn't yet listed.",
      "For sellers, off-market can be a strong strategy when the home has a defined buyer profile and a flexible timeline. It's a weak strategy when the seller needs broad market exposure — you trade reach for privacy.",
      "For buyers, the implication is straightforward: if you're shopping over $2M, the public listings are not the full market. Working with an agent who is plugged into the off-market network changes the inventory you see by 30-50%.",
      "This trend is not going to reverse. Expect the share of off-market sales to keep climbing through the rest of 2026.",
    ].join("\n\n"),
    category: "Market",
    heroImage: "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=1600&h=900&fit=crop",
    readMinutes: 4,
  },
  {
    slug: "renovating-vs-rebuilding-mount-royal",
    title: "Renovating vs. Rebuilding in Mount Royal",
    excerpt:
      "When does it make sense to restore a heritage home, and when is the better play to rebuild? A frank look at the math.",
    body: [
      "The most common question I field on inner-city luxury homes: do I restore the existing house, or tear it down and build new? The answer depends on three numbers.",
      "First, the lot value. In Upper Mount Royal, a finished 60-foot lot is worth $1.6-2.1M as land. If the home on it adds less than 60% to that — meaning the total list is under $3.4M for a 60-foot lot — you're effectively pricing it as a teardown anyway.",
      "Second, the cost to renovate. A meaningful renovation of a 1920s heritage home runs $400-600/sqft on the floor area touched. New construction in the same neighbourhood is closer to $700-900/sqft all-in. The renovation looks cheaper per foot, but the deferred maintenance — knob-and-tube wiring, lath-and-plaster walls, undersized ductwork — adds 20-30% in scope by the time you finish.",
      "Third, the heritage covenant. If the home is formally protected, the rebuild option is partially or fully off the table. That changes the math entirely — you're committed to a restoration, and the lot's price needs to reflect that constraint.",
      "My rule of thumb: if the existing home was built before 1950 and has architectural integrity, restoration almost always wins on resale. If it's a 1960s or 70s box on a great lot, the rebuild is the play. The middle case — a 1980s or 90s home on a strong lot — is the hardest call, and depends on the specific home.",
    ].join("\n\n"),
    category: "Buying",
    heroImage: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1600&h=900&fit=crop",
    readMinutes: 7,
  },
  {
    slug: "aspen-woods-vs-springbank-hill",
    title: "Aspen Woods vs. Springbank Hill: Which Suits You?",
    excerpt:
      "Two of Calgary's strongest west-side prestige communities, side by side. The differences are real and they affect resale.",
    body: [
      "Aspen Woods and Springbank Hill share a lot — both built between 2000 and 2018, both west of Sarcee Trail, both feeding into the same Webber/Rundle/Calgary Academy private school cluster. But they price differently for a reason.",
      "Aspen has the demographic concentration. School cohort matters here — families pay a premium to be in the catchment that puts their kids on the same bus as the neighbour's kids. The community has a tighter social fabric and a more uniform housing standard.",
      "Springbank Hill has the lots. The older sections, built in the late 1990s, sit on 0.18-0.35 acre lots that you simply cannot find in Aspen. If you want acreage feel inside city limits, Springbank delivers it. The trade-off is a 5-10 minute longer commute and a slightly looser housing standard — not every block is uniformly upscale.",
      "Resale: Aspen homes hold value in normal markets and outperform in downturns. Springbank Hill homes hold value in normal markets and slightly underperform in downturns, but offer more upside in tight markets when the inventory advantage matters.",
      "My read: if you're a family with two or three school-age kids and a five-to-ten year horizon, Aspen is the safer play. If you have a longer horizon, want a bigger lot, or have already aged past the school-age window, Springbank Hill is often the better dollar.",
    ].join("\n\n"),
    category: "Neighbourhood",
    heroImage: "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1600&h=900&fit=crop",
    readMinutes: 6,
  },
];

const SEED_TESTIMONIALS = [
  {
    authorName: "Jane & Marcus W.",
    authorRole: "Upper Mount Royal Sellers",
    rating: 5,
    body: "Spencer sold our Upper Mount Royal home off-market in 14 days, $200K above what two other agents had quoted. He was direct, prepared, and never wasted our time. Highest recommendation.",
    sortOrder: 1,
  },
  {
    authorName: "David L.",
    authorRole: "Aspen Woods Buyer",
    rating: 5,
    body: "We were relocating from Toronto and needed an agent who actually knew the difference between Calgary's communities. Spencer walked us through Aspen, Springbank, and Mount Royal in two days and helped us land a home that hadn't hit MLS yet.",
    sortOrder: 2,
  },
  {
    authorName: "Priya & Anand R.",
    authorRole: "Elbow Park Buyers",
    rating: 5,
    body: "What stood out was the data. Spencer ran the comps live during our showing and explained exactly why one house was priced right and the other wasn't. We ended up writing on the right one.",
    sortOrder: 3,
  },
  {
    authorName: "Robert T.",
    authorRole: "Britannia Seller",
    rating: 5,
    body: "Six other agents told us we should list at $2.8M. Spencer told us $3.1M was supportable if we addressed three specific items. We sold at $3.05M in eleven days.",
    sortOrder: 4,
  },
  {
    authorName: "Hannah B.",
    authorRole: "Bel-Aire Buyer",
    rating: 5,
    body: "Spencer is the rare agent who will tell you not to write on a house. He talked us out of two offers and into the right one. We've been in our Bel-Aire home for two years and still feel he saved us a million dollars in regret.",
    sortOrder: 5,
  },
  {
    authorName: "James W.",
    authorRole: "Springbank Hill Seller",
    rating: 5,
    body: "Sold our home in eight days. The marketing package — photos, video, the listing copy itself — was at a different level than what other agents had shown us.",
    sortOrder: 6,
  },
  {
    authorName: "Sofia M.",
    authorRole: "Aspen Woods Seller & Buyer",
    rating: 5,
    body: "Spencer represented us on both sides of a move within Aspen. The execution on both transactions was clean — he negotiated firm on our sale and patient on our purchase, exactly as the situation needed.",
    sortOrder: 7,
  },
  {
    authorName: "Ken & Lila P.",
    authorRole: "Mount Royal Sellers",
    rating: 5,
    body: "We had a heritage home with restrictions on what could be advertised. Spencer ran a quiet, controlled process — three private showings, two offers, sale closed in 23 days at full ask.",
    sortOrder: 8,
  },
];
