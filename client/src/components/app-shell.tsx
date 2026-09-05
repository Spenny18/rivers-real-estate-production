import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Logo } from "@/components/logo";
import { useTheme } from "@/components/theme-provider";
import {
  LayoutDashboard,
  Home,
  Users,
  Search,
  Bell,
  Sun,
  Moon,
  LogOut,
  Database,
  Globe,
  Calendar,
  Megaphone,
  BarChart3,
  Bookmark,
  Building2,
  FileText,
  MapPinned,
  LayoutTemplate,
  Target,
  CalendarClock,
  Contact,
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

const primaryNav: NavItem[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/admin/dashboard" },
  { label: "Listings", icon: Home, href: "/admin/listings" },
  { label: "Leads", icon: Users, href: "/admin/leads" },
  { label: "CRM", icon: Contact, href: "/admin/crm" },
  { label: "Calendar", icon: Calendar, href: "/admin/calendar" },
  { label: "Scheduling", icon: CalendarClock, href: "/admin/scheduling" },
  { label: "Marketing", icon: Megaphone, href: "/admin/marketing" },
  { label: "Analytics", icon: BarChart3, href: "/admin/analytics" },
  { label: "Saved Searches", icon: Bookmark, href: "/admin/saved-searches" },
  { label: "Home Page CMS", icon: LayoutTemplate, href: "/admin/home" },
  { label: "Condos CMS", icon: Building2, href: "/admin/condos" },
  { label: "Neighbourhoods", icon: MapPinned, href: "/admin/neighbourhoods" },
  { label: "Blog CMS", icon: FileText, href: "/admin/blog" },
  { label: "SEO Keywords", icon: Target, href: "/admin/seo" },
  { label: "MLS Sync", icon: Database, href: "/admin/mls-sync" },
];

const secondaryNav: NavItem[] = [
  { label: "View Public Site", icon: Globe, href: "/" },
];

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

  const navWithBadges = primaryNav.map((item) =>
    item.href === "/admin/leads" && newLeadCount > 0
      ? { ...item, badge: newLeadCount }
      : item,
  );

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
          {navWithBadges.map((item) => {
            const active =
              location === item.href ||
              (item.href !== "/admin/dashboard" && item.href !== "/" && location.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, "-")}`} className={`flex items-center gap-3 px-3 py-2 rounded-sm transition-all group ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                  }`}>
                  <Icon className="w-4 h-4 shrink-0" strokeWidth={1.6} />
                  <span
                    className="flex-1 font-display text-[11px] tracking-[0.16em]"
                    style={{ fontWeight: active ? 600 : 500 }}
                  >
                    {item.label.toUpperCase()}
                  </span>
                  {item.badge ? (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-white text-black tabular-nums">
                      {item.badge}
                    </span>
                  ) : null}
                
              </Link>
            );
          })}

          <div className="px-3 py-2 mt-5 font-display text-[10px] tracking-[0.2em] text-sidebar-foreground/45">
            ACCOUNT
          </div>
          {secondaryNav.map((item) => {
            const active = location === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} data-testid={`nav-${item.label.toLowerCase()}`} className={`flex items-center gap-3 px-3 py-2 rounded-sm transition-all ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                  }`}>
                  <Icon className="w-4 h-4 shrink-0" strokeWidth={1.6} />
                  <span
                    className="font-display text-[11px] tracking-[0.16em]"
                    style={{ fontWeight: active ? 600 : 500 }}
                  >
                    {item.label.toUpperCase()}
                  </span>
                
              </Link>
            );
          })}
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
