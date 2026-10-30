// "My MLS® listings" on /admin/listings: every Pillar 9 listing Spencer's
// agent ID is on (server/my-listings.ts), each opening its asset studio.

import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bath, Bed, ImageOff, Maximize, RefreshCw, Search, Sparkles } from "lucide-react";
import { apiErrorMessage, apiRequest } from "@/lib/queryClient";
import { useAuthedImage } from "@/lib/authed-blob";
import { formatPriceCompact, timeAgoShort } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

export interface MyListing {
  id: string;
  listingKey: number | null;
  role: "list" | "co-list" | "buyer";
  status: string;
  listPrice: number | null;
  originalListPrice: number | null;
  closePrice: number | null;
  closeDate: string | null;
  listDate: string | null;
  statusChangedAt: string | null;
  daysOnMarket: number | null;
  address: string;
  city: string | null;
  postalCode: string | null;
  community: string | null;
  propertyType: string | null;
  propertySubType: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  lotSqft: number | null;
  yearBuilt: number | null;
  garageSpaces: number | null;
  condoFee: number | null;
  photoCount: number;
  remarks: string | null;
  syncedAt: string;
  missingSince: string | null;
}

interface MyListingsResponse {
  agentId: string;
  connected: boolean;
  syncing: boolean;
  lastSync: { status: string; finishedAt: string | null; startedAt: string; error: string | null; fields: string | null } | null;
  listings: MyListing[];
}

export const ROLE_LABEL: Record<MyListing["role"], string> = { list: "Listing agent", "co-list": "Co-listing", buyer: "Buyer side" };

export const MY_STATUS_STYLES: Record<string, string> = {
  Active: "bg-foreground text-background border-transparent",
  "Coming Soon": "bg-foreground text-background border-transparent",
  Pending: "bg-secondary text-foreground border-border",
  Sold: "bg-[#D4AF37] text-black border-transparent",
};

export function streetOf(address: string): string {
  return address.split(",")[0].trim().replace(/\b([a-z])([a-z]+)\b/g, (_m, f: string, r: string) => f.toUpperCase() + r);
}

/** "SPRINGBANK HILL" → "Springbank Hill": the feed sends community names in capitals. */
export function placeOf(l: Pick<MyListing, "community" | "city">, extra: Array<string | null> = []): string {
  const tc = (v: string | null) => (v ? v.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null);
  return [tc(l.community), tc(l.city), ...extra].filter(Boolean).join(" · ");
}

export function ListingPhoto({ listing, index = 0, className }: { listing: MyListing; index?: number; className?: string }) {
  const { url } = useAuthedImage(listing.photoCount > index ? `/api/admin/my-listings/${listing.id}/photo/${index}` : null);
  if (!url) {
    return (
      <div className={`flex items-center justify-center bg-secondary text-muted-foreground ${className ?? ""}`}>
        <ImageOff className="w-5 h-5" strokeWidth={1.4} />
      </div>
    );
  }
  return <img src={url} alt="" className={`object-cover ${className ?? ""}`} />;
}

const FILTERS = ["all", "Active", "Pending", "Sold", "other"] as const;

