/**
 * schema.org VideoObject for a YouTube video embedded on one of our pages.
 *
 * Google only shows a video rich result (and only lists the page in video
 * search) when the page's markup carries `name`, `thumbnailUrl`, `uploadDate`
 * and one of `contentUrl` / `embedUrl`, and when the video is actually
 * watchable on that page. The homepage video block is; a blog post that
 * merely links to YouTube is not, so nothing here is emitted for those.
 *
 * Nothing is fetched from YouTube at request time. YouTube's watch page and
 * its player API answer datacenter IPs with a bot check (verified from the
 * build environment; a Fly machine is no better placed), and the oEmbed
 * endpoint that does answer carries no upload date or duration. Both come
 * from the CMS instead — the editor reads them off YouTube Studio once — and
 * the title, description and poster fall back to what the block already
 * shows on the page, so the markup never claims more than the page does.
 */

import { IDS, type SchemaNode } from "./entities";

/** Accept "5:53", "1:02:03", "353" (seconds) or an ISO 8601 duration
 * ("PT5M53S") and return the ISO form, or undefined when it isn't one. */
export function isoDuration(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (/^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/i.test(v)) return v.toUpperCase();
  const parts = v.split(":").map((p) => p.trim());
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return undefined;
  const nums = parts.map(Number);
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  if (seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

/** Accept "2025-01-01" or a full ISO timestamp; anything else is dropped
 * rather than emitted as an invalid date. Google wants the date the video
 * went live, in ISO 8601, ideally with a timezone. A bare date is passed
 * through as-is (schema.org allows Date), not turned into midnight UTC. */
export function isoUploadDate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(v)) return undefined;
  if (Number.isNaN(Date.parse(v))) return undefined;
  return v;
}

/** A YouTube id is 11 URL-safe base64 characters. The CMS field says "the
 * part after watch?v=", but a pasted URL is an easy mistake — pull the id
 * out of the common URL shapes too. */
export function youtubeId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m = v.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m?.[1];
}

export interface YouTubeVideoInput {
  /** The page the video is embedded on (absolute). Anchors the @id. */
  pageUrl: string;
  youtubeId: string;
  name: string;
  description?: string;
  /** Poster the page shows; falls back to YouTube's own maxres frame. */
  thumbnail?: string;
  uploadDate?: string;
  duration?: string;
}

/** Build the VideoObject node for a YouTube video shown on `pageUrl`.
 * Returns null when the page can't truthfully name the video. */
export function youtubeVideoNode(input: YouTubeVideoInput): SchemaNode | null {
  const id = youtubeId(input.youtubeId);
  const name = input.name?.trim();
  if (!id || !name) return null;

  const maxres = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  const hq = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const poster = input.thumbnail?.trim();
  // The CMS poster first (it is what the page shows), then YouTube's own
  // frames: maxres isn't rendered for every upload, hqdefault always is.
  const thumbnailUrl = Array.from(new Set([poster || maxres, maxres, hq]));

  const node: SchemaNode = {
    "@type": "VideoObject",
    "@id": `${input.pageUrl}#video-${id}`,
    name,
    thumbnailUrl,
    url: `https://www.youtube.com/watch?v=${id}`,
    embedUrl: `https://www.youtube.com/embed/${id}`,
    inLanguage: "en-CA",
    isFamilyFriendly: true,
    author: { "@id": IDS.person },
    publisher: { "@id": IDS.agent },
  };
  const description = input.description?.trim();
  if (description) node.description = description;
  const uploadDate = isoUploadDate(input.uploadDate);
  if (uploadDate) node.uploadDate = uploadDate;
  const duration = isoDuration(input.duration);
  if (duration) node.duration = duration;
  return node;
}
