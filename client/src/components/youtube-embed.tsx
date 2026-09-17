import { useState } from "react";
import { Play } from "lucide-react";
import { youtubeThumbnails } from "@shared/youtube";

/**
 * Click-to-play YouTube embed. Shows the poster frame with a play button
 * and only loads YouTube's iframe once the visitor asks for it, so a page
 * with a video doesn't pay for the player (and YouTube's cookies) up front.
 * The poster falls back from maxres to hqdefault, which every upload has.
 */
export function YouTubeEmbed({
  id,
  title,
  poster,
  className = "",
  testid = "youtube-embed",
}: {
  id: string;
  title: string;
  /** Poster to show before play; YouTube's own frame when omitted. */
  poster?: string;
  className?: string;
  testid?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [maxres, hq] = youtubeThumbnails(id);
  const [src, setSrc] = useState(poster || maxres);
  return (
    <div className={`relative aspect-video overflow-hidden bg-black ${className}`} data-testid={testid}>
      {playing ? (
        <iframe
          src={`https://www.youtube.com/embed/${id}?autoplay=1&rel=0`}
          title={title}
          className="w-full h-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="group absolute inset-0 w-full h-full"
          aria-label={`Play video: ${title}`}
          data-testid={`${testid}-play`}
        >
          <img
            src={src}
            onError={() => {
              if (src !== hq) setSrc(hq);
            }}
            alt={title}
            className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="w-20 h-20 lg:w-24 lg:h-24 rounded-full bg-white/95 group-hover:bg-white flex items-center justify-center transition-transform group-hover:scale-105">
              <Play className="w-8 h-8 lg:w-10 lg:h-10 text-black ml-1" strokeWidth={1.6} fill="currentColor" />
            </span>
          </div>
        </button>
      )}
    </div>
  );
}
