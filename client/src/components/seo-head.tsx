// Client-side page metadata for SPA navigations.
//
// The SERVER is the single source of truth for everything crawlers see:
// title/description/canonical/OG in server/seo-inject.ts, and ALL JSON-LD
// via server/schema/entities.ts (one @graph per page, stable @ids). This
// component exists only so client-side route changes update the tab title
// and metadata — its strings must MATCH the server's for the same route,
// otherwise JS-executing crawlers (Googlebot) see different metadata than
// non-JS crawlers.
//
// Do NOT reintroduce schema injection here: a client-side JSON-LD block
// invisibly forks the entity graph (the old buildOrgPersonSchema minted a
// competing "#person" entity on hydrated pages) and non-JS crawlers never
// see it anyway. Page-specific schema belongs in metaForPath().
import { useEffect } from "react";

export interface SeoHeadProps {
  // Required
  title: string; // pass the complete title, same as the server emits
  description: string;
  // Strongly recommended
  canonical?: string; // absolute URL
  ogImage?: string;
  ogType?: "website" | "article" | "place";
  // Per-page noindex/nofollow if you ever need it (admin pages, drafts).
  noindex?: boolean;
}

const DATA_ATTR = "data-rivers-seo";

declare global {
  interface Window {
    /** Title/description set from /admin/seo, keyed by path. Emitted inline
     *  by server/seo-inject.ts so this component and the server agree. */
    __SEO_OVERRIDES__?: Record<string, { title: string | null; description: string | null }>;
  }
}

function overrideFor(): { title: string | null; description: string | null } | null {
  if (typeof window === "undefined") return null;
  const p = window.location.pathname;
  const key = p.length > 1 ? p.replace(/\/+$/, "") : p;
  return window.__SEO_OVERRIDES__?.[key] ?? null;
}

function setOrCreateMeta(selector: string, attrName: string, attrValue: string, content: string) {
  let el = document.head.querySelector(selector) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attrName, attrValue);
    el.setAttribute(DATA_ATTR, "1");
    document.head.appendChild(el);
  }
  el.content = content;
}

function setOrCreateLink(rel: string, href: string) {
  let el = document.head.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement("link");
    el.rel = rel;
    el.setAttribute(DATA_ATTR, "1");
    document.head.appendChild(el);
  }
  el.href = href;
}

export function SeoHead({
  title: propTitle,
  description: propDescription,
  canonical,
  ogImage,
  ogType = "website",
  noindex,
}: SeoHeadProps) {
  // An override set from the SEO console beats the page's own strings — the
  // server already emitted it, and putting the old title back here would
  // show Googlebot something different from what it was served.
  const o = overrideFor();
  const title = o?.title || propTitle;
  const description = o?.description || propDescription;

  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;

    setOrCreateMeta('meta[name="description"]', "name", "description", description);
    setOrCreateMeta('meta[property="og:title"]', "property", "og:title", title);
    setOrCreateMeta('meta[property="og:description"]', "property", "og:description", description);
    setOrCreateMeta('meta[property="og:type"]', "property", "og:type", ogType);
    setOrCreateMeta('meta[name="twitter:card"]', "name", "twitter:card", "summary_large_image");
    setOrCreateMeta('meta[name="twitter:title"]', "name", "twitter:title", title);
    setOrCreateMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
    if (canonical) {
      setOrCreateLink("canonical", canonical);
      setOrCreateMeta('meta[property="og:url"]', "property", "og:url", canonical);
    }
    if (ogImage) {
      setOrCreateMeta('meta[property="og:image"]', "property", "og:image", ogImage);
      setOrCreateMeta('meta[name="twitter:image"]', "name", "twitter:image", ogImage);
    }
    if (noindex) {
      setOrCreateMeta('meta[name="robots"]', "name", "robots", "noindex,nofollow");
    } else {
      // Make sure no leftover noindex hangs around from a previous page.
      const r = document.head.querySelector('meta[name="robots"]');
      if (r) r.parentElement?.removeChild(r);
    }

    return () => {
      document.title = prevTitle;
      // Don't strip meta tags — leaving them is fine; they get overwritten
      // on the next page's mount via setOrCreateMeta.
    };
  }, [title, description, canonical, ogImage, ogType, noindex]);

  return null;
}
