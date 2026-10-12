// Photo proxy for RETS listing images.
//
// Why we proxy instead of letting the browser hit the RETS server directly:
//   - The Pillar 9 server requires Digest auth and session cookies
//   - Credentials must never reach the browser
//   - Caching dramatically reduces RETS load (each card fetches the same hero)
//
// Strategy:
//   - Single long-lived RetsClient that re-logs-in if a request 401s
//   - In-memory LRU cache keyed by `${listingId}:${index}` (max ~500 entries)
//   - On miss, fetch from RETS and cache for 24h
//   - On RETS error or "no photo", return a 404 so the client falls back to
//     the placeholder hero image.
import { RetsClient, RetsAuthError } from "./rets-client";
import { storage } from "./storage";

interface CacheEntry {
  contentType: string;
  body: Buffer;
  expiresAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 500;
// Cache "we know this listing has no photo" results for 1 hour so we don't
// re-poke the RETS server on every page view. A failed fetch (expired
// session, throttling, timeout) is NOT "no photo" — it only backs off briefly.
// Caching failures for the full hour blanked every card's lead photo after
// each restart, when the first page loads fire dozens of fetches at once.
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;
const negativeCache = new Map<string, number>();

// Pillar 9 throttles bursts of GetObject calls; a listing grid asks for a
// dozen photos at once. Cap concurrent fetches, and share one fetch between
// simultaneous requests for the same photo.
const MAX_CONCURRENT = 2;
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
const inFlight = new Map<string, Promise<{ contentType: string; body: Buffer } | null>>();
const cache = new Map<string, CacheEntry>();

let client: RetsClient | null = null;
let loginPromise: Promise<void> | null = null;
// "Photo" is the standard RETS object type for listing images on Pillar 9.
// Also seen: "LargePhoto", "HiRes", "HighRes", "Thumbnail". The exact valid
// names come from the OBJECT metadata — see /api/admin/rets/object-types.
//
// Strategy: try the user-configured type first (RETS_PHOTO_TYPE), then fall
// back through the standard candidates. Whatever returns bytes wins. This
// keeps images working even when the env var is set to a name Pillar 9
// doesn't recognise. The first-success type is sticky per process via
// `successfulType` so we don't waste round-trips on subsequent listings.
const CONFIGURED_TYPE = process.env.RETS_PHOTO_TYPE ?? "Photo";
const FALLBACK_TYPES = ["LargePhoto", "Photo", "HiRes", "HighRes"];
let successfulType: string | null = null;

function typesToTry(): string[] {
  const order: string[] = [];
  if (successfulType) order.push(successfulType);
  if (CONFIGURED_TYPE && !order.includes(CONFIGURED_TYPE)) order.push(CONFIGURED_TYPE);
  for (const t of FALLBACK_TYPES) if (!order.includes(t)) order.push(t);
  return order;
}

function getClient(): RetsClient {
  if (!client) {
    client = new RetsClient({
      loginUrl: process.env.RETS_LOGIN_URL!,
      username: process.env.RETS_USERNAME!,
      password: process.env.RETS_PASSWORD!,
      userAgent: process.env.RETS_USER_AGENT ?? "RiversRealEstate/1.0",
      uaPassword: process.env.RETS_UA_PASSWORD || undefined,
    });
  }
  return client;
}

async function ensureLogin(): Promise<void> {
  if (!loginPromise) {
    loginPromise = (async () => {
      try {
        await getClient().login();
      } catch (err) {
        loginPromise = null;
        throw err;
      }
    })();
  }
  return loginPromise;
}

function lruSet(key: string, entry: CacheEntry) {
  if (cache.size >= MAX_ENTRIES) {
    // Evict the oldest entry (Map iteration order = insertion order)
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, entry);
}

export async function fetchListingPhoto(
  listingId: string,
  index: number,
): Promise<{ contentType: string; body: Buffer } | null> {
  if (!process.env.RETS_USERNAME || !process.env.RETS_PASSWORD) return null;
  const key = `${listingId}:${index}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { contentType: cached.contentType, body: cached.body };
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = withSlot(() => fetchListingPhotoUncached(listingId, index)).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function fetchListingPhotoUncached(
  listingId: string,
  index: number,
): Promise<{ contentType: string; body: Buffer } | null> {
  const key = `${listingId}:${index}`;
  // 1-based for RETS GetObject \u2014 the API accepts 0-based indexing externally
  const retsIndex = index + 1;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { contentType: cached.contentType, body: cached.body };
  }
  const negExpiry = negativeCache.get(key);
  if (negExpiry && negExpiry > Date.now()) return null;

  // Pillar 9 RETS GetObject keys photos by ListingKeyNumeric, not the
  // alphanumeric ListingId. Look up the numeric key from the DB.
  const listing = storage.getMlsListingById(listingId);
  if (!listing || !listing.listingKey) {
    negativeCache.set(key, Date.now() + NEGATIVE_TTL_MS);
    return null;
  }
  const retsListingId = String(listing.listingKey);

  try {
    await ensureLogin();
    const c = getClient();
    let result: { contentType: string; body: Buffer } | null = null;
    let lastErr: any = null;
    for (const type of typesToTry()) {
      try {
        const r = await c.getPhoto({
          resource: "Property",
          type,
          listingId: retsListingId,
          index: retsIndex,
        });
        if (r) {
          result = r;
          if (successfulType !== type) {
            successfulType = type;
            console.log(`[rets-photos] using object type "${type}"`);
          }
          break;
        }
      } catch (err) {
        if (err instanceof RetsAuthError) {
          // Session likely expired — re-login once and retry the same type
          loginPromise = null;
          await ensureLogin();
          try {
            const r = await c.getPhoto({
              resource: "Property",
              type,
              listingId: retsListingId,
              index: retsIndex,
            });
            if (r) {
              result = r;
              if (successfulType !== type) {
                successfulType = type;
                console.log(`[rets-photos] using object type "${type}"`);
              }
              break;
            }
          } catch (retryErr) {
            lastErr = retryErr;
          }
        } else {
          // Type-not-supported errors propagate as non-binary responses; just
          // try the next candidate.
          lastErr = err;
        }
      }
    }
    if (!result) {
      if (lastErr) {
        console.error(`[rets-photos] all types failed for ${key}:`, (lastErr as any)?.message ?? lastErr);
      }
      // Only a clean "no such object" answer means the photo doesn't exist.
      negativeCache.set(key, Date.now() + (lastErr ? ERROR_TTL_MS : NEGATIVE_TTL_MS));
      return null;
    }
    lruSet(key, {
      contentType: result.contentType,
      body: result.body,
      expiresAt: Date.now() + TTL_MS,
    });
    return result;
  } catch (err) {
    console.error(`[rets-photos] failed for ${key}:`, (err as any)?.message ?? err);
    // Back off briefly so we don't hammer — but retry soon, it's not "no photo".
    negativeCache.set(key, Date.now() + ERROR_TTL_MS);
    return null;
  }
}
