// API-side types for the public MLS / marketing endpoints.

export interface PublicMlsListing {
  id: string;
  mlsNumber: string;
  seoSlug: string;
  status: string;
  listPrice: number;
  soldPrice: number | null;
  fullAddress: string;
  neighbourhood: string | null;
  subdivision: string | null;
  city: string;
  province: string;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  propertyType: string;
  propertySubType: string | null;
  beds: number;
  bedsAbove: number | null;
  bedsBelow: number | null;
  baths: number;
  halfBaths: number | null;
  sqft: number | null;
  sqftBelow: number | null;
  lotSize: string | null;
  yearBuilt: number | null;
  parking: string | null;
  garageSpaces: number | null;
  listDate: string | null;
  daysOnMarket: number | null;
  description: string | null;
  features: string[];
  listAgentName: string | null;
  listAgentPhone: string | null;
  listOffice: string | null;
  heroImage: string | null;
  gallery: string[];
  photoCount: number;
  source: string;
  syncedAt: string;
  createdAt: string;
}

export interface PublicMlsListingDetail extends PublicMlsListing {
  similar: PublicMlsListing[];
}

export interface PublicNeighbourhood {
  slug: string;
  name: string;
  tagline: string;
  story: string; // JSON-stringified array
  outsideCopy: string;
  amenitiesCopy: string;
  shopDineCopy: string;
  heroImage: string;
  gallery: string; // JSON-stringified
  centerLat: number;
  centerLng: number;
  avgPrice: number;
  activeCount: number;
  sortOrder: number;
}

export interface PublicNeighbourhoodDetail extends PublicNeighbourhood {
  listings: PublicMlsListing[];
  /** Condo & townhome buildings in the community. Entries with a slug have
   *  a dedicated /condos/:slug page; the rest render as plain names. */
  condoBuildings?: Array<{ name: string; address?: string; slug?: string }>;
  /** OSM boundary polygon (GeoJSON geometry), when OSM has a match. */
  polygon?:
    | { type: "Polygon"; coordinates: number[][][] }
    | { type: "MultiPolygon"; coordinates: number[][][][] }
    | null;
  /** CC-photo attribution for the hero, when the hero is a licensed photo. */
  heroCredit?: {
    author: string;
    authorUrl?: string;
    license: string;
    licenseUrl: string;
    sourceUrl: string;
  } | null;
}

export interface PublicBlogPost {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  category: string;
  heroImage: string;
  heroImageAlt: string | null;
  /** Attached video (YouTube/Vimeo/.mp4 URL), shown in the hero slot. */
  videoUrl?: string | null;
  authorName: string;
  authorAvatar: string | null;
  readMinutes: number;
  publishedAt: string;
}

export interface PublicTestimonial {
  id: number;
  authorName: string;
  authorRole: string;
  rating: number;
  body: string;
  sortOrder: number;
}

export interface PublicStats {
  activeListings: number;
  totalListings: number;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
}

export interface MlsSearchResult {
  items: PublicMlsListing[];
  total: number;
}

// Helper for parsing JSON-encoded array fields on neighbourhoods.
// Accepts either a JSON string (legacy) or an already-parsed array (current
// API response shape) — pass-through if it's already an array.
export function parseJsonArray(s: any): any[] {
  if (Array.isArray(s)) return s;
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
