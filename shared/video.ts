/**
 * Video URL recognition, shared by the server (schema.org VideoObject
 * emission in server/seo-inject.ts) and the client (the embed the blog page
 * renders). One parser on both sides is what keeps the structured data
 * honest: a VideoObject is emitted for exactly the videos the page shows,
 * and nothing else.
 *
 * Recognised forms:
 *   YouTube  — watch?v=ID, youtu.be/ID, /shorts/ID, /embed/ID, /live/ID
 *   Vimeo    — vimeo.com/ID, vimeo.com/ID/HASH (unlisted), player.vimeo.com/video/ID
 *   File     — an absolute or site-relative URL ending in .mp4/.webm/.mov/.m4v/.ogv
 */

export type VideoProvider = "youtube" | "vimeo" | "file";

export interface VideoRef {
  provider: VideoProvider;
  /** YouTube/Vimeo id, or the file URL itself. */
  id: string;
  /** Canonical page URL for the video (watch page, Vimeo page, or the file). */
  url: string;
  /** iframe src for hosted providers. Absent for a direct file. */
  embedUrl?: string;
  /** The media file itself. Only for direct files. */
  contentUrl?: string;
  /**
   * Provider-hosted poster frames, best first. Empty for Vimeo and files —
   * the caller supplies its own image (the post's hero) for those.
   */
  thumbnailUrls: string[];
}

const YT_ID = "([A-Za-z0-9_-]{11})";
const YT_PATTERNS: RegExp[] = [
  new RegExp(`^(?:https?:)?\\/\\/(?:www\\.|m\\.)?youtube(?:-nocookie)?\\.com\\/watch\\?(?:[^#]*&)?v=${YT_ID}`, "i"),
  new RegExp(`^(?:https?:)?\\/\\/(?:www\\.|m\\.)?youtube(?:-nocookie)?\\.com\\/(?:embed|shorts|live|v)\\/${YT_ID}`, "i"),
  new RegExp(`^(?:https?:)?\\/\\/youtu\\.be\\/${YT_ID}`, "i"),
];
const VIMEO_PATTERNS: RegExp[] = [
  /^(?:https?:)?\/\/(?:www\.)?vimeo\.com\/(?:channels\/[\w-]+\/|groups\/[\w-]+\/videos\/|showcase\/\d+\/video\/)?(\d+)(?:\/([A-Za-z0-9]+))?(?:[?#]|$)/i,
  /^(?:https?:)?\/\/player\.vimeo\.com\/video\/(\d+)(?:\?(?:[^#]*&)?h=([A-Za-z0-9]+))?/i,
];
const FILE_PATTERN = /^(?:(?:https?:)?\/\/[^\s?#]+|\/[^\s?#]+)\.(mp4|webm|mov|m4v|ogv)(?:[?#]\S*)?$/i;

/** Parse one URL (or a bare-URL line). Returns null for anything that is not a video. */
export function parseVideoUrl(input: unknown): VideoRef | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  // A URL pasted as <https://…> (autolink syntax) or wrapped in quotes.
  s = s.replace(/^<(.+)>$/, "$1").replace(/^["'](.+)["']$/, "$1").trim();
  if (/\s/.test(s)) return null;

  for (const re of YT_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const id = m[1];
      return {
        provider: "youtube",
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: `https://www.youtube.com/embed/${id}`,
        thumbnailUrls: [
          `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
          `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        ],
      };
    }
  }
  for (const re of VIMEO_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const id = m[1];
      const hash = m[2];
      return {
        provider: "vimeo",
        id,
        url: hash ? `https://vimeo.com/${id}/${hash}` : `https://vimeo.com/${id}`,
        embedUrl: hash
          ? `https://player.vimeo.com/video/${id}?h=${hash}`
          : `https://player.vimeo.com/video/${id}`,
        thumbnailUrls: [],
      };
    }
  }
  if (FILE_PATTERN.test(s)) {
    const url = s.startsWith("//") ? `https:${s}` : s;
    return { provider: "file", id: url, url, contentUrl: url, thumbnailUrls: [] };
  }
  return null;
}

/** The dedupe key for a video: two refs to the same media compare equal. */
export function videoKey(v: VideoRef): string {
  return `${v.provider}:${v.id}`;
}

/**
 * Blog bodies are paragraph-separated text (see renderBody in
 * client/src/pages/blog-detail.tsx). A paragraph that is nothing but a video
 * URL is rendered as an embedded player; this returns those, in order.
 */
export function findBodyVideos(body: unknown): VideoRef[] {
  if (typeof body !== "string" || !body) return [];
  const out: VideoRef[] = [];
  for (const raw of body.split(/\n\s*\n/)) {
    const v = parseVideoUrl(raw);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Every video a post shows: the attached one first (it sits in the hero
 * slot), then any embedded in the body, without repeats.
 */
export function collectPostVideos(post: {
  videoUrl?: string | null;
  body?: string | null;
}): VideoRef[] {
  const seen = new Set<string>();
  const out: VideoRef[] = [];
  const attached = parseVideoUrl(post.videoUrl);
  for (const v of [...(attached ? [attached] : []), ...findBodyVideos(post.body)]) {
    const k = videoKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}
