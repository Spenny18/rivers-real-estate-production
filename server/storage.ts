import {
  users,
  listings,
  leads,
  messages,
  tours,
  mlsListings,
  mlsSyncRuns,
  blogPosts,
  neighbourhoods,
  testimonials,
  poisCache,
  savedSearches,
  socialPosts,
  condoBuildings,
  leadAlerts,
  mlsPriceHistory,
  userIntegrations,
  pages,
  pageRevisions,
  bookingEventTypes,
  bookingAvailability,
  bookingDateOverrides,
  bookings,
} from "@shared/schema";
import type {
  User,
  PublicUser,
  ListingRow,
  Lead,
  Message,
  Tour,
  InsertListing,
  InsertLead,
  InsertMessage,
  InsertTour,
  MlsListing,
  InsertMlsListing,
  MlsSyncRun,
  BlogPost,
  InsertBlogPost,
  Neighbourhood,
  InsertNeighbourhood,
  Testimonial,
  InsertTestimonial,
  PoiCacheRow,
  SavedSearch,
  InsertSavedSearch,
  SocialPost,
  InsertSocialPost,
  CondoBuilding,
  InsertCondoBuilding,
  LeadAlert,
  InsertLeadAlert,
  MlsPriceHistory,
  InsertMlsPriceHistory,
  UserIntegration,
  InsertUserIntegration,
  PageRow,
  InsertPageRow,
  PageRevision,
  BookingEventType,
  InsertBookingEventType,
  BookingAvailability,
  BookingDateOverride,
  InsertBookingDateOverride,
  Booking,
  InsertBooking,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, and, gte, lte, like, sql, or, asc, inArray } from "drizzle-orm";
import { assignMlsLegacySeoSlugs, assignMlsPreviousSeoSlugs, assignMlsSeoSlugs } from "@shared/mls-url";

// Use data.db for SQLite. The publish flow snapshots/restores `data.db` across
// redeploys. If the snapshot becomes corrupt ("database disk image is
// malformed"), fall back to a fresh file so seed() + RETS sync can rebuild it.
//
// In production hosts where the working directory is read-only or wiped on each
// deploy (Fly.io, Render, etc.) set DB_PATH to a path on a persistent volume,
// e.g. DB_PATH=/data/rivers.db.
import fs from "node:fs";
import nodePath from "node:path";
import { pointInGeometry } from "./point-in-polygon";
function openDb(): InstanceType<typeof Database> {
  const path = process.env.DB_PATH || "data.db";
  try {
    const dir = nodePath.dirname(path);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {}
  try {
    const db = new Database(path);
    // Probe for corruption with a cheap PRAGMA quick_check
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check && check.quick_check && check.quick_check !== "ok") {
      console.warn("[storage] quick_check =", check.quick_check, "— rebuilding data.db");
      db.close();
      try { fs.renameSync(path, path + ".corrupt." + Date.now()); } catch (e) { try { fs.unlinkSync(path); } catch {} }
      return new Database(path);
    }
    return db;
  } catch (err: any) {
    console.error("[storage] open failed, rebuilding:", err?.message);
    try { fs.renameSync(path, path + ".corrupt." + Date.now()); } catch (e) { try { fs.unlinkSync(path); } catch {} }
    return new Database(path);
  }
}
const sqlite = openDb();
sqlite.pragma("journal_mode = WAL");

