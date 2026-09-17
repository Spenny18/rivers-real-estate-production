import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Logo } from "@/components/logo";
import { useTheme } from "@/components/theme-provider";
import {
  LayoutDashboard,
  Search,
  Bell,
  Sun,
  Moon,
  LogOut,
  Database,
  Globe,
  Calendar,
  BarChart3,
  Bookmark,
  Building2,
  FileText,
  MapPinned,
  LayoutTemplate,
  Target,
  CalendarClock,
  Contact,
  TrendingUp,
  FileBarChart,
  FileSignature,
  FileStack,
  Mail,
  Briefcase,
  ChevronDown,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";

interface NavItem {
  label: string;
  icon: typeof LayoutDashboard;
  href: string;
  badge?: string | number;
}

/**
 * A top-level sidebar entry. Entries with `children` render as a collapsible
 * group; the children are revealed when the parent row is clicked. A group
 * may optionally have its own `href` (e.g. Calendar), in which case clicking
 * the label navigates there and opens the group, while the chevron only
 * toggles the group.
 */
interface NavGroup {
  label: string;
  icon: typeof LayoutDashboard;
  href?: string;
  children?: NavItem[];
}

const primaryNav: NavGroup[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/admin/dashboard" },
  {
    label: "Calendar",
    icon: Calendar,
    href: "/admin/calendar",
    children: [
      { label: "Scheduling", icon: CalendarClock, href: "/admin/scheduling" },
    ],
  },
  { label: "CRM", icon: Contact, href: "/admin/crm" },
  {
    label: "Transactions",
    icon: Briefcase,
    children: [
      { label: "Forms", icon: FileStack, href: "/admin/forms" },
      { label: "Deals & E-Sign", icon: FileSignature, href: "/admin/deals" },
    ],
  },
  {
    label: "Market Report",
    icon: TrendingUp,
    href: "/admin/market",
    children: [
      { label: "Community Reports", icon: FileBarChart, href: "/admin/market-reports" },
    ],
  },
  { label: "Newsletter", icon: Mail, href: "/admin/newsletter" },
  { label: "Analytics", icon: BarChart3, href: "/admin/analytics" },
  {
    label: "Website",
    icon: Globe,
    children: [
      { label: "Saved Searches", icon: Bookmark, href: "/admin/saved-searches" },
      { label: "Home Page CMS", icon: LayoutTemplate, href: "/admin/home" },
      { label: "Condos CMS", icon: Building2, href: "/admin/condos" },
      { label: "Neighbourhoods", icon: MapPinned, href: "/admin/neighbourhoods" },
      { label: "Blog CMS", icon: FileText, href: "/admin/blog" },
      { label: "SEO Keywords", icon: Target, href: "/admin/seo" },
      { label: "MLS Sync", icon: Database, href: "/admin/mls-sync" },
    ],
  },
];

const secondaryNav: NavItem[] = [
  { label: "View Public Site", icon: Globe, href: "/" },
];

const testId = (label: string) => `nav-${label.toLowerCase().replace(/\s/g, "-")}`;

/** Exact match, or a nested route under `href` (segment-aware so /admin/market
 *  does not light up for /admin/market-reports). */
function isRouteActive(location: string, href: string) {
  if (href === "/" || href === "/admin/dashboard") return location === href;
  return location === href || location.startsWith(`${href}/`);
}

function groupContainsRoute(group: NavGroup, location: string) {
  return (group.children ?? []).some((c) => isRouteActive(location, c.href));
}

/** True when the group's own page or any of its children is the current route. */
function groupOwnsRoute(group: NavGroup, location: string) {
  return (group.href ? isRouteActive(location, group.href) : false) || groupContainsRoute(group, location);
}

// Every admin page mounts its own AppShell, so expanded/collapsed state has to
// live outside the component or it resets on each navigation.
const OPEN_GROUPS_KEY = "admin-sidebar-open-groups";
function loadOpenGroups(): Set<string> {
  try {
    const raw = sessionStorage.getItem(OPEN_GROUPS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}
function saveOpenGroups(groups: Set<string>) {
  try {
    sessionStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(Array.from(groups)));
  } catch {
    /* ignore */
  }
}

const rowClass = (active: boolean) =>
  `flex items-center gap-3 px-3 py-2 rounded-sm transition-all group ${
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
  }`;

function NavLabel({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className="flex-1 font-display text-[11px] tracking-[0.16em]"
      style={{ fontWeight: active ? 600 : 500 }}
    >
      {label.toUpperCase()}
    </span>
  );
}

export function AppShell({
  children,
  pageTitle,
  pageActions,
  newLeadCount = 0,
}: {
  children: ReactNode;
  pageTitle?: string;
  pageActions?: ReactNode;
  newLeadCount?: number;
}) {
  const [location, setLocation] = useLocation();
  const { theme, toggle } = useTheme();
  const { user, signOut } = useAuth();

  // Groups the user has expanded. The group containing the current route is
  // opened automatically so the active child is never hidden.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const initial = loadOpenGroups();
    for (const g of primaryNav) if (g.children && groupOwnsRoute(g, location)) initial.add(g.label);
    return initial;
  });
  useEffect(() => {
    const owner = primaryNav.find((g) => g.children && groupOwnsRoute(g, location));
    if (owner && !openGroups.has(owner.label)) {
      setOpenGroups((prev) => new Set(prev).add(owner.label));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);
  useEffect(() => saveOpenGroups(openGroups), [openGroups]);

  const toggleGroup = (label: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  const openGroup = (label: string) =>
    setOpenGroups((prev) => (prev.has(label) ? prev : new Set(prev).add(label)));

  const badgeFor = (href: string) =>
    href === "/admin/leads" && newLeadCount > 0 ? newLeadCount : undefined;

  const renderLeaf = (item: NavItem, nested = false) => {
    const active = isRouteActive(location, item.href);
    const Icon = item.icon;
    const badge = item.badge ?? badgeFor(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        data-testid={testId(item.label)}
        className={`${rowClass(active)} ${nested ? "pl-9" : ""}`}
      >
        <Icon className={`${nested ? "w-3.5 h-3.5" : "w-4 h-4"} shrink-0`} strokeWidth={1.6} />
        <NavLabel label={item.label} active={active} />
        {badge ? (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-white text-black tabular-nums">
            {badge}
          </span>
        ) : null}
      </Link>
    );
  };

  const renderGroup = (group: NavGroup) => {
    if (!group.children?.length) {
      return renderLeaf({ label: group.label, icon: group.icon, href: group.href! });
    }
    const Icon = group.icon;
    const open = openGroups.has(group.label);
    const selfActive = group.href ? isRouteActive(location, group.href) : false;
    const childActive = groupContainsRoute(group, location);
    const chevron = (
      <ChevronDown
        className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        strokeWidth={1.6}
      />
    );
    const content = (
      <>
        <Icon className="w-4 h-4 shrink-0" strokeWidth={1.6} />
        <NavLabel label={group.label} active={selfActive || childActive} />
      </>
    );

    return (
      <div key={group.label} className="flex flex-col gap-0.5">
        {group.href ? (
          // Parent with its own page: the label navigates (and opens the
          // group); the chevron toggles without navigating.
          <div className={`${rowClass(selfActive)} ${!selfActive && childActive ? "text-sidebar-foreground" : ""}`}>
            <Link
              href={group.href}
              data-testid={testId(group.label)}
              className="flex flex-1 items-center gap-3 min-w-0"
              onClick={() => openGroup(group.label)}
            >
              {content}
            </Link>
            <button
              type="button"
              aria-label={`${open ? "Collapse" : "Expand"} ${group.label}`}
              aria-expanded={open}
              data-testid={`${testId(group.label)}-toggle`}
              className="p-1 -mr-1 rounded-sm hover:bg-sidebar-accent"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleGroup(group.label);
              }}
            >
              {chevron}
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            data-testid={testId(group.label)}
            className={`${rowClass(false)} w-full text-left ${childActive ? "text-sidebar-foreground" : ""}`}
            onClick={() => toggleGroup(group.label)}
          >
            {content}
            {chevron}
          </button>
        )}
        {open ? (
          <div className="flex flex-col gap-0.5" data-testid={`${testId(group.label)}-children`}>
            {group.children.map((child) => renderLeaf(child, true))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="grid grid-cols-[260px_1fr] grid-rows-[auto_1fr] h-[100dvh] bg-background overflow-hidden">
      {/* Sidebar — pure black, gold logo, Cinzel labels */}
      <aside
        className="row-span-2 bg-sidebar text-sidebar-foreground flex flex-col"
        style={{ overflowY: "auto", overscrollBehavior: "contain" }}
      >
        <div className="px-5 pt-6 pb-5 border-b border-sidebar-border">
          <Logo layout="row" invert size={36} />
        </div>

        <nav className="flex-1 p-3 flex flex-col gap-0.5">
          <div className="px-3 py-2 mt-1 font-display text-[10px] tracking-[0.2em] text-sidebar-foreground/45">
            WORKSPACE
          </div>
          {primaryNav.map(renderGroup)}

          <div className="px-3 py-2 mt-5 font-display text-[10px] tracking-[0.2em] text-sidebar-foreground/45">
            ACCOUNT
          </div>
          {secondaryNav.map((item) => renderLeaf(item))}
        </nav>

        {/* Plan card */}
        <div className="p-3">
          <div className="rounded-sm p-4 border border-sidebar-border bg-sidebar-accent/30">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full gold-gradient" style={{ background: "linear-gradient(135deg, #B8893D, #D4AF37, #B8893D)" }} />
              <span className="font-display text-[10px] tracking-[0.22em] text-sidebar-foreground/75">
                TRIFECTA PLAN
              </span>
            </div>
            <div className="mt-2 text-[12px] text-sidebar-foreground/65 leading-snug">
              2 of 3 listings active · 64 days left
            </div>
            <div className="mt-3 h-px bg-sidebar-border relative overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-white"
                style={{ width: "67%" }}
              />
            </div>
          </div>
        </div>

        {/* User */}
        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-3 px-2 py-2">
            <Avatar className="w-8 h-8 border border-sidebar-border">
              <AvatarImage src={user?.avatar} />
              <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-[11px]">
                {user?.name
                  ? user.name
                      .split(" ")
                      .map((s) => s[0])
                      .slice(0, 2)
                      .join("")
                  : "SR"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium truncate text-sidebar-foreground">
                {user?.name ?? "Spencer Rivers"}
              </div>
              <div className="text-[10px] text-sidebar-foreground/55 truncate font-display tracking-[0.08em]">
                {user?.email ?? "spencer@riversrealestate.ca"}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8 text-sidebar-foreground/55 hover:text-sidebar-foreground hover:bg-sidebar-accent"
              onClick={async () => {
                await signOut();
                setLocation("/admin");
              }}
              aria-label="Sign out"
              data-testid="button-sign-out"
            >
              <LogOut className="w-3.5 h-3.5" strokeWidth={1.6} />
            </Button>
          </div>
        </div>
      </aside>

      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center gap-6 px-8 h-16 border-b border-border bg-background/85 backdrop-blur">
        <div className="min-w-[180px]">
          {pageTitle && (
            <h1
              className="font-display text-[13px] tracking-[0.22em] text-foreground"
              style={{ fontWeight: 600 }}
            >
              {pageTitle.toUpperCase()}
            </h1>
          )}
        </div>

        <div className="flex-1 flex justify-center max-w-xl mx-auto">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.6} />
            <Input
              placeholder="Search listings, leads, addresses…"
              className="pl-9 h-9 bg-secondary border-transparent focus-visible:bg-background rounded-sm text-[13px]"
              data-testid="input-global-search"
            />
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden md:inline-flex items-center px-1.5 h-5 text-[10px] font-medium text-muted-foreground bg-background border border-border rounded-sm">
              ⌘K
            </kbd>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {pageActions}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            className="rounded-full"
            data-testid="button-theme-toggle"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" strokeWidth={1.6} /> : <Moon className="w-4 h-4" strokeWidth={1.6} />}
          </Button>
          <Button variant="ghost" size="icon" className="rounded-full relative" data-testid="button-notifications">
            <Bell className="w-4 h-4" strokeWidth={1.6} />
            <span className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-foreground" />
          </Button>
        </div>
      </header>

      {/* Main */}
      <main
        className="overflow-y-auto"
        style={{ overscrollBehavior: "contain" }}
        data-testid="main-content"
      >
        {children}
      </main>
    </div>
  );
}
