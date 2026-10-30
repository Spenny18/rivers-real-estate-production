import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Eye,
  Plus,
  Search,
  Bed,
  Bath,
  Maximize,
  Grid3x3,
  List as ListIcon,
} from "lucide-react";
import { formatPriceCompact, timeAgo } from "@/lib/mock-data";
import type { PublicListing } from "@/lib/types";
import { MyMlsListings } from "@/components/my-mls-listings";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-foreground text-background border-transparent",
  draft: "bg-secondary text-foreground border-border",
  sold: "bg-muted text-muted-foreground border-border line-through",
  pending: "bg-secondary text-foreground border-border",
};

const TAB_KEY = "rivers.listings.tab";

export default function ListingsPage() {
  // My Pillar 9 listings first; the site's hand-built listings on the other tab.
  const [tab, setTabState] = useState<"mls" | "site">(() => {
    try {
      return window.localStorage.getItem(TAB_KEY) === "site" ? "site" : "mls";
    } catch {
      return "mls";
    }
  });
  const setTab = (t: "mls" | "site") => {
    setTabState(t);
    try {
      window.localStorage.setItem(TAB_KEY, t);
    } catch {}
  };
  const [view, setView] = useState<"grid" | "list">("grid");
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const { data: listings = [], isLoading } = useQuery<PublicListing[]>({
    queryKey: ["/api/listings"],
  });

  const filtered = listings.filter((l) => {
    if (filter !== "all" && l.status !== filter) return false;
    if (
      query &&
      !`${l.title} ${l.address} ${l.neighbourhood}`.toLowerCase().includes(query.toLowerCase())
    )
      return false;
    return true;
  });

  return (
    <AppShell
      pageTitle="Listings"
      pageActions={
        <Link href="/admin/listings/new">
          <Button className="rounded-sm font-display tracking-[0.16em] text-[11px]" data-testid="button-new-listing">
            <Plus className="w-4 h-4 mr-1.5" /> NEW LISTING
          </Button>
        </Link>
      }
    >
      <div className="px-8 py-7 space-y-6">
        <div className="inline-flex p-1 bg-secondary rounded-sm gap-0.5" role="tablist">
          {(
            [
              ["mls", "MY MLS® LISTINGS"],
              ["site", "SITE LISTINGS"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              role="tab"
              aria-selected={tab === id}
              variant={tab === id ? "default" : "ghost"}
              className="h-8 rounded-sm font-display tracking-[0.14em] text-[11px]"
              onClick={() => setTab(id)}
              data-testid={`tab-listings-${id}`}
            >
              {label}
            </Button>
          ))}
        </div>

        {tab === "mls" ? (
          <MyMlsListings />
        ) : (
        <>
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.6} />
            <Input
              placeholder="Search by address, neighbourhood, or title…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9 rounded-sm"
              data-testid="input-search-listings"
            />
          </div>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[160px] rounded-sm" data-testid="select-status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All listings</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="sold">Sold</SelectItem>
            </SelectContent>
          </Select>
          <div className="inline-flex p-1 bg-secondary rounded-sm gap-0.5">
            <Button
              variant={view === "grid" ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView("grid")}
              data-testid="button-view-grid"
              aria-label="Grid view"
            >
              <Grid3x3 className="w-4 h-4" strokeWidth={1.6} />
            </Button>
            <Button
              variant={view === "list" ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView("list")}
              data-testid="button-view-list"
              aria-label="List view"
            >
              <ListIcon className="w-4 h-4" strokeWidth={1.6} />
            </Button>
          </div>
        </div>

        {/* Listings */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Card key={i}>
                <div className="aspect-[4/3] bg-muted">
                  <Skeleton className="w-full h-full" />
                </div>
                <CardContent className="p-4 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {filtered.map((l) => (
              <Link key={l.id} href={`/admin/listings/${l.id}`} data-testid={`listing-card-${l.id}`} className="block group">
                  <Card className="overflow-hidden hover:shadow-md transition-shadow rounded-sm">
                    <div className="aspect-[4/3] relative overflow-hidden bg-secondary">
                      <img
                        src={l.heroImage}
                        alt={l.title}
                        className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-700"
                      />
                      <div className="absolute top-3 left-3 flex gap-2">
                        <Badge className={`capitalize rounded-sm font-display tracking-[0.14em] text-[10px] px-2 py-0.5 ${STATUS_STYLES[l.status]}`}>
                          {l.status.toUpperCase()}
                        </Badge>
                      </div>
                      <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between text-white">
                        <div>
                          <div className="font-serif text-2xl drop-shadow" style={{ letterSpacing: "-0.01em" }}>
                            {formatPriceCompact(l.price)}
                          </div>
                        </div>
                        <div className="flex gap-3 text-xs items-center bg-black/40 backdrop-blur px-2.5 py-1 rounded-sm">
                          <span className="flex items-center gap-1"><Bed className="w-3 h-3" strokeWidth={1.6} />{l.beds}</span>
                          <span className="flex items-center gap-1"><Bath className="w-3 h-3" strokeWidth={1.6} />{l.baths}</span>
                          <span className="flex items-center gap-1 tabular-nums"><Maximize className="w-3 h-3" strokeWidth={1.6} />{l.sqft.toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                    <CardContent className="p-4">
                      <div className="font-serif text-[17px] text-foreground truncate">{l.title}</div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {l.address} · {l.neighbourhood}
                      </div>
                      <div className="mt-3 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <span className="flex items-center gap-1"><Eye className="w-3 h-3" strokeWidth={1.6} />{l.views.toLocaleString()}</span>
                        </div>
                        <span className="text-muted-foreground/70 font-display tracking-[0.08em] text-[10px]">{timeAgo(l.createdAt).toUpperCase()}</span>
                      </div>
                    </CardContent>
                  </Card>
                
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="font-display tracking-[0.14em] text-[10px] text-muted-foreground bg-secondary/40">
                  <tr>
                    <th className="text-left px-5 py-3">PROPERTY</th>
                    <th className="text-left px-3 py-3">STATUS</th>
                    <th className="text-right px-3 py-3">PRICE</th>
                    <th className="text-right px-3 py-3">BEDS · BATHS</th>
                    <th className="text-right px-3 py-3">SQ FT</th>
                    <th className="text-right px-3 py-3">VIEWS</th>
                    <th className="text-right px-5 py-3">UPDATED</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => (
                    <tr key={l.id} className="border-t border-border hover:bg-secondary/40 transition-colors">
                      <td className="px-5 py-3">
                        <Link href={`/admin/listings/${l.id}`} data-testid={`listing-row-${l.id}`} className="flex items-center gap-3">
                            <img src={l.heroImage} alt="" className="w-12 h-9 rounded-sm object-cover" />
                            <div className="min-w-0">
                              <div className="font-serif text-[15px] truncate text-foreground">{l.title}</div>
                              <div className="text-xs text-muted-foreground truncate">{l.address}</div>
                            </div>
                          
                        </Link>
                      </td>
                      <td className="px-3 py-3">
                        <Badge className={`capitalize rounded-sm font-display tracking-[0.14em] text-[10px] px-2 py-0.5 ${STATUS_STYLES[l.status]}`}>
                          {l.status.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-right font-serif tabular-nums">{formatPriceCompact(l.price)}</td>
                      <td className="px-3 py-3 text-right text-muted-foreground tabular-nums">{l.beds} · {l.baths}</td>
                      <td className="px-3 py-3 text-right text-muted-foreground tabular-nums">{l.sqft.toLocaleString()}</td>
                      <td className="px-3 py-3 text-right text-muted-foreground tabular-nums">{l.views.toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-muted-foreground font-display tracking-[0.08em] text-[11px]">{timeAgo(l.createdAt).toUpperCase()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {!isLoading && filtered.length === 0 && (
          <Card>
            <CardContent className="p-12 text-center">
              <div className="eyebrow text-muted-foreground mb-3">EMPTY</div>
              <div className="font-serif text-xl mb-2">No listings match those filters</div>
              <p className="text-sm text-muted-foreground">Try a different status or clear your search.</p>
            </CardContent>
          </Card>
        )}
        </>
        )}
      </div>
    </AppShell>
  );
}
