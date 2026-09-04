import { ReactNode, useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Logo } from "@/components/logo";
import { useTheme } from "@/components/theme-provider";
import { Menu, X, Sun, Moon, Phone, User, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SPENCER_PHONE, SPENCER_PHONE_HREF } from "@/lib/format";
import { useAccount } from "@/lib/account";

interface NavItem {
  label: string;
  href: string;
}

const NAV: NavItem[] = [
  { label: "MLS Search", href: "/mls" },
  { label: "Neighbourhoods", href: "/neighbourhoods" },
  { label: "Condos", href: "/condos" },
  { label: "Assignments", href: "/assignments" },
  { label: "About", href: "/about" },
  { label: "Journal", href: "/blog" },
  { label: "Contact", href: "/contact" },
];

// Audience-segment landing pages. Slugs must match AUDIENCE_SEGMENTS in
// client/src/pages/work-with.tsx (not imported from there — that file imports
// PublicLayout, and we don't want the circular dependency).
const WORK_WITH_LINKS: NavItem[] = [
  { label: "Luxury Properties", href: "/work-with/luxury-properties" },
  { label: "First-Time Home Sellers", href: "/work-with/first-time-home-sellers" },
  { label: "Expired & Frustrated Sellers", href: "/work-with/expired-listings" },
  { label: "Empty Nesters", href: "/work-with/empty-nesters" },
  { label: "First-Time Home Buyers", href: "/work-with/first-time-home-buyers" },
  { label: "Innercity Properties", href: "/work-with/innercity-properties" },
  { label: "Move-Ups", href: "/work-with/move-ups" },
  { label: "Family-Focused Properties", href: "/work-with/family-focused-properties" },
  { label: "Urban Properties", href: "/work-with/urban-properties" },
];

function NavLink({
  item,
  active,
  invert = false,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  invert?: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={item.href}
      data-testid={`nav-public-${item.label.toLowerCase().replace(/\s/g, "-")}`} onClick={onClick}
        className={`relative whitespace-nowrap font-display text-[11px] tracking-[0.22em] py-1 transition-opacity ${
          invert ? "text-white" : "text-foreground"
        } ${active ? "opacity-100" : "opacity-65 hover:opacity-100"}`}
        style={{ fontWeight: active ? 600 : 500 }}>
        {item.label.toUpperCase()}
        {active && (
          <span
            className={`absolute -bottom-1 left-0 right-0 h-px ${invert ? "bg-white" : "bg-foreground"}`}
          />
        )}
      
    </Link>
  );
}

/** Desktop "Work With" nav item — links to /work-with, with a hover/focus
 *  dropdown listing the eight audience-segment landing pages. */
