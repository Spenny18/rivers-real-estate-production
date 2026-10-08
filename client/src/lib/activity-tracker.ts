// The site's own activity beacon — page views and listing views, posted to
// /t/e. The server sets the first-party visitor cookie and ties the browser to
// a person once they identify (see server/tracking.ts).
//
// fetch with keepalive rather than navigator.sendBeacon: both survive the page
// unloading, but a fetch response's Set-Cookie is applied reliably everywhere,
// and the very first beacon is what issues the visitor cookie.

const TOKEN_KEY = "rivers.auth.token";

/** Spencer browsing his own site while signed in to the admin isn't a lead. */
function isAdminBrowser(): boolean {
  try {
    return !!window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return false;
  }
}

function send(payload: Record<string, unknown>) {
  if (typeof window === "undefined" || isAdminBrowser()) return;
  try {
    void fetch("/t/e", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* tracking must never break the page */
  }
}

// The previous in-site URL, so a listing view's referrer reads "/mls?..."
// rather than the external page the visit started from.
let lastPath: string | null = null;

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

export function trackPageview() {
  if (typeof window === "undefined") return;
  const path = currentPath();
  send({
    kind: "pageview",
    path,
    title: document.title,
    referrer: lastPath ?? document.referrer ?? null,
  });
  lastPath = path;
}

export interface TrackedListing {
  mlsNumber?: string | null;
  address?: string | null;
  price?: number | null;
  beds?: number | null;
  baths?: number | null;
  neighbourhood?: string | null;
}

export function trackListingView(listing: TrackedListing) {
  if (typeof window === "undefined") return;
  send({
    kind: "listing_view",
    path: currentPath(),
    title: document.title,
    listing,
  });
}
