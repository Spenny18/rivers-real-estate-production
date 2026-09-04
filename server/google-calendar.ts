// Google Calendar integration — OAuth 2.0 flow + event mirroring.
//
// Required Fly secrets:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   PUBLIC_ORIGIN  (used to build the OAuth redirect URI)
//
// Setup steps for Spencer (one-time):
//   1. https://console.cloud.google.com -> create or pick a project
//   2. APIs & Services -> Library -> enable "Google Calendar API"
//   3. APIs & Services -> OAuth consent screen -> External, fill in app name
//      "Rivers Real Estate", user support email, developer contact. Add both
//      scopes `https://www.googleapis.com/auth/calendar.events` and
//      `https://www.googleapis.com/auth/calendar.freebusy`. In Test users
//      add spencer@riversrealestate.ca (Test mode is fine for personal use).
//   4. APIs & Services -> Credentials -> Create OAuth 2.0 Client ID, type
//      "Web application". Add Authorized redirect URI:
//        https://luxury-homes-calgary.fly.dev/api/admin/google/callback
//      (or your custom domain when DNS is wired)
//   5. Copy Client ID + Client Secret -> set as Fly secrets.

import { storage } from "./storage";
import type { UserIntegration } from "@shared/schema";

// calendar.events lets us write showings and bookings; calendar.freebusy lets
// the /book slot engine see the agent's real busy blocks so a slot is never
// offered over top of something already on the calendar. Adding a scope means
// reconnecting Google once from /admin/scheduling — until then free/busy
// simply returns nothing and only in-app bookings are treated as busy.
const SCOPE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const CAL_API = "https://www.googleapis.com/calendar/v3";

function clientId() {
  return process.env.GOOGLE_OAUTH_CLIENT_ID || "";
}
function clientSecret() {
  return process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
}
function redirectUri() {
  const origin = process.env.PUBLIC_ORIGIN || "https://luxury-homes-calgary.fly.dev";
  return `${origin}/api/admin/google/callback`;
}

export function googleConfigured(): boolean {
  return !!clientId() && !!clientSecret();
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}> {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Google token exchange failed: ${r.status} ${err}`);
  }
  const data: any = await r.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Google token refresh failed: ${r.status} ${err}`);
  }
  const data: any = await r.json();
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export async function getValidAccessToken(userId: number): Promise<string | null> {
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) return null;
  const expiresAt = integ.expiresAt ? new Date(integ.expiresAt).getTime() : 0;
  // Refresh 60 seconds before expiry.
  if (Date.now() < expiresAt - 60_000) return integ.accessToken;
  if (!integ.refreshToken) return null;
  try {
    const fresh = await refreshAccessToken(integ.refreshToken);
    storage.upsertUserIntegration({
      userId: integ.userId,
      provider: "google",
      accountEmail: integ.accountEmail ?? undefined,
      accessToken: fresh.accessToken,
      refreshToken: integ.refreshToken,
      expiresAt: new Date(Date.now() + fresh.expiresIn * 1000).toISOString(),
      scope: integ.scope ?? undefined,
      metadata: integ.metadata as any,
      active: true,
    } as any);
    return fresh.accessToken;
  } catch (e) {
    console.error("[google-cal] token refresh failed:", (e as any)?.message);
    return null;
  }
}

async function getAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    return data.email ?? null;
  } catch {
    return null;
  }
}

export async function persistTokens(
  userId: number,
  tokens: { accessToken: string; refreshToken?: string; expiresIn: number; scope?: string },
): Promise<UserIntegration> {
  const accountEmail = await getAccountEmail(tokens.accessToken);
  return storage.upsertUserIntegration({
    userId,
    provider: "google",
    accountEmail: accountEmail ?? undefined,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    scope: tokens.scope,
    metadata: JSON.stringify({ calendarId: "primary" }),
    active: true,
  } as any);
}

// ---- Calendar event sync --------------------------------------------------

interface TourLike {
  id: number;
  listingId: string;
  leadId: number | null;
  scheduledFor: string; // ISO
  status: string;
  notes: string | null;
  googleEventId?: string | null;
}

