import { Link } from "wouter";
import { Heart, Search, FileText, Calendar, BarChart3, LogOut, FileSignature } from "lucide-react";
import { PublicLayout } from "@/components/public-layout";
import { useAccount, useLogout, useFavorites, useSavedSearches, useNotes, useTours, useMarketReports, usePortalDocuments } from "@/lib/account";

const CARDS: Array<{
  href: string;
  icon: typeof Heart;
  label: string;
  description: string;
  phase: "live" | "soon";
}> = [
  {
    href: "/account/favorites",
    icon: Heart,
    label: "Favourites",
    description: "Listings you've heart-saved while browsing.",
    phase: "live",
  },
  {
    href: "/account/searches",
    icon: Search,
    label: "Saved searches",
    description: "Filter sets that email you when new matches hit the market.",
    phase: "live",
  },
  {
    href: "/account/tours",
    icon: Calendar,
    label: "Property tours",
    description: "Tour requests and confirmed showings.",
    phase: "live",
  },
  {
    href: "/account/notes",
    icon: FileText,
    label: "Notes",
    description: "Private notes on properties you're considering.",
    phase: "live",
  },
  {
    href: "/account/reports",
    icon: BarChart3,
    label: "Market reports",
    description: "Recurring digests for your neighbourhoods.",
    phase: "live",
  },
  {
    href: "/account/calendar",
    icon: Calendar,
    label: "Calendar",
    description: "Month-view of your tour schedule.",
    phase: "live",
  },
  {
    href: "/account/documents",
    icon: FileSignature,
    label: "Documents",
    description: "Contracts to sign and your completed copies.",
    phase: "live",
  },
];

export default function AccountDashboardPage() {
  const { data: me, isLoading } = useAccount();
  const { data: favorites } = useFavorites();
  const { data: searches } = useSavedSearches();
  const { data: notes } = useNotes();
  const { data: tours } = useTours();
  const { data: reports } = useMarketReports();
  const { data: portalDocs } = usePortalDocuments();
  const logout = useLogout();
  const docsToSign = (portalDocs ?? []).filter((d) => d.status === "sent" && d.canSignNow && d.signerStatus !== "signed").length;
  const pendingTours = (tours ?? []).filter((t) => t.status === "requested" || t.status === "confirmed").length;
  const activeReports = (reports ?? []).filter((r) => r.active).length;

  if (isLoading) {
    return (
      <PublicLayout>
        <div className="max-w-3xl mx-auto px-6 py-32 text-center text-muted-foreground">
          Loading…
        </div>
      </PublicLayout>
    );
  }

  if (!me) {
    if (typeof window !== "undefined") window.location.href = "/account/login";
    return null;
  }

  return (
    <PublicLayout>
      <section className="max-w-5xl mx-auto px-6 lg:px-10 pt-16 pb-24">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="font-display text-[11px] tracking-[0.32em] text-muted-foreground">
              YOUR PORTAL
            </div>
            <h1 className="mt-3 font-serif text-[40px] lg:text-[52px] leading-[1.05]">
              Welcome back.
            </h1>
            <p className="mt-3 text-muted-foreground text-[15px]">
              Signed in as {me.email}
            </p>
          </div>
          <button
            onClick={() => logout.mutate()}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="btn-account-logout"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {CARDS.map((card) => {
            const Icon = card.icon;
            const isFavorites = card.href === "/account/favorites";
            return (
              <Link key={card.href} href={card.href} className={`group block rounded-sm border border-border p-6 transition-colors ${
                    card.phase === "live"
                      ? "hover:border-foreground hover:bg-muted/30"
                      : "opacity-60 cursor-not-allowed"
                  }`}
                  onClick={(e) => {
                    if (card.phase !== "live") e.preventDefault();
                  }}
                  data-testid={`card-${card.href.replace("/account/", "")}`}>
                  <div className="flex items-center justify-between">
                    <Icon className="w-5 h-5" strokeWidth={1.5} />
                    {card.phase === "soon" && (
                      <span className="font-display text-[9px] tracking-[0.22em] text-muted-foreground">
                        SOON
                      </span>
                    )}
                  </div>
                  <div className="mt-4 font-serif text-xl">{card.label}</div>
                  <div className="mt-1 text-sm text-muted-foreground leading-relaxed">
                    {card.description}
                  </div>
                  {isFavorites && (
                    <div className="mt-4 font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                      {favorites?.length ?? 0} SAVED
                    </div>
                  )}
                  {card.href === "/account/searches" && card.phase === "live" && (
                    <div className="mt-4 font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                      {searches?.length ?? 0} ACTIVE
                    </div>
                  )}
                  {card.href === "/account/notes" && card.phase === "live" && (
                    <div className="mt-4 font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                      {notes?.length ?? 0} SAVED
                    </div>
                  )}
                  {card.href === "/account/tours" && card.phase === "live" && (
                    <div className="mt-4 font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                      {pendingTours} UPCOMING
                    </div>
                  )}
                  {card.href === "/account/reports" && card.phase === "live" && (
                    <div className="mt-4 font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                      {activeReports} ACTIVE
                    </div>
                  )}
                  {card.href === "/account/documents" && (
                    <div className={`mt-4 font-display text-[10px] tracking-[0.22em] ${docsToSign ? "text-amber-700" : "text-muted-foreground"}`}>
                      {docsToSign} TO SIGN
                    </div>
                  )}
                
              </Link>
            );
          })}
        </div>
      </section>
    </PublicLayout>
  );
}
