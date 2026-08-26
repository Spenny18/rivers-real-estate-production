import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  Search,
  SlidersHorizontal,
  X,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Map as MapIcon,
  List as ListIcon,
  Bookmark,
  BookmarkCheck,
} from "lucide-react";
import { useAccount, useCreateSavedSearch } from "@/lib/account";
import { toast as showToast } from "@/hooks/use-toast";
import { PublicLayout } from "@/components/public-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { apiRequest } from "@/lib/queryClient";
import { formatPriceCompact, formatSqft } from "@/lib/format";
import type {
  MlsSearchResult,
  PublicMlsListing,
  PublicNeighbourhood,
} from "@/lib/mls-types";
import { Link } from "wouter";
import { mlsPropertyPath } from "@shared/mls-url";
import {
  RIVERS_TILE_ATTRIBUTION,
  RIVERS_TILE_SUBDOMAINS,
  RIVERS_TILE_URL,
} from "@/components/rivers-map";

const PAGE_SIZE = 50;

const PROPERTY_TYPES = [
  { value: "any", label: "All types" },
  { value: "Detached", label: "Detached" },
  { value: "Semi-Detached", label: "Semi-Detached" },
  { value: "Townhouse", label: "Townhouse" },
  { value: "Apartment", label: "Apartment / Condo" },
  { value: "Estate", label: "Estate" },
];

const STATUS_OPTIONS = [
  { value: "Active", label: "Active" },
  { value: "Pending", label: "Pending" },
  { value: "Sold", label: "Sold" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "price-asc", label: "Price · low to high" },
  { value: "price-desc", label: "Price · high to low" },
  { value: "sqft-desc", label: "Largest first" },
];

// Multi-select filter values are stored as comma-separated strings inside the
// Filters object (e.g. "Detached,Semi-Detached"). This keeps URL serialization
// trivial while letting checkbox UIs work via toggleCsv() helper below.
interface Filters {
  q: string;
  minPrice: string;
  maxPrice: string;
  beds: string;
  baths: string;
  propertyType: string;
  propertySubTypes: string; // multi (csv)
  cities: string; // multi (csv)
  postalCode: string;
  minSqft: string;
  maxSqft: string;
  yearMin: string;
  yearMax: string;
  garageMin: string;
  domMax: string;
  hasPhotos: string; // "" or "true"
  // Boolean toggles
  garageYn: string; // "", "true", "false"
  poolYn: string;
  waterfrontYn: string;
  airConditioned: string;
  suiteYn: string;
  legalSuiteYn: string;
  suiteLocations: string; // multi (csv)
  // Multi-value (csv) structured filters
  basements: string;
  basementDevelopments: string;
  parkingFeatures: string;
  lotFeatures: string;
  laundryFeatures: string;
  appliances: string;
  levels: string;
  structureTypes: string;
  architecturalStyles: string;
  accessibilityFeatures: string;
  associationAmenities: string;
  views: string;
  subdivisions: string; // free-text csv (substring match)
  districts: string; // free-text csv
  neighbourhood: string; // exact match on mls_listings.neighbourhood (deep links from neighbourhood pages)
  condoFeeMax: string;
  keywords: string;
  statuses: string; // multi (csv)
  sort: string;
}

const DEFAULT_FILTERS: Filters = {
  q: "",
  minPrice: "",
  maxPrice: "",
  beds: "any",
  baths: "any",
  propertyType: "any",
  propertySubTypes: "",
  // The marketing site is explicitly Calgary-only, so default the city
  // filter to Calgary (a ?neighbourhood= deep link clears it — see initialFilters).
  cities: "Calgary",
  postalCode: "",
  minSqft: "",
  maxSqft: "",
  yearMin: "",
  yearMax: "",
  garageMin: "any",
  domMax: "any",
  hasPhotos: "",
  garageYn: "",
  poolYn: "",
  waterfrontYn: "",
  airConditioned: "",
  suiteYn: "",
  legalSuiteYn: "",
  suiteLocations: "",
  basements: "",
  basementDevelopments: "",
  parkingFeatures: "",
  lotFeatures: "",
  laundryFeatures: "",
  appliances: "",
  levels: "",
  structureTypes: "",
  architecturalStyles: "",
  accessibilityFeatures: "",
  associationAmenities: "",
  views: "",
  subdivisions: "",
  districts: "",
  neighbourhood: "",
  condoFeeMax: "",
  keywords: "",
  statuses: "Active",
  sort: "newest",
};

// Lookup tables for multi-checkbox sections — values must match what the
// Pillar 9 RETS feed stores in each field (substring match on the column).
const STATUS_OPTS = ["Active", "Pending", "Sold"];
const SUBTYPE_OPTS = [
  "Detached",
  "Semi Detached (Half Duplex)",
  "Row/Townhouse",
  "Apartment",
  "Full Duplex",
  "Recreational",
];
const CITY_OPTS = [
  "Calgary",
  "Airdrie",
  "Cochrane",
  "Okotoks",
  "Chestermere",
  "Strathmore",
  "Rocky View County",
  "Foothills County",
  "High River",
  "Canmore",
  "Banff",
  "Bragg Creek",
  "Diamond Valley",
  "Crossfield",
  "Carstairs",
  "Olds",
  "Didsbury",
  "Sundre",
];
const BASEMENT_OPTS = [
  "Walkout",
  "Finished",
  "Full",
  "Partial",
  "Unfinished",
  "Separate Entrance",
  "Suite",
  "None",
];
const BASEMENT_DEV_OPTS = [
  "Finished",
  "Partially Finished",
  "Unfinished",
];
const PARKING_OPTS = [
  "Attached Garage",
  "Detached Garage",
  "Heated Garage",
  "Triple Garage",
  "Double Garage",
  "Single Garage",
  "Underground",
  "RV Access/Parking",
  "Carport",
  "Driveway",
  "Front Drive",
  "Rear Drive",
  "Off Street",
  "On Street",
  "220 Volt Wiring",
];
const LOT_FEATURE_OPTS = [
  "Backs on to Park/Green Space",
  "Cul-De-Sac",
  "Corner Lot",
  "Pie Shaped Lot",
  "Treed",
  "Private",
  "Landscaped",
  "Lawn",
  "Fruit Trees/Shrub(s)",
  "Garden",
  "Many Trees",
  "Creek/River/Stream",
  "Lake",
  "Mountain View",
  "View",
];
const LAUNDRY_OPTS = [
  "Main Level",
  "Upper Level",
  "Lower Level",
  "In Basement",
  "In Unit",
  "Laundry Room",
  "Sink",
  "Gas Dryer Hookup",
];
const APPLIANCE_OPTS = [
  "Dishwasher",
  "Refrigerator",
  "Stove",
  "Microwave",
  "Range Hood",
  "Washer",
  "Dryer",
  "Built-In Oven",
  "Bar Fridge",
  "Wine Refrigerator",
  "Garburator",
];
const LEVELS_OPTS = [
  "One",
  "One and One Half",
  "Two",
  "2 and Half Storey",
  "Three Or More",
  "Bi-Level",
  "Multi/Split",
];
const STRUCTURE_OPTS = [
  "House",
  "Cabin",
  "Duplex",
  "Five Plus",
  "Other",
  "Townhouse",
  "Manufactured House",
];
const ARCH_STYLE_OPTS = [
  "Bungalow",
  "2 Storey",
  "1 and Half Storey",
  "3 Storey",
  "Acreage with Residence",
  "Bi-Level",
  "Mid-Century Modern",
  "Mountain Modern",
  "Tri-Level Split",
];
const ACCESSIBILITY_OPTS = [
  "Accessible Approach with Ramp",
  "Accessible Bedroom",
  "Accessible Cabinetry/Closets",
  "Accessible Central Living Area",
  "Accessible Closets",
  "Accessible Doors",
  "Accessible Electrical and Environmental Controls",
  "Accessible Entrance",
  "Accessible Hallway(s)",
  "Accessible Kitchen",
  "Accessible Washer/Dryer",
];
const ASSOCIATION_AMENITY_OPTS = [
  "Beach Access",
  "Bicycle Storage",
  "Boating",
  "Cable TV",
  "Car Wash",
  "Clubhouse",
  "Concierge",
  "Elevator(s)",
  "Fitness Center",
  "Indoor Pool",
  "Outdoor Pool",
  "Park",
  "Parking",
  "Party Room",
  "Playground",
  "Recreation Facilities",
  "Recreation Room",
  "Sauna",
  "Secured Parking",
  "Storage",
  "Visitor Parking",
];
const VIEW_OPTS = [
  "Mountain(s)",
  "City",
  "Downtown",
  "Lake",
  "Park/Greenbelt",
  "Pasture",
  "Pond",
  "Ravine",
  "River",
  "Trees/Woods",
  "Valley",
  "Water",
];

