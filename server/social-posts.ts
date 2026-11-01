// Sending a Marketing social post to the auto-poster: the "Luxury Homes
// Calgary — Social Post" Make scenario, behind MAKE_SOCIAL_WEBHOOK_URL, which
// routes each platform to its own module (Instagram, Google Business…).
//
// A post has one image (imageUrl) or several (mediaUrls, in order). Several
// images go to Instagram as a carousel: each platform's entry in the payload
// carries `postType` ("carousel" | "photo") and `media`, a list of
// {image_url, media_type} shaped for Make's Instagram "Create a Carousel Post"
// module, so the scenario can map it straight in. Image paths on this site
// (/uploads/…) are made absolute, since Make fetches them from outside.

import { storage } from "./storage";
import { publicOrigin } from "./origin";

function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return (raw as T) ?? fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** A site-relative path as a full URL; full URLs and empties pass through. */
export function absoluteUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return `${publicOrigin()}${u.startsWith("/") ? "" : "/"}${u}`;
}

/** The JSON columns of a stored post, parsed. */
export function socialPostView<T extends { channels: unknown; variants?: unknown; mediaUrls?: unknown }>(p: T) {
  return {
    ...p,
    channels: parse<string[]>(p.channels, []),
    variants: parse<Record<string, any>>(p.variants ?? "{}", {}),
    mediaUrls: parse<string[]>(p.mediaUrls ?? "[]", []),
  };
}

export interface PlatformPost {
  caption: string;
  imageUrl: string | null;
  mediaUrls: string[];
  media: Array<{ image_url: string; media_type: "IMAGE" }>;
  postType: "carousel" | "photo" | "text";
  linkUrl: string | null;
  scheduledFor: string | null;
}

/** What the webhook receives for one post. */
export function socialPayload(post: any) {
  const view = socialPostView(post as { channels: unknown; variants?: unknown; mediaUrls?: unknown });
  const posts: Record<string, PlatformPost> = {};
  for (const ch of view.channels) {
    const v = view.variants[ch] ?? {};
    const imageUrl = absoluteUrl(v.imageUrl ?? post.imageUrl ?? null);
    // A per-platform image replaces the carousel for that platform.
    const sources: string[] = v.imageUrl ? [v.imageUrl] : view.mediaUrls.length ? view.mediaUrls : imageUrl ? [imageUrl] : [];
    const media = sources
      .map((u) => absoluteUrl(u))
      .filter((u): u is string => !!u)
      .slice(0, 10); // Instagram's carousel limit
    posts[ch] = {
      caption: typeof v.caption === "string" && v.caption.trim() ? v.caption : post.caption,
      imageUrl: imageUrl ?? media[0] ?? null,
      mediaUrls: media,
      media: media.map((u) => ({ image_url: u, media_type: "IMAGE" as const })),
      postType: media.length > 1 ? "carousel" : media.length ? "photo" : "text",
      linkUrl: absoluteUrl(v.linkUrl ?? post.linkUrl ?? null),
      scheduledFor: v.scheduledFor ?? post.scheduledFor ?? null,
    };
  }
  const mediaUrls = view.mediaUrls.map((u: string) => absoluteUrl(u)).filter((u): u is string => !!u);
  return {
    postId: post.id,
    listingId: post.listingId,
    platforms: view.channels, // backwards-compat with router filters
    posts,
    // backwards-compat top-level master fields
    caption: post.caption,
    imageUrl: absoluteUrl(post.imageUrl) ?? mediaUrls[0] ?? null,
    linkUrl: absoluteUrl(post.linkUrl),
    mediaUrls,
  };
}

/** Send a stored post to the auto-poster and record the outcome. */
export async function dispatchSocialPost(id: number) {
  const post: any = storage.getSocialPost(id);
  if (!post) return null;
  const payload = socialPayload(post);
  const url = process.env.MAKE_SOCIAL_WEBHOOK_URL;
  let dispatched = false;
  let webhookError: string | null = null;
  if (url && payload.platforms.length > 0) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      dispatched = r.ok;
      if (!r.ok) webhookError = `Webhook ${r.status}: ${await r.text()}`;
    } catch (e: any) {
      webhookError = e?.message ?? "fetch failed";
    }
  } else if (!url) {
    webhookError = "MAKE_SOCIAL_WEBHOOK_URL not set";
  } else {
    webhookError = "No channels selected";
  }
  const updated = storage.updateSocialPost(id, {
    status: dispatched ? "posted" : "failed",
    postedAt: dispatched ? new Date().toISOString() : null,
  } as any);
  return { ...socialPostView(updated as any), dispatched, webhookError, posts: payload.posts };
}
