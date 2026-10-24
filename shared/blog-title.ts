// A blog post's stored title is its H1. The page <title> appends the site
// name itself (server/seo-inject.ts), so a stored title that already ends in
// it renders "… — Rivers Real Estate — Rivers Real Estate" in the tab and
// shows the brand in the H1. SEO fixes have written titles that way (they
// copy the shape of the rendered <title> they were shown), so every write
// goes through this.

const SITE_SUFFIX = /(?:\s*[—–|\-:·]\s*Rivers Real Estate)+\s*$/i;

/** The title with any trailing " — Rivers Real Estate" (or "| …", "- …") removed. */
export function stripSiteName(title: string): string {
  const stripped = title.replace(SITE_SUFFIX, "").trim();
  // A title that is nothing but the site name stays as it is.
  return stripped || title.trim();
}
