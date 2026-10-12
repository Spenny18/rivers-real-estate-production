import { useState, useMemo } from "react";
import { MapContainer, Marker, Popup, CircleMarker, Tooltip } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  RiversBasemap,
} from "@/components/rivers-map";
import {
  TreePine,
  Coffee,
  GraduationCap,
  TrainFront,
  ShoppingBag,
  UtensilsCrossed,
  Dumbbell,
} from "lucide-react";
import type { Amenity } from "@/lib/mock-data";

// Brand says: gold is for the logo only. Use foreground/black for the property pin.
// Amenity types use neutral grayscale variations to keep the page monochrome.

const TYPES: Array<{
  key: Amenity["type"];
  label: string;
  Icon: typeof Coffee;
  shade: string; // grayscale shade
}> = [
  { key: "park", label: "Parks", Icon: TreePine, shade: "#1A1A1A" },
  { key: "cafe", label: "Cafés", Icon: Coffee, shade: "#333333" },
  { key: "restaurant", label: "Dining", Icon: UtensilsCrossed, shade: "#4D4D4D" },
  { key: "school", label: "Schools", Icon: GraduationCap, shade: "#666666" },
  { key: "transit", label: "Transit", Icon: TrainFront, shade: "#7A7A7A" },
  { key: "shopping", label: "Shopping", Icon: ShoppingBag, shade: "#999999" },
  { key: "fitness", label: "Fitness", Icon: Dumbbell, shade: "#B3B3B3" },
];

interface Props {
  amenities: Amenity[];
  centerLat: number;
  centerLng: number;
  propertyAddress: string;
}

// Property marker — black diamond with white border, in keeping with monochrome palette.
const propertyIcon = L.divIcon({
  className: "rivers-property-marker",
  html: `
    <div style="
      width: 28px; height: 28px;
      background: #000;
      border: 3px solid #fff;
      border-radius: 50%;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 11px;
      letter-spacing: 0.04em;
    ">★</div>
  `,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

export function NeighbourhoodMap({ amenities, centerLat, centerLng, propertyAddress }: Props) {
  const [active, setActive] = useState<Set<string>>(new Set(TYPES.map((t) => t.key)));

  const toggle = (key: string) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visible = useMemo(
    () => amenities.filter((a) => active.has(a.type)),
    [amenities, active],
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-4">
      {/* Map */}
      <div className="relative rounded-xl overflow-hidden border border-border aspect-[4/3] bg-secondary">
        <MapContainer
          center={[centerLat, centerLng]}
          zoom={15}
          scrollWheelZoom={false}
          style={{ height: "100%", width: "100%" }}
          attributionControl={true}
        >
          <RiversBasemap />

          {/* Amenity markers — small grayscale circles */}
          {visible.map((a) => {
            const meta = TYPES.find((t) => t.key === a.type)!;
            return (
              <CircleMarker
                key={a.id}
                center={[a.lat, a.lng]}
                radius={7}
                pathOptions={{
                  color: "#fff",
                  weight: 2,
                  fillColor: meta.shade,
                  fillOpacity: 1,
                }}
              >
                <Tooltip direction="top" offset={[0, -6]} opacity={1}>
                  <div style={{ fontFamily: "Manrope, sans-serif" }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: "#666", textTransform: "capitalize" }}>
                      {a.type}
                      {a.walkMin ? ` · ${a.walkMin} min walk` : ""}
                      {a.rating ? ` · ★ ${a.rating}` : ""}
                    </div>
                  </div>
                </Tooltip>
              </CircleMarker>
            );
          })}

          {/* Property marker */}
          <Marker position={[centerLat, centerLng]} icon={propertyIcon}>
            <Popup>
              <div style={{ fontFamily: "Manrope, sans-serif" }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#000" }}>
                  {propertyAddress}
                </div>
                <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                  Listed by Rivers Real Estate
                </div>
              </div>
            </Popup>
          </Marker>
        </MapContainer>

        {/* Property address overlay */}
        <div className="pointer-events-none absolute top-3 left-3 px-3 py-1.5 rounded-full bg-background/90 backdrop-blur border border-border text-xs font-medium z-[400] flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-foreground" />
          {propertyAddress}
        </div>
      </div>

      {/* Filter legend */}
      <div className="space-y-2">
        <div className="eyebrow px-1">
          What's nearby
        </div>
        {TYPES.map((t) => {
          const count = amenities.filter((a) => a.type === t.key).length;
          if (count === 0) return null;
          const isActive = active.has(t.key);
          const Icon = t.Icon;
          return (
            <button
              key={t.key}
              onClick={() => toggle(t.key)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                isActive
                  ? "bg-secondary/60 border-border"
                  : "bg-transparent border-border opacity-50 hover:opacity-80"
              }`}
              data-testid={`filter-${t.key}`}
            >
              <div
                className="w-7 h-7 rounded-md flex items-center justify-center text-white shrink-0"
                style={{ background: t.shade }}
              >
                <Icon className="w-3.5 h-3.5" />
              </div>
              <span className="text-sm font-medium flex-1 text-left">{t.label}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
