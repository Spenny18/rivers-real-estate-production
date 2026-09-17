import { useState } from "react";
import { Play } from "lucide-react";
import type { VideoRef } from "@shared/video";

/**
 * The one player the public site uses for a recognised video URL (see
 * shared/video.ts). Hosted providers get a click-to-play poster so the page
 * loads no third-party iframe until the visitor asks for it; a direct file
 * gets the native <video> element.
 *
 * The server emits a schema.org VideoObject for every video rendered
 * through this component (server/seo-inject.ts), keyed on the same parser —
 * if you render a video some other way, the markup won't know about it.
 */
export function VideoEmbed({
  video,
  title,
  poster,
  className = "",
}: {
  video: VideoRef;
  title: string;
  /** Poster frame. Falls back to the provider's own thumbnail for YouTube. */
  poster?: string | null;
  className?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [posterIdx, setPosterIdx] = useState(0);
  const posters = [poster, ...video.thumbnailUrls].filter((p): p is string => !!p);
  const posterSrc = posters[posterIdx];

  const frame = `relative aspect-video rounded-sm overflow-hidden bg-black ${className}`;

  if (video.provider === "file") {
    return (
      <div className={frame} data-testid="video-embed">
        <video
          controls
          playsInline
          preload="metadata"
          src={video.contentUrl}
          poster={poster || undefined}
          title={title}
          className="w-full h-full"
        />
      </div>
    );
  }

  const embedSrc = `${video.embedUrl}${video.embedUrl!.includes("?") ? "&" : "?"}autoplay=1${
    video.provider === "youtube" ? "&rel=0" : ""
  }`;

  // Vimeo with no poster of our own: the iframe straight away, since Vimeo
  // offers no predictable thumbnail URL to show first.
  if (playing || !posterSrc) {
    return (
      <div className={frame} data-testid="video-embed">
        <iframe
          src={playing ? embedSrc : video.embedUrl}
          title={title}
          className="w-full h-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <div className={frame} data-testid="video-embed">
      <button
        type="button"
        onClick={() => setPlaying(true)}
        className="group absolute inset-0 w-full h-full"
        aria-label={`Play video: ${title}`}
        data-testid="btn-play-video"
      >
        <img
          src={posterSrc}
          alt={title}
          // A missing maxresdefault (older or low-res uploads) 404s — step
          // down to the next candidate rather than showing a broken image.
          onError={() => setPosterIdx((i) => Math.min(i + 1, posters.length - 1))}
          className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="w-16 h-16 lg:w-20 lg:h-20 rounded-full bg-white/95 group-hover:bg-white flex items-center justify-center transition-transform group-hover:scale-105">
            <Play
              className="w-7 h-7 lg:w-8 lg:h-8 text-black ml-1"
              strokeWidth={1.6}
              fill="currentColor"
            />
          </span>
        </div>
      </button>
    </div>
  );
}