export function MyMlsListings() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [role, setRole] = useState<"all" | MyListing["role"]>("all");
  const [query, setQuery] = useState("");
  const { data, isLoading } = useQuery<MyListingsResponse>({ queryKey: ["/api/admin/my-listings"] });

  const sync = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/my-listings/sync")).json(),
    onSuccess: () => toast({ title: "Pulled your listings from Pillar 9" }),
    onError: (e) => toast({ title: "Sync failed", description: apiErrorMessage(e), variant: "destructive" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["/api/admin/my-listings"] }),
  });

  const listings = (data?.listings ?? []).filter((l) => {
    if (filter === "other" ? ["Active", "Pending", "Sold"].includes(l.status) : filter !== "all" && l.status !== filter) return false;
    if (role !== "all" && l.role !== role) return false;
    if (query && !`${l.address} ${l.community ?? ""} ${l.city ?? ""} ${l.id}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const last = data?.lastSync;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.6} />
          <Input
            placeholder="Search by address, community or MLS® #…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 rounded-sm"
            data-testid="input-search-my-listings"
          />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as any)}>
          <SelectTrigger className="w-[150px] rounded-sm" data-testid="select-my-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="Active">Active</SelectItem>
            <SelectItem value="Pending">Pending</SelectItem>
            <SelectItem value="Sold">Sold</SelectItem>
            <SelectItem value="other">Expired / other</SelectItem>
          </SelectContent>
        </Select>
        <Select value={role} onValueChange={(v) => setRole(v as any)}>
          <SelectTrigger className="w-[150px] rounded-sm" data-testid="select-my-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sides</SelectItem>
            <SelectItem value="list">Listing agent</SelectItem>
            <SelectItem value="co-list">Co-listing</SelectItem>
            <SelectItem value="buyer">Buyer side</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          className="rounded-sm font-display tracking-[0.14em] text-[11px]"
          onClick={() => sync.mutate()}
          disabled={sync.isPending || data?.syncing}
          data-testid="button-sync-my-listings"
        >
          <RefreshCw className={`w-4 h-4 mr-1.5 ${sync.isPending || data?.syncing ? "animate-spin" : ""}`} /> SYNC PILLAR 9
        </Button>
      </div>

      <div className="text-xs text-muted-foreground">
        Pillar 9 agent ID <span className="font-mono text-foreground">{data?.agentId ?? "…"}</span>
        {last && (
          <>
            {" · "}last sync {timeAgoShort(last.finishedAt ?? last.startedAt)}
            {last.status === "error" && <span className="text-destructive"> · failed: {last.error}</span>}
          </>
        )}
        {data && !data.connected && <span className="text-destructive"> · Pillar 9 credentials aren't set on the server</span>}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <Skeleton className="aspect-[4/3] w-full" />
              <CardContent className="p-4 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : listings.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="eyebrow text-muted-foreground mb-3">{data?.listings.length ? "NO MATCHES" : "NOTHING YET"}</div>
            <div className="font-serif text-xl mb-2">
              {data?.listings.length ? "No listings match those filters" : `No Pillar 9 listings for ${data?.agentId ?? "your agent ID"} yet`}
            </div>
            <p className="text-sm text-muted-foreground">
              {data?.listings.length ? "Try a different status or clear your search." : "Run a sync to pull them in."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
          {listings.map((l) => {
            const price = l.status === "Sold" && l.closePrice ? l.closePrice : l.listPrice;
            return (
              <Link key={l.id} href={`/admin/listings/mls/${encodeURIComponent(l.id)}`} className="block group" data-testid={`my-listing-${l.id}`}>
                <Card className="overflow-hidden hover:shadow-md transition-shadow rounded-sm h-full">
                  <div className="aspect-[4/3] relative overflow-hidden bg-secondary">
                    <ListingPhoto listing={l} className="w-full h-full group-hover:scale-[1.03] transition-transform duration-700" />
                    <div className="absolute top-3 left-3 flex gap-2">
                      <Badge className={`rounded-sm font-display tracking-[0.14em] text-[10px] px-2 py-0.5 ${MY_STATUS_STYLES[l.status] ?? "bg-muted text-muted-foreground border-border"}`}>
                        {l.status.toUpperCase()}
                      </Badge>
                      {l.role !== "list" && (
                        <Badge variant="outline" className="rounded-sm bg-background/80 text-[10px] px-2 py-0.5">
                          {ROLE_LABEL[l.role]}
                        </Badge>
                      )}
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between text-white">
                      <div className="font-serif text-2xl drop-shadow">{price ? formatPriceCompact(price) : ""}</div>
                      <div className="flex gap-3 text-xs items-center bg-black/40 backdrop-blur px-2.5 py-1 rounded-sm">
                        {l.beds != null && <span className="flex items-center gap-1"><Bed className="w-3 h-3" strokeWidth={1.6} />{l.beds}</span>}
                        {l.baths != null && <span className="flex items-center gap-1"><Bath className="w-3 h-3" strokeWidth={1.6} />{l.baths}</span>}
                        {l.sqft != null && <span className="flex items-center gap-1 tabular-nums"><Maximize className="w-3 h-3" strokeWidth={1.6} />{l.sqft.toLocaleString()}</span>}
                      </div>
                    </div>
                  </div>
                  <CardContent className="p-4">
                    <div className="font-serif text-[17px] text-foreground truncate">{streetOf(l.address)}</div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {placeOf(l)} · MLS® {l.id}
                    </div>
                    <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                      <span className="flex items-center gap-1 text-foreground">
                        <Sparkles className="w-3 h-3" strokeWidth={1.6} /> Create assets
                      </span>
                      <span className="font-display tracking-[0.08em] text-[10px]">
                        {l.status === "Sold" && l.closeDate ? `SOLD ${l.closeDate}` : l.listDate ? `LISTED ${l.listDate}` : ""}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
