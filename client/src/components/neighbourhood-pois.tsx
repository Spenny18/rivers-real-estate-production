// Shared "What's nearby" map + POI list. Used on the public MLS detail page
// AND on each marquee condo building page so the experience is identical.
//
// The component is data-source agnostic — pass it a `poiUrl` (which must
// return the same shape as `/api/mls/:id/pois`) and a center lat/lng. Walking
// + driving routes hit `/api/route` so they work for any point on Earth as
// long as OSRM has data for the area.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MapContainer,
  TileLayer,
  Marker,
  CircleMarker,
  Tooltip,
  Circle,
  Polyline,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { apiUrl } from "@/lib/queryClient";
import { ClientOnly } from "@/components/client-only";
import {
  RIVERS_TILE_ATTRIBUTION,
  RIVERS_TILE_SUBDOMAINS,
  RIVERS_TILE_URL,
} from "@/components/rivers-map";

const propertyIcon = L.divIcon({
  className: "rivers-detail-marker",
  html: `<div style="
    width:32px;height:32px;
    background:#000;border:3px solid #fff;border-radius:50%;
    box-shadow:0 4px 12px rgba(0,0,0,0.4);
  "></div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

type Poi = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distance: number;
  kind: string;
  cuisine?: string | null;
  shop?: string;
  tags?: any;
};
type PoisPayload = {
  center: { lat: number; lng: number };
  radius: number;
  schools: Poi[];
  restaurants: Poi[];
  parks: Poi[];
  transit: Poi[];
  cached?: boolean;
  error?: string;
};

const POI_CATEGORIES = [
  { id: "all", label: "All", color: "#23412d" },
  { id: "schools", label: "Schools", color: "#2563eb" },
  { id: "restaurants", label: "Restaurants & cafes", color: "#dc2626" },
  { id: "parks", label: "Parks & recreation", color: "#16a34a" },
  { id: "transit", label: "Transit & shopping", color: "#a16207" },
] as const;
type CatId = (typeof POI_CATEGORIES)[number]["id"];
function colorFor(cat: CatId): string {
  return POI_CATEGORIES.find((c) => c.id === cat)?.color ?? "#23412d";
}

type RouteResult = {
  profile: string;
  distance: number;
  duration: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
function formatDistanceKm(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

function FitToRoute({
  coords,
  fallback,
}: {
  coords: [number, number][] | null;
  fallback: [number, number];
}) {
  const map = useMap();
  useEffect(() => {
    if (!coords || coords.length === 0) {
      map.setView(fallback, 15);
      return;
    }
    const latlngs = coords.map(([lng, lat]) => [lat, lng] as [number, number]);
    map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 16 });
  }, [coords, fallback, map]);
  return null;
}

export interface NeighbourhoodPoisProps {
  /** Center point — the listing or building location. */
  lat: number;
  lng: number;
  /** Endpoint that returns the PoisPayload shape (e.g. `/api/mls/abc/pois`). */
  poiUrl: string;
  /** Stable key used to cache the query — usually the listing id or condo slug. */
  cacheKey: string;
  /** Optional override for the eyebrow + sub-copy above the map. */
  eyebrow?: string;
  caption?: string;
}

// Gated behind ClientOnly at the export so every usage site (neighbourhood,
// condo, and MLS detail pages) skips it during SSR/hydration in one place —
// the whole component is Leaflet-centric and can only run in a browser.
export function NeighbourhoodPois(props: NeighbourhoodPoisProps) {
  return (
    <ClientOnly>
      <NeighbourhoodPoisInner {...props} />
    </ClientOnly>
  );
}

function NeighbourhoodPoisInner({
  lat,
  lng,
  poiUrl,
  cacheKey,
  eyebrow = "LOCATION & NEIGHBOURHOOD",
  caption = "What's within a 1 km walk of this property.",
}: NeighbourhoodPoisProps) {
  const [active, setActive] = useState<CatId>("all");
  const [selectedPoi, setSelectedPoi] = useState<Poi | null>(null);

  const { data, isLoading } = useQuery<PoisPayload>({
    queryKey: ["pois", cacheKey],
    queryFn: async () => {
      const r = await fetch(apiUrl(poiUrl));
      if (!r.ok) throw new Error("Failed to load POIs");
      return r.json();
    },
    staleTime: 1000 * 60 * 60,
  });

  const visible = useMemo(() => {
    if (!data) return { schools: [], restaurants: [], parks: [], transit: [] };
    if (active === "all") return data;
    return {
      schools: active === "schools" ? data.schools : [],
      restaurants: active === "restaurants" ? data.restaurants : [],
      parks: active === "parks" ? data.parks : [],
      transit: active === "transit" ? data.transit : [],
    };
  }, [data, active]);

  const counts = data
    ? {
        schools: data.schools.length,
        restaurants: data.restaurants.length,
        parks: data.parks.length,
        transit: data.transit.length,
      }
    : { schools: 0, restaurants: 0, parks: 0, transit: 0 };

  const list: { poi: Poi; cat: CatId }[] = [];
  for (const p of visible.schools) list.push({ poi: p, cat: "schools" });
  for (const p of visible.restaurants) list.push({ poi: p, cat: "restaurants" });
  for (const p of visible.parks) list.push({ poi: p, cat: "parks" });
  for (const p of visible.transit) list.push({ poi: p, cat: "transit" });
  list.sort((a, b) => a.poi.distance - b.poi.distance);

  const walkRoute = useQuery<RouteResult>({
    queryKey: ["/api/route", lat, lng, selectedPoi?.id, "foot"],
    enabled: !!selectedPoi,
    queryFn: async () => {
      const url = apiUrl(
        `/api/route?fromLat=${lat}&fromLng=${lng}&toLat=${selectedPoi!.lat}&toLng=${selectedPoi!.lng}&profile=foot`,
      );
      const r = await fetch(url);
      if (!r.ok) throw new Error("walking route unavailable");
      return r.json();
    },
    staleTime: 1000 * 60 * 60,
  });
  const driveRoute = useQuery<RouteResult>({
    queryKey: ["/api/route", lat, lng, selectedPoi?.id, "driving"],
    enabled: !!selectedPoi,
    queryFn: async () => {
      const url = apiUrl(
        `/api/route?fromLat=${lat}&fromLng=${lng}&toLat=${selectedPoi!.lat}&toLng=${selectedPoi!.lng}&profile=driving`,
      );
      const r = await fetch(url);
      if (!r.ok) throw new Error("driving route unavailable");
      return r.json();
    },
    staleTime: 1000 * 60 * 60,
  });

  const fitCoords =
    walkRoute.data?.geometry.coordinates ??
    driveRoute.data?.geometry.coordinates ??
    null;

  return (
    <div className="mt-12">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-xs tracking-[0.22em] text-muted-foreground">
            {eyebrow}
          </h2>
          <p className="mt-2 text-[13px] text-muted-foreground">{caption}</p>
        </div>
        {isLoading && (
          <span className="text-[11px] font-display tracking-[0.18em] text-muted-foreground">
            LOADING NEARBY PLACES…
          </span>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {POI_CATEGORIES.map((c) => {
          const isActive = active === c.id;
          const count =
            c.id === "all"
              ? counts.schools + counts.restaurants + counts.parks + counts.transit
              : counts[c.id as keyof typeof counts];
          return (
            <button
              key={c.id}
              onClick={() => setActive(c.id)}
              className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11px] font-display tracking-[0.18em] transition-colors ${
                isActive
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-foreground/75 border-border hover:border-foreground/40"
              }`}
              data-testid={`poi-chip-${c.id}`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: c.color }}
              />
              {c.label.toUpperCase()}
              <span className="opacity-60 tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 relative rounded-sm overflow-hidden border border-border aspect-[4/3] lg:aspect-auto lg:h-[460px] bg-secondary">
          <MapContainer
            center={[lat, lng]}
            zoom={15}
            scrollWheelZoom={false}
            style={{ height: "100%", width: "100%" }}
          >
            <TileLayer
              attribution={RIVERS_TILE_ATTRIBUTION}
              url={RIVERS_TILE_URL}
              subdomains={RIVERS_TILE_SUBDOMAINS}
            />
            <Circle
              center={[lat, lng]}
              radius={1000}
              pathOptions={{
                color: "#23412d",
                fillColor: "#23412d",
                fillOpacity: 0.05,
                weight: 1,
                dashArray: "4 4",
              }}
            />
            <Marker position={[lat, lng]} icon={propertyIcon} />

            {selectedPoi && driveRoute.data && (
              <Polyline
                positions={driveRoute.data.geometry.coordinates.map(
                  ([lng, lat]) => [lat, lng] as [number, number],
                )}
                pathOptions={{
                  color: "#2563eb",
                  weight: 5,
                  opacity: 0.85,
                }}
              />
            )}
            {selectedPoi && walkRoute.data && (
              <Polyline
                positions={walkRoute.data.geometry.coordinates.map(
                  ([lng, lat]) => [lat, lng] as [number, number],
                )}
                pathOptions={{
                  color: "#23412d",
                  weight: 4,
                  opacity: 1,
                  dashArray: "6 6",
                }}
              />
            )}

            {(
              [
                ["schools", visible.schools],
                ["restaurants", visible.restaurants],
                ["parks", visible.parks],
                ["transit", visible.transit],
              ] as [CatId, Poi[]][]
            ).flatMap(([cat, arr]) =>
              arr.map((p) => {
                const isSelected = selectedPoi?.id === p.id;
                return (
                  <CircleMarker
                    key={`${cat}-${p.id}`}
                    center={[p.lat, p.lng]}
                    radius={isSelected ? 9 : 6}
                    pathOptions={{
                      color: isSelected ? "#0a0a0a" : "#fff",
                      weight: isSelected ? 3 : 2,
                      fillColor: colorFor(cat),
                      fillOpacity: 1,
                    }}
                    eventHandlers={{
                      click: () =>
                        setSelectedPoi((prev) => (prev?.id === p.id ? null : p)),
                    }}
                  >
                    <Tooltip direction="top" offset={[0, -6]} opacity={1}>
                      <div className="text-[11px]">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-muted-foreground tabular-nums">
                          {p.distance < 1000
                            ? `${p.distance} m`
                            : `${(p.distance / 1000).toFixed(1)} km`}
                          {" · "}
                          {p.kind}
                          {!isSelected && (
                            <span className="block text-[9px] tracking-[0.18em] uppercase mt-0.5 opacity-70">
                              Click for routes
                            </span>
                          )}
                        </div>
                      </div>
                    </Tooltip>
                  </CircleMarker>
                );
              }),
            )}

            <FitToRoute coords={fitCoords} fallback={[lat, lng]} />
          </MapContainer>

          {selectedPoi && (
            <div
              className="absolute top-3 left-3 right-3 lg:right-auto lg:max-w-[280px] z-[400] bg-white/95 dark:bg-background/95 backdrop-blur rounded-sm border border-border shadow-lg p-3 pointer-events-auto"
              data-testid="poi-route-panel"
            >
              <div className="flex items-start gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="eyebrow text-muted-foreground">Route to</div>
                  <div
                    className="font-serif text-[15px] leading-tight truncate"
                    style={{ letterSpacing: "-0.005em" }}
                  >
                    {selectedPoi.name}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedPoi(null)}
                  aria-label="Clear route"
                  className="shrink-0 rounded-sm border border-border h-6 w-6 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition"
                >
                  ×
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <div className="rounded-sm bg-secondary/60 px-2.5 py-2">
                  <div className="font-display tracking-[0.16em] text-[9px] text-muted-foreground mb-0.5">
                    🚶 WALK
                  </div>
                  {walkRoute.isLoading ? (
                    <div className="text-muted-foreground italic text-[11px]">Calculating…</div>
                  ) : walkRoute.data ? (
                    <div>
                      <div className="font-medium">
                        {formatDuration(walkRoute.data.duration)}
                      </div>
                      <div className="text-muted-foreground tabular-nums text-[11px]">
                        {formatDistanceKm(walkRoute.data.distance)}
                      </div>
                    </div>
                  ) : (
                    <div className="text-muted-foreground italic text-[11px]">Unavailable</div>
                  )}
                </div>
                <div className="rounded-sm bg-secondary/60 px-2.5 py-2">
                  <div className="font-display tracking-[0.16em] text-[9px] text-muted-foreground mb-0.5">
                    🚗 DRIVE
                  </div>
                  {driveRoute.isLoading ? (
                    <div className="text-muted-foreground italic text-[11px]">Calculating…</div>
                  ) : driveRoute.data ? (
                    <div>
                      <div className="font-medium">
                        {formatDuration(driveRoute.data.duration)}
                      </div>
                      <div className="text-muted-foreground tabular-nums text-[11px]">
                        {formatDistanceKm(driveRoute.data.distance)}
                      </div>
                    </div>
                  ) : (
                    <div className="text-muted-foreground italic text-[11px]">Unavailable</div>
                  )}
                </div>
              </div>
              <a
                href={`https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${selectedPoi.lat},${selectedPoi.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block text-center font-display tracking-[0.18em] text-[10px] py-1.5 border border-border rounded-sm hover:bg-secondary transition"
              >
                OPEN IN GOOGLE MAPS
              </a>
            </div>
          )}
        </div>

        <div className="lg:col-span-2 rounded-sm border border-border bg-card max-h-[460px] overflow-auto">
          {list.length === 0 && !isLoading && (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              No places found in this category nearby.
            </div>
          )}
          <ul className="divide-y divide-border">
            {list.slice(0, 60).map((row) => (
              <li
                key={`${row.cat}-${row.poi.id}`}
                onClick={() =>
                  setSelectedPoi((prev) => (prev?.id === row.poi.id ? null : row.poi))
                }
                className={`px-4 py-3 flex items-start gap-3 transition-colors cursor-pointer ${
                  selectedPoi?.id === row.poi.id ? "bg-secondary/70" : "hover:bg-secondary/40"
                }`}
                data-testid={`poi-row-${row.poi.id}`}
              >
                <span
                  className="mt-1.5 w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: colorFor(row.cat) }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium leading-tight truncate">
                    {row.poi.name}
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    {row.poi.distance < 1000
                      ? `${row.poi.distance} m`
                      : `${(row.poi.distance / 1000).toFixed(1)} km`}
                    {" · "}
                    <span className="capitalize">
                      {row.poi.kind.replace(/_/g, " ")}
                    </span>
                    {row.poi.cuisine && (
                      <span className="capitalize">
                        {" · "}
                        {row.poi.cuisine}
                      </span>
                    )}
                  </div>
                </div>
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${row.poi.lat},${row.poi.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-[10px] tracking-[0.18em] font-display text-muted-foreground hover:text-foreground"
                >
                  DIRECTIONS
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default NeighbourhoodPois;
