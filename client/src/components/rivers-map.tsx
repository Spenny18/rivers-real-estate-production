// Shared map building blocks. Every map on the public site uses these so the
// UI stays consistent (Airbnb-style price pills, monochrome tiles, brand
// accents in green for selected and red for reductions/sold).
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";

// Basemap: OpenFreeMap's "Positron" vector style (free, no API key, OK for
// commercial use) recoloured Airbnb-style — grey land and roads, with soft
// blue water and green parks/woods as the only colour besides the pills.
// Rendered inside Leaflet via maplibre-gl-leaflet so markers/clusters are
// unchanged. Falls back to greyscaled OSM raster tiles if WebGL or the style
// fetch fails.
export const RIVERS_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
export const RIVERS_BASEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export const RIVERS_TILE_URL =
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const RIVERS_TILE_SUBDOMAINS = ["a", "b", "c"];
export const RIVERS_TILE_CLASS = "rivers-tiles";
export const RIVERS_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const RIVERS_BASEMAP_COLORS = {
  water: "#c3dbea",
  waterway: "#a9cbe0",
  waterLabel: "#4f7590",
  park: "#d6e8cf",
  wood: "#cde3c4",
  grass: "#dcebd5",
} as const;

// Style is fetched once per page load and shared by every map instance.
let stylePromise: Promise<any> | null = null;
function loadRiversStyle(): Promise<any> {
  if (!stylePromise) {
    stylePromise = fetch(RIVERS_STYLE_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`style ${r.status}`);
        return r.json();
      })
      .then(recolourStyle)
      .catch((err) => {
        stylePromise = null;
        throw err;
      });
  }
  return stylePromise;
}

function recolourStyle(style: any) {
  const c = RIVERS_BASEMAP_COLORS;
  const layers: any[] = style.layers ?? [];
  const byId = (id: string) => layers.find((l) => l.id === id);
  const paint = (id: string, props: Record<string, unknown>) => {
    const l = byId(id);
    if (l) l.paint = { ...(l.paint ?? {}), ...props };
  };
  paint("water", { "fill-color": c.water });
  paint("waterway", { "line-color": c.waterway });
  paint("park", { "fill-color": c.park });
  paint("landcover_wood", { "fill-color": c.wood });
  for (const id of ["water_name_point_label", "water_name_line_label", "waterway_line_label"]) {
    paint(id, { "text-color": c.waterLabel });
  }
  // Positron has no grass layer — add one so golf courses, fields and
  // green belts read green too.
  const woodIdx = layers.findIndex((l) => l.id === "landcover_wood");
  if (woodIdx >= 0 && !byId("landcover_grass")) {
    layers.splice(woodIdx + 1, 0, {
      id: "landcover_grass",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "grass"],
      paint: {
        "fill-color": c.grass,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 12, 0.9],
      },
    });
  }
  return style;
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

// Drop-in replacement for <TileLayer>: render inside any <MapContainer>.
// maplibre-gl is imported dynamically so it never loads during SSR.
export function RiversBasemap() {
  const map = useMap();
  useEffect(() => {
    let cancelled = false;
    let layer: L.Layer | null = null;

    const useRasterFallback = () => {
      if (cancelled) return;
      layer = L.tileLayer(RIVERS_TILE_URL, {
        subdomains: RIVERS_TILE_SUBDOMAINS,
        attribution: RIVERS_TILE_ATTRIBUTION,
        className: RIVERS_TILE_CLASS,
      }).addTo(map);
    };

    if (!supportsWebGL()) {
      useRasterFallback();
    } else {
      Promise.all([
        loadRiversStyle(),
        import("@maplibre/maplibre-gl-leaflet"),
        import("maplibre-gl/dist/maplibre-gl.css"),
      ])
        .then(([style, mod]) => {
          if (cancelled) return;
          layer = mod.maplibreGL({ style, attributionControl: false } as any);
          (layer as any).options.attribution = RIVERS_BASEMAP_ATTRIBUTION;
          layer.addTo(map);
        })
        .catch(useRasterFallback);
    }

    // Leaflet only re-measures on window resize. Maps that mount hidden
    // (mobile list/map toggle) or change size with the layout would keep a
    // 0×0 GL canvas and misplaced markers, so watch the container directly.
    const container = map.getContainer();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => map.invalidateSize())
        : null;
    observer?.observe(container);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (layer) map.removeLayer(layer);
    };
  }, [map]);
  return null;
}

