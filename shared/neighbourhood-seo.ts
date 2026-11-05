/**
 * Default <title> and meta description for /neighbourhoods/<slug>.
 *
 * One source for the server (server/seo-inject.ts, what crawlers get) and the
 * client (client/src/pages/neighbourhood-detail.tsx, what <SeoHead> sets after
 * hydration) so the two can never drift.
 *
 * Why this format: every neighbourhood page with Search Console history is
 * found for "<place> calgary real estate" (Meadowlark Park, Rosedale,
 * Scarboro, Oakridge, Ramsay, ...), not the WordPress-era "<place> homes for
 * sale" the title used to lead with. The hybrid keeps "Homes for Sale" for the
 * listing-intent searches and the "Luxury Homes Calgary" suffix that carries
 * the old site's rankings, and puts the demand that exists at the front.
 *
 * Communities outside the city are named by their own town — "Bayside
 * Airdrie Real Estate" — because that is how people search for them and
 * calling Airdrie "Calgary" is simply wrong. A per-page override saved in the
 * SEO console still wins over this default.
 */

/** Towns around Calgary that are searched by their own name. */
const TOWNS = new Set([
  "airdrie", "canmore", "chestermere", "cochrane", "okotoks", "bragg creek", "high river",
  "strathmore", "carstairs", "crossfield", "banff",
]);

export interface NeighbourhoodPlace {
  /** The community itself: "Bayside", "Elbow Park". */
  place: string;
  /** What follows it in a search: "Airdrie", "Calgary", "Lakefront". */
  locality: string;
  /** The phrase titles lead with: "Bayside Airdrie", "Elbow Park Calgary". */
  label: string;
  /** For prose: "Bayside, Airdrie", "Elbow Park, Calgary". */
  inCity: string;
}

/** "Bayside (Airdrie)" → place Bayside in Airdrie; "Chestermere (Lakefront)"
 *  → Chestermere is the town, "Lakefront" a descriptor; "Elbow Park" →
 *  Calgary. */
export function neighbourhoodPlace(name: string): NeighbourhoodPlace {
  const m = name.trim().match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const place = (m ? m[1] : name).trim();
  const paren = m ? m[2].trim() : "";
  const town = TOWNS.has(paren.toLowerCase())
    ? paren
    : TOWNS.has(place.toLowerCase())
      ? null // the community is the town itself
      : "Calgary";
  if (town === null) {
    const label = paren ? `${place} ${paren}` : place;
    return { place, locality: paren || place, label, inCity: place };
  }
  const descriptor = paren && paren !== town ? ` ${paren}` : "";
  return {
    place,
    locality: town,
    label: `${place}${descriptor} ${town}`,
    inCity: `${place}, ${town}`,
  };
}

export function neighbourhoodSeoTitle(name: string): string {
  return `${neighbourhoodPlace(name).label} Real Estate & Homes for Sale - Luxury Homes Calgary`;
}

export function neighbourhoodSeoDescription(name: string): string {
  const p = neighbourhoodPlace(name);
  return `${p.label} real estate with Spencer Rivers: today's homes for sale, recent prices and a local's guide to living in ${p.place}. See current listings.`;
}
