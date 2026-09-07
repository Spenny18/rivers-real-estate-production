// /admin/neighbourhoods — self-serve CMS for the editorial neighbourhood
// pages. Master-detail layout matching /admin/condos. Editorial paragraphs
// are stored as JSON arrays and edited as blank-line-separated text.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Image as ImageIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface AdminNeighbourhood {
  slug: string;
  name: string;
  tagline: string;
  story: string[];
  outsideCopy: string[];
  amenitiesCopy: string[];
  shopDineCopy: string[];
  realEstateCopy: string[];
  lifeCopy: string[];
  quadrant: string;
  zone: string;
  borders: Record<string, string>;
  schools: Array<{ name: string; level: string; area?: string; url?: string }>;
  condoBuildingsList: Array<{ name: string; address?: string }>;
  heroImage: string;
  gallery: string[];
  centerLat: number;
  centerLng: number;
  avgPrice: number;
  activeCount: number;
  sortOrder: number;
}

function CopyArea({
  label,
  value,
  onChange,
  rows = 6,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  rows?: number;
}) {
  return (
    <div>
      <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
        {label.toUpperCase()}
      </Label>
      <Textarea
        rows={rows}
        value={(value || []).join("\n\n")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(/\n\s*\n/)
              .map((p) => p.trim())
              .filter(Boolean),
          )
        }
        className="mt-1 text-[14px] leading-relaxed"
        placeholder="One paragraph per blank line"
      />
    </div>
  );
}

// Condo buildings editor — one building per line, "Name | Address" (address
// optional). Stored as [{name, address?}] and rendered as the "Condo
// buildings" section on the public page. Buildings that also have a condo
// page are matched by name automatically and shown as links there.
function CondoBuildingsArea({
  value,
  onChange,
}: {
  value: Array<{ name: string; address?: string }>;
  onChange: (v: Array<{ name: string; address?: string }>) => void;
}) {
  const text = (value || [])
    .map((b) => (b.address ? `${b.name} | ${b.address}` : b.name))
    .join("\n");
  return (
    <div>
      <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
        CONDO BUILDINGS
      </Label>
      <Textarea
        rows={8}
        value={text}
        onChange={(e) =>
          onChange(
            e.target.value.split("\n").flatMap((line) => {
              const [name, address] = line.split("|").map((s) => s.trim());
              if (!name) return [];
              return [address ? { name, address } : { name }];
            }),
          )
        }
        className="mt-1 text-[14px] leading-relaxed font-mono"
        placeholder={"One building per line: Name | Address (address optional)\ne.g. Valmont at Aspen Stone | 10 Aspen Stone Blvd SW"}
      />
      <p className="mt-1 text-[11px] text-muted-foreground">
        Buildings that also exist under /admin/condos are linked to their page
        automatically (matched by name) and always appear — no need to repeat
        them here.
      </p>
    </div>
  );
}