// Brand palette — kept here so any new map references the same swatches.
export const RIVERS_MAP_COLORS = {
  pillBg: "#ffffff",
  pillFg: "#0a0a0a",
  pillSelectedBg: "#23412d", // forest green = selected / active emphasis
  pillSelectedFg: "#ffffff",
  pillReducedBg: "#a31e1e", // crimson = price reduction / urgent
  pillReducedFg: "#ffffff",
  pillSoldBg: "#0a0a0a", // black = sold (closed status)
  pillSoldFg: "#ffffff",
} as const;

export type PricePillState = "default" | "selected" | "reduced" | "sold";

function shortPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  if (price >= 1_000_000) {
    const m = price / 1_000_000;
    return m >= 10 ? `$${Math.round(m)}M` : `$${m.toFixed(1)}M`;
  }
  if (price >= 1_000) return `$${Math.round(price / 1_000)}K`;
  return `$${price}`;
}

// Price pill marker — Airbnb's listing chip in Rivers' palette.
export function buildPricePill(price: number, state: PricePillState = "default") {
  const c = RIVERS_MAP_COLORS;
  let bg: string = c.pillBg;
  let fg: string = c.pillFg;
  if (state === "selected") {
    bg = c.pillSelectedBg;
    fg = c.pillSelectedFg;
  } else if (state === "reduced") {
    bg = c.pillReducedBg;
    fg = c.pillReducedFg;
  } else if (state === "sold") {
    bg = c.pillSoldBg;
    fg = c.pillSoldFg;
  }
  const ring = state === "selected" ? "1.5px solid #fff" : "1px solid rgba(0,0,0,0.04)";
  return L.divIcon({
    className: "rivers-price-pill",
    html: `<div style="
      display:inline-flex;align-items:center;justify-content:center;
      padding:5px 11px;border-radius:9999px;
      background:${bg};color:${fg};
      font-family:Manrope,system-ui,sans-serif;font-weight:700;font-size:13px;
      letter-spacing:-0.01em;line-height:1;
      box-shadow:0 2px 8px rgba(0,0,0,0.18),0 0 0 1px rgba(0,0,0,0.06);
      white-space:nowrap;border:${ring};
      transform:translateY(-2px);
    ">${shortPrice(price)}</div>`,
    iconSize: [60, 26],
    iconAnchor: [30, 13],
  });
}

// Cluster marker shown when zoomed out — same chip silhouette so the page
// reads as one map system.
export function buildClusterPill(count: number) {
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

// "You are here" / center pin used on listing detail + neighbourhood pages
// when there's a single subject point that should stand out from the listing
// pins around it.
export function buildSubjectPin() {
  return L.divIcon({
    className: "rivers-subject-pin",
    html: `<div style="
      width:32px;height:32px;
      background:#0a0a0a;border:3px solid #ffffff;border-radius:50%;
      box-shadow:0 4px 12px rgba(0,0,0,0.4);
      display:flex;align-items:center;justify-content:center;
      color:#fff;font-family:'Manrope',sans-serif;font-weight:800;font-size:13px;
    ">★</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

// Helper: fit map bounds to a list of [lat,lng] points, only on first paint.
export function FitBoundsOnce({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 14);
      return;
    }
    const bounds = L.latLngBounds(points.map((p) => L.latLng(p[0], p[1])));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    // Intentionally only on mount — we don't want zoom changes to refit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
