// Hub-and-spoke links from the SEO console's cluster map
// (server/cluster-links.ts): a child page names its pillar with the pillar's
// head term, and a pillar lists the journal guides in its cluster. Both are in
// the server-rendered body, which is what Google counts.
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";

export interface ClusterLinksData {
  up: Array<{ path: string; anchor: string; label: string }>;
  guides: Array<{ path: string; title: string }>;
}

/** Query key for a page's cluster links. Each path segment is its own key
 *  part, so the default queryFn's "/" join builds the endpoint URL and
 *  server/ssr.ts can prefetch the same key. */
export function clusterLinksKey(path: string): string[] {
  return ["/api/public/cluster-links", ...path.split("/").filter(Boolean)];
}

export function useClusterLinks(path: string) {
  return useQuery<ClusterLinksData>({ queryKey: clusterLinksKey(path), staleTime: 5 * 60 * 1000 });
}

/** One sentence linking up to the page's pillar(s). Renders nothing if the
 *  page has none. */
export function PillarUpLink({ path, className = "" }: { path: string; className?: string }) {
  const { data } = useClusterLinks(path);
  const up = data?.up ?? [];
  if (!up.length) return null;
  return (
    <p className={`text-sm text-muted-foreground ${className}`} data-testid="text-pillar-uplink">
      Part of our guide to{" "}
      {up.map((u, i) => (
        <span key={u.path}>
          {i > 0 && (i === up.length - 1 ? " and " : ", ")}
          <Link href={u.path} className="text-foreground underline underline-offset-4 hover:opacity-80"
            data-testid={`link-pillar-${u.path.replace(/\//g, "-")}`}>
            {u.anchor}
          </Link>
        </span>
      ))}
      .
    </p>
  );
}

/** A pillar's journal guides. Renders nothing when there are none. */
export function ClusterGuides({
  path,
  eyebrow = "FROM THE JOURNAL",
  title,
}: {
  path: string;
  eyebrow?: string;
  title: string;
}) {
  const { data } = useClusterLinks(path);
  const guides = data?.guides ?? [];
  if (!guides.length) return null;
  return (
    <section className="max-w-[1300px] mx-auto px-6 lg:px-10 py-16 lg:py-20 border-t border-border"
      data-testid="section-cluster-guides">
      <div className="font-display text-xs tracking-[0.22em] text-muted-foreground">{eyebrow}</div>
      <h2 className="mt-4 font-serif text-2xl lg:text-3xl">{title}</h2>
      <ul className="mt-8 grid gap-x-12 md:grid-cols-2 border-t border-border">
        {guides.map((g) => (
          <li key={g.path} className="border-b border-border">
            <Link href={g.path} className="group flex items-center justify-between gap-4 py-4"
              data-testid={`link-guide-${g.path.split("/").pop()}`}>
              <span className="font-serif text-lg group-hover:underline underline-offset-4">{g.title}</span>
              <ArrowRight className="w-4 h-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" strokeWidth={1.6} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A pillar's hand-picked guide list (curated labels, in curated order) plus
 *  every other journal post the cluster map assigns to it, so a new post in
 *  the cluster is linked from its pillar without anyone editing this page. */
export function useMergedGuides(path: string, curated: Array<{ href: string; label: string }>) {
  const { data } = useClusterLinks(path);
  const seen = new Set(curated.map((g) => g.href.replace(/\/+$/, "")));
  const extra = (data?.guides ?? [])
    .filter((g) => !seen.has(g.path))
    .map((g) => ({ href: g.path, label: g.title }));
  return [...curated, ...extra];
}
