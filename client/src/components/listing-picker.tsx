// Pick the MLS® listing a deal is about, by address or MLS number. Uses the
// showings lookups (server/showing-routes.ts): an MLS-shaped query is looked
// up exactly, anything else searches addresses in the listing mirror,
// including sold and off-market listings.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { ShowingListing } from "@/components/showings";

export type PickedListing = ShowingListing & { status?: string | null };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function looksLikeMls(s: string) {
  return /^[a-z]\d{5,}$/i.test(s.trim());
}

/** Matches for a query: exact by MLS number, else by address. */
export function useListingMatches(query: string, enabled = true) {
  const typed = useDebounced(query.trim(), 300);
  const mls = looksLikeMls(typed);
  const byMls = useQuery<PickedListing>({
    queryKey: [`/api/admin/showings/listing?mls=${encodeURIComponent(typed.toUpperCase())}`],
    enabled: enabled && mls,
    retry: false,
  });
  const byAddress = useQuery<PickedListing[]>({
    queryKey: [`/api/admin/showings/listing-search?q=${encodeURIComponent(typed)}`],
    enabled: enabled && !mls && typed.length >= 3,
  });
  const matches: PickedListing[] = mls ? (byMls.data ? [byMls.data] : []) : byAddress.data ?? [];
  return { typed, mls, matches, searching: mls ? byMls.isFetching : byAddress.isFetching };
}

export function ListingCard({ listing, onClear }: { listing: PickedListing; onClear?: () => void }) {
  return (
    <div className="flex gap-3 rounded-sm border border-border p-2.5" data-testid="deal-listing-card">
      {listing.photoUrl ? <img src={listing.photoUrl} alt="" className="w-20 h-14 object-cover rounded-sm shrink-0 bg-secondary" /> : null}
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="font-medium truncate">{listing.address}</div>
        <div className="text-muted-foreground text-[12px]">{[listing.summary, listing.mlsNumber && `MLS® ${listing.mlsNumber}`].filter(Boolean).join(" · ")}</div>
        {listing.status && listing.status !== "Active" ? <div className="text-[12px] text-amber-700 dark:text-amber-400">Listing status: {listing.status}</div> : null}
      </div>
      {onClear ? (
        <button type="button" onClick={onClear} aria-label="Change property" className="self-start text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

export function ListingMatches({ matches, onPick, empty }: { matches: PickedListing[]; onPick: (l: PickedListing) => void; empty?: string | null }) {
  if (!matches.length) return empty ? <div className="px-3 py-2 text-[12px] text-muted-foreground rounded-sm border border-border">{empty}</div> : null;
  return (
    <div className="rounded-sm border border-border divide-y divide-border max-h-64 overflow-y-auto">
      {matches.map((m) => (
        <button
          key={m.mlsNumber ?? m.address}
          type="button"
          onClick={() => onPick(m)}
          className="w-full text-left px-3 py-2 hover:bg-secondary/50 flex items-center gap-3"
          data-testid={`deal-listing-${m.mlsNumber}`}
        >
          {m.photoUrl ? <img src={m.photoUrl} alt="" className="w-14 h-10 object-cover rounded-sm shrink-0 bg-secondary" loading="lazy" /> : <div className="w-14 h-10 rounded-sm bg-secondary shrink-0" />}
          <div className="min-w-0">
            <div className="text-[13px] truncate">{m.address}</div>
            <div className="text-[12px] text-muted-foreground truncate">
              {[m.summary, m.mlsNumber && `MLS® ${m.mlsNumber}`, m.status && m.status !== "Active" ? m.status : null].filter(Boolean).join(" · ")}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

/** A search box that resolves to one listing. */
export function ListingSearch({ onPick, placeholder, autoFocus }: { onPick: (l: PickedListing) => void; placeholder?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const { typed, mls, matches, searching } = useListingMatches(q);
  return (
    <div className="space-y-1.5">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder ?? "Address or MLS® number, e.g. 48 Glamis Green SW"}
        autoFocus={autoFocus}
        data-testid="input-deal-property"
      />
      {typed.length >= 3 ? (
        searching && !matches.length ? (
          <div className="px-3 py-2 text-[12px] text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Searching listings…
          </div>
        ) : (
          <ListingMatches
            matches={matches}
            onPick={(l) => {
              setQ("");
              onPick(l);
            }}
            empty={mls ? `No listing found for MLS® ${typed.toUpperCase()}.` : "No listings match that address."}
          />
        )
      ) : null}
    </div>
  );
}
