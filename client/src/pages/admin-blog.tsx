// /admin/blog — self-serve CMS for the public blog. Master-detail layout:
// list of all posts on the left, edit form on the right. Saves persist to
// the database; public /blog re-fetches on next view. Same auth + shell as
// the other admin pages.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Plus, Image as ImageIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ImageField } from "@/components/image-field";

interface AdminBlogPost {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  category: string;
  heroImage: string;
  heroImageAlt: string | null;
  authorName: string;
  authorAvatar: string | null;
  readMinutes: number;
  status: "draft" | "published";
  publishedAt: string;
  videoUploadDate: string | null;
  videoDuration: string | null;
}

function fmtDate(iso: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Same rule the server enforces on POST: lowercase letters, digits, hyphens.
function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Blank post for the "New post" form. The server fills in a unique hero
// image when heroImage is left empty.
function emptyPost(): AdminBlogPost {
  return {
    id: 0,
    slug: "",
    title: "",
    excerpt: "",
    body: "",
    category: "Guide",
    heroImage: "",
    heroImageAlt: null,
    authorName: "Spencer Rivers",
    authorAvatar: null,
    readMinutes: 0, // 0 = let the server estimate from the body
    status: "draft",
    publishedAt: new Date().toISOString(),
    videoUploadDate: null,
    videoDuration: null,
  };
}

export default function AdminBlogPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<AdminBlogPost[]>({
    queryKey: ["/api/admin/blog"],
  });
  const posts = data ?? [];
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdminBlogPost | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "published">("all");
  // "New post" mode: the editor shows a blank draft that is POSTed on save.
  const [creating, setCreating] = useState(false);
  // Until the slug is edited by hand, it follows the title.
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    if (!selectedSlug && posts.length > 0) setSelectedSlug(posts[0].slug);
  }, [posts, selectedSlug]);

  // The list carries summaries only — it deliberately does not include the
  // article body, which is 95% of the payload and is not shown in the list.
  // Fetch the selected post in full so the editor has something to edit;
  // seeding the draft from a summary would open an empty body box and a save
  // would then write that emptiness back over the article.
  const { data: selected } = useQuery<AdminBlogPost>({
    queryKey: ["/api/admin/blog", selectedSlug],
    enabled: !!selectedSlug,
  });

  // Reset the draft whenever the selected post changes (server is the source
  // of truth — unsaved local changes are intentionally dropped on switch).
  useEffect(() => {
    if (creating) return;
    setDraft(selected ? { ...selected } : null);
  }, [selected, creating]);

  const startNewPost = () => {
    setCreating(true);
    setSlugTouched(false);
    setDraft(emptyPost());
  };

  const selectPost = (slug: string) => {
    setCreating(false);
    setSelectedSlug(slug);
  };

  const create = useMutation({
    mutationFn: async (post: AdminBlogPost) => {
      const r = await apiRequest("POST", "/api/admin/blog", post);
      return (await r.json()) as AdminBlogPost;
    },
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: ["/api/admin/blog"] });
      setCreating(false);
      setSelectedSlug(created.slug);
      toast({ title: created.status === "published" ? "Post published" : "Draft created" });
    },
    onError: (e: any) => {
      // apiRequest errors read "409: {"message":"…"}" — show just the message.
      const raw = String(e?.message ?? "");
      const msg = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? (raw || "Try again");
      toast({ title: "Create failed", description: msg, variant: "destructive" });
    },
  });

  const submitNew = (status: "draft" | "published") => {
    if (!draft) return;
    if (!draft.title.trim() || !draft.body.trim()) {
      toast({ title: "Title and body are required", variant: "destructive" });
      return;
    }
    if (!/^[a-z0-9-]+$/.test(draft.slug)) {
      toast({
        title: "Invalid URL slug",
        description: "Use lowercase letters, numbers and hyphens only.",
        variant: "destructive",
      });
      return;
    }
    create.mutate({ ...draft, status });
  };

  const save = useMutation({
    mutationFn: async (patch: Partial<AdminBlogPost>) => {
      if (!selected) throw new Error("no selection");
      const r = await apiRequest("PATCH", `/api/admin/blog/${selected.slug}`, patch);
      return (await r.json()) as AdminBlogPost;
    },
    onSuccess: (saved) => {
      qc.setQueryData<AdminBlogPost[]>(["/api/admin/blog"], (prev) =>
        (prev ?? []).map((p) => (p.slug === saved.slug ? saved : p)),
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

  const draftCount = posts.filter((p) => (p.status ?? "published") === "draft").length;
  const filtered = posts.filter((p) => {
    if (statusFilter === "draft" && (p.status ?? "published") !== "draft") return false;
    if (statusFilter === "published" && (p.status ?? "published") !== "published") return false;
    if (
      filter.trim() &&
      !p.title.toLowerCase().includes(filter.toLowerCase()) &&
      !p.slug.toLowerCase().includes(filter.toLowerCase())
    )
      return false;
    return true;
  });

  return (
    <AppShell>
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] h-[calc(100dvh-64px)] gap-0">
        {/* LIST */}
        <aside className="border-r border-border overflow-y-auto bg-card">
          <div className="px-4 py-4 border-b border-border sticky top-0 bg-card z-10 space-y-2">
            <Button
              onClick={startNewPost}
              variant={creating ? "outline" : "default"}
              className="w-full h-9"
              data-testid="btn-new-post"
            >
              <Plus className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.8} />
              New post
            </Button>
            <Input
              placeholder="Search posts…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-9"
            />
            <div className="flex gap-1.5">
              {(["all", "draft", "published"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  className={`flex-1 px-2 py-1 rounded-sm text-[10px] font-display tracking-[0.18em] transition-colors ${
                    statusFilter === f
                      ? "bg-foreground text-background"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted"
                  }`}
                  data-testid={`filter-${f}`}
                >
                  {f.toUpperCase()}
                  {f === "draft" && draftCount > 0 && (
                    <span className="ml-1 opacity-80">({draftCount})</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((p) => (
                <li key={p.slug}>
                  <button
                    onClick={() => selectPost(p.slug)}
                    className={`w-full text-left px-4 py-3 hover:bg-muted/40 transition-colors ${
                      !creating && p.slug === selectedSlug ? "bg-muted/60" : ""
                    }`}
                    data-testid={`admin-blog-item-${p.slug}`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="font-serif text-[14px] leading-snug line-clamp-2 flex-1">
                        {p.title}
                      </div>
                      {(p.status ?? "published") === "draft" && (
                        <span className="px-1.5 py-0.5 bg-amber-500/15 text-amber-700 dark:text-amber-300 font-display text-[9px] tracking-[0.18em] rounded-sm">
                          DRAFT
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] tracking-[0.18em] text-muted-foreground font-display">
                      {p.category.toUpperCase()} · {fmtDate(p.publishedAt)}
                      {(!p.heroImage || !p.heroImage.trim()) && (
                        <span className="text-amber-600">· NO IMAGE</span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="p-4 text-sm text-muted-foreground">No posts match.</li>
              )}
            </ul>
          )}
        </aside>

        {/* EDIT */}
        <section className="overflow-y-auto">
          {draft && (selected || creating) ? (
            <div className="max-w-3xl mx-auto px-6 lg:px-10 py-8">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-display text-[10px] tracking-[0.22em] text-muted-foreground">
                    {creating ? "NEW POST" : "EDIT POST"} · /{draft.slug}
                  </div>
                  <h1 className="mt-2 font-serif text-2xl lg:text-3xl leading-tight">
                    {draft.title || "Untitled"}
                  </h1>
                </div>
                {creating ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => setCreating(false)}
                      disabled={create.isPending}
                      data-testid="btn-cancel-new-post"
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => submitNew("draft")}
                      disabled={create.isPending}
                      data-testid="btn-create-draft"
                    >
                      <Save className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.6} />
                      Save draft
                    </Button>
                    <Button
                      onClick={() => submitNew("published")}
                      disabled={create.isPending}
                      data-testid="btn-create-publish"
                    >
                      {create.isPending ? "Creating…" : "Publish"}
                    </Button>
                  </div>
                ) : (
                <div className="flex items-center gap-2">
                  {(draft.status ?? "published") === "published" && (
                    <a
                      href={`/blog/${draft.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs underline text-muted-foreground"
                    >
                      View live
                    </a>
                  )}
                  {(draft.status ?? "published") === "draft" ? (
                    <Button
                      variant="default"
                      onClick={() => save.mutate({ ...draft, status: "published" })}
                      disabled={save.isPending}
                      data-testid="btn-publish-post"
                    >
                      {save.isPending ? "Publishing…" : "Publish"}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => save.mutate({ ...draft, status: "draft" })}
                      disabled={save.isPending}
                      data-testid="btn-unpublish-post"
                    >
                      Unpublish
                    </Button>
                  )}
                  <Button
                    onClick={() => save.mutate(draft)}
                    disabled={save.isPending}
                    data-testid="btn-save-post"
                  >
                    <Save className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.6} />
                    {save.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
                )}
              </div>

              <div className="mt-8 space-y-5">
                <div>
                  <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                    TITLE
                  </Label>
                  <Input
                    value={draft.title}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        title: e.target.value,
                        ...(creating && !slugTouched ? { slug: slugify(e.target.value) } : {}),
                      })
                    }
                    className="mt-1 h-11"
                    data-testid="input-title"
                  />
                </div>

                {/* The slug can't be renamed after creation (PATCH never
                    renames), so it's only editable here. */}
                {creating && (
                  <div>
                    <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                      URL SLUG
                    </Label>
                    <Input
                      value={draft.slug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setDraft({ ...draft, slug: e.target.value.toLowerCase() });
                      }}
                      className="mt-1 h-10 font-mono text-[13px]"
                      placeholder="best-calgary-luxury-neighbourhoods-2026"
                      data-testid="input-slug"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      The post will live at /blog/{draft.slug || "…"}. It can't be changed after the post is created.
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-[1fr_140px_160px] gap-3">
                  <div>
                    <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                      CATEGORY
                    </Label>
                    <Input
                      value={draft.category}
                      onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                      className="mt-1 h-10"
                      placeholder="Guide, Market, Selling, Buying, Neighbourhoods, Condos"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                      READ (MIN)
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      value={draft.readMinutes || ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          // Blank on a new post = let the server estimate it.
                          readMinutes:
                            creating && !e.target.value ? 0 : Math.max(1, Number(e.target.value) || 1),
                        })
                      }
                      className="mt-1 h-10"
                      placeholder="Auto"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                      PUBLISHED
                    </Label>
                    <Input
                      type="date"
                      value={(draft.publishedAt || "").slice(0, 10)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          publishedAt: e.target.value
                            ? new Date(e.target.value).toISOString()
                            : draft.publishedAt,
                        })
                      }
                      className="mt-1 h-10"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground inline-flex items-center gap-1.5">
                    <ImageIcon className="w-3 h-3" strokeWidth={1.8} /> HERO IMAGE
                  </Label>
                  <div className="mt-1">
                    <ImageField
                      value={draft.heroImage || ""}
                      onChange={(v) => setDraft({ ...draft, heroImage: v })}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                    HERO IMAGE ALT TEXT (FOCUS KEYWORD)
                  </Label>
                  <Input
                    value={draft.heroImageAlt || ""}
                    onChange={(e) => setDraft({ ...draft, heroImageAlt: e.target.value || null })}
                    className="mt-1 h-10"
                    placeholder="e.g. Calgary luxury home staging"
                  />
                </div>

                {/* A YouTube link in the body becomes a player on the page and a
                    VideoObject for search engines. YouTube won't tell the server
                    when the video went live or how long it is, so they're typed
                    here (YouTube Studio → Content → the video). */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                      VIDEO PUBLISHED ON YOUTUBE
                    </Label>
                    <Input
                      value={draft.videoUploadDate || ""}
                      onChange={(e) => setDraft({ ...draft, videoUploadDate: e.target.value })}
                      className="mt-1 h-10"
                      placeholder="YYYY-MM-DD"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Only used when the body links to a YouTube video. Blank = the post date.
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                      VIDEO LENGTH
                    </Label>
                    <Input
                      value={draft.videoDuration || ""}
                      onChange={(e) => setDraft({ ...draft, videoDuration: e.target.value })}
                      className="mt-1 h-10"
                      placeholder="12:22"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">Minutes:seconds, as YouTube shows it.</p>
                  </div>
                </div>

                <div>
                  <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                    EXCERPT
                  </Label>
                  <Textarea
                    rows={3}
                    value={draft.excerpt}
                    onChange={(e) => setDraft({ ...draft, excerpt: e.target.value })}
                    className="mt-1"
                    placeholder="1-2 sentence summary shown on /blog cards and meta description."
                  />
                </div>

                <div>
                  <Label className="text-xs font-display tracking-[0.18em] text-muted-foreground">
                    BODY (markdown: ## H2, ### H3, &gt; blockquote, **bold**, [link](url); a YouTube link embeds the video)
                  </Label>
                  <Textarea
                    rows={24}
                    value={draft.body}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    className="mt-1 font-mono text-[13px] leading-relaxed"
                    data-testid="textarea-body"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              {isLoading ? "Loading posts…" : "Select a post on the left to edit, or create a new one."}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