function WorkWithNav({ active, invert }: { active: boolean; invert: boolean }) {
  return (
    <div className="relative group">
      <NavLink
        item={{ label: "Work With", href: "/work-with" }}
        active={active}
        invert={invert}
      />
      {/* pt-3 bridges the hover gap between the trigger and the panel */}
      <div className="absolute left-1/2 -translate-x-1/2 top-full pt-3 hidden group-hover:block group-focus-within:block z-50">
        <div className="w-72 bg-background border border-border rounded-sm shadow-lg py-2">
          {WORK_WITH_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="block px-5 py-2 font-display text-[10.5px] tracking-[0.16em] text-foreground/70 hover:text-foreground hover:bg-secondary/60 transition-colors"
                data-testid={`nav-workwith-${l.href.split("/").pop()}`}>
                {l.label.toUpperCase()}
              
            </Link>
          ))}
          <div className="mt-2 pt-2 border-t border-border">
            <Link href="/work-with" className="block px-5 py-2 font-display text-[10.5px] tracking-[0.16em] text-foreground hover:bg-secondary/60 transition-colors"
                data-testid="nav-workwith-all">
                VIEW ALL →
              
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PublicHeader({ transparent = false }: { transparent?: boolean }) {
  const [location] = useLocation();
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  const matches = (href: string) => {
    if (href === "/") return location === "/";
    return location === href || location.startsWith(href);
  };

  // The transparent variant is only used over a dark hero — keep header dark
  // text styles when scrolled past or on subpages.
  // Track scroll: when the page has scrolled past the hero, switch the
  // transparent header to the solid styling so the dark text stays legible.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!transparent) return;
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [transparent]);

  const isOverlay = transparent && !scrolled;
  const baseBg = isOverlay
    ? "bg-transparent"
    : "bg-background/85 backdrop-blur border-b border-border";
  const positioning = transparent ? "fixed top-0 left-0 right-0" : "sticky top-0";

  return (
    <header
      className={`${positioning} z-40 ${baseBg} transition-colors`}
      data-testid="public-header"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 h-16 lg:h-20 flex items-center gap-4 2xl:gap-6">
        <Link href="/" data-testid="link-home-logo" className="flex items-center gap-3 shrink-0">
            <Logo
              layout="row"
              size={36}
              invert={isOverlay}
            />
          
        </Link>

        <nav className="hidden lg:flex items-center gap-5 2xl:gap-7 ml-5">
          {NAV.slice(0, 3).map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={matches(item.href)}
              invert={isOverlay}
            />
          ))}
          <WorkWithNav active={matches("/work-with")} invert={isOverlay} />
          {NAV.slice(3).map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={matches(item.href)}
              invert={isOverlay}
            />
          ))}
        </nav>

        <div className="flex-1" />

        <a
          href={SPENCER_PHONE_HREF}
          className={`hidden md:inline-flex items-center gap-2 whitespace-nowrap font-display text-[11px] tracking-[0.18em] ${
            isOverlay ? "text-white" : "text-foreground"
          }`}
          data-testid="link-call-spencer"
        >
          <Phone className="w-3.5 h-3.5" strokeWidth={1.6} />
          {/* Icon-only between lg and xl — the 7-item nav needs the room */}
          <span className="lg:hidden xl:inline">{SPENCER_PHONE}</span>
        </a>

        {/* Booking CTA. A bordered button rather than an eighth nav link —
            the nav row is already at its width budget at lg. */}
        <Link
          href="/book"
          data-testid="link-book-header"
          className={`hidden md:inline-flex items-center gap-2 whitespace-nowrap font-display text-[11px] tracking-[0.18em] border px-3 py-1.5 rounded-sm transition-colors ${
            isOverlay
              ? "text-white border-white/50 hover:bg-white/10"
              : "text-foreground border-border hover:bg-secondary/60"
          }`}
        >
          <CalendarClock className="w-3.5 h-3.5" strokeWidth={1.6} />
          <span className="lg:hidden xl:inline">BOOK</span>
        </Link>

        <AccountHeaderLink invert={isOverlay} />

        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          className={`rounded-full hidden md:inline-flex ${isOverlay ? "text-white hover:bg-white/10 hover:text-white" : ""}`}
          aria-label="Toggle theme"
          data-testid="button-public-theme-toggle"
        >
          {theme === "dark" ? (
            <Sun className="w-4 h-4" strokeWidth={1.6} />
          ) : (
            <Moon className="w-4 h-4" strokeWidth={1.6} />
          )}
        </Button>

        <button
          className={`lg:hidden p-2 ${isOverlay ? "text-white" : "text-foreground"}`}
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
          data-testid="button-mobile-menu"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden border-t border-border bg-background">
          <div className="px-6 py-5 flex flex-col gap-4">
            {NAV.slice(0, 3).map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={matches(item.href)}
                onClick={() => setMobileOpen(false)}
              />
            ))}
            <NavLink
              item={{ label: "Work With", href: "/work-with" }}
              active={matches("/work-with")}
              onClick={() => setMobileOpen(false)}
            />
            {NAV.slice(3).map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={matches(item.href)}
                onClick={() => setMobileOpen(false)}
              />
            ))}
            <Link
              href="/book"
              onClick={() => setMobileOpen(false)}
              data-testid="link-book-mobile"
              className="font-display text-[11px] tracking-[0.18em] text-foreground inline-flex items-center gap-2 pt-3 border-t border-border"
            >
              <CalendarClock className="w-3.5 h-3.5" strokeWidth={1.6} />
              BOOK A TIME
            </Link>
            <a
              href={SPENCER_PHONE_HREF}
              className="font-display text-[11px] tracking-[0.18em] text-foreground inline-flex items-center gap-2"
            >
              <Phone className="w-3.5 h-3.5" strokeWidth={1.6} />
              {SPENCER_PHONE}
            </a>
            <AccountMobileLink onClick={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
    </header>
  );
}

/** Desktop header account link. Signed out → "Sign in" link; signed in
 *  → "Account" link to the dashboard. Hidden until the auth query resolves
 *  to avoid a "Sign in" → "Account" flash on every page load. */