// Create tables (idempotent — for SQLite without migrations)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT,
    avatar TEXT,
    phone TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    address TEXT NOT NULL,
    neighbourhood TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT 'Calgary, AB',
    price INTEGER NOT NULL,
    beds INTEGER NOT NULL,
    baths REAL NOT NULL,
    sqft INTEGER NOT NULL,
    lot_size TEXT,
    year_built INTEGER NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    description TEXT NOT NULL,
    features TEXT NOT NULL DEFAULT '[]',
    hero_image TEXT NOT NULL,
    gallery TEXT NOT NULL DEFAULT '[]',
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    message TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'Landing page',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    from_agent INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL,
    lead_id INTEGER,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested',
    notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mls_listings (
    id TEXT PRIMARY KEY,
    mls_number TEXT NOT NULL,
    listing_key INTEGER,
    status TEXT NOT NULL DEFAULT 'Active',
    list_price INTEGER NOT NULL,
    sold_price INTEGER,
    street_number TEXT,
    street_name TEXT,
    unit TEXT,
    full_address TEXT NOT NULL,
    neighbourhood TEXT,
    city TEXT NOT NULL DEFAULT 'Calgary',
    province TEXT NOT NULL DEFAULT 'AB',
    postal_code TEXT,
    lat REAL,
    lng REAL,
    property_type TEXT NOT NULL DEFAULT 'Detached',
    property_sub_type TEXT,
    beds INTEGER NOT NULL DEFAULT 0,
    beds_above INTEGER,
    beds_below INTEGER,
    baths REAL NOT NULL DEFAULT 0,
    half_baths INTEGER,
    sqft INTEGER,
    sqft_below INTEGER,
    lot_size TEXT,
    year_built INTEGER,
    parking TEXT,
    garage_spaces INTEGER,
    list_date TEXT,
    days_on_market INTEGER,
    description TEXT,
    features TEXT NOT NULL DEFAULT '[]',
    list_agent_name TEXT,
    list_agent_phone TEXT,
    list_office TEXT,
    hero_image TEXT,
    gallery TEXT NOT NULL DEFAULT '[]',
    photo_count INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'pillar9',
    raw_json TEXT,
    synced_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mls_neighbourhood ON mls_listings(neighbourhood);
  CREATE INDEX IF NOT EXISTS idx_mls_status ON mls_listings(status);
  CREATE INDEX IF NOT EXISTS idx_mls_price ON mls_listings(list_price);
  CREATE TABLE IF NOT EXISTS mls_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    source TEXT NOT NULL DEFAULT 'pillar9',
    fetched INTEGER NOT NULL DEFAULT 0,
    upserted INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
  );
  CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Market',
    hero_image TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT 'Spencer Rivers',
    author_avatar TEXT,
    read_minutes INTEGER NOT NULL DEFAULT 4,
    published_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS neighbourhoods (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tagline TEXT NOT NULL,
    story TEXT NOT NULL DEFAULT '[]',
    outside_copy TEXT NOT NULL DEFAULT '[]',
    amenities_copy TEXT NOT NULL DEFAULT '[]',
    shop_dine_copy TEXT NOT NULL DEFAULT '[]',
    hero_image TEXT NOT NULL,
    gallery TEXT NOT NULL DEFAULT '[]',
    center_lat REAL NOT NULL,
    center_lng REAL NOT NULL,
    avg_price INTEGER NOT NULL,
    active_count INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS testimonials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_name TEXT NOT NULL,
    author_role TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 5,
    body TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS user_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    account_email TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT,
    scope TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_integrations_user_provider
    ON user_integrations(user_id, provider);
  CREATE TABLE IF NOT EXISTS lead_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    filters TEXT NOT NULL DEFAULT '{}',
    frequency TEXT NOT NULL DEFAULT 'daily',
    instant INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    last_sent_at TEXT,
    last_match_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mls_price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL,
    old_price INTEGER,
    new_price INTEGER,
    old_status TEXT,
    new_status TEXT,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mls_price_history_listing
    ON mls_price_history(listing_id, changed_at);
  CREATE INDEX IF NOT EXISTS idx_mls_price_history_changed_at
    ON mls_price_history(changed_at);
  CREATE TABLE IF NOT EXISTS condo_buildings (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tagline TEXT NOT NULL,
    intro TEXT NOT NULL DEFAULT '[]',
    residences_copy TEXT NOT NULL DEFAULT '[]',
    architectural_copy TEXT NOT NULL DEFAULT '[]',
    location_copy TEXT NOT NULL DEFAULT '[]',
    dining_copy TEXT NOT NULL DEFAULT '[]',
    shopping_copy TEXT NOT NULL DEFAULT '[]',
    community_copy TEXT NOT NULL DEFAULT '[]',
    schools_copy TEXT NOT NULL DEFAULT '[]',
    amenities TEXT NOT NULL DEFAULT '[]',
    address TEXT NOT NULL,
    address_aliases TEXT,
    neighbourhood_slug TEXT NOT NULL,
    neighbourhood TEXT NOT NULL,
    quadrant TEXT NOT NULL DEFAULT 'city-centre',
    units INTEGER,
    stories INTEGER,
    built_in INTEGER,
    developer TEXT,
    architect TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    hero_image TEXT NOT NULL,
    gallery TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS pois_cache (
    id TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    radius INTEGER NOT NULL DEFAULT 1000,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saved_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    filters TEXT NOT NULL DEFAULT '{}',
    email_alerts INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    match_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS social_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    listing_id TEXT,
    caption TEXT NOT NULL,
    image_url TEXT,
    link_url TEXT,
    channels TEXT NOT NULL DEFAULT '[]',
    variants TEXT NOT NULL DEFAULT '{}',
    scheduled_for TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    posted_at TEXT,
    created_at TEXT NOT NULL
  );

  -- Consumer portal (/account/*) tables ----------------------------------
  CREATE TABLE IF NOT EXISTS account_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    google_sub TEXT,
    name TEXT,
    phone TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_account_users_email ON account_users(email);
  CREATE INDEX IF NOT EXISTS idx_account_users_lead_id ON account_users(lead_id);

  CREATE TABLE IF NOT EXISTS account_sessions (
    id TEXT PRIMARY KEY,
    account_user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_account_sessions_user ON account_sessions(account_user_id);

  CREATE TABLE IF NOT EXISTS account_magic_tokens (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_account_magic_tokens_email ON account_magic_tokens(email);

  CREATE TABLE IF NOT EXISTS account_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_user_id INTEGER NOT NULL,
    mls_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(account_user_id, mls_id)
  );

  CREATE TABLE IF NOT EXISTS account_property_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_user_id INTEGER NOT NULL,
    mls_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_user_id, mls_id)
  );

  CREATE TABLE IF NOT EXISTS account_market_report_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_user_id INTEGER NOT NULL,
    neighbourhood_slug TEXT,
    frequency TEXT NOT NULL DEFAULT 'weekly',
    active INTEGER NOT NULL DEFAULT 1,
    last_sent_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pages (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    seo_title TEXT NOT NULL DEFAULT '',
    seo_description TEXT NOT NULL DEFAULT '',
    seo_keywords TEXT NOT NULL DEFAULT '',
    og_image TEXT NOT NULL DEFAULT '',
    canonical TEXT NOT NULL DEFAULT '',
    noindex INTEGER NOT NULL DEFAULT 0,
    blocks TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS page_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_slug TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    label TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_page_revisions_slug ON page_revisions(page_slug, id DESC);

  -- Focus-keyword intent set by hand in the admin SEO console. Absent rows mean
  -- "derive the keyword from the page title", which is the default behaviour.
  CREATE TABLE IF NOT EXISTS seo_keyword_targets (
    path TEXT PRIMARY KEY,
    focus_keyword TEXT NOT NULL,
    note TEXT,
    updated_at TEXT NOT NULL
  );

  -- Scheduling: the Calendly-style booker behind /book and /admin/scheduling.
  CREATE TABLE IF NOT EXISTS booking_event_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    location_type TEXT NOT NULL DEFAULT 'phone',
    location_detail TEXT,
    color TEXT NOT NULL DEFAULT '#23412d',
    buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
    buffer_after_minutes INTEGER NOT NULL DEFAULT 15,
    minimum_notice_minutes INTEGER NOT NULL DEFAULT 240,
    advance_days INTEGER NOT NULL DEFAULT 60,
    slot_interval_minutes INTEGER NOT NULL DEFAULT 30,
    max_per_day INTEGER,
    timezone TEXT NOT NULL DEFAULT 'America/Edmonton',
    require_phone INTEGER NOT NULL DEFAULT 1,
    custom_question TEXT,
    confirmation_message TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS booking_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type_id INTEGER,
    day_of_week INTEGER NOT NULL,
    start_minute INTEGER NOT NULL,
    end_minute INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_booking_availability_type
    ON booking_availability(event_type_id, day_of_week);
  CREATE TABLE IF NOT EXISTS booking_date_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    unavailable INTEGER NOT NULL DEFAULT 1,
    start_minute INTEGER,
    end_minute INTEGER,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    event_type_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    answer TEXT,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/Edmonton',
    status TEXT NOT NULL DEFAULT 'confirmed',
    cancel_reason TEXT,
    cancelled_at TEXT,
    cancelled_by TEXT,
    google_event_id TEXT,
    lead_id INTEGER,
    listing_id TEXT,
    source TEXT NOT NULL DEFAULT 'booking_page',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_starts_at ON bookings(starts_at);
  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status, starts_at);
  CREATE INDEX IF NOT EXISTS idx_bookings_event_type ON bookings(event_type_id, starts_at);
`);

// Migration: add account_user_id to saved_searches so portal users own
// their own rows separately from admin-created searches.
try {
  const cols = sqlite.prepare("PRAGMA table_info(saved_searches)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "account_user_id")) {
    sqlite.exec("ALTER TABLE saved_searches ADD COLUMN account_user_id INTEGER");
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_saved_searches_account_user ON saved_searches(account_user_id)");
    console.log("[migration] added account_user_id to saved_searches");
  }
} catch (e) {
  console.error("[migration] saved_searches account_user_id:", e);
}

// Migration: add status column to blog_posts (draft | published). Existing
// rows default to "published" so legacy migrated content stays live.
try {
  const cols = sqlite.prepare("PRAGMA table_info(blog_posts)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "status")) {
    sqlite.exec("ALTER TABLE blog_posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'");
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status)");
    console.log("[migration] added status to blog_posts");
  }
} catch (e) {
  console.error("[migration] blog_posts status:", e);
}

// Migration: add hero_image_alt to blog_posts — SEO alt text (focus keyword)
// for the hero image. Nullable; client falls back to the post title.
try {
  const cols = sqlite.prepare("PRAGMA table_info(blog_posts)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "hero_image_alt")) {
    sqlite.exec("ALTER TABLE blog_posts ADD COLUMN hero_image_alt TEXT");
    console.log("[migration] added hero_image_alt to blog_posts");
  }
} catch (e) {
  console.error("[migration] blog_posts hero_image_alt:", e);
}

// One-time backfill (2026-07-31): the BOFU cluster cadence assigned one shared
// hero image per 3-post cluster, so recent posts repeated the same 7 images.
// Give each of the 20 most recent posts a unique, topical hero + focus-keyword
// alt text. Guarded on hero_image_alt IS NULL so it applies exactly once per
// row and never clobbers later manual edits from /admin/blog.
try {
  const heroBackfill: Array<[slug: string, photo: string, alt: string]> = [
    ["vacant-vs-occupied-luxury-listings-which-sells-faster-in-calgary", "photo-1513694203232-719a280e022f", "vacant vs occupied luxury listings Calgary"],
    ["luxury-home-staging-in-calgary-costs-and-real-roi", "photo-1618221195710-dd6b41faaea6", "luxury home staging Calgary"],
    ["should-you-stage-your-luxury-calgary-home-before-listing", "photo-1616486338812-3dadae4b4ace", "staging a luxury Calgary home before listing"],
    ["should-you-pre-inspect-your-calgary-luxury-home-before-listing", "photo-1454165804606-c3d57bc86b40", "pre-listing home inspection Calgary"],
    ["stucco-attic-rain-and-other-calgary-specific-inspection-issues", "photo-1523217582562-09d0def993a6", "Calgary stucco and attic rain inspection issues"],
    ["what-a-calgary-luxury-home-inspection-actually-finds", "photo-1621905251189-08b45d6a269e", "Calgary luxury home inspection"],
    ["springbank-hill-schools-amenities-and-mountain-access", "photo-1464822759023-fed622ff2c3b", "Springbank Hill mountain access"],
    ["springbank-hill-estate-homes-lot-sizes-views-and-walk-outs", "photo-1558036117-15d82a90b9b1", "Springbank Hill estate homes"],
    ["living-in-springbank-hill-the-calgary-luxury-buyers-guide", "photo-1570129477492-45c003edd2be", "living in Springbank Hill Calgary"],
    ["east-village-luxury-condos-modern-towers-and-the-true-cost-of-ownership", "photo-1460317442991-0ec209397118", "East Village Calgary luxury condos"],
    ["eau-claire-luxury-condos-buildings-views-and-price-per-square-foot", "photo-1600210492486-724fe5c67fb0", "Eau Claire Calgary luxury condos"],
    ["calgarys-top-luxury-condo-districts-mission-eau-claire-and-east-village-compared", "photo-1449157291145-7efd050a4d0e", "Calgary luxury condo districts"],
    ["how-calgarys-market-cycle-affects-luxury-days-on-market", "photo-1494526585095-c41746248156", "Calgary luxury days on market"],
    ["the-5-best-streets-in-aspen-woods-for-luxury-buyers", "photo-1600047509807-ba8f99d2cdde", "best streets in Aspen Woods Calgary"],
    ["aspen-woods-real-estate-price-points-build-era-and-architecture", "photo-1600047509358-9dc75507daeb", "Aspen Woods real estate architecture"],
    ["living-in-aspen-woods-the-calgary-luxury-buyers-guide", "photo-1600566753086-00f18fb6b3ea", "living in Aspen Woods Calgary"],
    ["spring-vs-fall-luxury-listing-strategy-in-calgary", "photo-1523712999610-f77fbcfc3843", "spring vs fall home listing Calgary"],
    ["when-to-sell-a-luxury-home-in-calgary-a-month-by-month-guide", "photo-1506784983877-45594efa4cbe", "when to sell a luxury home in Calgary"],
    ["alberta-closing-costs-for-sellers-lawyer-fees-rpr-and-mortgage-penalties", "photo-1450101499163-c8848c66ca85", "Alberta seller closing costs"],
    ["how-calgary-luxury-realtor-commissions-actually-work", "photo-1521791136064-7986c2920216", "Calgary luxury realtor commissions"],
  ];
  const applyHero = sqlite.prepare(
    "UPDATE blog_posts SET hero_image = ?, hero_image_alt = ? WHERE slug = ? AND hero_image_alt IS NULL",
  );
  let heroApplied = 0;
  for (const [slug, photo, alt] of heroBackfill) {
    const url = `https://images.unsplash.com/${photo}?w=1600&q=85&fm=jpg&auto=format`;
    heroApplied += applyHero.run(url, alt, slug).changes;
  }
  if (heroApplied > 0) console.log(`[migration] backfilled unique hero images + alt text on ${heroApplied} blog posts`);

  // Correction pass for DBs that received the first (2026-07-31) backfill,
  // which mis-assigned three photos (a Toronto skyline on the condo-districts
  // post, and swapped inspection/estate shots). Keyed on the wrong URL, so it
  // fires once and never touches manual edits.
  const heroFixes: Array<[slug: string, wrongPhoto: string, photo: string]> = [
    ["springbank-hill-estate-homes-lot-sizes-views-and-walk-outs", "photo-1454165804606", "photo-1558036117-15d82a90b9b1"],
    ["should-you-pre-inspect-your-calgary-luxury-home-before-listing", "photo-1581092160562", "photo-1454165804606-c3d57bc86b40"],
    ["calgarys-top-luxury-condo-districts-mission-eau-claire-and-east-village-compared", "photo-1486325212027", "photo-1449157291145-7efd050a4d0e"],
  ];
  const applyFix = sqlite.prepare(
    "UPDATE blog_posts SET hero_image = ? WHERE slug = ? AND hero_image LIKE ?",
  );
  let heroFixed = 0;
  for (const [slug, wrongPhoto, photo] of heroFixes) {
    const url = `https://images.unsplash.com/${photo}?w=1600&q=85&fm=jpg&auto=format`;
    heroFixed += applyFix.run(url, slug, `%${wrongPhoto}%`).changes;
  }
  if (heroFixed > 0) console.log(`[migration] corrected ${heroFixed} backfilled hero images`);
} catch (e) {
  console.error("[migration] blog_posts hero backfill:", e);
}

// Migration: add link_url + variants columns to existing social_posts rows.
try {
  const cols = sqlite.prepare("PRAGMA table_info(social_posts)").all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("link_url")) {
      sqlite.exec("ALTER TABLE social_posts ADD COLUMN link_url TEXT");
      console.log("[migration] added link_url to social_posts");
    }
    if (!existing.has("variants")) {
      sqlite.exec("ALTER TABLE social_posts ADD COLUMN variants TEXT NOT NULL DEFAULT '{}'");
      console.log("[migration] added variants to social_posts");
    }
  }
} catch (err) {
  console.error("[migration] social_posts column add failed:", err);
}

// Migration: add address_aliases + long-form copy columns to condo_buildings.
try {
  const cols = sqlite.prepare("PRAGMA table_info(condo_buildings)").all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("address_aliases")) {
      sqlite.exec("ALTER TABLE condo_buildings ADD COLUMN address_aliases TEXT");
      console.log("[migration] added address_aliases to condo_buildings");
    }
    const longFormCols: Array<[string, string]> = [
      ["location_copy",  "ALTER TABLE condo_buildings ADD COLUMN location_copy TEXT NOT NULL DEFAULT '[]'"],
      ["dining_copy",    "ALTER TABLE condo_buildings ADD COLUMN dining_copy TEXT NOT NULL DEFAULT '[]'"],
      ["shopping_copy",  "ALTER TABLE condo_buildings ADD COLUMN shopping_copy TEXT NOT NULL DEFAULT '[]'"],
      ["community_copy", "ALTER TABLE condo_buildings ADD COLUMN community_copy TEXT NOT NULL DEFAULT '[]'"],
      ["schools_copy",   "ALTER TABLE condo_buildings ADD COLUMN schools_copy TEXT NOT NULL DEFAULT '[]'"],
    ];
    for (const [name, ddl] of longFormCols) {
      if (!existing.has(name)) {
        sqlite.exec(ddl);
        console.log(`[migration] added ${name} to condo_buildings`);
      }
    }
  }
} catch (err) {
  console.error("[migration] condo_buildings copy-fields add failed:", err);
}

// --- Lightweight migrations (additive only) ---
// Add new columns to mls_listings if missing. SQLite ALTER TABLE ADD COLUMN is
// idempotent only if we check first — easiest path is PRAGMA table_info.
try {
  const cols = sqlite.prepare("PRAGMA table_info(mls_listings)").all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const existing = new Set(cols.map((c) => c.name));
    const additions: Array<[string, string]> = [
      ["listing_key", "INTEGER"],
      ["structure_type", "TEXT"],
      ["architectural_style", "TEXT"],
      ["levels", "TEXT"],
      ["basement", "TEXT"],
      ["basement_development", "TEXT"],
      ["parking_features", "TEXT"],
      ["garage_yn", "INTEGER"],
      ["lot_features", "TEXT"],
      ["laundry_features", "TEXT"],
      ["appliances", "TEXT"],
      ["cooling", "TEXT"],
      ["heating", "TEXT"],
      ["flooring", "TEXT"],
      ["fireplaces_total", "INTEGER"],
      ["fireplace_features", "TEXT"],
      ["pool_private_yn", "INTEGER"],
      ["pool_features", "TEXT"],
      ["waterfront_yn", "INTEGER"],
      ["view", "TEXT"],
      ["subdivision", "TEXT"],
      ["district", "TEXT"],
      ["condo_fee", "INTEGER"],
      ["association_fee_includes", "TEXT"],
      ["association_amenities", "TEXT"],
      ["accessibility_features", "TEXT"],
      ["inclusions", "TEXT"],
      ["exclusions", "TEXT"],
      ["zoning", "TEXT"],
      ["suite", "TEXT"],
      ["legal_suite_yn", "INTEGER"],
      ["suite_location", "TEXT"],
      ["previous_price", "INTEGER"],
      ["price_changed_at", "TEXT"],
      ["removed_at", "TEXT"],
      ["removed_reason", "TEXT"],
      ["status_changed_at", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) {
        sqlite.exec(`ALTER TABLE mls_listings ADD COLUMN ${name} ${type}`);
        console.log(`[migration] added ${name} to mls_listings`);
      }
    }
  }
} catch (err) {
  console.error("[migration] failed to add mls_listings columns:", err);
}

// Tours: add google_event_id for two-way Calendar sync.
try {
  const cols = sqlite.prepare("PRAGMA table_info(tours)").all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("google_event_id")) {
      sqlite.exec("ALTER TABLE tours ADD COLUMN google_event_id TEXT");
      console.log("[migration] added google_event_id to tours");
    }
  }
} catch (err) {
  console.error("[migration] failed to add google_event_id column:", err);
}

// Saved-searches table additions for unified alerts (idempotent).
try {
  const cols = sqlite.prepare("PRAGMA table_info(saved_searches)").all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const existing = new Set(cols.map((c) => c.name));
    const additions: Array<[string, string]> = [
      ["lead_id", "INTEGER"],
      ["email_recipient", "TEXT"],
      ["alert_type", "TEXT NOT NULL DEFAULT 'listings'"],
      ["frequency", "TEXT NOT NULL DEFAULT 'daily'"],
      ["instant", "INTEGER NOT NULL DEFAULT 0"],
      ["active", "INTEGER NOT NULL DEFAULT 1"],
      ["last_sent_at", "TEXT"],
      ["last_match_count", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) {
        sqlite.exec(`ALTER TABLE saved_searches ADD COLUMN ${name} ${type}`);
        console.log(`[migration] added ${name} to saved_searches`);
      }
    }
  }
} catch (err) {
  console.error("[migration] failed to add saved_searches columns:", err);
}

// One-time data migration: copy lead_alerts rows into saved_searches so the
// unified table is the canonical source for the cron. Migrated rows are
// flagged via the lead_id column. lead_alerts table is not dropped — kept
// as a read-only audit trail.
try {
  const oldRows = sqlite
    .prepare("SELECT * FROM lead_alerts WHERE active = 1")
    .all() as Array<any>;
  if (oldRows.length > 0) {
    const existing = sqlite
      .prepare("SELECT lead_id, name FROM saved_searches WHERE lead_id IS NOT NULL")
      .all() as Array<{ lead_id: number; name: string }>;
    const existingKey = new Set(existing.map((r) => `${r.lead_id}::${r.name}`));
    let migrated = 0;
    for (const r of oldRows) {
      const key = `${r.lead_id}::${r.label}`;
      if (existingKey.has(key)) continue;
      sqlite
        .prepare(
          `INSERT INTO saved_searches (
            user_id, lead_id, name, filters, email_alerts, alert_type, frequency,
            instant, active, last_sent_at, last_match_count, created_at
          ) VALUES (?, ?, ?, ?, 1, 'listings', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          1, // Spencer's user id
          r.lead_id,
          r.label,
          r.filters,
          r.frequency ?? "daily",
          r.instant ?? 0,
          r.active ?? 1,
          r.last_sent_at,
          r.last_match_count ?? 0,
          r.created_at ?? new Date().toISOString(),
        );
      migrated++;
    }
    if (migrated > 0) {
      console.log(`[migration] copied ${migrated} lead_alerts rows into saved_searches`);
    }
  }
} catch (err) {
  console.error("[migration] lead_alerts -> saved_searches copy failed:", err);
}

// Neighbourhoods table additions (idempotent).
try {
  const cols = sqlite.prepare("PRAGMA table_info(neighbourhoods)").all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const existing = new Set(cols.map((c) => c.name));
    const additions: Array<[string, string]> = [
      ["real_estate_copy", "TEXT NOT NULL DEFAULT '[]'"],
      ["life_copy", "TEXT NOT NULL DEFAULT '[]'"],
      ["quadrant", "TEXT NOT NULL DEFAULT 'city-centre'"],
      ["borders", "TEXT NOT NULL DEFAULT '{}'"],
      ["schools", "TEXT NOT NULL DEFAULT '[]'"],
      ["zone", "TEXT NOT NULL DEFAULT 'City Centre & Inner-City'"],
      ["condo_buildings_list", "TEXT NOT NULL DEFAULT '[]'"],
      ["hero_credit", "TEXT NOT NULL DEFAULT ''"],
      // OSM boundary cache (see server/neighbourhood-polygons.ts):
      // NULL = never fetched, "" = fetched-but-no-match, else GeoJSON geometry.
      ["polygon", "TEXT"],
      ["polygon_fetched_at", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) {
        sqlite.exec(`ALTER TABLE neighbourhoods ADD COLUMN ${name} ${type}`);
        console.log(`[migration] added ${name} to neighbourhoods`);
      }
    }
  }
} catch (err) {
  console.error("[migration] failed to add neighbourhoods columns:", err);
}

export const db = drizzle(sqlite);

// Convert raw row → public-shape (parse JSON arrays)
export type PublicListing = Omit<ListingRow, "features" | "gallery"> & {
  features: string[];
  gallery: string[];
};

function toPublicListing(row: ListingRow): PublicListing {
  return {
    ...row,
    features: safeParseArray(row.features),
    gallery: safeParseArray(row.gallery),
  };
}

function safeParseArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function stripUser(u: User): PublicUser {
  const { passwordHash, ...rest } = u;
  return rest;
}

export interface IStorage {
  // Users
  getUserById(id: number): User | undefined;
  getUserByEmail(email: string): User | undefined;
  createUser(data: { email: string; passwordHash: string; name: string; title?: string; avatar?: string; phone?: string }): User;

  // Listings
  listListings(opts?: { status?: string }): PublicListing[];
  getListingById(id: string): PublicListing | undefined;
  getListingBySlug(slug: string): PublicListing | undefined;
  createListing(data: any, userId: number): PublicListing;
  updateListing(id: string, patch: any): PublicListing | undefined;
  deleteListing(id: string): boolean;
  incrementViews(id: string): void;

  // Leads
  listLeads(): Lead[];
  getLead(id: number): Lead | undefined;
  createLead(data: InsertLead): Lead;
  updateLeadStatus(id: number, status: string): Lead | undefined;

  // Messages
  listMessagesByLead(leadId: number): Message[];
  createMessage(data: InsertMessage): Message;

  // Tours
  listTours(): Tour[];
  createTour(data: InsertTour): Tour;
  updateTourStatus(id: number, status: string): Tour | undefined;
}

// trailing storage methods are on DatabaseStorage above

// Normalize a Calgary street name so listings match seed data regardless of
// whether the broker wrote "Ave"/"Avenue", "St"/"Street", "NW"/"N.W.", etc.
// Returns lowercase, single-spaced, suffix-expanded.
const STREET_SUFFIX_MAP: Record<string, string> = {
  ave: "avenue",
  av: "avenue",
  st: "street",
  rd: "road",
  blvd: "boulevard",
  dr: "drive",
  cres: "crescent",
  cr: "crescent",
  pl: "place",
  ct: "court",
  trl: "trail",
  hwy: "highway",
  ln: "lane",
  pkwy: "parkway",
  pk: "park",
  cir: "circle",
  ter: "terrace",
  way: "way",
  bay: "bay",
  cl: "close",
  cv: "cove",
  pt: "point",
  hts: "heights",
  vw: "view",
  gr: "green",
  gdns: "gardens",
  mews: "mews",
  ml: "mile",
  pls: "plaza",
  hl: "hill",
};
const QUADRANT_MAP: Record<string, string> = {
  nw: "nw",
  ne: "ne",
  sw: "sw",
  se: "se",
  "n.w.": "nw",
  "n.e.": "ne",
  "s.w.": "sw",
  "s.e.": "se",
  northwest: "nw",
  northeast: "ne",
  southwest: "sw",
  southeast: "se",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
};
export function normalizeStreetName(raw: string | null | undefined): string {
  if (!raw) return "";
  const tokens = String(raw)
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const expanded = tokens.map((t) => {
    if (STREET_SUFFIX_MAP[t]) return STREET_SUFFIX_MAP[t];
    if (QUADRANT_MAP[t]) return QUADRANT_MAP[t];
    return t;
  });
  return expanded.join(" ");
}

export class DatabaseStorage implements IStorage {
  private mlsSlugCache: Map<string, string> | null = null;
  private mlsSlugLookup: Map<string, string> | null = null;
  private mlsLegacySlugLookup: Map<string, string> | null = null;
  // Users
  getUserById(id: number) {
    return db.select().from(users).where(eq(users.id, id)).get();
  }
  getUserByEmail(email: string) {
    return db.select().from(users).where(eq(users.email, email)).get();
  }
  createUser(data: { email: string; passwordHash: string; name: string; title?: string; avatar?: string; phone?: string }) {
    return db
      .insert(users)
      .values({
        email: data.email,
        passwordHash: data.passwordHash,
        name: data.name,
        title: data.title ?? null,
        avatar: data.avatar ?? null,
        phone: data.phone ?? null,
      })
      .returning()
      .get();
  }

  // Listings
  listListings() {
    const rows = db
      .select()
      .from(listings)
      .orderBy(desc(listings.createdAt))
      .all();
    return rows.map(toPublicListing);
  }
  getListingById(id: string) {
    const row = db.select().from(listings).where(eq(listings.id, id)).get();
    return row ? toPublicListing(row) : undefined;
  }
  getListingBySlug(slug: string) {
    const row = db.select().from(listings).where(eq(listings.slug, slug)).get();
    return row ? toPublicListing(row) : undefined;
  }
  createListing(data: any, userId: number) {
    const id = data.id ?? `l-${Date.now().toString(36)}`;
    const row = db
      .insert(listings)
      .values({
        id,
        slug: data.slug,
        title: data.title,
        address: data.address,
        neighbourhood: data.neighbourhood,
        city: data.city ?? "Calgary, AB",
        price: data.price,
        beds: data.beds,
        baths: data.baths,
        sqft: data.sqft,
        lotSize: data.lotSize ?? null,
        yearBuilt: data.yearBuilt,
        type: data.type,
        status: data.status ?? "active",
        description: data.description,
        features: JSON.stringify(data.features ?? []),
        heroImage: data.heroImage,
        gallery: JSON.stringify(data.gallery ?? []),
        lat: data.lat,
        lng: data.lng,
        userId,
      })
      .returning()
      .get();
    return toPublicListing(row);
  }
  updateListing(id: string, patch: any) {
    const update: any = { ...patch };
    if (Array.isArray(update.features)) update.features = JSON.stringify(update.features);
    if (Array.isArray(update.gallery)) update.gallery = JSON.stringify(update.gallery);
    delete update.id;
    delete update.createdAt;
    const row = db
      .update(listings)
      .set(update)
      .where(eq(listings.id, id))
      .returning()
      .get();
    return row ? toPublicListing(row) : undefined;
  }
  deleteListing(id: string) {
    const r = db.delete(listings).where(eq(listings.id, id)).run();
    return r.changes > 0;
  }
  incrementViews(id: string) {
    const row = db.select().from(listings).where(eq(listings.id, id)).get();
    if (!row) return;
    db.update(listings)
      .set({ views: (row.views ?? 0) + 1 })
      .where(eq(listings.id, id))
      .run();
  }

  // Leads
  listLeads() {
    return db.select().from(leads).orderBy(desc(leads.createdAt)).all();
  }
  getLead(id: number) {
    return db.select().from(leads).where(eq(leads.id, id)).get();
  }
  createLead(data: InsertLead) {
    return db
      .insert(leads)
      .values({
        listingId: data.listingId ?? null,
        name: data.name,
        email: data.email,
        phone: data.phone ?? null,
        message: data.message,
        source: data.source ?? "Landing page",
        status: data.status ?? "new",
      })
      .returning()
      .get();
  }
  updateLeadStatus(id: number, status: string) {
    return db
      .update(leads)
      .set({ status })
      .where(eq(leads.id, id))
      .returning()
      .get();
  }

  // Messages
  listMessagesByLead(leadId: number) {
    return db
      .select()
      .from(messages)
      .where(eq(messages.leadId, leadId))
      .all();
  }
  createMessage(data: InsertMessage) {
    return db
      .insert(messages)
      .values({
        leadId: data.leadId,
        fromAgent: data.fromAgent ?? false,
        body: data.body,
      })
      .returning()
      .get();
  }

  // ---- MLS listings -------------------------------------------------------
  invalidateMlsSlugCaches(): void {
    this.mlsSlugCache = null;
    this.mlsSlugLookup = null;
    this.mlsLegacySlugLookup = null;
  }
  upsertMlsListing(data: InsertMlsListing): MlsListing {
    const existing = db.select().from(mlsListings).where(eq(mlsListings.id, data.id!)).get();
    if (existing) {
      // Track price + status changes for the market snapshot.
      const now = new Date().toISOString();
      const newPrice = (data.listPrice as number | null) ?? null;
      const newStatus = (data.status as string) ?? existing.status;
      const priceChanged =
        newPrice != null && existing.listPrice != null && newPrice !== existing.listPrice;
      const statusChanged = newStatus !== existing.status;
      if (priceChanged || statusChanged) {
        try {
          db.insert(mlsPriceHistory).values({
            listingId: existing.id,
            oldPrice: existing.listPrice,
            newPrice,
            oldStatus: existing.status,
            newStatus,
            changedAt: now,
          }).run();
        } catch (e) {
          console.warn("[storage] price-history insert failed:", (e as any)?.message);
        }
      }
      const patch: any = {
        ...data,
        syncedAt: now,
      };
      if (priceChanged) {
        patch.previousPrice = existing.listPrice;
        patch.priceChangedAt = now;
      }
      // If a previously-Active listing becomes anything else, mark removed and capture reason.
      if (statusChanged && existing.status === "Active" && newStatus !== "Active") {
        patch.removedAt = now;
        patch.removedReason = newStatus;
      }
      // If a previously-removed listing becomes Active again, clear removal markers.
      if (statusChanged && existing.status !== "Active" && newStatus === "Active") {
        patch.removedAt = null;
        patch.removedReason = null;
      }
      return db
        .update(mlsListings)
        .set(patch)
        .where(eq(mlsListings.id, data.id!))
        .returning()
        .get();
    }
    return db.insert(mlsListings).values(data).returning().get();
  }
  getMlsListingById(id: string): MlsListing | undefined {
    return db.select().from(mlsListings).where(eq(mlsListings.id, id)).get();
  }
  private ensureMlsSlugCaches(): void {
    if (!this.mlsSlugCache) {
      const sources = db.select({
        id: mlsListings.id,
        mlsNumber: mlsListings.mlsNumber,
        fullAddress: mlsListings.fullAddress,
        subdivision: mlsListings.subdivision,
        neighbourhood: mlsListings.neighbourhood,
        city: mlsListings.city,
        status: mlsListings.status,
        syncedAt: mlsListings.syncedAt,
      }).from(mlsListings).all();
      this.mlsSlugCache = assignMlsSeoSlugs(sources);
      this.mlsSlugLookup = new Map(
        Array.from(this.mlsSlugCache.entries()).map(([id, slug]) => [slug, id]),
      );
    }
  }
  getMlsSeoSlug(listing: MlsListing): string {
    this.ensureMlsSlugCaches();
    return this.mlsSlugCache!.get(listing.id)!;
  }
  getMlsListingBySeoSlug(slug: string): MlsListing | undefined {
    this.ensureMlsSlugCaches();
    const id = this.mlsSlugLookup?.get(slug);
    return id ? this.getMlsListingById(id) : undefined;
  }
  getMlsListingByLegacySeoSlug(slug: string): MlsListing | undefined {
    if (!this.mlsLegacySlugLookup) {
      const rows = db.select().from(mlsListings).all();
      const aliases = [assignMlsLegacySeoSlugs(rows), assignMlsPreviousSeoSlugs(rows)];
      this.mlsLegacySlugLookup = new Map();
      for (const byId of aliases) {
        byId.forEach((legacySlug, id) => this.mlsLegacySlugLookup!.set(legacySlug, id));
      }
    }
    const id = this.mlsLegacySlugLookup.get(slug);
    return id ? this.getMlsListingById(id) : undefined;
  }
  countMlsListings(): number {
    const r = db.select({ c: sql<number>`count(*)` }).from(mlsListings).get();
    return Number(r?.c ?? 0);
  }
  countActiveMlsListings(): number {
    const r = db
      .select({ c: sql<number>`count(*)` })
      .from(mlsListings)
      .where(eq(mlsListings.status, "Active"))
      .get();
    return Number(r?.c ?? 0);
  }
  // Returns sorted, deduped, non-empty values for a column on mls_listings.
  // Whitelisted to a fixed set of safe column names — see /api/public/mls/distinct.
  distinctMlsValues(field: "subdivision" | "district" | "city" | "neighbourhood" | "structureType" | "architecturalStyle"): string[] {
    const colMap: Record<string, string> = {
      subdivision: "subdivision",
      district: "district",
      city: "city",
      neighbourhood: "neighbourhood",
      structureType: "structure_type",
      architecturalStyle: "architectural_style",
    };
    const col = colMap[field];
    if (!col) return [];
    const rows = sqlite
      .prepare(
        `SELECT DISTINCT ${col} AS value FROM mls_listings WHERE ${col} IS NOT NULL AND TRIM(${col}) != '' ORDER BY ${col} ASC`,
      )
      .all() as Array<{ value: string }>;
    // Some Pillar 9 fields are comma-separated lists (e.g. "Cul-De-Sac, Treed").
    // Split + dedupe so the dropdown shows individual values, not concatenations.
    const set = new Set<string>();
    for (const r of rows) {
      const v = r.value;
      if (!v) continue;
      // Only split fields known to be multi-value lists. Subdivision, district,
      // city and neighbourhood are atomic so we keep them whole.
      if (field === "structureType" || field === "architecturalStyle") {
        for (const part of v.split(/\s*,\s*/)) {
          const t = part.trim();
          if (t) set.add(t);
        }
      } else {
        set.add(v.trim());
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  searchMlsListings(opts: {
    q?: string;
    minPrice?: number;
    maxPrice?: number;
    beds?: number; // minimum
    baths?: number; // minimum
    propertyType?: string;
    propertySubTypes?: string[];
    cities?: string[];
    neighbourhood?: string;
    postalCode?: string;
    statuses?: string[];
    minSqft?: number;
    maxSqft?: number;
    yearMin?: number;
    yearMax?: number;
    garageMin?: number;
    domMax?: number;
    hasPhotos?: boolean;
    garageYn?: boolean;
    poolYn?: boolean;
    waterfrontYn?: boolean;
    airConditioned?: boolean;
    suiteYn?: boolean;
    legalSuiteYn?: boolean;
    suiteLocations?: string[];
    basements?: string[];
    basementDevelopments?: string[];
    parkingFeatures?: string[];
    lotFeatures?: string[];
    laundryFeatures?: string[];
    appliances?: string[];
    levels?: string[];
    structureTypes?: string[];
    architecturalStyles?: string[];
    accessibilityFeatures?: string[];
    associationAmenities?: string[];
    views?: string[];
    subdivisions?: string[];
    districts?: string[];
    keywords?: string; // comma-separated; ALL must appear in description
    condoFeeMax?: number;
    sort?: "price-asc" | "price-desc" | "newest" | "sqft-desc";
    limit?: number;
    offset?: number;
  }) {
    const where: any[] = [];
    if (opts.minPrice) where.push(gte(mlsListings.listPrice, opts.minPrice));
    if (opts.maxPrice) where.push(lte(mlsListings.listPrice, opts.maxPrice));
    if (opts.beds) where.push(gte(mlsListings.beds, opts.beds));
    if (opts.baths) where.push(gte(mlsListings.baths, opts.baths));
    if (opts.propertyType && opts.propertyType !== "Any") where.push(eq(mlsListings.propertyType, opts.propertyType));
    if (opts.propertySubTypes?.length) {
      where.push(or(...opts.propertySubTypes.map((s) => eq(mlsListings.propertySubType, s)))!);
    }
    if (opts.cities?.length) {
      where.push(or(...opts.cities.map((c) => eq(mlsListings.city, c)))!);
    }
    if (opts.neighbourhood) where.push(eq(mlsListings.neighbourhood, opts.neighbourhood));
    if (opts.postalCode) where.push(like(mlsListings.postalCode, `${opts.postalCode.toUpperCase()}%`));
    if (opts.statuses?.length) {
      where.push(or(...opts.statuses.map((s) => eq(mlsListings.status, s)))!);
    }
    if (opts.minSqft) where.push(gte(mlsListings.sqft, opts.minSqft));
    if (opts.maxSqft) where.push(lte(mlsListings.sqft, opts.maxSqft));
    if (opts.yearMin) where.push(gte(mlsListings.yearBuilt, opts.yearMin));
    if (opts.yearMax) where.push(lte(mlsListings.yearBuilt, opts.yearMax));
    if (opts.garageMin) where.push(gte(mlsListings.garageSpaces, opts.garageMin));
    if (opts.domMax != null) where.push(lte(mlsListings.daysOnMarket, opts.domMax));
    if (opts.hasPhotos) where.push(gte(mlsListings.photoCount, 1));
    if (opts.condoFeeMax != null) where.push(lte(mlsListings.condoFee, opts.condoFeeMax));
    if (opts.garageYn != null) where.push(eq(mlsListings.garageYn, opts.garageYn));
    if (opts.poolYn != null) where.push(eq(mlsListings.poolPrivateYn, opts.poolYn));
    if (opts.waterfrontYn != null) where.push(eq(mlsListings.waterfrontYn, opts.waterfrontYn));
    if (opts.airConditioned != null) {
      // Cooling field is a multi-value string like "Central Air, Wall Unit"
      // — anything containing the word "Air" or "Conditioner" counts.
      if (opts.airConditioned) {
        where.push(
          or(
            like(mlsListings.cooling, "%Air%"),
            like(mlsListings.cooling, "%Cool%"),
            like(mlsListings.cooling, "%Conditioner%"),
          )!,
        );
      }
    }
    if (opts.suiteYn != null) {
      // Pillar 9's `Suite` field varies — sometimes "Yes/No", sometimes a
      // descriptive list ("Walk-Up, Separate Entrance"). Treat any non-"No",
      // non-empty value as "has a suite".
      if (opts.suiteYn) {
        where.push(
          and(
            sql`${mlsListings.suite} IS NOT NULL`,
            sql`${mlsListings.suite} != ''`,
            sql`LOWER(${mlsListings.suite}) NOT LIKE 'no%'`,
            sql`LOWER(${mlsListings.suite}) NOT LIKE 'none%'`,
          )!,
        );
      } else {
        where.push(
          or(
            sql`${mlsListings.suite} IS NULL`,
            eq(mlsListings.suite, ""),
            like(sql`LOWER(${mlsListings.suite})`, "no%"),
            like(sql`LOWER(${mlsListings.suite})`, "none%"),
          )!,
        );
      }
    }
    if (opts.legalSuiteYn != null) where.push(eq(mlsListings.legalSuiteYn, opts.legalSuiteYn));
    // For each multi-value list filter, listing matches if ANY of the
    // selected values appears in its RETS string (substring match).
    const matchesAny = (col: any, vals?: string[]) => {
      if (!vals?.length) return null;
      return or(...vals.map((v) => like(col, `%${v}%`)))!;
    };
    const orFilters = [
      matchesAny(mlsListings.basement, opts.basements),
      matchesAny(mlsListings.basementDevelopment, opts.basementDevelopments),
      matchesAny(mlsListings.parkingFeatures, opts.parkingFeatures),
      matchesAny(mlsListings.lotFeatures, opts.lotFeatures),
      matchesAny(mlsListings.laundryFeatures, opts.laundryFeatures),
      matchesAny(mlsListings.appliances, opts.appliances),
      matchesAny(mlsListings.levels, opts.levels),
      matchesAny(mlsListings.structureType, opts.structureTypes),
      matchesAny(mlsListings.architecturalStyle, opts.architecturalStyles),
      matchesAny(mlsListings.accessibilityFeatures, opts.accessibilityFeatures),
      matchesAny(mlsListings.associationAmenities, opts.associationAmenities),
      matchesAny(mlsListings.view, opts.views),
      matchesAny(mlsListings.subdivision, opts.subdivisions),
      matchesAny(mlsListings.district, opts.districts),
      matchesAny(mlsListings.suiteLocation, opts.suiteLocations),
    ];
    for (const f of orFilters) {
      if (f) where.push(f);
    }
    if (opts.q) {
      const q = `%${opts.q}%`;
      where.push(
        or(
          like(mlsListings.fullAddress, q),
          like(mlsListings.neighbourhood, q),
          like(mlsListings.mlsNumber, q),
          like(mlsListings.description, q),
        )!,
      );
    }
    if (opts.keywords) {
      const terms = opts.keywords
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      for (const term of terms) {
        where.push(like(mlsListings.description, `%${term}%`));
      }
    }
    let qb: any = db.select().from(mlsListings);
    if (where.length) qb = qb.where(and(...where));
    switch (opts.sort) {
      case "price-asc":
        qb = qb.orderBy(asc(mlsListings.listPrice));
        break;
      case "price-desc":
        qb = qb.orderBy(desc(mlsListings.listPrice));
        break;
      case "sqft-desc":
        qb = qb.orderBy(desc(mlsListings.sqft));
        break;
      case "newest":
      default:
        qb = qb.orderBy(desc(mlsListings.listDate), desc(mlsListings.syncedAt));
        break;
    }
    const all = qb.all() as MlsListing[];
    const total = all.length;
    const limit = opts.limit ?? 24;
    const offset = opts.offset ?? 0;
    const items = all.slice(offset, offset + limit).map((row) => ({
      ...row,
      seoSlug: this.getMlsSeoSlug(row),
      gallery: safeParseArray(row.gallery),
      features: safeParseArray(row.features),
    }));
    return { items, total };
  }
  // Featured rail on the home page: Calgary residential $4M+, newest first —
  // excluding the NE quadrant and vacant land. "Newest" = Pillar 9
  // StatusChangeTimestamp (when it entered its current status), falling back
  // to list/created dates for rows synced before the field existed. Falls
  // back to the priciest actives city-wide if fewer than `limit` qualify,
  // so the rail never renders half-empty.
  listFeaturedMls(limit = 6) {
    // Quadrant lives at the end of the street name ("89 Avenue NE"); check
    // fullAddress too for rows where the street didn't parse.
    const notNE = sql`(
      (${mlsListings.streetName} IS NULL OR ${mlsListings.streetName} NOT LIKE '% NE')
      AND ${mlsListings.fullAddress} NOT LIKE '% NE'
      AND ${mlsListings.fullAddress} NOT LIKE '% NE,%'
    )`;
    const notVacantLand = sql`(
      ${mlsListings.propertySubType} IS NULL
      OR lower(${mlsListings.propertySubType}) NOT LIKE '%vacant%'
    )`;
    const rows = db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          eq(mlsListings.propertyType, "Residential"),
          sql`lower(${mlsListings.city}) = 'calgary'`,
          gte(mlsListings.listPrice, 4_000_000),
          notNE,
          notVacantLand,
        )!,
      )
      .orderBy(
        desc(
          sql`COALESCE(${mlsListings.statusChangedAt}, ${mlsListings.listDate}, ${mlsListings.createdAt})`,
        ),
      )
      .limit(limit)
      .all();
    if (rows.length < limit) {
      const have = new Set(rows.map((r) => r.id));
      const backfill = db
        .select()
        .from(mlsListings)
        .where(
          and(
            eq(mlsListings.status, "Active"),
            eq(mlsListings.propertyType, "Residential"),
            notNE,
            notVacantLand,
          )!,
        )
        .orderBy(desc(mlsListings.listPrice))
        .limit(limit * 2)
        .all()
        .filter((r) => !have.has(r.id))
        .slice(0, limit - rows.length);
      rows.push(...backfill);
    }
    return rows.map((row) => ({
      ...row,
      seoSlug: this.getMlsSeoSlug(row),
      gallery: safeParseArray(row.gallery),
      features: safeParseArray(row.features),
    }));
  }
  listMlsByNeighbourhood(slug: string, limit = 12) {
    // We match neighbourhood by name (slug is the URL-friendly form)
    const rows = db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          eq(mlsListings.neighbourhood, slug),
        )!,
      )
      .orderBy(desc(mlsListings.listPrice))
      .all()
      .slice(0, limit);
    return rows.map((row) => ({
      ...row,
      gallery: safeParseArray(row.gallery),
      features: safeParseArray(row.features),
    }));
  }
  // Active MLS listings within `radiusMeters` of a neighbourhood's centerLat
  // /Lng. Falls back to the name-based match if GPS yields nothing.
  listMlsNearPoint(
    lat: number,
    lng: number,
    radiusMeters = 1500,
    limit = 24,
  ): MlsListing[] {
    // 1 deg lat ~ 111,000m. 1 deg lng at 51N ~ 70,000m.
    const dLat = radiusMeters / 111_000;
    const dLng = radiusMeters / 70_000;
    const candidates = db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          gte(mlsListings.lat, lat - dLat),
          lte(mlsListings.lat, lat + dLat),
          gte(mlsListings.lng, lng - dLng),
          lte(mlsListings.lng, lng + dLng),
        )!,
      )
      .all();
    const haversine = (
      a: { lat: number; lng: number },
      b: { lat: number; lng: number },
    ) => {
      const R = 6371000;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dlat = toRad(b.lat - a.lat);
      const dlng = toRad(b.lng - a.lng);
      const sa =
        Math.sin(dlat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dlng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(sa));
    };
    return candidates
      .filter((l) => l.lat != null && l.lng != null)
      .filter(
        (l) =>
          haversine({ lat, lng }, { lat: l.lat as number, lng: l.lng as number }) <=
          radiusMeters,
      )
      .sort((a, b) => b.listPrice - a.listPrice)
      .slice(0, limit);
  }
  listSimilarMls(listing: MlsListing, limit = 4) {
    const rows = db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          eq(mlsListings.neighbourhood, listing.neighbourhood ?? ""),
        )!,
      )
      .all()
      .filter((r) => r.id !== listing.id)
      .slice(0, limit);
    return rows.map((row) => ({
      ...row,
      gallery: safeParseArray(row.gallery),
      features: safeParseArray(row.features),
    }));
  }
  /** Mark every active mls_listings row whose id is NOT in keep[] as Removed.
   *  Returns the number of rows updated. Used by the sync loop to expire stale
   *  listings that no longer appear in the active feed. */
  markMlsListingsRemovedExcept(keep: string[]): number {
    if (keep.length === 0) {
      const r = db
        .update(mlsListings)
        .set({ status: "Removed" })
        .where(eq(mlsListings.status, "Active"))
        .run();
      return Number((r as any)?.changes ?? 0);
    }
    // SQLite has a parameter limit (~999). Chunk if needed.
    const CHUNK = 500;
    let total = 0;
    // Build an exclusion list per chunk and update with a NOT IN.
    for (let i = 0; i < keep.length; i += CHUNK) {
      const slice = keep.slice(i, i + CHUNK);
      // For chunked NOT IN we need rows whose id is NOT in any chunk.
      // Easier approach: load all active ids, compute set difference in JS,
      // then update affected rows individually. The total is small (~few thousand).
      // But we only need to do it once per sync, not per chunk — break out below.
      void slice;
    }
    const activeRows = db
      .select({ id: mlsListings.id, status: mlsListings.status })
      .from(mlsListings)
      .where(eq(mlsListings.status, "Active"))
      .all() as { id: string; status: string }[];
    const keepSet = new Set(keep);
    const toRemove = activeRows.filter((r) => !keepSet.has(r.id));
    const now = new Date().toISOString();
    for (const r of toRemove) {
      // Reason "Unknown" because the Pillar 9 feed dropped the listing without
      // telling us why. The cron-side reconciliation can refine to Sold/Expired
      // by querying the Sold/Expired class once per run (future enhancement).
      db.update(mlsListings)
        .set({
          status: "Removed",
          removedAt: now,
          removedReason: "Unknown",
        })
        .where(eq(mlsListings.id, r.id))
        .run();
      try {
        db.insert(mlsPriceHistory).values({
          listingId: r.id,
          oldStatus: r.status,
          newStatus: "Removed",
          changedAt: now,
        }).run();
      } catch {}
      total++;
    }
    return total;
  }

  // ---- MLS sync runs ------------------------------------------------------
  startSyncRun(opts: { source: string }): MlsSyncRun {
    return db
      .insert(mlsSyncRuns)
      .values({
        startedAt: new Date().toISOString(),
        status: "running",
        source: opts.source,
      })
      .returning()
      .get();
  }
  finishSyncRun(
    id: number,
    patch: { status: string; fetched?: number; upserted?: number; removed?: number; errorMessage?: string },
  ) {
    return db
      .update(mlsSyncRuns)
      .set({
        finishedAt: new Date().toISOString(),
        status: patch.status,
        fetched: patch.fetched ?? 0,
        upserted: patch.upserted ?? 0,
        removed: patch.removed ?? 0,
        errorMessage: patch.errorMessage ?? null,
      })
      .where(eq(mlsSyncRuns.id, id))
      .returning()
      .get();
  }
  getLatestSyncRun(): MlsSyncRun | undefined {
    return db.select().from(mlsSyncRuns).orderBy(desc(mlsSyncRuns.startedAt)).all()[0];
  }
  listRecentSyncRuns(limit = 10): MlsSyncRun[] {
    return db.select().from(mlsSyncRuns).orderBy(desc(mlsSyncRuns.startedAt)).all().slice(0, limit);
  }
  // ---- Blog posts ---------------------------------------------------------
  listBlogPosts(): BlogPost[] {
    return db.select().from(blogPosts).orderBy(desc(blogPosts.publishedAt)).all();
  }
  getBlogBySlug(slug: string): BlogPost | undefined {
    return db.select().from(blogPosts).where(eq(blogPosts.slug, slug)).get();
  }
  upsertBlogPost(data: InsertBlogPost): BlogPost {
    const existing = db.select().from(blogPosts).where(eq(blogPosts.slug, data.slug!)).get();
    if (existing) {
      return db.update(blogPosts).set(data).where(eq(blogPosts.slug, data.slug!)).returning().get();
    }
    return db.insert(blogPosts).values(data).returning().get();
  }
  // ---- Neighbourhoods ----------------------------------------------------
  listNeighbourhoods(): Neighbourhood[] {
    return db.select().from(neighbourhoods).orderBy(asc(neighbourhoods.sortOrder)).all();
  }
  getNeighbourhoodBySlug(slug: string): Neighbourhood | undefined {
    return db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, slug)).get();
  }
  upsertNeighbourhood(data: InsertNeighbourhood): Neighbourhood {
    const existing = db.select().from(neighbourhoods).where(eq(neighbourhoods.slug, data.slug!)).get();
    if (existing) {
      return db.update(neighbourhoods).set(data).where(eq(neighbourhoods.slug, data.slug!)).returning().get();
    }
    return db.insert(neighbourhoods).values(data).returning().get();
  }
  // The canonical active-listing match for a neighbourhood, in priority order:
  //   1. exact `subdivision` name  (e.g. "Pump Hill")
  //   2. legacy `neighbourhood` field
  //   3. eponymous street prefix    (e.g. "Varsity Estates Drive NW")
  //   4. tight GPS proximity to the stored center (last resort)
  // Both the public detail route and the POI route call this so they agree on
  // exactly which listings define the neighbourhood.
  listMlsForNeighbourhood(
    n: Neighbourhood,
    limit = 5000,
    // Optional OSM boundary. Used to keep the two guess-based cascade steps
    // honest — authoritative steps (subdivision, street prefix) are trusted
    // even when the polygon is coarse.
    polygon?: Parameters<typeof pointInGeometry>[2] | null,
  ): MlsListing[] {
    const insidePolygon = (m: MlsListing) =>
      !polygon ||
      (typeof m.lat === "number" &&
        typeof m.lng === "number" &&
        pointInGeometry(m.lng, m.lat, polygon));
    // Page names are display labels; CREB subdivision values are the
    // authoritative community signal — but the two drift apart in spelling:
    // "Bayside (Airdrie)" vs "Bayside", "Coopers Crossing" vs "Cooper's
    // Crossing", "Hounsfield Heights / Briar Hill" vs "Hounsfield
    // Heights/Briar Hill", "St. Andrews" vs "St Andrews". Compare through a
    // normalization key (lowercase, & → and, strip all non-alphanumerics)
    // and strip a trailing "(Qualifier)" from the display name.
    const normKey = (s: string) =>
      s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
    const baseName = n.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    const keys = new Set([normKey(n.name), normKey(baseName)]);
    // Curated CREB labels that belong to a page but can't be derived by
    // normalization alone.
    const SUBDIVISION_ALIASES: Record<string, string[]> = {
      "bridgeland-riverside": ["Bridgeland/Riverside"],
      "heritage-pointe": ["Heritage Point"],
    };
    for (const a of SUBDIVISION_ALIASES[n.slug] ?? []) keys.add(normKey(a));
    // A row whose subdivision names a DIFFERENT community must never appear
    // via the guess-based steps (stale legacy tags, GPS proximity), no
    // matter how close it sits. (Britannia was showing Windsor Park homes;
    // Spring Creek was showing South Canmore.)
    const subdivisionAgrees = (m: any) =>
      !m.subdivision || keys.has(normKey(m.subdivision));

    // 1. Authoritative: rows whose CREB subdivision normalizes to this page.
    let matches: MlsListing[] = [];
    const matchingSubs = this.distinctMlsValues("subdivision").filter((s) =>
      keys.has(normKey(s)),
    );
    for (const s of matchingSubs) {
      matches = matches.concat(this.listMlsBySubdivision(s, limit));
    }
    if (matches.length === 0) {
      // 2. The legacy `neighbourhood` column predates subdivision tagging and
      // holds stale values on many rows. Trust it only when the row's
      // subdivision doesn't contradict it, and — when we have a boundary —
      // when the home is actually inside the community.
      matches = (this.listMlsByNeighbourhood(n.name, limit) as any[]).filter(
        (m) => subdivisionAgrees(m) && insidePolygon(m),
      ) as any;
    }
    if (matches.length === 0) {
      // 3. Eponymous streets — use the base name so "Spring Creek (Canmore)"
      // still matches homes on "Spring Creek Drive".
      matches = this.listMlsByStreetPrefix(baseName, limit);
    }
    if (matches.length === 0 && /^chestermere\b/i.test(baseName)) {
      // 3b. Chestermere (Lakefront) — CREB's SubdivisionName can't isolate
      // true lakefront: odd civics on East Chestermere Drive, even on West
      // Chestermere Drive, every 4th number 97-257 on Cove Road.
      matches = this.listMlsActiveByCity("Chestermere", limit).filter((l) => {
        const m = (l.fullAddress || "").match(/(\d+)\s+([^,]+)/);
        if (!m) return false;
        const num = parseInt(m[1], 10);
        const street = m[2].toLowerCase();
        const onDr = /chestermere\s+dr(ive)?\b/.test(street);
        if (onDr && /\beast\b/.test(street) && num % 2 === 1) return true;
        if (onDr && /\bwest\b/.test(street) && num % 2 === 0) return true;
        return (
          /\bcove\s+r(oa)?d\b/.test(street) &&
          num >= 97 && num <= 257 && (num - 97) % 4 === 0
        );
      });
    }
    if (matches.length === 0) {
      // 4. Last-resort GPS proximity is a pure location guess — in small
      // communities it happily pulls in the neighbours (Roxboro showed
      // Mission condos). An empty result is more honest than the wrong
      // community's homes.
      matches = this.listMlsNearPoint(n.centerLat, n.centerLng, 800, limit).filter(
        (m) => m.status === "Active" && subdivisionAgrees(m) && insidePolygon(m),
      );
    }
    return matches;
  }

  // The center to draw the map pin / POIs around. Manually-entered
  // center_lat/center_lng have drifted badly for some neighbourhoods (Varsity
  // Estates was 4 km off, Pump Hill 2.5 km), so when we have geocoded listings
  // we trust their centroid instead — it's literally where the homes are.
  // Falls back to the stored center when nothing is geocoded.
  neighbourhoodDisplayCenter(
    n: Neighbourhood,
    matches?: MlsListing[],
  ): { lat: number; lng: number } {
    const listings = matches ?? this.listMlsForNeighbourhood(n);
    const geo = listings.filter((l) => l.lat != null && l.lng != null);
    if (geo.length > 0) {
      return {
        lat: geo.reduce((s, l) => s + (l.lat as number), 0) / geo.length,
        lng: geo.reduce((s, l) => s + (l.lng as number), 0) / geo.length,
      };
    }
    return { lat: n.centerLat, lng: n.centerLng };
  }

  // Active listings whose `subdivision` field matches the neighbourhood name
  // (case-insensitive). This is the precise match — GPS proximity was too
  // broad for tightly-defined Calgary subdivisions like Springbank Hill.
  // Active listings in a city — used by address-level community rules
  // (e.g. Chestermere Lakefront) that filter a whole town's inventory.
  listMlsActiveByCity(city: string, limit = 2000): MlsListing[] {
    if (!city) return [];
    return db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          sql`lower(${mlsListings.city}) = ${city.toLowerCase()}`,
        )!,
      )
      .orderBy(desc(mlsListings.listPrice))
      .limit(limit)
      .all();
  }

  listMlsBySubdivision(subdivisionName: string, limit = 100): MlsListing[] {
    if (!subdivisionName) return [];
    const target = subdivisionName.trim().toLowerCase();
    // SQLite LIKE is case-insensitive by default for ASCII. Use exact match
    // via lower(subdivision) to be safe across SQLite builds.
    const rows = db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          sql`lower(${mlsListings.subdivision}) = ${target}`,
        )!,
      )
      .orderBy(desc(mlsListings.listPrice))
      .limit(limit)
      .all();
    return rows;
  }

  // Active listings whose street name is named after the neighbourhood —
  // e.g. "Varsity Estates" matches "Varsity Estates Drive NW", "Varsity
  // Estates Court NW", etc. Calgary sub-areas like Varsity Estates aren't a
  // distinct MLS `subdivision` (they roll up under "Varsity"), so a name/GPS
  // match finds nothing; the eponymous streets are the reliable signal for
  // the physical enclave. Requires the name to be followed by a space so we
  // match whole street prefixes, not partial words.
  listMlsByStreetPrefix(name: string, limit = 100): MlsListing[] {
    if (!name) return [];
    const target = name.trim().toLowerCase();
    if (!target) return [];
    const pattern = `${target} %`;
    const rows = db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          sql`lower(${mlsListings.streetName}) LIKE ${pattern}`,
        )!,
      )
      .orderBy(desc(mlsListings.listPrice))
      .limit(limit)
      .all();
    return rows;
  }

  // Active listings at a specific building, matched by street_number +
  // normalized street_name. Normalization expands common abbreviations
  // (Ave→Avenue, St→Street, etc.) and lowercases everything so the same
  // building matches whether broker A wrote "26 Ave SW" and broker B wrote
  // "26 Avenue SW".
  listMlsAtBuilding(streetNumber: string, streetName: string, limit = 60): MlsListing[] {
    if (!streetNumber || !streetName) return [];
    const num = String(streetNumber).trim();
    if (!num) return [];
    const targetNorm = normalizeStreetName(streetName);
    if (!targetNorm) return [];

    // Pre-filter by street_number in SQL, then normalize+compare in JS so we
    // don't have to maintain a SQL-side normalizer. The pre-filter keeps the
    // candidate set tiny.
    const candidates = db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          eq(mlsListings.streetNumber, num),
        )!,
      )
      .orderBy(desc(mlsListings.listPrice))
      .all();
    return candidates
      .filter((c) => normalizeStreetName(c.streetName) === targetNorm)
      .slice(0, limit);
  }

  refreshNeighbourhoodActiveCounts() {
    // Match by `subdivision` field. Pillar 9 populates this consistently
    // (e.g., "Springbank Hill", "Aspen Woods", "Bel-Aire") so name-equality
    // gives the precise neighbourhood boundary. GPS proximity was too broad
    // for Calgary's tightly defined subdivisions.
    const all = db.select().from(neighbourhoods).all();
    for (const n of all) {
      const active = this.listMlsBySubdivision(n.name, 5000);
      const count = active.length;
      const avgPrice =
        count > 0
          ? Math.round(active.reduce((s, l) => s + (l.listPrice || 0), 0) / count)
          : 0;
      const update: any = { activeCount: count };
      if (avgPrice > 0) update.avgPrice = avgPrice;
      db.update(neighbourhoods).set(update).where(eq(neighbourhoods.slug, n.slug)).run();
    }
  }
  // ---- Condo Buildings ---------------------------------------------------
  // ---------- SEO keyword targets (admin SEO console) ----------
  listSeoKeywordTargets(): Array<{ path: string; focusKeyword: string; note: string | null; updatedAt: string }> {
    const rows = sqlite
      .prepare("SELECT path, focus_keyword, note, updated_at FROM seo_keyword_targets")
      .all() as Array<{ path: string; focus_keyword: string; note: string | null; updated_at: string }>;
    return rows.map((r) => ({
      path: r.path, focusKeyword: r.focus_keyword, note: r.note, updatedAt: r.updated_at,
    }));
  }
  setSeoKeywordTarget(path: string, focusKeyword: string, note?: string | null): void {
    const kw = focusKeyword.trim();
    if (!kw) { this.clearSeoKeywordTarget(path); return; }
    sqlite
      .prepare(
        `INSERT INTO seo_keyword_targets (path, focus_keyword, note, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           focus_keyword = excluded.focus_keyword,
           note = excluded.note,
           updated_at = excluded.updated_at`,
      )
      .run(path, kw, note ?? null, new Date().toISOString());
  }
  clearSeoKeywordTarget(path: string): void {
    sqlite.prepare("DELETE FROM seo_keyword_targets WHERE path = ?").run(path);
  }

  listCondoBuildings(): CondoBuilding[] {
    return db.select().from(condoBuildings).orderBy(asc(condoBuildings.sortOrder)).all();
  }
  getCondoBuildingBySlug(slug: string): CondoBuilding | undefined {
    return db.select().from(condoBuildings).where(eq(condoBuildings.slug, slug)).get();
  }
  upsertCondoBuilding(data: InsertCondoBuilding): CondoBuilding {
    const existing = db.select().from(condoBuildings).where(eq(condoBuildings.slug, data.slug!)).get();
    if (existing) {
      return db.update(condoBuildings).set(data).where(eq(condoBuildings.slug, data.slug!)).returning().get();
    }
    return db.insert(condoBuildings).values(data).returning().get();
  }
  // Used by the seed: only insert if a condo with this slug doesn't already
  // exist. Once Spencer has edited a condo via the /admin/condos UI, the seed
  // must NEVER overwrite his changes — so additive seed updates only land for
  // brand-new condo slugs.
  insertCondoBuildingIfMissing(data: InsertCondoBuilding): CondoBuilding | null {
    const existing = db.select().from(condoBuildings).where(eq(condoBuildings.slug, data.slug!)).get();
    if (existing) return null;
    return db.insert(condoBuildings).values(data).returning().get();
  }
  // Update arbitrary fields on a condo (admin UI). Slug is the row key and
  // is excluded from updates — renaming a slug breaks public URLs.
  updateCondoBuilding(slug: string, data: Partial<InsertCondoBuilding>): CondoBuilding | undefined {
    const { slug: _slug, ...rest } = data as any;
    db.update(condoBuildings).set(rest).where(eq(condoBuildings.slug, slug)).run();
    return this.getCondoBuildingBySlug(slug);
  }
  deleteCondoBuilding(slug: string): boolean {
    const res = db.delete(condoBuildings).where(eq(condoBuildings.slug, slug)).run();
    return (res.changes ?? 0) > 0;
  }
  // Active MLS listings at a specific street address — used by condo detail
  // pages to show units currently for sale in the building.
  listingsAtAddress(addressMatch: string, limit = 24): MlsListing[] {
    return db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          like(mlsListings.fullAddress, `%${addressMatch}%`),
        )!,
      )
      .orderBy(desc(mlsListings.listPrice))
      .limit(limit)
      .all();
  }
  // Active MLS listings within `radiusMeters` of a building's coordinates.
  // More robust than address-string matching because Pillar 9 stores unit-
  // prefixed addresses ("#1808 1188 3 Street SE") and abbreviated forms
  // ("1188 3 St SE") that don't share clean substrings with our seed addresses.
  // Coordinates always match — every MLS listing in a tower will sit within
  // ~30m of the same point on the map.
  listingsAtBuilding(
    lat: number,
    lng: number,
    radiusMeters = 75,
    limit = 30,
  ): MlsListing[] {
    // Tight bounding box pre-filter so we don't pull every active listing.
    // 1 deg lat ~ 111,000m. 1 deg lng at 51N ~ 70,000m.
    const dLat = radiusMeters / 111_000;
    const dLng = radiusMeters / 70_000;
    const candidates = db
      .select()
      .from(mlsListings)
      .where(
        and(
          eq(mlsListings.status, "Active"),
          gte(mlsListings.lat, lat - dLat),
          lte(mlsListings.lat, lat + dLat),
          gte(mlsListings.lng, lng - dLng),
          lte(mlsListings.lng, lng + dLng),
        )!,
      )
      .all();
    // Refine with full haversine within the bbox to enforce circular radius.
    const haversine = (
      a: { lat: number; lng: number },
      b: { lat: number; lng: number },
    ) => {
      const R = 6371000;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dlat = toRad(b.lat - a.lat);
      const dlng = toRad(b.lng - a.lng);
      const sa =
        Math.sin(dlat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dlng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(sa));
    };
    return candidates
      .filter((l) => l.lat != null && l.lng != null)
      .filter(
        (l) =>
          haversine({ lat, lng }, { lat: l.lat as number, lng: l.lng as number }) <=
          radiusMeters,
      )
      .sort((a, b) => b.listPrice - a.listPrice)
      .slice(0, limit);
  }
  // ---- User integrations (OAuth tokens) --------------------------------
  getUserIntegration(userId: number, provider: string): UserIntegration | undefined {
    return db
      .select()
      .from(userIntegrations)
      .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, provider))!)
      .get();
  }
  upsertUserIntegration(data: InsertUserIntegration): UserIntegration {
    const existing = db
      .select()
      .from(userIntegrations)
      .where(
        and(eq(userIntegrations.userId, data.userId!), eq(userIntegrations.provider, data.provider!))!,
      )
      .get();
    const now = new Date().toISOString();
    const row: any = {
      ...data,
      metadata: typeof (data as any).metadata === "string"
        ? (data as any).metadata
        : JSON.stringify((data as any).metadata ?? {}),
      updatedAt: now,
    };
    if (existing) {
      return db.update(userIntegrations).set(row).where(eq(userIntegrations.id, existing.id)).returning().get();
    }
    return db.insert(userIntegrations).values({ ...row, createdAt: now }).returning().get();
  }
  deleteUserIntegration(userId: number, provider: string): boolean {
    const r = db
      .delete(userIntegrations)
      .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, provider))!)
      .run();
    return (r.changes ?? 0) > 0;
  }
  updateTourGoogleEventId(tourId: number, googleEventId: string | null) {
    db.update(tours).set({ googleEventId } as any).where(eq(tours.id, tourId)).run();
  }
  // ---- Lead Alerts -------------------------------------------------------
  listLeadAlerts(leadId: number): LeadAlert[] {
    return db
      .select()
      .from(leadAlerts)
      .where(eq(leadAlerts.leadId, leadId))
      .orderBy(desc(leadAlerts.createdAt))
      .all();
  }
  getLeadAlert(id: number): LeadAlert | undefined {
    return db.select().from(leadAlerts).where(eq(leadAlerts.id, id)).get();
  }
  createLeadAlert(data: InsertLeadAlert): LeadAlert {
    return db.insert(leadAlerts).values(data).returning().get();
  }
  updateLeadAlert(id: number, patch: Partial<LeadAlert>): LeadAlert | undefined {
    const updated = db.update(leadAlerts).set(patch).where(eq(leadAlerts.id, id)).returning().get();
    return updated;
  }
  deleteLeadAlert(id: number): boolean {
    const r = db.delete(leadAlerts).where(eq(leadAlerts.id, id)).run();
    return (r.changes ?? 0) > 0;
  }
  // Returns alerts that are "due" — active, instant=false, and last_sent_at
  // is older than the frequency cadence (or null).
  dueLeadAlerts(now = new Date()): LeadAlert[] {
    const all = db.select().from(leadAlerts).where(eq(leadAlerts.active, true)).all();
    const cutoffMs: Record<string, number> = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
    };
    return all.filter((a) => {
      if (a.instant) return false; // instant alerts fire on listing-event hooks
      const lim = cutoffMs[a.frequency];
      if (!lim) return false;
      if (!a.lastSentAt) return true;
      return now.getTime() - new Date(a.lastSentAt).getTime() >= lim;
    });
  }
  // Unified: returns saved_searches rows that are due to fire — emailAlerts=on,
  // active=on, and lastSentAt is older than the frequency cadence (or null).
  // Personal searches (leadId null) are included so the cron can also email
  // Spencer.
  dueSavedSearches(now = new Date()): SavedSearch[] {
    const all = db.select().from(savedSearches).all();
    const cutoffMs: Record<string, number> = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
    };
    return all.filter((s: any) => {
      if (!s.emailAlerts) return false;
      if (s.active === false) return false;
      if (s.instant) return false;
      const freq = s.frequency || "daily";
      const lim = cutoffMs[freq];
      if (!lim) return false;
      if (!s.lastSentAt) return true;
      return now.getTime() - new Date(s.lastSentAt).getTime() >= lim;
    });
  }
  listSavedSearchesByLead(leadId: number): SavedSearch[] {
    return db
      .select()
      .from(savedSearches)
      .where(eq(savedSearches.leadId, leadId))
      .orderBy(desc(savedSearches.createdAt))
      .all();
  }
  // ---- MLS price + status change history --------------------------------
  recordMlsPriceChange(data: InsertMlsPriceHistory): void {
    db.insert(mlsPriceHistory).values(data).run();
  }
  // ---- Market snapshot ---------------------------------------------------
  // Returns counts of: new listings, sold, terminated/expired/withdrawn, and
  // price reductions matching `filters` over the last `daysBack` days.
  marketSnapshot(opts: {
    filters?: any;
    daysBack?: number;
  }): {
    newListings: number;
    sold: number;
    terminated: number;
    priceReductions: number;
    averageListPrice: number;
    averageSoldPrice: number;
    samples: {
      newListings: any[];
      priceReductions: any[];
    };
  } {
    const daysBack = opts.daysBack ?? 30;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

    // Pull a candidate set using the same filter semantics as searchMlsListings
    // BUT without the status=Active default — we want to also include sold
    // and removed listings within the window.
    const f = opts.filters ?? {};
    // Build WHERE for the candidate set (no status restriction).
    // IMPORTANT: saved-search UI emits "any" for unset numeric filters and ""
    // for unset text filters. Treat both as no-op so the snapshot doesn't
    // accidentally filter out everything via gte(col, NaN).
    const numFilter = (v: any): number | null => {
      if (v == null || v === "" || v === "any") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const strFilter = (v: any): string | null => {
      if (typeof v !== "string") return null;
      const s = v.trim();
      if (!s || s === "any") return null;
      return s;
    };
    const csvFilter = (v: any): string[] => {
      const s = strFilter(v);
      if (!s) return [];
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    };

    const where: any[] = [];
    const minPrice = numFilter(f.minPrice);
    if (minPrice != null) where.push(gte(mlsListings.listPrice, minPrice));
    const maxPrice = numFilter(f.maxPrice);
    if (maxPrice != null) where.push(lte(mlsListings.listPrice, maxPrice));
    const beds = numFilter(f.beds);
    if (beds != null) where.push(gte(mlsListings.beds, beds));
    const baths = numFilter(f.baths);
    if (baths != null) where.push(gte(mlsListings.baths, baths));
    const propertyType = strFilter(f.propertyType);
    if (propertyType) where.push(eq(mlsListings.propertyType, propertyType));
    const neighbourhood = strFilter(f.neighbourhood);
    if (neighbourhood) where.push(eq(mlsListings.neighbourhood, neighbourhood));
    const minSqft = numFilter(f.minSqft);
    if (minSqft != null) where.push(gte(mlsListings.sqft, minSqft));
    const maxSqft = numFilter(f.maxSqft);
    if (maxSqft != null) where.push(lte(mlsListings.sqft, maxSqft));
    // Multi-select CSV filters (saved-search UI stores these as comma strings).
    const cities = csvFilter(f.cities);
    if (cities.length) where.push(inArray(mlsListings.city, cities));
    const subTypes = csvFilter(f.propertySubTypes);
    if (subTypes.length) where.push(inArray(mlsListings.propertySubType, subTypes));
    const subdivisions = csvFilter(f.subdivisions);
    if (subdivisions.length) where.push(inArray(mlsListings.subdivision, subdivisions));
    const districts = csvFilter(f.districts);
    if (districts.length) where.push(inArray(mlsListings.district, districts));

    const candidates = where.length
      ? db.select().from(mlsListings).where(and(...where)!).all()
      : db.select().from(mlsListings).all();

    const candidateIds = new Set(candidates.map((c) => c.id));

    // 1) new listings — synced after cutoff and currently Active
    const newListings = candidates.filter(
      (l) => l.status === "Active" && l.syncedAt > cutoff,
    );

    // 2) sold — current status Sold OR removedReason=Sold within window
    const sold = candidates.filter(
      (l) =>
        (l.status === "Sold" || l.removedReason === "Sold") &&
        ((l.removedAt && l.removedAt > cutoff) || (l.syncedAt > cutoff && l.status === "Sold")),
    );

    // 3) terminated/expired/withdrawn within window (non-Sold removals)
    const terminated = candidates.filter(
      (l) =>
        l.removedAt &&
        l.removedAt > cutoff &&
        l.removedReason &&
        l.removedReason !== "Sold",
    );

    // 4) price reductions — listings with priceChangedAt in window AND new price
    //    less than previous price. Plus history-table check for older changes
    //    that may have reverted.
    const priceReductionRows = db
      .select()
      .from(mlsPriceHistory)
      .where(gte(mlsPriceHistory.changedAt, cutoff))
      .all();
    const reductionByListing = new Map<string, MlsPriceHistory>();
    for (const h of priceReductionRows) {
      if (!candidateIds.has(h.listingId)) continue;
      if (h.oldPrice == null || h.newPrice == null) continue;
      if (h.newPrice >= h.oldPrice) continue;
      // Keep most recent reduction per listing
      const ex = reductionByListing.get(h.listingId);
      if (!ex || ex.changedAt < h.changedAt) reductionByListing.set(h.listingId, h);
    }
    const priceReductions = Array.from(reductionByListing.values());

    // Aggregate stats
    const activePrices = candidates
      .filter((l) => l.status === "Active")
      .map((l) => l.listPrice);
    const soldPrices = sold.map((l) => l.soldPrice ?? l.listPrice);

    const avg = (arr: number[]) =>
      arr.length === 0 ? 0 : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);

    return {
      newListings: newListings.length,
      sold: sold.length,
      terminated: terminated.length,
      priceReductions: priceReductions.length,
      averageListPrice: avg(activePrices),
      averageSoldPrice: avg(soldPrices),
      samples: {
        newListings: newListings.slice(0, 6).map((l) => ({
          id: l.id,
          fullAddress: l.fullAddress,
          listPrice: l.listPrice,
          neighbourhood: l.neighbourhood,
          syncedAt: l.syncedAt,
          beds: l.beds,
          baths: l.baths,
          sqft: l.sqft,
          heroImage: l.heroImage,
        })),
        priceReductions: priceReductions.slice(0, 6).map((h) => {
          const listing = candidates.find((c) => c.id === h.listingId);
          return {
            id: h.listingId,
            oldPrice: h.oldPrice,
            newPrice: h.newPrice,
            changedAt: h.changedAt,
            fullAddress: listing?.fullAddress,
            neighbourhood: listing?.neighbourhood,
            heroImage: listing?.heroImage,
          };
        }),
      },
    };
  }
  // ---- Testimonials -------------------------------------------------------
  listTestimonials(): Testimonial[] {
    return db.select().from(testimonials).orderBy(asc(testimonials.sortOrder)).all();
  }
  upsertTestimonial(data: InsertTestimonial): Testimonial {
    if (data.id) {
      const existing = db.select().from(testimonials).where(eq(testimonials.id, data.id)).get();
      if (existing) {
        return db.update(testimonials).set(data).where(eq(testimonials.id, data.id)).returning().get();
      }
    }
    return db.insert(testimonials).values(data).returning().get();
  }

  // Tours
  listTours() {
    return db.select().from(tours).orderBy(desc(tours.scheduledFor)).all();
  }
  createTour(data: InsertTour) {
    return db
      .insert(tours)
      .values({
        listingId: data.listingId,
        leadId: data.leadId ?? null,
        scheduledFor: data.scheduledFor,
        status: data.status ?? "requested",
        notes: data.notes ?? null,
      })
      .returning()
      .get();
  }
  updateTourStatus(id: number, status: string) {
    return db
      .update(tours)
      .set({ status })
      .where(eq(tours.id, id))
      .returning()
      .get();
  }

  // ---- POIs cache ---------------------------------------------------------
  getPoisCacheById(id: string): PoiCacheRow | undefined {
    return db.select().from(poisCache).where(eq(poisCache.id, id)).get();
  }
  upsertPoisCache(row: { id: string; lat: number; lng: number; radius: number; payload: string }) {
    const existing = db.select().from(poisCache).where(eq(poisCache.id, row.id)).get();
    if (existing) {
      return db
        .update(poisCache)
        .set({ payload: row.payload, fetchedAt: new Date().toISOString() })
        .where(eq(poisCache.id, row.id))
        .returning()
        .get();
    }
    return db.insert(poisCache).values(row).returning().get();
  }

  // ---- Saved searches -----------------------------------------------------
  listSavedSearches(userId: number): SavedSearch[] {
    return db
      .select()
      .from(savedSearches)
      .where(eq(savedSearches.userId, userId))
      .orderBy(desc(savedSearches.createdAt))
      .all();
  }
  getSavedSearchById(id: number): SavedSearch | undefined {
    return db
      .select()
      .from(savedSearches)
      .where(eq(savedSearches.id, id))
      .get();
  }
  createSavedSearch(data: any): SavedSearch {
    const row: any = {
      userId: data.userId,
      leadId: data.leadId ?? null,
      emailRecipient: data.emailRecipient ?? null,
      name: data.name,
      filters: typeof data.filters === "string" ? data.filters : JSON.stringify(data.filters ?? {}),
      emailAlerts: data.emailAlerts ?? true,
      alertType: data.alertType ?? "listings",
      frequency: data.frequency ?? "daily",
      instant: data.instant === true || data.frequency === "instant",
      active: data.active !== false,
    };
    return db.insert(savedSearches).values(row).returning().get();
  }
  updateSavedSearch(id: number, patch: any): SavedSearch | undefined {
    const update: any = { ...patch };
    if (update.filters && typeof update.filters !== "string") {
      update.filters = JSON.stringify(update.filters);
    }
    if (update.frequency === "instant") update.instant = true;
    if (update.frequency && update.frequency !== "instant") update.instant = false;
    return db
      .update(savedSearches)
      .set(update)
      .where(eq(savedSearches.id, id))
      .returning()
      .get();
  }
  deleteSavedSearch(id: number): boolean {
    const r = db.delete(savedSearches).where(eq(savedSearches.id, id)).run();
    return (r.changes ?? 0) > 0;
  }

  // ---- Social posts -------------------------------------------------------
  listSocialPosts(userId: number): SocialPost[] {
    return db
      .select()
      .from(socialPosts)
      .where(eq(socialPosts.userId, userId))
      .orderBy(desc(socialPosts.createdAt))
      .all();
  }
  getSocialPost(id: number): SocialPost | undefined {
    return db.select().from(socialPosts).where(eq(socialPosts.id, id)).get();
  }
  createSocialPost(data: InsertSocialPost & { userId: number; linkUrl?: string | null; variants?: any }): SocialPost {
    return db
      .insert(socialPosts)
      .values({
        userId: data.userId,
        listingId: data.listingId ?? null,
        caption: data.caption,
        imageUrl: data.imageUrl ?? null,
        linkUrl: (data as any).linkUrl ?? null,
        channels: typeof (data as any).channels === "string" ? (data as any).channels : JSON.stringify(data.channels ?? []),
        variants: typeof (data as any).variants === "string" ? (data as any).variants : JSON.stringify((data as any).variants ?? {}),
        scheduledFor: data.scheduledFor ?? null,
        status: data.status ?? "draft",
      } as any)
      .returning()
      .get();
  }
  updateSocialPost(id: number, patch: Partial<{ status: string; postedAt: string | null; caption: string; imageUrl: string | null; linkUrl: string | null; channels: any; variants: any; scheduledFor: string | null; listingId: string | null }>): SocialPost | undefined {
    const update: any = { ...patch };
    if (update.channels && typeof update.channels !== "string") {
      update.channels = JSON.stringify(update.channels);
    }
    if (update.variants && typeof update.variants !== "string") {
      update.variants = JSON.stringify(update.variants);
    }
    return db
      .update(socialPosts)
      .set(update)
      .where(eq(socialPosts.id, id))
      .returning()
      .get();
  }
  deleteSocialPost(id: number): boolean {
    const r = db.delete(socialPosts).where(eq(socialPosts.id, id)).run();
    return (r.changes ?? 0) > 0;
  }

  // ---- CMS pages ----------------------------------------------------------
  // Rows are written by /admin/home; readers (public API, SEO injection) must
  // tolerate a missing row and fall back to the factory defaults in
  // shared/home-content.ts, so a fresh database still renders the homepage.
  getPage(slug: string): PageRow | undefined {
    return db.select().from(pages).where(eq(pages.slug, slug)).get();
  }
  listPages(): PageRow[] {
    return db.select().from(pages).orderBy(asc(pages.slug)).all();
  }
  upsertPage(data: InsertPageRow): PageRow {
    const row = { ...data, updatedAt: data.updatedAt ?? new Date().toISOString() };
    const existing = db.select().from(pages).where(eq(pages.slug, data.slug)).get();
    if (existing) {
      return db.update(pages).set(row).where(eq(pages.slug, data.slug)).returning().get();
    }
    return db.insert(pages).values(row).returning().get();
  }
  deletePage(slug: string): boolean {
    const r = db.delete(pages).where(eq(pages.slug, slug)).run();
    return (r.changes ?? 0) > 0;
  }

  // ---- CMS page revisions -------------------------------------------------
  listPageRevisions(slug: string, limit = 30): PageRevision[] {
    return db
      .select()
      .from(pageRevisions)
      .where(eq(pageRevisions.pageSlug, slug))
      .orderBy(desc(pageRevisions.id))
      .limit(limit)
      .all();
  }
  getPageRevision(id: number): PageRevision | undefined {
    return db.select().from(pageRevisions).where(eq(pageRevisions.id, id)).get();
  }
  createPageRevision(row: {
    pageSlug: string;
    snapshot: string;
    label?: string | null;
    createdBy?: string | null;
  }): PageRevision {
    const created = db
      .insert(pageRevisions)
      .values({
        pageSlug: row.pageSlug,
        snapshot: row.snapshot,
        label: row.label ?? null,
        createdBy: row.createdBy ?? null,
      })
      .returning()
      .get();
    this.prunePageRevisions(row.pageSlug);
    return created;
  }
  /** Keep only the newest `keep` snapshots per page so the table stays small. */
  prunePageRevisions(slug: string, keep = 30): void {
    const ids = db
      .select({ id: pageRevisions.id })
      .from(pageRevisions)
      .where(eq(pageRevisions.pageSlug, slug))
      .orderBy(desc(pageRevisions.id))
      .all()
      .map((r) => r.id);
    const stale = ids.slice(keep);
    if (stale.length === 0) return;
    db.delete(pageRevisions).where(inArray(pageRevisions.id, stale)).run();
  }

  // ---- Scheduling: event types -------------------------------------------
  listBookingEventTypes(): BookingEventType[] {
    return db
      .select()
      .from(bookingEventTypes)
      .orderBy(asc(bookingEventTypes.sortOrder), asc(bookingEventTypes.id))
      .all();
  }
  getBookingEventType(id: number): BookingEventType | undefined {
    return db.select().from(bookingEventTypes).where(eq(bookingEventTypes.id, id)).get();
  }
  getBookingEventTypeBySlug(slug: string): BookingEventType | undefined {
    return db.select().from(bookingEventTypes).where(eq(bookingEventTypes.slug, slug)).get();
  }
  createBookingEventType(data: Partial<InsertBookingEventType>): BookingEventType {
    const now = new Date().toISOString();
    return db
      .insert(bookingEventTypes)
      .values({ ...(data as any), createdAt: now, updatedAt: now })
      .returning()
      .get();
  }
  updateBookingEventType(
    id: number,
    patch: Partial<InsertBookingEventType>,
  ): BookingEventType | undefined {
    return db
      .update(bookingEventTypes)
      .set({ ...(patch as any), updatedAt: new Date().toISOString() })
      .where(eq(bookingEventTypes.id, id))
      .returning()
      .get();
  }
  deleteBookingEventType(id: number): boolean {
    // Availability rows scoped to this type go with it; bookings are kept so
    // the history (and the invitee's manage link) survives.
    db.delete(bookingAvailability).where(eq(bookingAvailability.eventTypeId, id)).run();
    const r = db.delete(bookingEventTypes).where(eq(bookingEventTypes.id, id)).run();
    return (r.changes ?? 0) > 0;
  }

  // ---- Scheduling: weekly availability -----------------------------------
  // `eventTypeId === null` addresses the default schedule every event type
  // falls back to when it has no rows of its own.
  listBookingAvailability(eventTypeId: number | null): BookingAvailability[] {
    return db
      .select()
      .from(bookingAvailability)
      .where(
        eventTypeId === null
          ? sql`${bookingAvailability.eventTypeId} IS NULL`
          : eq(bookingAvailability.eventTypeId, eventTypeId),
      )
      .orderBy(asc(bookingAvailability.dayOfWeek), asc(bookingAvailability.startMinute))
      .all();
  }
  replaceBookingAvailability(
    eventTypeId: number | null,
    windows: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>,
  ): BookingAvailability[] {
    const now = new Date().toISOString();
    db.delete(bookingAvailability)
      .where(
        eventTypeId === null
          ? sql`${bookingAvailability.eventTypeId} IS NULL`
          : eq(bookingAvailability.eventTypeId, eventTypeId),
      )
      .run();
    for (const w of windows) {
      db.insert(bookingAvailability)
        .values({
          eventTypeId,
          dayOfWeek: w.dayOfWeek,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
          createdAt: now,
        })
        .run();
    }
    return this.listBookingAvailability(eventTypeId);
  }

  // ---- Scheduling: one-off date overrides --------------------------------
  listBookingDateOverrides(fromDate?: string): BookingDateOverride[] {
    const q = db.select().from(bookingDateOverrides);
    const rows = fromDate
      ? q.where(gte(bookingDateOverrides.date, fromDate)).all()
      : q.all();
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }
  upsertBookingDateOverride(
    data: Omit<InsertBookingDateOverride, "createdAt">,
  ): BookingDateOverride {
    const existing = db
      .select()
      .from(bookingDateOverrides)
      .where(eq(bookingDateOverrides.date, data.date))
      .get();
    if (existing) {
      return db
        .update(bookingDateOverrides)
        .set(data as any)
        .where(eq(bookingDateOverrides.id, existing.id))
        .returning()
        .get();
    }
    return db
      .insert(bookingDateOverrides)
      .values({ ...(data as any), createdAt: new Date().toISOString() })
      .returning()
      .get();
  }
  deleteBookingDateOverride(id: number): boolean {
    const r = db.delete(bookingDateOverrides).where(eq(bookingDateOverrides.id, id)).run();
    return (r.changes ?? 0) > 0;
  }

  // ---- Scheduling: bookings ----------------------------------------------
  listBookings(opts: { from?: string; to?: string; status?: string; eventTypeId?: number } = {}): Booking[] {
    const clauses: any[] = [];
    if (opts.from) clauses.push(gte(bookings.startsAt, opts.from));
    if (opts.to) clauses.push(lte(bookings.startsAt, opts.to));
    if (opts.status) clauses.push(eq(bookings.status, opts.status));
    if (opts.eventTypeId) clauses.push(eq(bookings.eventTypeId, opts.eventTypeId));
    const base = db.select().from(bookings);
    const rows = clauses.length > 0 ? base.where(and(...clauses)!).all() : base.all();
    return rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }
  getBooking(id: number): Booking | undefined {
    return db.select().from(bookings).where(eq(bookings.id, id)).get();
  }
  getBookingByUid(uid: string): Booking | undefined {
    return db.select().from(bookings).where(eq(bookings.uid, uid)).get();
  }
  createBooking(data: Omit<InsertBooking, "createdAt" | "updatedAt">): Booking {
    const now = new Date().toISOString();
    return db
      .insert(bookings)
      .values({ ...(data as any), createdAt: now, updatedAt: now })
      .returning()
      .get();
  }
  updateBooking(id: number, patch: Partial<InsertBooking>): Booking | undefined {
    return db
      .update(bookings)
      .set({ ...(patch as any), updatedAt: new Date().toISOString() })
      .where(eq(bookings.id, id))
      .returning()
      .get();
  }
  /**
   * Confirmed bookings overlapping [fromIso, toIso). Used both to paint the
   * booking page's busy times and to re-check for a double-book at the moment
   * of writing. `excludeId` lets a reschedule ignore its own row.
   */
  listBookingsInRange(fromIso: string, toIso: string, excludeId?: number): Booking[] {
    return db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.status, "confirmed"),
          lte(bookings.startsAt, toIso),
          gte(bookings.endsAt, fromIso),
        )!,
      )
      .all()
      .filter((b) => (excludeId ? b.id !== excludeId : true));
  }
  countBookingsBetween(fromIso: string, toIso: string, eventTypeId?: number): number {
    return this.listBookingsInRange(fromIso, toIso).filter((b) =>
      eventTypeId ? b.eventTypeId === eventTypeId : true,
    ).length;
  }
}

export const storage = new DatabaseStorage();
export { stripUser };