const DOM_OPTIONS = [
  { value: "any", label: "Any time on market" },
  { value: "3", label: "≤ 3 days (just listed)" },
  { value: "7", label: "≤ 7 days" },
  { value: "14", label: "≤ 14 days" },
  { value: "30", label: "≤ 30 days" },
  { value: "60", label: "≤ 60 days" },
  { value: "90", label: "≤ 90 days" },
];

// CSV helpers for multi-select fields stored as comma-separated strings.
function csvHas(csv: string, value: string): boolean {
  return csv.split(",").map((s) => s.trim()).includes(value);
}
function csvToggle(csv: string, value: string): string {
  const set = new Set(csv.split(",").map((s) => s.trim()).filter(Boolean));
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return Array.from(set).join(",");
}

function parseQuery(qs: string): Partial<Filters> {
  const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
  const out: Partial<Filters> = {};
  const map: (keyof Filters)[] = [
    "q", "minPrice", "maxPrice", "beds", "baths",
    "propertyType", "propertySubTypes", "cities", "postalCode",
    "minSqft", "maxSqft", "yearMin", "yearMax", "garageMin", "domMax",
    "hasPhotos", "garageYn", "poolYn", "waterfrontYn", "airConditioned",
    "suiteYn", "legalSuiteYn", "suiteLocations",
    "basements", "basementDevelopments", "parkingFeatures", "lotFeatures",
    "laundryFeatures", "appliances", "levels", "structureTypes",
    "architecturalStyles", "accessibilityFeatures", "associationAmenities",
    "views", "subdivisions", "districts", "neighbourhood", "condoFeeMax", "keywords", "statuses", "sort",
  ];
  for (const k of map) {
    const v = params.get(k);
    if (v) (out as any)[k] = v;
  }
  return out;
}

// Format price as a compact pill: $1.3M, $750K, $4.2M
function priceShort(price: number): string {
  if (price >= 1_000_000) {
    const m = price / 1_000_000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (price >= 1000) return `$${Math.round(price / 1000)}K`;
  return `$${price}`;
}

// Build a price pill divIcon for a single listing marker
function buildPriceIcon(price: number, selected = false) {
  const label = priceShort(price);
  const bg = selected ? "#23412d" : "#ffffff";
  const fg = selected ? "#ffffff" : "#0a0a0a";
  return L.divIcon({
    className: "rivers-price-pill",
    html: `<div style="
      display:inline-flex;align-items:center;justify-content:center;
      padding:5px 11px;border-radius:9999px;
      background:${bg};color:${fg};
      font-family:Manrope,system-ui,sans-serif;font-weight:700;font-size:13px;
      letter-spacing:-0.01em;line-height:1;
      box-shadow:0 2px 8px rgba(0,0,0,0.18),0 0 0 1px rgba(0,0,0,0.06);
      white-space:nowrap;border:${selected ? "1.5px solid #fff" : "1px solid rgba(0,0,0,0.04)"};
      transform:translateY(-2px);
    ">${label}</div>`,
    iconSize: [60, 26],
    iconAnchor: [30, 13],
  });
}

// Build a cluster pill divIcon (house icon + count)
function buildClusterIcon(count: number) {
  return L.divIcon({
    className: "rivers-cluster-pill",
    html: `<div style="
      display:inline-flex;align-items:center;gap:5px;
      padding:6px 11px 6px 9px;border-radius:9999px;
      background:#ffffff;color:#0a0a0a;
      font-family:Manrope,system-ui,sans-serif;font-weight:700;font-size:13px;
      line-height:1;
      box-shadow:0 2px 10px rgba(0,0,0,0.20),0 0 0 1px rgba(0,0,0,0.06);
      white-space:nowrap;
    ">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
        <path d="M3 12 L12 4 L21 12"></path>
        <path d="M5 10 L5 20 L19 20 L19 10"></path>
      </svg>
      ${count.toLocaleString()}
    </div>`,
    iconSize: [70, 28],
    iconAnchor: [35, 14],
  });
}

// Cluster listings into a sparse grid by zoom level so we don't render thousands of markers.
function clusterListings(
  listings: PublicMlsListing[],
  zoom: number,
): Array<
  | { kind: "single"; listing: PublicMlsListing; lat: number; lng: number }
  | { kind: "cluster"; count: number; lat: number; lng: number; listings: PublicMlsListing[] }
> {
  // At higher zooms we let everything render as singles; at lower zooms group nearby points.
  const withCoords = listings.filter(
    (l) => typeof l.lat === "number" && typeof l.lng === "number",
  );
  if (zoom >= 14) {
    return withCoords.map((l) => ({
      kind: "single" as const,
      listing: l,
      lat: l.lat as number,
      lng: l.lng as number,
    }));
  }
  // Grid size tuned for Calgary at typical zooms
  const grid = zoom >= 12 ? 0.0035 : zoom >= 11 ? 0.008 : zoom >= 10 ? 0.018 : zoom >= 9 ? 0.04 : 0.09;
  const buckets = new Map<string, PublicMlsListing[]>();
  for (const l of withCoords) {
    const gx = Math.round((l.lng as number) / grid);
    const gy = Math.round((l.lat as number) / grid);
    const k = `${gx}:${gy}`;
    let arr = buckets.get(k);
    if (!arr) {
      arr = [];
      buckets.set(k, arr);
    }
    arr.push(l);
  }
  const out: any[] = [];
  buckets.forEach((arr) => {
    if (arr.length === 1) {
      const l = arr[0];
      out.push({ kind: "single", listing: l, lat: l.lat, lng: l.lng });
    } else {
      let lat = 0, lng = 0;
      for (const l of arr) {
        lat += l.lat as number;
        lng += l.lng as number;
      }
      out.push({
        kind: "cluster" as const,
        count: arr.length,
        lat: lat / arr.length,
        lng: lng / arr.length,
        listings: arr,
      });
    }
  });
  return out;
}

// Component that tracks zoom level so we can re-cluster
function ZoomTracker({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = () => onZoom(map.getZoom());
    map.on("zoomend", handler);
    onZoom(map.getZoom());
    return () => {
      map.off("zoomend", handler);
    };
  }, [map, onZoom]);
  return null;
}