function AccountHeaderLink({ invert }: { invert: boolean }) {
  const { data: me, isLoading } = useAccount();
  if (isLoading) return null;
  const href = me ? "/account/dashboard" : "/account/login";
  const label = me ? "Account" : "Sign in";
  return (
    <Link href={href} data-testid="link-account-header" className={`hidden md:inline-flex items-center gap-2 whitespace-nowrap font-display text-[11px] tracking-[0.18em] ${
          invert ? "text-white" : "text-foreground"
        }`}>
        <User className="w-3.5 h-3.5" strokeWidth={1.6} />
        <span className="lg:hidden xl:inline">{label}</span>
      
    </Link>
  );
}

/** Mobile drawer variant of the account link. */
function AccountMobileLink({ onClick }: { onClick: () => void }) {
  const { data: me, isLoading } = useAccount();
  if (isLoading) return null;
  const href = me ? "/account/dashboard" : "/account/login";
  const label = me ? "Account" : "Sign in";
  return (
    <Link href={href} onClick={onClick}
        className="font-display text-[11px] tracking-[0.18em] text-foreground inline-flex items-center gap-2"
        data-testid="link-account-mobile">
        <User className="w-3.5 h-3.5" strokeWidth={1.6} />
        {label}
      
    </Link>
  );
}

export function PublicFooter() {
  return (
    <footer
      className="bg-black text-white"
      data-testid="public-footer"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-16 lg:py-20 grid grid-cols-1 md:grid-cols-12 gap-10">
        <div className="md:col-span-4">
          <Logo layout="stack" size={48} invert />
          <p className="mt-6 max-w-md text-sm leading-relaxed text-white/65">
            Spencer Rivers represents buyers and sellers in Calgary's
            most established luxury communities — Springbank Hill, Aspen
            Woods, Upper Mount Royal, Elbow Park, Britannia, and Bel-Aire.
          </p>
          <div className="mt-8 flex flex-col gap-2 text-[13px] text-white/75">
            <a
              href={SPENCER_PHONE_HREF}
              className="hover:text-white transition-colors inline-flex items-center gap-2"
              data-testid="footer-phone"
            >
              <Phone className="w-3.5 h-3.5" strokeWidth={1.6} />
              {SPENCER_PHONE}
            </a>
            <a
              href="mailto:spencer@riversrealestate.ca"
              className="hover:text-white transition-colors"
              data-testid="footer-email"
            >
              spencer@riversrealestate.ca
            </a>
          </div>
        </div>

        <div className="md:col-span-2">
          <div className="font-display text-[10px] tracking-[0.22em] text-white/55 mb-4">
            EXPLORE
          </div>
          <ul className="space-y-2.5 text-[13px] text-white/75">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="hover:text-white transition-colors">{n.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="md:col-span-3">
          <div className="font-display text-[10px] tracking-[0.22em] text-white/55 mb-4">
            WHO WE WORK WITH
          </div>
          <ul className="space-y-2.5 text-[13px] text-white/75">
            {WORK_WITH_LINKS.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="hover:text-white transition-colors"
                    data-testid={`footer-workwith-${n.href.split("/").pop()}`}>
                    {n.label}
                  
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="md:col-span-3">
          <div className="font-display text-[10px] tracking-[0.22em] text-white/55 mb-4">
            BROKERAGE
          </div>
          <div className="text-[13px] text-white/75 leading-relaxed">
            Synterra Realty
            <br />
            Calgary, Alberta
            <br />
            <span className="text-white/55">REALTOR® | CLHMS, CNE, CIPS, CCS, LLS</span>
            <br />
            <span className="text-white/55">Million Dollar Guild</span>
          </div>
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-[11px] text-white/45 font-display tracking-[0.14em]">
          <div>© {new Date().getFullYear()} RIVERS REAL ESTATE · ALL RIGHTS RESERVED</div>
          <div className="flex gap-6">
            <span>LUXURYHOMESCALGARY.CA</span>
            <Link href="/admin" className="hover:text-white/80 transition-colors"
                data-testid="footer-link-admin">
                AGENT LOGIN
              
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function PublicLayout({
  children,
  transparentHeader = false,
  fullBleed = false,
}: {
  children: ReactNode;
  transparentHeader?: boolean;
  fullBleed?: boolean;
}) {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
      <PublicHeader transparent={transparentHeader} />
      <main
        className={fullBleed ? "flex-1 w-full" : "flex-1"}
        data-testid="public-main"
      >
        {children}
      </main>
      {!fullBleed && <PublicFooter />}
    </div>
  );
}