export default function AdminNeighbourhoodsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<AdminNeighbourhood[]>({
    queryKey: ["/api/admin/neighbourhoods"],
  });
  const hoods = data ?? [];
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdminNeighbourhood | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!selectedSlug && hoods.length > 0) setSelectedSlug(hoods[0].slug);
  }, [hoods, selectedSlug]);

  // Summaries in the list, full record for the editor — the long-form copy is
  // around 80% of a neighbourhood row and none of it appears in the sidebar.
  // Seeding the draft from a summary would blank those fields on save.
  const { data: selected } = useQuery<AdminNeighbourhood>({
    queryKey: ["/api/admin/neighbourhoods", selectedSlug],
    enabled: !!selectedSlug,
  });

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
  }, [selected]);

  const save = useMutation({
    mutationFn: async (patch: Partial<AdminNeighbourhood>) => {
      if (!selected) throw new Error("no selection");
      const r = await apiRequest(
        "PATCH",
        `/api/admin/neighbourhoods/${selected.slug}`,
        patch,
      );
      return (await r.json()) as AdminNeighbourhood;
    },
    onSuccess: (saved) => {
      qc.setQueryData<AdminNeighbourhood[]>(
        ["/api/admin/neighbourhoods"],
        (prev) => (prev ?? []).map((h) => (h.slug === saved.slug ? saved : h)),
      );
      toast({ title: "Saved" });
    },
    onError: (e: any) =>
      toast({
        title: "Save failed",
        description: e?.message ?? "Try again",
        variant: "destructive",
      }),
  });

  const filtered = hoods.filter(
    (h) =>
      !filter.trim() ||
      h.name.toLowerCase().includes(filter.toLowerCase()) ||
      h.slug.toLowerCase().includes(filter.toLowerCase()) ||
      h.zone.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <AppShell>
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] h-[calc(100dvh-64px)] gap-0">
        <aside className="border-r border-border overflow-y-auto bg-card">
          <div className="px-4 py-4 border-b border-border sticky top-0 bg-card z-10">
            <Input
              placeholder="Search neighbourhoods…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-9"
            />
          </div>
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((h) => (
                <li key={h.slug}>
                  <button
                    onClick={() => setSelectedSlug(h.slug)}
                    className={`w-full text-left px-4 py-3 hover:bg-muted/40 transition-colors ${
                      h.slug === selectedSlug ? "bg-muted/60" : ""
                    }`}
                    data-testid={`admin-hood-item-${h.slug}`}
                  >
                    <div className="font-serif text-[14px]">{h.name}</div>
                    <div className="mt-0.5 font-display text-[10px] tracking-[0.18em] text-muted-foreground">
                      {h.zone.toUpperCase()}
                    </div>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="p-4 text-sm text-muted-foreground">No matches.</li>
              )}
            </ul>
          )}
        </aside>

        <section className="overflow-y-auto">
          {draft && selected ? (
            <div className="max-w-3xl mx-auto px-6 lg:px-10 py-8">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                    EDIT NEIGHBOURHOOD · /{draft.slug}
                  </div>
                  <h1 className="mt-2 font-serif text-2xl lg:text-3xl">{draft.name}</h1>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`/neighbourhoods/${draft.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs underline text-muted-foreground"
                  >
                    View live
                  </a>
                  <Button
                    onClick={() => save.mutate(draft)}
                    disabled={save.isPending}
                    data-testid="btn-save-hood"
                  >
                    <Save className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.6} />
                    {save.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>

              <div className="mt-8 space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                      NAME
                    </Label>
                    <Input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      className="mt-1 h-11"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                      ZONE
                    </Label>
                    <Input
                      value={draft.zone}
                      onChange={(e) => setDraft({ ...draft, zone: e.target.value })}
                      className="mt-1 h-11"
                      placeholder="City Centre & Inner-City"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                    TAGLINE
                  </Label>
                  <Input
                    value={draft.tagline}
                    onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                    className="mt-1 h-11"
                  />
                </div>

                <div>
                  <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground inline-flex items-center gap-1.5">
                    <ImageIcon className="w-3 h-3" strokeWidth={1.8} /> HERO IMAGE URL
                  </Label>
                  <Input
                    value={draft.heroImage || ""}
                    onChange={(e) => setDraft({ ...draft, heroImage: e.target.value })}
                    className="mt-1 h-10"
                  />
                  {draft.heroImage && (
                    <div className="mt-3 aspect-[5/2] rounded-sm overflow-hidden border border-border bg-secondary">
                      <img
                        src={draft.heroImage}
                        alt="Hero preview"
                        className="w-full h-full object-cover"
                        onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0.3")}
                      />
                    </div>
                  )}
                </div>

                <CopyArea
                  label="Story"
                  value={draft.story}
                  onChange={(v) => setDraft({ ...draft, story: v })}
                />
                <CopyArea
                  label="Outside / Recreation"
                  value={draft.outsideCopy}
                  onChange={(v) => setDraft({ ...draft, outsideCopy: v })}
                />
                <CopyArea
                  label="Amenities"
                  value={draft.amenitiesCopy}
                  onChange={(v) => setDraft({ ...draft, amenitiesCopy: v })}
                />
                <CopyArea
                  label="Shop & Dine"
                  value={draft.shopDineCopy}
                  onChange={(v) => setDraft({ ...draft, shopDineCopy: v })}
                />
                <CopyArea
                  label="Real estate"
                  value={draft.realEstateCopy}
                  onChange={(v) => setDraft({ ...draft, realEstateCopy: v })}
                />
                <CopyArea
                  label="Life / family"
                  value={draft.lifeCopy}
                  onChange={(v) => setDraft({ ...draft, lifeCopy: v })}
                />
                <CondoBuildingsArea
                  value={draft.condoBuildingsList}
                  onChange={(v) => setDraft({ ...draft, condoBuildingsList: v })}
                />
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              {isLoading ? "Loading neighbourhoods…" : "Select one on the left to edit."}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
