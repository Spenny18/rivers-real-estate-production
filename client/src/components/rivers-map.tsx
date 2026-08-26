// Shared map building blocks. Every map on the public site uses these so the
// UI stays consistent (Airbnb-style price pills, monochrome tiles, brand
// accents in green for selected and red for reductions/sold).
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";

// OpenStreetMap's standard public tiles do not require an API key. Keep the
// provider in one place so every public map uses the same supported source.
export const RIVERS_TILE_URL =
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const RIVERS_TILE_SUBDOMAINS = ["a", "b", "c"];
export const RIVERS_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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
