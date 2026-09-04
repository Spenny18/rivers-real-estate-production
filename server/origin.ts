// The one place that answers "what is this site's public origin?".
//
// Before this existed the answer was copy-pasted a dozen times with two
// different fallbacks — `https://riversrealestate.ca` in routes/SEO/booking,
// `https://luxury-homes-calgary.fly.dev` in the Google OAuth redirect and the
// lead-alert emails. With PUBLIC_ORIGIN unset that split meant the OAuth
// redirect URI pointed at one host while the links in outbound email pointed
// at another, which is exactly the kind of mismatch Google rejects with
// `redirect_uri_mismatch`.
//
// Set PUBLIC_ORIGIN in production and none of this matters. The fallback is
// only a development convenience, and `warnIfPublicOriginUnset` says so at
// boot so it never quietly becomes the deployed behaviour.

const DEFAULT_ORIGIN = "https://riversrealestate.ca";

/** The site's public origin, with any trailing slash removed. */
export function publicOrigin(): string {
  const raw = (process.env.PUBLIC_ORIGIN || DEFAULT_ORIGIN).trim();
  return raw.replace(/\/+$/, "");
}

export function publicOriginConfigured(): boolean {
  return !!process.env.PUBLIC_ORIGIN?.trim();
}

/**
 * The OAuth redirect URI this deploy will send to Google.
 *
 * It has to match an entry in the OAuth client's "Authorized redirect URIs"
 * character for character, so it is surfaced in /admin/scheduling for
 * copy-paste rather than left for someone to reconstruct by hand.
 */
export function googleRedirectUri(): string {
  return `${publicOrigin()}/api/admin/google/callback`;
}

let warned = false;
export function warnIfPublicOriginUnset(): void {
  if (warned || publicOriginConfigured()) return;
  warned = true;
  console.warn(
    `[origin] PUBLIC_ORIGIN is not set — falling back to ${DEFAULT_ORIGIN}. ` +
      `Booking links, outbound email and the Google OAuth redirect ` +
      `(${googleRedirectUri()}) all use it, so set it to the origin this app ` +
      `actually serves: fly secrets set PUBLIC_ORIGIN=https://your-domain`,
  );
}
