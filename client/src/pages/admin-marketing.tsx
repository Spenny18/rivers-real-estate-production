import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Send,
  Sparkles,
  Trash2,
  Image as ImageIcon,
  CalendarPlus,
  Instagram,
  Facebook,
  Linkedin,
  Twitter,
  MapPin,
  Youtube,
  Copy,
  Eye,
  Link as LinkIcon,
} from "lucide-react";
import { apiRequest, apiUrl } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { timeAgoShort } from "@/lib/format";
import type { PublicListing } from "@/lib/types";

// Per-platform metadata. `limit` = soft character cap shown in the composer
// to nudge captions toward each network's algorithm sweet spot. `linkSupport`
// = whether the network supports a clickable link in-post (FB, X, GBP do; IG
// + LinkedIn do not — link goes in bio / first comment / dedicated field).
const CHANNELS = [
  { id: "instagram", label: "Instagram", icon: Instagram, limit: 2200, linkSupport: false, color: "#c13584" },
  { id: "facebook", label: "Facebook", icon: Facebook, limit: 5000, linkSupport: true, color: "#3b5998" },
  { id: "x", label: "X", icon: Twitter, limit: 280, linkSupport: true, color: "#000000" },
  { id: "linkedin", label: "LinkedIn", icon: Linkedin, limit: 3000, linkSupport: true, color: "#0a66c2" },
  { id: "gbp", label: "Google Business", icon: MapPin, limit: 1500, linkSupport: true, color: "#4285f4" },
  { id: "youtube", label: "YouTube", icon: Youtube, limit: 5000, linkSupport: true, color: "#ff0000" },
] as const;
type ChannelId = (typeof CHANNELS)[number]["id"];

interface PlatformVariant {
  caption?: string;
  imageUrl?: string | null;
  linkUrl?: string | null;
  scheduledFor?: string | null;
}

interface SocialPost {
  id: number;
  caption: string;
  imageUrl: string | null;
  mediaUrls?: string[];
  linkUrl: string | null;
  channels: string[];
  variants: Record<string, PlatformVariant>;
  scheduledFor: string | null;
  status: "draft" | "scheduled" | "posted" | "failed";
  postedAt: string | null;
  createdAt: string;
  listingId: string | null;
}

// Deterministic placeholder caption generator (the live deploy can't reach
// external AI APIs, so we synthesize a brand-aligned suggestion from the
// listing data and let Spencer edit before posting).
function suggestCaption(listing: PublicListing | undefined) {
  if (!listing) {
    return "New on the market in Calgary. Reply for the brief.";
  }
  const lines = [
    `${listing.title} — ${listing.address.split(",")[0]}.`,
    `${listing.beds} bed · ${listing.baths} bath · ${(listing.sqft ?? 0).toLocaleString("en-CA")} sqft`,
    listing.features?.[0] ? `Highlight: ${listing.features[0].toLowerCase()}.` : "",
    "DM for the full brief.",
  ].filter(Boolean);
  return lines.join("\n");
}