interface ListingLike {
  id: string;
  title?: string;
  fullAddress?: string;
  address?: string;
}

interface LeadLike {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

function buildEvent(tour: TourLike, listing?: ListingLike, lead?: LeadLike) {
  const start = new Date(tour.scheduledFor);
  const end = new Date(start.getTime() + 60 * 60 * 1000); // 1h default
  const title = listing
    ? `Showing — ${listing.title ?? listing.fullAddress ?? listing.id}`
    : `Showing — ${tour.listingId}`;
  const descLines: string[] = [];
  if (listing) {
    descLines.push(listing.fullAddress ?? listing.address ?? "");
    descLines.push("");
  }
  if (lead) {
    descLines.push(`Buyer: ${lead.name}`);
    if (lead.email) descLines.push(`Email: ${lead.email}`);
    if (lead.phone) descLines.push(`Phone: ${lead.phone}`);
    descLines.push("");
  }
  if (tour.notes) descLines.push(tour.notes);
  descLines.push("");
  descLines.push(`Status: ${tour.status}`);
  descLines.push(`Tour ID: ${tour.id}`);
  return {
    summary: title,
    description: descLines.join("\n"),
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    location: listing?.fullAddress ?? listing?.address ?? undefined,
    attendees: lead?.email ? [{ email: lead.email, displayName: lead.name }] : undefined,
    reminders: { useDefault: true },
  };
}

async function calApiCall(
  userId: number,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: any,
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return { ok: false, status: 401, error: "no_access_token" };
  const r = await fetch(`${CAL_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return { ok: true, status: 204 };
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    return { ok: false, status: r.status, error: JSON.stringify(data) };
  }
  return { ok: true, status: r.status, data };
}

export async function syncTourToGoogle(
  userId: number,
  tour: TourLike,
  listing?: ListingLike,
  lead?: LeadLike,
): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  if (!googleConfigured()) return { ok: false, error: "Google OAuth not configured" };
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) return { ok: false, error: "Google not connected" };
  const calendarId = (() => {
    try {
      return JSON.parse(integ.metadata as any).calendarId || "primary";
    } catch {
      return "primary";
    }
  })();

  const event = buildEvent(tour, listing, lead);
  if (tour.googleEventId) {
    // Update existing event
    const r = await calApiCall(
      userId,
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${tour.googleEventId}`,
      event,
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, eventId: tour.googleEventId };
  } else {
    // Create new event
    const r = await calApiCall(
      userId,
      "POST",
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      event,
    );
    if (!r.ok || !r.data?.id) return { ok: false, error: r.error };
    return { ok: true, eventId: r.data.id };
  }
}

export async function deleteTourFromGoogle(
  userId: number,
  tour: TourLike,
): Promise<{ ok: boolean; error?: string }> {
  if (!tour.googleEventId) return { ok: true };
  if (!googleConfigured()) return { ok: false, error: "Google OAuth not configured" };
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) return { ok: false, error: "Google not connected" };
  const calendarId = (() => {
    try {
      return JSON.parse(integ.metadata as any).calendarId || "primary";
    } catch {
      return "primary";
    }
  })();
  const r = await calApiCall(
    userId,
    "DELETE",
    `/calendars/${encodeURIComponent(calendarId)}/events/${tour.googleEventId}`,
  );
  if (!r.ok && r.status !== 404 && r.status !== 410) return { ok: false, error: r.error };
  return { ok: true };
}

// ---- Free/busy ------------------------------------------------------------

export interface BusyBlock {
  start: string; // ISO
  end: string; // ISO
}

function calendarIdFor(integ: UserIntegration): string {
  try {
    return JSON.parse(integ.metadata as any).calendarId || "primary";
  } catch {
    return "primary";
  }
}

/**
 * The agent's busy blocks between two instants, straight from Google.
 *
 * Returns [] rather than throwing whenever Google isn't connected, isn't
 * configured, or answers with an error — the booking page has to keep working
 * when the integration is down, and in-app bookings are still enforced.
 */