function FitBoundsOnce({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current) return;
    if (points.length === 0) return;
    // Default-state heuristic: when the unfiltered result set is huge
    // (thousands of listings spread across Calgary metro + outlying towns),
    // auto-fitting zooms out to a non-useful "all of Southern Alberta" view.
    // Keep the MapContainer's preset Calgary center / zoom 11 in that case.
    // A filtered subset (< 200 markers) is small enough that fitting to it
    // is helpful — e.g., filtering to one neighbourhood pans the map there.
    if (points.length > 200) {
      fittedRef.current = true;
      return;
    }
    if (points.length === 1) {
      map.setView(points[0], 13);
      fittedRef.current = true;
      return;
    }
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });
    fittedRef.current = true;
  }, [map, points]);
  return null;
}

export default function MlsSearchPage() {
  const [location, setLocation] = useLocation();
  const initialFilters = useMemo<Filters>(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const qs = search.startsWith("?") ? search.slice(1) : search;
    const parsed = parseQuery(qs);
    // A neighbourhood deep link (from a neighbourhood page's "SEE ALL")
    // targets a specific community — drop the Calgary city default so
    // out-of-Calgary communities (Chestermere, Canmore, Airdrie) still show,
    // unless the URL explicitly set a city.
    if (parsed.neighbourhood && parsed.cities === undefined) {
      return { ...DEFAULT_FILTERS, ...parsed, cities: "" };
    }
    return { ...DEFAULT_FILTERS, ...parsed };
  }, []);

  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [page, setPage] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // "Save this search" — portal users can persist the current filter set as
  // a recurring email-alert subscription. Signed-out clicks bounce to login.
  const { data: portalMe } = useAccount();
  const createSearch = useCreateSavedSearch();
  const [savedFlash, setSavedFlash] = useState(false);
  function deriveSearchName(f: Filters): string {
    const parts: string[] = [];
    if (f.q) parts.push(`"${f.q}"`);
    if (f.neighbourhood) parts.push(String(f.neighbourhood));
    if (f.type && f.type !== "any") parts.push(String(f.type));
    if (f.beds && f.beds !== "any") parts.push(`${f.beds}+ bd`);
    if (f.minPrice || f.maxPrice) {
      const lo = f.minPrice ? `$${Math.round(Number(f.minPrice) / 1000)}K` : "";
      const hi = f.maxPrice ? `$${Math.round(Number(f.maxPrice) / 1000)}K` : "";
      parts.push([lo, hi].filter(Boolean).join("–"));
    }
    return parts.length ? parts.join(" · ") : `Calgary MLS · ${new Date().toLocaleDateString("en-CA")}`;
  }
  function handleSaveSearch() {
    if (!portalMe) {
      window.location.href = "/account/login";
      return;
    }
    createSearch.mutate(
      {
        name: deriveSearchName(filters),
        filters: filters as unknown as Record<string, unknown>,
        frequency: "daily",
        emailAlerts: true,
      },
      {
        onSuccess: () => {
          setSavedFlash(true);
          showToast({
            title: "Search saved",
            description: "You'll get daily email alerts when new matches hit the market.",
          });
          setTimeout(() => setSavedFlash(false), 4000);
        },
        onError: () =>
          showToast({
            title: "Couldn't save",
            description: "Please try again in a moment.",
            variant: "destructive",
          }),
      },
    );
  }
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [popupListing, setPopupListing] = useState<PublicMlsListing | null>(null);
  const [zoom, setZoom] = useState(11);
  // mobile view toggle ("map" or "list")
  const [mobileView, setMobileView] = useState<"list" | "map">("list");

  useEffect(() => {
    setPage(0);
  }, [JSON.stringify(filters)]);

  useEffect(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (!v) return;
      if (v === "any") return;
      if (k === "statuses" && v === "Active") return;
      if (k === "sort" && v === "newest") return;
      params.set(k, v);
    });
    const qs = params.toString();
    const target = qs ? `/mls?${qs}` : `/mls`;
    if (location !== target) setLocation(target);
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.q) p.set("q", filters.q);
    if (filters.minPrice) p.set("minPrice", filters.minPrice);
    if (filters.maxPrice) p.set("maxPrice", filters.maxPrice);
    if (filters.beds && filters.beds !== "any") p.set("beds", filters.beds);
    if (filters.baths && filters.baths !== "any") p.set("baths", filters.baths);
    if (filters.propertyType && filters.propertyType !== "any")
      p.set("propertyType", filters.propertyType);
    if (filters.propertySubTypes) p.set("propertySubTypes", filters.propertySubTypes);
    if (filters.cities) p.set("cities", filters.cities);
    if (filters.neighbourhood) p.set("neighbourhood", filters.neighbourhood);
    if (filters.postalCode) p.set("postalCode", filters.postalCode);
    if (filters.minSqft) p.set("minSqft", filters.minSqft);
    if (filters.maxSqft) p.set("maxSqft", filters.maxSqft);
    if (filters.yearMin) p.set("yearMin", filters.yearMin);
    if (filters.yearMax) p.set("yearMax", filters.yearMax);
    if (filters.garageMin && filters.garageMin !== "any")
      p.set("garageMin", filters.garageMin);
    if (filters.domMax && filters.domMax !== "any") p.set("domMax", filters.domMax);
    if (filters.hasPhotos === "true") p.set("hasPhotos", "true");
    if (filters.garageYn) p.set("garageYn", filters.garageYn);
    if (filters.poolYn) p.set("poolYn", filters.poolYn);
    if (filters.waterfrontYn) p.set("waterfrontYn", filters.waterfrontYn);
    if (filters.airConditioned) p.set("airConditioned", filters.airConditioned);
    if (filters.suiteYn) p.set("suiteYn", filters.suiteYn);
    if (filters.legalSuiteYn) p.set("legalSuiteYn", filters.legalSuiteYn);
    if (filters.suiteLocations) p.set("suiteLocations", filters.suiteLocations);
    if (filters.basements) p.set("basements", filters.basements);
    if (filters.basementDevelopments) p.set("basementDevelopments", filters.basementDevelopments);
    if (filters.parkingFeatures) p.set("parkingFeatures", filters.parkingFeatures);
    if (filters.lotFeatures) p.set("lotFeatures", filters.lotFeatures);
    if (filters.laundryFeatures) p.set("laundryFeatures", filters.laundryFeatures);
    if (filters.appliances) p.set("appliances", filters.appliances);
    if (filters.levels) p.set("levels", filters.levels);
    if (filters.structureTypes) p.set("structureTypes", filters.structureTypes);
    if (filters.architecturalStyles) p.set("architecturalStyles", filters.architecturalStyles);
    if (filters.accessibilityFeatures) p.set("accessibilityFeatures", filters.accessibilityFeatures);
    if (filters.associationAmenities) p.set("associationAmenities", filters.associationAmenities);
    if (filters.views) p.set("views", filters.views);
    if (filters.subdivisions) p.set("subdivisions", filters.subdivisions);
    if (filters.districts) p.set("districts", filters.districts);
    if (filters.condoFeeMax) p.set("condoFeeMax", filters.condoFeeMax);
    if (filters.keywords) p.set("keywords", filters.keywords);
    if (filters.statuses) p.set("statuses", filters.statuses);
    if (filters.sort) p.set("sort", filters.sort);
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(page * PAGE_SIZE));
    return p.toString();
  }, [filters, page]);

  const { data, isLoading } = useQuery<MlsSearchResult>({
    queryKey: ["/api/public/mls/search", queryString],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/public/mls/search?${queryString}`);
      return r.json();
    },
  });

  const { data: neighbourhoods } = useQuery<PublicNeighbourhood[]>({
    queryKey: ["/api/public/neighbourhoods"],
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const updateFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [k]: v }));
  };
  const resetFilters = () => setFilters(DEFAULT_FILTERS);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.q) n++;
    if (filters.minPrice) n++;
    if (filters.maxPrice) n++;
    if (filters.beds !== "any") n++;
    if (filters.baths !== "any") n++;
    if (filters.propertyType !== "any") n++;
    if (filters.propertySubTypes) n++;
    if (filters.cities) n++;
    if (filters.postalCode) n++;
    if (filters.minSqft) n++;
    if (filters.maxSqft) n++;
    if (filters.yearMin) n++;
    if (filters.yearMax) n++;
    if (filters.garageMin !== "any") n++;
    if (filters.domMax !== "any") n++;
    if (filters.hasPhotos === "true") n++;
    if (filters.garageYn) n++;
    if (filters.poolYn) n++;
    if (filters.waterfrontYn) n++;
    if (filters.airConditioned) n++;
    if (filters.suiteYn) n++;
    if (filters.legalSuiteYn) n++;
    if (filters.suiteLocations) n++;
    if (filters.basements) n++;
    if (filters.basementDevelopments) n++;
    if (filters.parkingFeatures) n++;
    if (filters.lotFeatures) n++;
    if (filters.laundryFeatures) n++;
    if (filters.appliances) n++;
    if (filters.levels) n++;
    if (filters.structureTypes) n++;
    if (filters.architecturalStyles) n++;
    if (filters.accessibilityFeatures) n++;
    if (filters.associationAmenities) n++;
    if (filters.views) n++;
    if (filters.subdivisions) n++;
    if (filters.districts) n++;
    if (filters.condoFeeMax) n++;
    if (filters.keywords) n++;
    if (filters.statuses && filters.statuses !== "Active") n++;
    return n;
  }, [filters]);

  const mapItems = items.filter((l) => l.lat != null && l.lng != null);
  const mapPoints: Array<[number, number]> = mapItems.map((l) => [
    l.lat as number,
    l.lng as number,
  ]);
  const calgaryCenter: [number, number] = [51.0447, -114.0719];

  const clusters = useMemo(() => clusterListings(mapItems, zoom), [mapItems, zoom]);

  // Helper for closing popup
  const closePopup = () => setPopupListing(null);

  return (
    <PublicLayout fullBleed>
      {/* Two-column layout: map left, list right (Scarlet style) */}
      <div
        className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(0,580px)] xl:grid-cols-[1fr_minmax(0,640px)]"
        style={{ height: "calc(100dvh - 80px)" }}
      >
        {/* MAP — left */}
        <div
          className={`relative ${mobileView === "list" ? "hidden lg:block" : "block"} bg-secondary p-4`}
        >
          <div className="absolute inset-4 rounded-xl overflow-hidden border border-border">
            <MapContainer
              center={calgaryCenter}
              zoom={11}
              scrollWheelZoom
              style={{ height: "100%", width: "100%", background: "#f5f5f5" }}
              zoomControl={true}
            >
              <TileLayer
                attribution={RIVERS_TILE_ATTRIBUTION}
                url={RIVERS_TILE_URL}
                subdomains={RIVERS_TILE_SUBDOMAINS}
              />
              <ZoomTracker onZoom={setZoom} />
              <FitBoundsOnce points={mapPoints} />

              {clusters.map((c, idx) => {
                if (c.kind === "single") {
                  const isSelected = selectedId === c.listing.id;
                  return (
                    <Marker
                      key={`s-${c.listing.id}`}
                      position={[c.lat, c.lng]}
                      icon={buildPriceIcon(c.listing.listPrice, isSelected)}
                      zIndexOffset={isSelected ? 1000 : 0}
                      eventHandlers={{
                        click: () => {
                          setSelectedId(c.listing.id);
                          setPopupListing(c.listing);
                        },
                      }}
                    />
                  );
                }
                return (
                  <Marker
                    key={`c-${idx}-${c.lat.toFixed(4)}-${c.lng.toFixed(4)}`}
                    position={[c.lat, c.lng]}
                    icon={buildClusterIcon(c.count)}
                    eventHandlers={{
                      click: (e) => {
                        // Zoom in toward the cluster
                        const map = e.target._map as L.Map;
                        if (map) map.setView([c.lat, c.lng], Math.min(map.getZoom() + 2, 16));
                      },
                    }}
                  />
                );
              })}
            </MapContainer>

            {/* Popup card overlay */}
            {popupListing && (
              <div
                className="absolute inset-0 pointer-events-none flex items-end lg:items-center lg:justify-center p-6 z-[450]"
              >
                <div
                  className="pointer-events-auto bg-white rounded-2xl shadow-2xl overflow-hidden flex w-full max-w-[420px] relative animate-in fade-in slide-in-from-bottom-4 duration-300"
                  style={{
                    fontFamily: "Manrope, sans-serif",
                    boxShadow: "0 8px 28px rgba(0,0,0,0.22)",
                  }}
                  data-testid="map-popup-card"
                >
                  {/* Photo */}
                  <Link href={mlsPropertyPath(popupListing)} className="w-[140px] h-[140px] shrink-0 bg-secondary block"
                      style={{ textDecoration: "none" }}>
                      {popupListing.heroImage ? (
                        <img
                          src={popupListing.heroImage}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                          <MapPin className="w-6 h-6" />
                        </div>
                      )}
                    
                  </Link>
                  {/* Details */}
                  <Link href={mlsPropertyPath(popupListing)} className="flex-1 p-3.5 pr-9 block min-w-0"
                      style={{ textDecoration: "none", color: "#0a0a0a" }}>
                      <div
                        style={{
                          fontWeight: 800,
                          fontSize: 19,
                          letterSpacing: "-0.02em",
                          lineHeight: 1.1,
                        }}
                      >
                        {priceShort(popupListing.listPrice)}
                      </div>
                      <div
                        style={{
                          fontSize: 12.5,
                          color: "#0a0a0a",
                          marginTop: 6,
                          fontWeight: 500,
                          lineHeight: 1.3,
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {popupListing.fullAddress}
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "#666",
                          marginTop: 6,
                          fontWeight: 500,
                        }}
                      >
                        {popupListing.beds} bd · {popupListing.baths} ba
                        {popupListing.sqft ? ` · ${popupListing.sqft.toLocaleString()} sqft` : ""}
                      </div>
                      {popupListing.listOffice && (
                        <div
                          style={{
                            fontSize: 10.5,
                            color: "#999",
                            marginTop: 8,
                            fontWeight: 500,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Listed by {popupListing.listOffice}
                        </div>
                      )}
                    
                  </Link>
                  {/* Close */}
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      closePopup();
                    }}
                    className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full bg-black text-white flex items-center justify-center hover:opacity-85 transition"
                    aria-label="Close"
                    data-testid="button-close-popup"
                  >
                    <X className="w-3.5 h-3.5" strokeWidth={2.4} />
                  </button>
                </div>
              </div>
            )}

            {/* Mobile view toggle */}
            <button
              onClick={() => setMobileView("list")}
              className="lg:hidden absolute bottom-6 left-1/2 -translate-x-1/2 z-[500] px-5 h-11 rounded-full bg-black text-white text-[13px] font-medium shadow-lg flex items-center gap-2"
              data-testid="button-show-list"
            >
              <ListIcon className="w-4 h-4" />
              View list
            </button>
          </div>
        </div>

        {/* LIST — right */}
        <aside
          className={`${mobileView === "map" ? "hidden lg:flex" : "flex"} flex-col bg-background border-l border-border overflow-hidden`}
        >
          {/* Search bar */}
          <div className="p-4 border-b border-border bg-background">
            <div className="relative">
              <Search
                className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
                strokeWidth={1.6}
              />
              <Input
                placeholder="Search by city, neighbourhood, address or MLS #"
                value={filters.q}
                onChange={(e) => updateFilter("q", e.target.value)}
                className="pl-10 h-11 rounded-md text-[14px]"
                style={{ fontFamily: "Manrope, sans-serif" }}
                data-testid="input-mls-search"
              />
            </div>

            {/* Filter pills row */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select
                value={filters.propertyType}
                onValueChange={(v) => updateFilter("propertyType", v)}
              >
                <SelectTrigger
                  className="h-9 w-auto rounded-full border-border text-[13px] px-3.5 hover:bg-secondary/50 transition"
                  data-testid="select-property-type"
                >
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  {PROPERTY_TYPES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.beds}
                onValueChange={(v) => updateFilter("beds", v)}
              >
                <SelectTrigger
                  className="h-9 w-auto rounded-full border-border text-[13px] px-3.5 hover:bg-secondary/50 transition"
                  data-testid="select-beds"
                >
                  <SelectValue placeholder="Beds" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any beds</SelectItem>
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n}+ beds</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.baths}
                onValueChange={(v) => updateFilter("baths", v)}
              >
                <SelectTrigger
                  className="h-9 w-auto rounded-full border-border text-[13px] px-3.5 hover:bg-secondary/50 transition"
                  data-testid="select-baths"
                >
                  <SelectValue placeholder="Baths" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any baths</SelectItem>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n}+ baths</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <button
                type="button"
                onClick={handleSaveSearch}
                disabled={createSearch.isPending}
                className={`h-9 px-3.5 rounded-full border text-[13px] transition flex items-center gap-1.5 ${
                  savedFlash
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:bg-secondary/50"
                }`}
                title={portalMe ? "Save this filter set as a recurring alert" : "Sign in to save searches"}
                data-testid="button-save-search"
              >
                {savedFlash ? (
                  <>
                    <BookmarkCheck className="w-3.5 h-3.5" strokeWidth={1.6} />
                    Saved
                  </>
                ) : (
                  <>
                    <Bookmark className="w-3.5 h-3.5" strokeWidth={1.6} />
                    Save search
                  </>
                )}
              </button>

              <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
                <SheetTrigger asChild>
                  <button
                    className="h-9 px-3.5 rounded-full border border-border text-[13px] hover:bg-secondary/50 transition flex items-center gap-1.5"
                    data-testid="button-more-filters"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" strokeWidth={1.6} />
                    More
                    {activeFilterCount > 0 && (
                      <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-foreground text-background text-[10px] tabular-nums">
                        {activeFilterCount}
                      </span>
                    )}
                  </button>
                </SheetTrigger>
                <SheetContent side="right" className="w-full sm:w-[440px] overflow-y-auto">
                  <div className="font-display text-xs tracking-[0.22em] mb-6">REFINE SEARCH</div>

                  {/* PRICE */}
                  <FilterSection title="Price">
                    <div className="grid grid-cols-2 gap-3">
                      <FilterRow label="Min price" inline>
                        <Input
                          inputMode="numeric"
                          value={filters.minPrice}
                          onChange={(e) =>
                            updateFilter("minPrice", e.target.value.replace(/[^\d]/g, ""))
                          }
                          className="h-11 tabular-nums"
                          placeholder="$"
                        />
                      </FilterRow>
                      <FilterRow label="Max price" inline>
                        <Input
                          inputMode="numeric"
                          value={filters.maxPrice}
                          onChange={(e) =>
                            updateFilter("maxPrice", e.target.value.replace(/[^\d]/g, ""))
                          }
                          className="h-11 tabular-nums"
                          placeholder="$"
                        />
                      </FilterRow>
                    </div>
                  </FilterSection>

                  {/* SIZE */}
                  <FilterSection title="Size & age">
                    <div className="grid grid-cols-2 gap-3">
                      <FilterRow label="Min sqft" inline>
                        <Input
                          inputMode="numeric"
                          value={filters.minSqft}
                          onChange={(e) =>
                            updateFilter("minSqft", e.target.value.replace(/[^\d]/g, ""))
                          }
                          className="h-11 tabular-nums"
                          placeholder="2,500"
                        />
                      </FilterRow>
                      <FilterRow label="Max sqft" inline>
                        <Input
                          inputMode="numeric"
                          value={filters.maxSqft}
                          onChange={(e) =>
                            updateFilter("maxSqft", e.target.value.replace(/[^\d]/g, ""))
                          }
                          className="h-11 tabular-nums"
                          placeholder="—"
                        />
                      </FilterRow>
                      <FilterRow label="Year built (min)" inline>
                        <Input
                          inputMode="numeric"
                          value={filters.yearMin}
                          onChange={(e) =>
                            updateFilter("yearMin", e.target.value.replace(/[^\d]/g, "").slice(0, 4))
                          }
                          className="h-11 tabular-nums"
                          placeholder="e.g. 2000"
                        />
                      </FilterRow>
                      <FilterRow label="Year built (max)" inline>
                        <Input
                          inputMode="numeric"
                          value={filters.yearMax}
                          onChange={(e) =>
                            updateFilter("yearMax", e.target.value.replace(/[^\d]/g, "").slice(0, 4))
                          }
                          className="h-11 tabular-nums"
                          placeholder="—"
                        />
                      </FilterRow>
                    </div>
                  </FilterSection>

                  {/* PROPERTY */}
                  <FilterSection title="Property">
                    <FilterRow label="Sub-type (multi-select)">
                      <CheckboxGroup
                        options={SUBTYPE_OPTS}
                        value={filters.propertySubTypes}
                        onChange={(v) => updateFilter("propertySubTypes", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="Levels (multi-select)">
                      <CheckboxGroup
                        options={LEVELS_OPTS}
                        value={filters.levels}
                        onChange={(v) => updateFilter("levels", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="Architectural style (multi-select)">
                      <CheckboxGroup
                        options={ARCH_STYLE_OPTS}
                        value={filters.architecturalStyles}
                        onChange={(v) => updateFilter("architecturalStyles", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="Garage spaces (min)">
                      <Select
                        value={filters.garageMin}
                        onValueChange={(v) => updateFilter("garageMin", v)}
                      >
                        <SelectTrigger className="h-11">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">Any</SelectItem>
                          <SelectItem value="1">1+ spaces</SelectItem>
                          <SelectItem value="2">2+ spaces (double)</SelectItem>
                          <SelectItem value="3">3+ spaces</SelectItem>
                          <SelectItem value="4">4+ spaces</SelectItem>
                        </SelectContent>
                      </Select>
                    </FilterRow>
                    <FilterRow label="Time on market">
                      <Select
                        value={filters.domMax}
                        onValueChange={(v) => updateFilter("domMax", v)}
                      >
                        <SelectTrigger className="h-11">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DOM_OPTIONS.map((d) => (
                            <SelectItem key={d.value} value={d.value}>
                              {d.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FilterRow>
                    <BoolToggleRow label="Has garage" value={filters.garageYn} onChange={(v) => updateFilter("garageYn", v)} />
                    <BoolToggleRow label="Has air conditioning" value={filters.airConditioned} onChange={(v) => updateFilter("airConditioned", v)} />
                    <BoolToggleRow label="Has private pool" value={filters.poolYn} onChange={(v) => updateFilter("poolYn", v)} />
                    <BoolToggleRow label="Waterfront" value={filters.waterfrontYn} onChange={(v) => updateFilter("waterfrontYn", v)} />
                    <label className="flex items-center gap-2 text-sm cursor-pointer pt-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded-sm border-border"
                        checked={filters.hasPhotos === "true"}
                        onChange={(e) => updateFilter("hasPhotos", e.target.checked ? "true" : "")}
                      />
                      Only listings with photos
                    </label>
                  </FilterSection>

                  {/* SUITE / SECONDARY DWELLING */}
                  <FilterSection title="Suite (secondary dwelling)">
                    <BoolToggleRow
                      label="Has any suite"
                      value={filters.suiteYn}
                      onChange={(v) => updateFilter("suiteYn", v)}
                    />
                    <BoolToggleRow
                      label="Legal suite only"
                      value={filters.legalSuiteYn}
                      onChange={(v) => updateFilter("legalSuiteYn", v)}
                    />
                    <FilterRow label="Suite location (comma-separated)">
                      <Input
                        value={filters.suiteLocations}
                        onChange={(e) => updateFilter("suiteLocations", e.target.value)}
                        className="h-11"
                        placeholder="e.g. Basement, Above Garage, Main Level"
                      />
                      <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                        Substring match against the SuiteLocation field. Listings matching ANY entry come back.
                      </p>
                    </FilterRow>
                  </FilterSection>

                  {/* BASEMENT + GARAGE FEATURES */}
                  <FilterSection title="Basement & parking">
                    <FilterRow label="Basement type (any of)">
                      <CheckboxGroup
                        options={BASEMENT_OPTS}
                        value={filters.basements}
                        onChange={(v) => updateFilter("basements", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="Basement development">
                      <CheckboxGroup
                        options={BASEMENT_DEV_OPTS}
                        value={filters.basementDevelopments}
                        onChange={(v) => updateFilter("basementDevelopments", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="Parking features">
                      <CheckboxGroup
                        options={PARKING_OPTS}
                        value={filters.parkingFeatures}
                        onChange={(v) => updateFilter("parkingFeatures", v)}
                        cols={2}
                      />
                    </FilterRow>
                  </FilterSection>

                  {/* INTERIOR */}
                  <FilterSection title="Interior">
                    <FilterRow label="Laundry features">
                      <CheckboxGroup
                        options={LAUNDRY_OPTS}
                        value={filters.laundryFeatures}
                        onChange={(v) => updateFilter("laundryFeatures", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="Appliances included">
                      <CheckboxGroup
                        options={APPLIANCE_OPTS}
                        value={filters.appliances}
                        onChange={(v) => updateFilter("appliances", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="Accessibility">
                      <CheckboxGroup
                        options={ACCESSIBILITY_OPTS}
                        value={filters.accessibilityFeatures}
                        onChange={(v) => updateFilter("accessibilityFeatures", v)}
                        cols={1}
                      />
                    </FilterRow>
                  </FilterSection>

                  {/* LOT + VIEW */}
                  <FilterSection title="Lot & view">
                    <FilterRow label="Lot features">
                      <CheckboxGroup
                        options={LOT_FEATURE_OPTS}
                        value={filters.lotFeatures}
                        onChange={(v) => updateFilter("lotFeatures", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="View">
                      <CheckboxGroup
                        options={VIEW_OPTS}
                        value={filters.views}
                        onChange={(v) => updateFilter("views", v)}
                        cols={2}
                      />
                    </FilterRow>
                  </FilterSection>

                  {/* CONDO */}
                  <FilterSection title="Condo / association">
                    <FilterRow label="Max condo fee ($/mo)" inline>
                      <Input
                        inputMode="numeric"
                        value={filters.condoFeeMax}
                        onChange={(e) => updateFilter("condoFeeMax", e.target.value.replace(/[^\d]/g, ""))}
                        className="h-11 tabular-nums"
                        placeholder="e.g. 600"
                      />
                    </FilterRow>
                    <FilterRow label="Association amenities">
                      <CheckboxGroup
                        options={ASSOCIATION_AMENITY_OPTS}
                        value={filters.associationAmenities}
                        onChange={(v) => updateFilter("associationAmenities", v)}
                        cols={2}
                      />
                    </FilterRow>
                  </FilterSection>

                  {/* LOCATION */}
                  <FilterSection title="Location">
                    <FilterRow label="Cities (multi-select)">
                      <CheckboxGroup
                        options={CITY_OPTS}
                        value={filters.cities}
                        onChange={(v) => updateFilter("cities", v)}
                        cols={2}
                      />
                    </FilterRow>
                    <FilterRow label="Subdivision (multi-select)">
                      <SearchableCheckboxList
                        field="subdivision"
                        value={filters.subdivisions}
                        onChange={(v) => updateFilter("subdivisions", v)}
                        placeholder="Search subdivisions…"
                      />
                    </FilterRow>
                    <FilterRow label="District (multi-select)">
                      <SearchableCheckboxList
                        field="district"
                        value={filters.districts}
                        onChange={(v) => updateFilter("districts", v)}
                        placeholder="Search districts…"
                      />
                    </FilterRow>
                    <FilterRow label="Postal code (prefix)">
                      <Input
                        value={filters.postalCode}
                        onChange={(e) =>
                          updateFilter("postalCode", e.target.value.toUpperCase().replace(/\s/g, "").slice(0, 6))
                        }
                        className="h-11 tabular-nums uppercase"
                        placeholder="e.g. T2T or T3H"
                      />
                    </FilterRow>
                  </FilterSection>

                  {/* KEYWORDS */}
                  <FilterSection title="Features (description match)">
                    <FilterRow label="Must contain (comma-separated)">
                      <Input
                        value={filters.keywords}
                        onChange={(e) => updateFilter("keywords", e.target.value)}
                        className="h-11"
                        placeholder="e.g. walkout, double garage, ensuite"
                      />
                    </FilterRow>
                    <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                      All terms must appear in the listing description. Useful for things not in
                      structured data — basement type, laundry location, garage details, finishes,
                      view, etc.
                    </p>
                  </FilterSection>

                  {/* STATUS */}
                  <FilterSection title="Status">
                    <FilterRow label="Listing status (multi-select)">
                      <CheckboxGroup
                        options={STATUS_OPTS}
                        value={filters.statuses}
                        onChange={(v) => updateFilter("statuses", v || "Active")}
                        cols={3}
                      />
                    </FilterRow>
                  </FilterSection>

                  <div className="pt-4 flex items-center gap-3">
                    <Button onClick={resetFilters} variant="outline" className="flex-1">
                      Reset
                    </Button>
                    <Button onClick={() => setFiltersOpen(false)} className="flex-1">
                      Apply
                    </Button>
                  </div>
                </SheetContent>
              </Sheet>

              <div className="ml-auto">
                <Select
                  value={filters.sort}
                  onValueChange={(v) => updateFilter("sort", v)}
                >
                  <SelectTrigger
                    className="h-9 w-auto rounded-full border-border text-[13px] px-3.5"
                    data-testid="select-sort"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SORT_OPTIONS.map((s) => (
                      <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Results header */}
          <div className="px-5 pt-5 pb-3 flex items-center justify-between flex-wrap gap-2 border-b border-border/50">
            <div>
              <h1 className="font-serif text-xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
                Properties
              </h1>
              <div className="text-[13px] text-muted-foreground mt-0.5" style={{ fontFamily: "Manrope, sans-serif" }}>
                {isLoading ? "Searching…" : (
                  <>
                    Showing {Math.min(items.length, total).toLocaleString()} of{" "}
                    <span data-testid="text-result-count">{total.toLocaleString()}</span> properties
                  </>
                )}
              </div>
            </div>
          </div>

          {/* List body */}
          <div className="flex-1 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
            {isLoading ? (
              <div className="p-5 space-y-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="w-[140px] h-[120px] shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-7 w-32" />
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-40" />
                    </div>
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <EmptyState onReset={resetFilters} />
            ) : (
              <div>
                <div className="divide-y divide-border/60">
                  {items.map((listing) => (
                    <ResultCard
                      key={listing.id}
                      listing={listing}
                      selected={selectedId === listing.id}
                      onHover={() => setSelectedId(listing.id)}
                    />
                  ))}
                </div>

                {pages > 1 && (
                  <div className="px-5 py-6 flex items-center justify-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="h-9 rounded-md gap-1.5"
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="w-4 h-4" /> Prev
                    </Button>
                    <div className="text-[12px] text-muted-foreground tabular-nums px-2">
                      {page + 1} / {pages}
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                      disabled={page >= pages - 1}
                      className="h-9 rounded-md gap-1.5"
                      data-testid="button-next-page"
                    >
                      Next <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Mobile show-map button */}
          <button
            onClick={() => setMobileView("map")}
            className="lg:hidden h-12 w-full bg-black text-white text-[13px] font-medium flex items-center justify-center gap-2"
            data-testid="button-show-map"
          >
            <MapIcon className="w-4 h-4" />
            View map
          </button>
        </aside>
      </div>
    </PublicLayout>
  );
}

function FilterRow({
  label,
  children,
  inline = false,
}: {
  label: string;
  children: React.ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={inline ? "" : "mb-3"}>
      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground mb-2">
        {label.toUpperCase()}
      </div>
      {children}
    </div>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 pb-5 border-b border-border last:border-b-0 last:mb-0 last:pb-0">
      <div className="font-display text-[11px] tracking-[0.22em] text-foreground mb-3">
        {title.toUpperCase()}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// Multi-select checkbox group. Stores value as a comma-separated string so
// the parent's Filters state and the URL serializer don't need any reshape.
function CheckboxGroup({
  options,
  value,
  onChange,
  cols = 1,
}: {
  options: string[];
  value: string;
  onChange: (next: string) => void;
  cols?: 1 | 2 | 3;
}) {
  const colClass = cols === 3 ? "grid-cols-3" : cols === 2 ? "grid-cols-2" : "grid-cols-1";
  return (
    <div className={`grid ${colClass} gap-1.5`}>
      {options.map((opt) => {
        const checked = csvHas(value, opt);
        return (
          <label
            key={opt}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-sm border cursor-pointer text-[12px] transition-colors ${
              checked
                ? "bg-foreground text-background border-foreground"
                : "bg-background border-border hover:bg-secondary/50"
            }`}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded-sm shrink-0"
              checked={checked}
              onChange={() => onChange(csvToggle(value, opt))}
            />
            <span className="truncate">{opt}</span>
          </label>
        );
      })}
    </div>
  );
}

