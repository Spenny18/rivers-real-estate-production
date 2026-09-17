/**
 * YouTube references in our own content — the homepage video block's id
 * field and the YouTube links a blog post carries in its markdown body.
 * Shared by the client (which turns those links into a player) and the
 * server (which describes the same video to search engines), so the two
 * agree on which video a page shows. No React, no Node APIs.
 */

/** A YouTube id is 11 URL-safe base64 characters. Accepts a bare id or the
 * common URL shapes (watch?v=, youtu.be/, /embed/, /shorts/, /live/). */
export function youtubeIdFrom(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m = v.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  return m?.[1];
}

/** True when the URL points at a YouTube video (not a channel or a search). */
export function isYouTubeVideoUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(url) && youtubeIdFrom(url) !== undefined;
}

export interface YouTubeReference {
  id: string;
  /** The link text when the reference came from a markdown link. */
  title?: string;
  url: string;
}

/** YouTube's poster frames for an id: maxres isn't rendered for every
 * upload, hqdefault always is. */
export function youtubeThumbnails(id: string): string[] {
  return [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ];
}

/** True when `url` is one of YouTube's own thumbnail frames for this id
 * (i.ytimg.com or img.youtube.com, any size). */
export function isYouTubeThumbnailFor(url: unknown, id: string): boolean {
  return typeof url === "string" && new RegExp(`^https?://(?:i\\.ytimg\\.com|img\\.youtube\\.com)/vi/${id}/`).test(url.trim());
}

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>)\]]+/g;

/**
 * Every YouTube video a markdown body refers to, first mention first, one
 * entry per video. Markdown links win over bare URLs because they carry a
 * title; a bare URL of a video already seen adds nothing.
 */
export function findYouTubeReferences(markdown: string): YouTubeReference[] {
  const out: YouTubeReference[] = [];
  const seen = new Set<string>();
  const add = (url: string, title?: string) => {
    if (!isYouTubeVideoUrl(url)) return;
    const id = youtubeIdFrom(url)!;
    if (seen.has(id)) return;
    seen.add(id);
    const t = title?.trim();
    out.push(t ? { id, title: t, url } : { id, url });
  };
  const text = markdown || "";
  // Two passes in document order: links first so the title survives, then
  // bare URLs (which also re-encounter the link URLs, already seen).
  const mentions: Array<{ at: number; url: string; title?: string }> = [];
  for (const m of Array.from(text.matchAll(MARKDOWN_LINK))) mentions.push({ at: m.index ?? 0, url: m[2], title: m[1] });
  for (const m of Array.from(text.matchAll(BARE_URL))) mentions.push({ at: (m.index ?? 0) + 0.5, url: m[0] });
  mentions.sort((a, b) => a.at - b.at);
  for (const m of mentions) add(m.url, m.title);
  return out;
}