export default function AdminMarketingPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: posts = [], isLoading } = useQuery<SocialPost[]>({ queryKey: ["/api/social-posts"] });
  const { data: listings = [] } = useQuery<PublicListing[]>({ queryKey: ["/api/listings"] });

  // Master fields apply to every selected channel unless the channel's
  // variant overrides them. Variants only need to set fields that DIFFER
  // from the master — empty variant = use master.
  const [caption, setCaption] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [selectedChannels, setSelectedChannels] = useState<ChannelId[]>(["instagram", "facebook"]);
  const [linkedListing, setLinkedListing] = useState<string>("none");
  const [scheduledFor, setScheduledFor] = useState("");
  const [variants, setVariants] = useState<Record<string, PlatformVariant>>({});
  const [activeTab, setActiveTab] = useState<"master" | ChannelId>("master");

  function toggleChannel(id: ChannelId) {
    setSelectedChannels((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }

  function setVariant(ch: ChannelId, patch: Partial<PlatformVariant>) {
    setVariants((v) => ({ ...v, [ch]: { ...(v[ch] ?? {}), ...patch } }));
  }

  function effectiveCaption(ch: ChannelId): string {
    const v = variants[ch];
    return v?.caption ?? caption;
  }
  function effectiveImage(ch: ChannelId): string {
    const v = variants[ch];
    return (v?.imageUrl as string) ?? imageUrl;
  }
  function effectiveLink(ch: ChannelId): string {
    const v = variants[ch];
    return (v?.linkUrl as string) ?? linkUrl;
  }

  function applySuggestion() {
    const listing = listings.find((l) => l.id === linkedListing);
    setCaption(suggestCaption(listing));
    if (!imageUrl && listing?.heroImage) setImageUrl(listing.heroImage);
  }

  // Copy the master text into the active channel's variant, marking it
  // "customized". Useful when Spencer wants to tweak just one channel.
  function forkFromMaster(ch: ChannelId) {
    setVariant(ch, { caption: caption, imageUrl: imageUrl, linkUrl: linkUrl });
  }

  // Reset a channel's overrides so it falls back to master values again.
  function resetVariant(ch: ChannelId) {
    setVariants((v) => {
      const next = { ...v };
      delete next[ch];
      return next;
    });
  }

  const saveAndPost = useMutation({
    mutationFn: async (mode: "draft" | "post-now" | "schedule") => {
      const created = await apiRequest("POST", "/api/social-posts", {
        caption,
        imageUrl: imageUrl || null,
        linkUrl: linkUrl || null,
        channels: selectedChannels,
        variants,
        scheduledFor: mode === "schedule" && scheduledFor ? new Date(scheduledFor).toISOString() : null,
        status: mode === "schedule" ? "scheduled" : "draft",
        listingId: linkedListing === "none" ? null : linkedListing,
      });
      const post = await created.json();
      if (mode === "post-now") {
        await apiRequest("POST", `/api/social-posts/${post.id}/post`);
      }
      return post;
    },
    onSuccess: (_data, mode) => {
      qc.invalidateQueries({ queryKey: ["/api/social-posts"] });
      setCaption("");
      setImageUrl("");
      setLinkUrl("");
      setScheduledFor("");
      setVariants({});
      setActiveTab("master");
      toast({
        title: mode === "post-now" ? "Posted" : mode === "schedule" ? "Scheduled" : "Saved as draft",
        description:
          mode === "post-now"
            ? `Pushed to ${selectedChannels.join(", ") || "no channels"}.`
            : mode === "schedule"
              ? "We'll post when the time hits."
              : "Lives in drafts until you're ready.",
      });
    },
    onError: (e: any) => {
      toast({ title: "Couldn't save post", description: e?.message ?? "Try again.", variant: "destructive" });
    },
  });

  const postNow = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/social-posts/${id}/post`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/social-posts"] });
      toast({ title: "Posted" });
    },
  });

  const deletePost = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/social-posts/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/social-posts"] });
    },
  });

  const drafts = posts.filter((p) => p.status === "draft");
  const scheduled = posts.filter((p) => p.status === "scheduled");
  const posted = posts.filter((p) => p.status === "posted");

  return (
    <AppShell pageTitle="Marketing">
      <div className="p-6 max-w-[1400px] mx-auto">
        <div className="mb-6">
          <h1 className="font-serif text-3xl text-foreground" style={{ letterSpacing: "-0.01em" }}>
            Marketing
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            One composer, all channels. Draft, schedule, or post a single piece of copy across your social
            accounts in one click.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
          {/* Composer */}
          <div className="space-y-5">
            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                  <Label className="eyebrow text-muted-foreground">Tied to listing</Label>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Select value={linkedListing} onValueChange={setLinkedListing}>
                      <SelectTrigger className="rounded-sm h-10">
                        <SelectValue placeholder="Optional · pick a listing" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— No listing —</SelectItem>
                        {listings.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-sm h-10 font-display tracking-[0.14em] text-[11px] shrink-0"
                      onClick={applySuggestion}
                      disabled={linkedListing === "none"}
                    >
                      <Sparkles className="w-3.5 h-3.5 mr-1.5" /> SUGGEST CAPTION
                    </Button>
                  </div>
                </div>

                {/* Channel toggles */}
                <div>
                  <Label className="eyebrow text-muted-foreground">Channels</Label>
                  <div className="flex flex-wrap gap-2 mt-1.5">
                    {CHANNELS.map((c) => {
                      const Icon = c.icon;
                      const checked = selectedChannels.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleChannel(c.id)}
                          className={`inline-flex items-center gap-2 px-3 h-9 rounded-sm border text-xs font-display tracking-[0.14em] transition-colors ${
                            checked
                              ? "bg-foreground text-background border-foreground"
                              : "bg-background text-foreground border-border hover:bg-secondary"
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" strokeWidth={1.6} />
                          {c.label.toUpperCase()}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Tab strip: Master + one tab per selected channel */}
                <div className="border-b border-border -mx-5 px-5 flex gap-0 overflow-x-auto">
                  <TabButton
                    active={activeTab === "master"}
                    onClick={() => setActiveTab("master")}
                    label="Master"
                    sub="all channels"
                  />
                  {CHANNELS.filter((c) => selectedChannels.includes(c.id)).map((c) => {
                    const Icon = c.icon;
                    const customized = !!variants[c.id];
                    const len = effectiveCaption(c.id).length;
                    return (
                      <TabButton
                        key={c.id}
                        active={activeTab === c.id}
                        onClick={() => setActiveTab(c.id)}
                        label={c.label}
                        sub={`${len}/${c.limit}`}
                        warning={len > c.limit}
                        customized={customized}
                        icon={<Icon className="w-3 h-3" strokeWidth={1.8} />}
                        color={c.color}
                      />
                    );
                  })}
                </div>

                {/* Editor for the active tab */}
                {activeTab === "master" ? (
                  <MasterEditor
                    caption={caption}
                    setCaption={setCaption}
                    imageUrl={imageUrl}
                    setImageUrl={setImageUrl}
                    linkUrl={linkUrl}
                    setLinkUrl={setLinkUrl}
                  />
                ) : (
                  <PlatformEditor
                    channel={CHANNELS.find((c) => c.id === activeTab)!}
                    masterCaption={caption}
                    masterImage={imageUrl}
                    masterLink={linkUrl}
                    variant={variants[activeTab]}
                    setVariant={(p) => setVariant(activeTab as ChannelId, p)}
                    fork={() => forkFromMaster(activeTab as ChannelId)}
                    reset={() => resetVariant(activeTab as ChannelId)}
                  />
                )}

                <div>
                  <Label className="eyebrow text-muted-foreground">Schedule (optional, applies to all channels)</Label>
                  <Input
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                    className="mt-1.5 rounded-sm h-10"
                  />
                </div>

                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <Button
                    variant="outline"
                    className="rounded-sm font-display tracking-[0.14em] text-[11px] h-10"
                    disabled={!caption.trim() || saveAndPost.isPending}
                    onClick={() => saveAndPost.mutate("draft")}
                  >
                    SAVE DRAFT
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-sm font-display tracking-[0.14em] text-[11px] h-10"
                    disabled={!caption.trim() || !scheduledFor || saveAndPost.isPending}
                    onClick={() => saveAndPost.mutate("schedule")}
                  >
                    <CalendarPlus className="w-3.5 h-3.5 mr-1.5" /> SCHEDULE
                  </Button>
                  <Button
                    className="rounded-sm font-display tracking-[0.14em] text-[11px] h-10 ml-auto"
                    disabled={
                      !caption.trim() || selectedChannels.length === 0 || saveAndPost.isPending
                    }
                    onClick={() => saveAndPost.mutate("post-now")}
                  >
                    <Send className="w-3.5 h-3.5 mr-1.5" />
                    POST TO {selectedChannels.length || 0}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* History */}
            <div>
              <div className="eyebrow text-muted-foreground mb-3">Recent activity</div>
              {isLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : posts.length === 0 ? (
                <Card>
                  <CardContent className="p-8 text-center text-sm text-muted-foreground">
                    Nothing posted yet. Drafts and posted items will land here.
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {[...drafts, ...scheduled, ...posted]
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                    .map((p) => (
                      <PostRow
                        key={p.id}
                        post={p}
                        onPostNow={() => postNow.mutate(p.id)}
                        onDelete={() => deletePost.mutate(p.id)}
                      />
                    ))}
                </div>
              )}
            </div>
          </div>

          {/* Right rail: stats */}
          <div className="space-y-4">
            <Card>
              <CardContent className="p-5">
                <div className="eyebrow text-muted-foreground mb-3">This month</div>
                <div className="grid grid-cols-3 gap-3">
                  <KpiCell label="Drafts" value={drafts.length} />
                  <KpiCell label="Scheduled" value={scheduled.length} />
                  <KpiCell label="Posted" value={posted.length} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <div className="eyebrow text-muted-foreground mb-3">Voice notes</div>
                <ul className="text-xs text-foreground/80 space-y-2 leading-relaxed">
                  <li>· Lead with the address or neighbourhood, not adjectives.</li>
                  <li>· One concrete detail beats three superlatives.</li>
                  <li>· Sign off with "Contact Spencer 🤵" on long posts.</li>
                  <li>· Skip: stunning, nestled, dream home, must-see, boasts.</li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function KpiCell({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-serif text-2xl text-foreground" style={{ letterSpacing: "-0.02em" }}>
        {value}
      </div>
      <div className="eyebrow text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function PostRow({
  post,
  onPostNow,
  onDelete,
}: {
  post: SocialPost;
  onPostNow: () => void;
  onDelete: () => void;
}) {
  const statusColor =
    post.status === "posted"
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
      : post.status === "scheduled"
        ? "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100"
        : post.status === "failed"
          ? "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100"
          : "bg-secondary text-secondary-foreground";

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {post.imageUrl || post.mediaUrls?.length ? (
            <div className="relative shrink-0">
              <img
                src={apiUrl(post.imageUrl ?? post.mediaUrls![0])}
                alt=""
                className="w-14 h-14 rounded-sm object-cover border border-border"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
              {(post.mediaUrls?.length ?? 0) > 1 && (
                <span className="absolute -bottom-1 -right-1 bg-foreground text-background text-[9px] font-display tracking-[0.08em] px-1 rounded-sm">
                  1/{post.mediaUrls!.length}
                </span>
              )}
            </div>
          ) : (
            <div className="w-14 h-14 rounded-sm bg-secondary flex items-center justify-center shrink-0">
              <ImageIcon className="w-5 h-5 text-muted-foreground" strokeWidth={1.4} />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                className={`rounded-sm font-display tracking-[0.1em] text-[9px] uppercase ${statusColor}`}
              >
                {post.status}
              </Badge>
              {(post.mediaUrls?.length ?? 0) > 1 && (
                <Badge variant="outline" className="rounded-sm font-display text-[9px] tracking-[0.1em] uppercase">
                  Carousel · {post.mediaUrls!.length}
                </Badge>
              )}
              {post.channels.map((c) => (
                <Badge key={c} variant="outline" className="rounded-sm font-display text-[9px] tracking-[0.1em] uppercase">
                  {c}
                </Badge>
              ))}
              <span className="text-[11px] text-muted-foreground ml-auto">
                {post.postedAt ? `Posted ${timeAgoShort(post.postedAt)}` : timeAgoShort(post.createdAt)}
              </span>
            </div>
            <div className="text-sm text-foreground/90 mt-2 line-clamp-3 whitespace-pre-line">
              {post.caption}
            </div>
            <div className="flex items-center gap-2 mt-2">
              {post.status !== "posted" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-sm font-display tracking-[0.14em] text-[10px] h-7"
                  onClick={onPostNow}
                >
                  <Send className="w-3 h-3 mr-1.5" /> POST NOW
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="rounded-sm font-display tracking-[0.14em] text-[10px] h-7 text-destructive ml-auto"
                onClick={onDelete}
              >
                <Trash2 className="w-3 h-3 mr-1" /> DELETE
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Per-platform composer pieces
// =============================================================================

function TabButton({
  active,
  onClick,
  label,
  sub,
  icon,
  warning = false,
  customized = false,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub?: string;
  icon?: ReactNode;
  warning?: boolean;
  customized?: boolean;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative shrink-0 px-4 py-3 -mb-px border-b-2 transition-colors ${
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {icon && (
          <span style={{ color: active && color ? color : undefined }}>{icon}</span>
        )}
        <span className="font-display tracking-[0.14em] text-[11px] uppercase">{label}</span>
        {customized && (
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: color || "#D4AF37" }}
            title="Customized for this channel"
          />
        )}
      </div>
      {sub && (
        <div
          className={`text-[9px] tracking-[0.1em] uppercase mt-0.5 ${
            warning ? "text-destructive" : "text-muted-foreground/70"
          }`}
        >
          {sub}
        </div>
      )}
    </button>
  );
}

function MasterEditor({
  caption,
  setCaption,
  imageUrl,
  setImageUrl,
  linkUrl,
  setLinkUrl,
}: {
  caption: string;
  setCaption: (v: string) => void;
  imageUrl: string;
  setImageUrl: (v: string) => void;
  linkUrl: string;
  setLinkUrl: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="text-[11px] text-muted-foreground italic">
        Write the master post once. It applies to every selected channel — switch to a channel tab to override.
      </div>
      <CaptionField
        value={caption}
        onChange={setCaption}
        placeholder="What you're posting…"
        helper="Avoid: stunning · nestled · must-see · dream home · boasts"
      />
      <ImageField value={imageUrl} onChange={setImageUrl} />
      <LinkField value={linkUrl} onChange={setLinkUrl} />
    </div>
  );
}

function PlatformEditor({
  channel,
  masterCaption,
  masterImage,
  masterLink,
  variant,
  setVariant,
  fork,
  reset,
}: {
  channel: (typeof CHANNELS)[number];
  masterCaption: string;
  masterImage: string;
  masterLink: string;
  variant: PlatformVariant | undefined;
  setVariant: (p: Partial<PlatformVariant>) => void;
  fork: () => void;
  reset: () => void;
}) {
  const Icon = channel.icon;
  const customized = !!variant;
  const captionVal = variant?.caption ?? masterCaption;
  const imageVal = (variant?.imageUrl as string) ?? masterImage;
  const linkVal = (variant?.linkUrl as string) ?? masterLink;
  const overLimit = captionVal.length > channel.limit;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-sm text-[10px] font-display tracking-[0.16em] uppercase text-white"
          style={{ background: channel.color }}
        >
          <Icon className="w-3 h-3" strokeWidth={1.8} />
          {channel.label}
        </span>
        <span className={`text-[10px] tracking-[0.12em] uppercase ${overLimit ? "text-destructive" : "text-muted-foreground"}`}>
          {captionVal.length} / {channel.limit} chars
        </span>
        {!channel.linkSupport && (
          <span className="text-[10px] tracking-[0.12em] uppercase text-amber-700 dark:text-amber-400">
            · No clickable link in-post
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!customized ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-sm font-display tracking-[0.12em] text-[10px] h-7"
              onClick={fork}
              title="Copy master into this channel so you can customize it"
            >
              <Copy className="w-3 h-3 mr-1" /> CUSTOMIZE
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-sm font-display tracking-[0.12em] text-[10px] h-7 text-muted-foreground"
              onClick={reset}
              title="Revert this channel to the master post"
            >
              RESET TO MASTER
            </Button>
          )}
        </div>
      </div>
      {!customized && (
        <div className="text-[11px] text-muted-foreground italic">
          Inheriting from <strong>Master</strong>. Click CUSTOMIZE to write a variant just for {channel.label}.
        </div>
      )}
      <CaptionField
        value={captionVal}
        onChange={(v) => setVariant({ caption: v })}
        placeholder={`What you're posting on ${channel.label}…`}
        readOnly={!customized}
        helper={
          channel.id === "x"
            ? "X is brutal — under 280, hook in the first line."
            : channel.id === "linkedin"
              ? "LinkedIn rewards a strong first sentence and a single insight."
              : channel.id === "gbp"
                ? "Google Business Profile shows in your map listing — focus on the offer."
                : channel.id === "instagram"
                  ? "Instagram captions can be long — first 125 chars show before 'more'."
                  : "Avoid: stunning · nestled · must-see · dream home · boasts"
        }
      />
      <ImageField
        value={imageVal}
        onChange={(v) => setVariant({ imageUrl: v })}
        readOnly={!customized}
      />
      {channel.linkSupport && (
        <LinkField
          value={linkVal}
          onChange={(v) => setVariant({ linkUrl: v })}
          readOnly={!customized}
        />
      )}
    </div>
  );
}

function CaptionField({
  value,
  onChange,
  placeholder,
  helper,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  helper?: string;
  readOnly?: boolean;
}) {
  return (
    <div>
      <Label className="eyebrow text-muted-foreground">Caption</Label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        className={`mt-1.5 rounded-sm min-h-[160px] font-serif text-base leading-relaxed ${readOnly ? "opacity-70 cursor-not-allowed" : ""}`}
        style={{ letterSpacing: "-0.005em" }}
      />
      {helper && (
        <div className="text-[11px] text-muted-foreground/70 italic mt-1.5">{helper}</div>
      )}
    </div>
  );
}

function ImageField({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div>
      <Label className="eyebrow text-muted-foreground">Image URL</Label>
      <div className="flex items-center gap-2 mt-1.5">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://…"
          readOnly={readOnly}
          className={`rounded-sm h-10 ${readOnly ? "opacity-70" : ""}`}
        />
        {value ? (
          <img
            src={apiUrl(value)}
            alt=""
            className="w-10 h-10 rounded-sm object-cover border border-border shrink-0"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
        ) : (
          <div className="w-10 h-10 rounded-sm bg-secondary flex items-center justify-center shrink-0">
            <ImageIcon className="w-4 h-4 text-muted-foreground" strokeWidth={1.4} />
          </div>
        )}
      </div>
    </div>
  );
}

function LinkField({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div>
      <Label className="eyebrow text-muted-foreground">Link URL (optional)</Label>
      <div className="flex items-center gap-2 mt-1.5">
        <LinkIcon className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.6} />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://riversrealestate.ca/mls/…"
          readOnly={readOnly}
          className={`rounded-sm h-10 ${readOnly ? "opacity-70" : ""}`}
        />
      </div>
    </div>
  );
}