// Searchable checkbox list — fetches its options from /api/public/mls/distinct
// for high-cardinality fields like subdivision and district (hundreds of values
// across the Pillar 9 service area). Renders a search input + scrollable list.
function SearchableCheckboxList({
  field,
  value,
  onChange,
  placeholder = "Search…",
}: {
  field: "subdivision" | "district";
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery<{ values: string[] }>({
    queryKey: ["/api/public/mls/distinct", field],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/public/mls/distinct?field=${field}`);
      return r.json();
    },
    staleTime: 1000 * 60 * 5, // refetch every 5 min
  });
  const all = data?.values ?? [];
  const selected = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((v) => v.toLowerCase().includes(q));
  }, [all, search]);
  return (
    <div className="space-y-2">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={placeholder}
        className="h-9"
      />
      <div className="text-[11px] text-muted-foreground tabular-nums">
        {isLoading
          ? "Loading…"
          : `${selected.length} selected · ${visible.length} of ${all.length} matches`}
      </div>
      <div className="max-h-[200px] overflow-y-auto border border-border rounded-sm divide-y divide-border">
        {selected
          .filter((s) => !visible.includes(s))
          .map((s) => (
            // Show currently-selected items that don't match the current
            // search filter (so users can de-select without losing them).
            <label
              key={`pinned-${s}`}
              className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[12px] bg-foreground/5"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded-sm shrink-0"
                checked
                onChange={() => onChange(csvToggle(value, s))}
              />
              <span className="truncate">{s}</span>
              <span className="ml-auto text-[10px] text-muted-foreground italic">selected</span>
            </label>
          ))}
        {visible.length === 0 && !isLoading ? (
          <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
            No matches.
          </div>
        ) : (
          visible.slice(0, 200).map((opt) => {
            const checked = selected.includes(opt);
            return (
              <label
                key={opt}
                className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[12px] transition-colors ${
                  checked ? "bg-foreground/5" : "hover:bg-secondary/40"
                }`}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded-sm shrink-0"
                  checked={checked}
                  onChange={() => onChange(csvToggle(value, opt))}
                />
                <span className="truncate">{opt}</span>
              </label>
            );
          })
        )}
        {visible.length > 200 && (
          <div className="px-3 py-2 text-center text-[11px] text-muted-foreground italic">
            Showing first 200 of {visible.length}. Type to narrow.
          </div>
        )}
      </div>
    </div>
  );
}

