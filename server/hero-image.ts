// AI-generated hero images for new blog posts (OpenAI gpt-image-1).
//
// The BOFU blog routine creates drafts through POST /api/admin/blog without a
// heroImage. When OPENAI_API_KEY is set, that route answers straight away with
// a placeholder from the stock pool and heroStatus "generating", then this
// module generates an image in the background (~20–60s), saves it on the
// uploads volume and swaps it in — unless someone has changed the hero in the
// meantime, in which case their choice wins and the generated file is unused.
//
// Env:
//   OPENAI_API_KEY        required; without it posts keep the pool image
//   HERO_IMAGE_MODEL      default gpt-image-1
//   HERO_IMAGE_QUALITY    low | medium | high (default medium, ~$0.04/image)
//   OPENAI_BASE_URL       optional API base (default https://api.openai.com/v1)
//   BLOG_HERO_AI=off      turn generation off without removing the key
//
// POST /api/admin/blog/:slug/generate-hero (routes.ts) regenerates one post's
// hero on demand — for an image that came out wrong, or an older post that
// predates this module.

import fs from "node:fs";
import path from "node:path";
import { ensureUploadsDir } from "./uploads";
import { storage } from "./storage";
import { invalidateSsrCache } from "./ssr";

const SUBDIR = "blog-heroes";
const TIMEOUT_MS = 180_000;

export function heroImageGenerationEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY && !/^(off|false|0|no)$/i.test(process.env.BLOG_HERO_AI ?? "");
}

// Same look as the condo heroes (script/generate-condo-images.ts): editorial
// real estate photography, no text. The subject comes from the post itself.
const STYLE =
  "Photorealistic editorial real estate photography for a luxury real estate blog in Calgary, Alberta. " +
  "Natural light, warm golden-hour tones, refined and uncluttered composition, wide 3:2 landscape framing " +
  "with room for the image to be cropped to 16:9. Authentic Calgary setting where relevant: mature " +
  "tree-lined streets, contemporary and character luxury homes, Rocky Mountain foothills or the downtown " +
  "skyline in the distance. No text, no words, no numbers, no signage, no logos, no watermarks, " +
  "no recognisable faces.";

export function buildHeroPrompt(post: { title: string; excerpt?: string | null; heroImageAlt?: string | null }): string {
  const parts = [`Hero image for a blog post titled "${post.title.trim()}".`];
  if (post.heroImageAlt?.trim()) parts.push(`Focus: ${post.heroImageAlt.trim()}.`);
  if (post.excerpt?.trim()) parts.push(`The post is about: ${post.excerpt.trim().slice(0, 400)}`);
  parts.push(STYLE);
  return parts.join(" ");
}

async function requestImage(prompt: string): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.HERO_IMAGE_MODEL || "gpt-image-1",
      prompt,
      size: "1536x1024",
      quality: process.env.HERO_IMAGE_QUALITY || "medium",
      // JPEG keeps a 1536px hero around 200–400KB; PNG would be several MB.
      output_format: "jpeg",
      output_compression: 85,
      n: 1,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`);
  }
  const data: any = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image data");
  return Buffer.from(b64, "base64");
}

/** Generate and save a hero for `slug`; returns its /uploads URL. */
export async function generateHeroImage(
  slug: string,
  post: { title: string; excerpt?: string | null; heroImageAlt?: string | null },
): Promise<string> {
  const buf = await requestImage(buildHeroPrompt(post));
  const dir = ensureUploadsDir(SUBDIR);
  // Temp file + rename so the static server never serves a half-written file.
  const final = path.join(dir, `${slug}.jpg`);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, final);
  return `/uploads/${SUBDIR}/${slug}.jpg?v=${Date.now()}`;
}

const inFlight = new Set<string>();
// slug → the placeholder a generated image replaced. In memory only: it
// covers an editor tab opened before the image landed.
const replaced = new Map<string, { placeholder: string; generated: string }>();

/**
 * The admin editor loads a new post while it still has its placeholder and
 * sends every field back on save — which would put the placeholder back over
 * the generated image. Treat "save the old placeholder" as "keep the image".
 */
export function keepGeneratedHero(slug: string, incoming: string, current: string): string {
  const swap = replaced.get(slug);
  if (swap && incoming === swap.placeholder && current === swap.generated) return current;
  return incoming;
}

/**
 * Fire-and-forget generation for a just-created post. `placeholder` is the
 * hero the post was saved with; the generated image replaces it only if the
 * post still has that placeholder when generation finishes.
 */
export function queueHeroImage(slug: string, placeholder: string): void {
  if (inFlight.has(slug)) return;
  const post = storage.getBlogBySlug(slug);
  if (!post) return;
  inFlight.add(slug);
  const started = Date.now();
  generateHeroImage(slug, post)
    .then((url) => {
      const current = storage.getBlogBySlug(slug);
      if (!current) return;
      if ((current.heroImage || "") !== placeholder) {
        console.log(`[hero-image] "${slug}": hero changed during generation — keeping ${current.heroImage}`);
        return;
      }
      storage.upsertBlogPost({ ...current, heroImage: url } as any);
      replaced.set(slug, { placeholder, generated: url });
      // Rendered pages (the post, the blog index, the homepage's journal
      // block) are cached for minutes; without this the placeholder lingers.
      invalidateSsrCache();
      console.log(`[hero-image] "${slug}": generated in ${Math.round((Date.now() - started) / 1000)}s → ${url}`);
    })
    .catch((err) => {
      console.error(`[hero-image] "${slug}": generation failed, keeping placeholder:`, err?.message ?? err);
    })
    .finally(() => inFlight.delete(slug));
}

/**
 * Regenerate one post's hero now and save it, replacing whatever it has.
 * `focus`, when given, steers the subject (it stands in for the alt text in
 * the prompt). Throws when generation is off, the post is missing, or a
 * generation for it is already running.
 */
export async function regenerateHeroImage(slug: string, focus?: string | null): Promise<string> {
  if (!heroImageGenerationEnabled()) throw new Error("Hero generation is off (OPENAI_API_KEY unset or BLOG_HERO_AI=off)");
  const post = storage.getBlogBySlug(slug);
  if (!post) throw new Error("Post not found");
  if (inFlight.has(slug)) throw new Error("A hero is already being generated for this post");
  inFlight.add(slug);
  try {
    const previous = post.heroImage || "";
    const url = await generateHeroImage(slug, { ...post, heroImageAlt: focus?.trim() || post.heroImageAlt });
    const current = storage.getBlogBySlug(slug);
    if (!current) throw new Error("Post was deleted during generation");
    storage.upsertBlogPost({ ...current, heroImage: url } as any);
    // Same guard as the background path: an editor tab still holding the old
    // hero shouldn't put it back on its next save.
    replaced.set(slug, { placeholder: previous, generated: url });
    invalidateSsrCache();
    return url;
  } finally {
    inFlight.delete(slug);
  }
}