export async function getFreeBusy(
  userId: number,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<BusyBlock[]> {
  if (!googleConfigured()) return [];
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) return [];
  const calendarId = calendarIdFor(integ);
  const r = await calApiCall(userId, "POST", "/freeBusy", {
    timeMin: new Date(timeMinIso).toISOString(),
    timeMax: new Date(timeMaxIso).toISOString(),
    items: [{ id: calendarId }],
  });
  if (!r.ok) {
    console.warn("[google-cal] freeBusy failed:", r.status, r.error);
    return [];
  }
  const cal = r.data?.calendars?.[calendarId];
  if (!cal || !Array.isArray(cal.busy)) return [];
  return cal.busy
    .filter((b: any) => b?.start && b?.end)
    .map((b: any) => ({ start: b.start, end: b.end }));
}

// ---- Booking events -------------------------------------------------------

interface BookingLike {
  id: number;
  uid: string;
  name: string;
  email: string;
  phone?: string | null;
  notes?: string | null;
  answer?: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  googleEventId?: string | null;
}

interface EventTypeLike {
  name: string;
  locationType: string;
  locationDetail?: string | null;
  customQuestion?: string | null;
}

function buildBookingEvent(
  booking: BookingLike,
  eventType: EventTypeLike,
  origin: string,
) {
  const where =
    eventType.locationDetail?.trim() ||
    (eventType.locationType === "phone"
      ? `Phone — ${booking.phone ?? booking.email}`
      : eventType.locationType === "video"
        ? "Video call"
        : "");
  const desc = [
    `${eventType.name} booked at ${origin}/book`,
    "",
    `Name: ${booking.name}`,
    `Email: ${booking.email}`,
    booking.phone ? `Phone: ${booking.phone}` : null,
    booking.notes ? `\nNotes: ${booking.notes}` : null,
    eventType.customQuestion && booking.answer
      ? `\n${eventType.customQuestion}\n${booking.answer}`
      : null,
    "",
    `Manage: ${origin}/book/manage/${booking.uid}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  return {
    summary: `${eventType.name} — ${booking.name}`,
    description: desc,
    start: { dateTime: new Date(booking.startsAt).toISOString() },
    end: { dateTime: new Date(booking.endsAt).toISOString() },
    location: where || undefined,
    attendees: [{ email: booking.email, displayName: booking.name }],
    reminders: { useDefault: true },
  };
}

/**
 * Mirror a booking onto the agent's Google Calendar, creating or updating as
 * needed. `sendUpdates=all` asks Google to email the invitee its own invite,
 * on top of our confirmation email.
 */
export async function syncBookingToGoogle(
  userId: number,
  booking: BookingLike,
  eventType: EventTypeLike,
  origin: string,
): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  if (!googleConfigured()) return { ok: false, error: "Google OAuth not configured" };
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) return { ok: false, error: "Google not connected" };
  const calendarId = calendarIdFor(integ);
  const event = buildBookingEvent(booking, eventType, origin);
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;

  if (booking.googleEventId) {
    const r = await calApiCall(
      userId,
      "PATCH",
      `${base}/${booking.googleEventId}?sendUpdates=all`,
      event,
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, eventId: booking.googleEventId };
  }
  const r = await calApiCall(userId, "POST", `${base}?sendUpdates=all`, event);
  if (!r.ok || !r.data?.id) return { ok: false, error: r.error };
  return { ok: true, eventId: r.data.id };
}

export async function deleteBookingFromGoogle(
  userId: number,
  googleEventId: string | null | undefined,
): Promise<{ ok: boolean; error?: string }> {
  if (!googleEventId) return { ok: true };
  if (!googleConfigured()) return { ok: false, error: "Google OAuth not configured" };
  const integ = storage.getUserIntegration(userId, "google");
  if (!integ || !integ.active) return { ok: false, error: "Google not connected" };
  const calendarId = calendarIdFor(integ);
  const r = await calApiCall(
    userId,
    "DELETE",
    `/calendars/${encodeURIComponent(calendarId)}/events/${googleEventId}?sendUpdates=all`,
  );
  // Already gone is the outcome we wanted anyway.
  if (!r.ok && r.status !== 404 && r.status !== 410) return { ok: false, error: r.error };
  return { ok: true };
}