// Tri-state boolean toggle row: Any / Yes / No.
function BoolToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string; // "", "true", "false"
  onChange: (next: string) => void;
}) {
  const opts: Array<{ v: string; l: string }> = [
    { v: "", l: "Any" },
    { v: "true", l: "Yes" },
    { v: "false", l: "No" },
  ];
  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
        {label.toUpperCase()}
      </div>
      <div className="inline-flex rounded-sm border border-border overflow-hidden text-[11px] font-display tracking-[0.14em]">
        {opts.map((o) => {
          const active = (value || "") === o.v;
          return (
            <button
              key={o.v || "any"}
              type="button"
              onClick={() => onChange(o.v)}
              className={`px-3 py-1.5 transition-colors ${
                active ? "bg-foreground text-background" : "bg-background text-foreground/70 hover:bg-secondary/50"
              }`}
            >
              {o.l.toUpperCase()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Horizontal listing card (Scarlet style: photo left, details right)
function ResultCard({
  listing,
  selected,
  onHover,
}: {
  listing: PublicMlsListing;
  selected?: boolean;
  onHover?: () => void;
}) {
  return (
    <Link href={mlsPropertyPath(listing)} onMouseEnter={onHover}
        className={`flex gap-4 px-5 py-4 hover:bg-secondary/40 transition cursor-pointer ${selected ? "bg-secondary/60" : ""}`}
        data-testid={`result-card-${listing.id}`}>
        <div className="w-[150px] h-[110px] shrink-0 rounded-lg overflow-hidden bg-secondary relative">
          {listing.heroImage ? (
            <img
              src={listing.heroImage}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground/50">
              <MapPin className="w-7 h-7" />
            </div>
          )}
          {/* Status badge top-right */}
          {listing.status === "Active" && (
            <span
              className="absolute top-2 right-2 px-2 py-0.5 rounded-sm text-white text-[9.5px] tracking-[0.1em] font-semibold uppercase"
              style={{ background: "rgba(34,197,94,0.95)" }}
            >
              Active
            </span>
          )}
          {listing.propertyType && (
            <span
              className="absolute bottom-2 left-2 px-2 py-0.5 rounded-sm text-white text-[9.5px] tracking-[0.08em] font-semibold uppercase"
              style={{ background: "rgba(0,0,0,0.78)" }}
            >
              {listing.propertyType}
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0" style={{ fontFamily: "Manrope, sans-serif" }}>
          <div
            className="text-[20px] tabular-nums text-foreground"
            style={{ fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}
          >
            ${listing.listPrice.toLocaleString()}
          </div>
          <div className="text-[13.5px] text-foreground mt-1.5 flex items-start gap-1.5 leading-snug">
            <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground" strokeWidth={1.7} />
            <span className="line-clamp-2">{listing.fullAddress}</span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[12.5px] text-muted-foreground">
            <span>
              <span className="text-foreground font-semibold tabular-nums">{listing.beds}</span> bd
            </span>
            <span>
              <span className="text-foreground font-semibold tabular-nums">{listing.baths}</span> ba
            </span>
            {listing.sqft ? (
              <span>
                <span className="text-foreground font-semibold tabular-nums">
                  {formatSqft(listing.sqft)}
                </span>{" "}
                sqft
              </span>
            ) : (
              <span>—</span>
            )}
          </div>
          {listing.listOffice && (
            <div className="text-[10.5px] text-muted-foreground/80 mt-2 truncate">
              Listed by {listing.listOffice}
            </div>
          )}
        </div>
      
    </Link>
  );
}

function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="px-6 py-16 flex flex-col items-center text-center">
      <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center">
        <MapPin className="w-6 h-6 text-muted-foreground" strokeWidth={1.4} />
      </div>
      <div className="font-display text-xs tracking-[0.22em] mt-5">NO MATCHES</div>
      <h2 className="mt-3 font-serif text-xl">Nothing here matches those filters</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Try widening the price range or clearing the neighbourhood — small changes
        often surface a property worth a closer look.
      </p>
      <Button onClick={onReset} variant="outline" className="mt-6 h-10 rounded-md">
        Reset filters
      </Button>
    </div>
  );
}
