// Showings: a property visit with a client, keyed to an MLS number, that lands
// on Spencer's calendar and in the client's.
//
// This replaces scheduling showings in Follow Up Boss. A showing is a row in
// `tours` (the table the /admin/calendar dashboard has always read); the admin
// "New showing" form, the client portal's tour requests and the status select
// on the calendar all go through here.
//
// Two separate deliveries per showing:
//
//   Spencer's calendar — when Google is connected, every showing is mirrored
//   as an event on his Google Calendar (tours.googleEventId).
//
//   The client's invite — sent once the showing is confirmed, if notifyClient
//   is on and there's an email address. Preferably by making the client an
//   attendee on that same Google event with sendUpdates=all: Google emails a
//   real invite they can accept, and moving or cancelling the event updates
//   their calendar automatically. If Google isn't connected (or refuses), a
//   branded email with an .ics invitation goes out through Resend instead.
//   Whichever channel invited the client is recorded and stays put, so a
//   reschedule or cancellation reaches them the same way the invite did.

import { storage, sqlite } from "./storage";
import { calendarRequest, googleCalendarReady } from "./google-calendar";
import { sendEmail, buildShowingEmailHtml } from "./email";
import { formatInZone } from "./booking";
import { publicOrigin } from "./origin";
import { AGENT } from "./brand";
import { mlsPropertyPath } from "@shared/mls-url";
import type { Tour } from "@shared/schema";
import { showingStreetLine } from "@shared/showing-address";

export const SHOWING_TIME_ZONE = "America/Edmonton";

// ---- What's being shown -------------------------------------------------------

export interface ShowingListing {
  source: "mls" | "managed" | "unknown";
  mlsNumber: string | null;
  address: string;
  /** "$1.85M · 4 bd · 3.5 ba" */
  summary: string | null;
  price: number | null;
  url: string | null;
  photoUrl: string | null;
}

function price(n: number | null | undefined): string | null {
  if (!n || !Number.isFinite(n)) return null;
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : `$${Math.round(n / 1000)}K`;
}

function summarize(p: number | null | undefined, beds: number | null | undefined, baths: number | null | undefined): string | null {
  const bits = [price(p), beds ? `${beds} bd` : null, baths ? `${baths} ba` : null].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

function absolute(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `${publicOrigin()}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * The feed's fullAddress is usually just the street line ("4504 67 Street");
 * a calendar location and a map search need the town too.
 */
function withLocality(street: string, city: string | null | undefined, province: string | null | undefined): string {
  const parts = [street.trim()];
  if (city && !street.toLowerCase().includes(city.toLowerCase())) parts.push(city.trim());
  if (province && !/\b(AB|Alberta)\b/i.test(street)) parts.push(province.trim());
  return parts.filter(Boolean).join(", ");
}

/** MLS numbers are stored upper-case ("A2349881"); accept them typed any way. */
export function normalizeMlsNumber(v: string): string {
  return v.trim().toUpperCase().replace(/\s+/g, "");
}

/** Resolve a tour's listingId: an MLS number first, then a managed listing. */
export function resolveShowingListing(listingId: string): ShowingListing {
  const mls = storage.getMlsListingById(normalizeMlsNumber(listingId));
  if (mls) {
    const path = mlsPropertyPath({ ...(mls as any), seoSlug: storage.getMlsSeoSlug(mls) });
    return {
      source: "mls",
      mlsNumber: mls.mlsNumber,
      address: withLocality(mls.fullAddress, mls.city, mls.province),
      summary: summarize(mls.listPrice, mls.beds, mls.baths),
      price: mls.listPrice ?? null,
      url: `${publicOrigin()}${path}`,
      photoUrl: absolute(mls.heroImage),
    };
  }
  const managed = storage.getListingById(listingId) as any;
  if (managed) {
    return {
      source: "managed",
      mlsNumber: null,
      address: [managed.address, managed.city].filter(Boolean).join(", "),
      summary: summarize(managed.price, managed.beds, managed.baths),
      price: managed.price ?? null,
      url: managed.slug ? `${publicOrigin()}/p/${managed.slug}` : null,
      photoUrl: absolute(managed.heroImage),
    };
  }
  return { source: "unknown", mlsNumber: null, address: listingId, summary: null, price: null, url: null, photoUrl: null };
}

/**
 * Spencer's own addresses. Google never emails an invitation to the calendar's
 * owner (the event is already on their calendar), so a showing with Spencer
 * as the client, which is how a test naturally gets done, goes by email
 * instead or nothing arrives.
 */
function isOwnAddress(email: string | null | undefined, userId: number): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const own = new Set<string>();
  const add = (v: string | null | undefined) => {
    const m = v?.match(/[^\s<>]+@[^\s<>]+/);
    if (m) own.add(m[0].toLowerCase());
  };
  add(AGENT.email);
  add(process.env.SPENCER_NOTIFY_EMAIL);
  add(process.env.RESEND_FROM_EMAIL);
  add(storage.getUserById(userId)?.email);
  add(storage.getUserIntegration(userId, "google")?.accountEmail);
  return own.has(e);
}

// Street-type abbreviations people type that aren't a substring of what the
// feed spells out. ("st", "dr", "ave", "cres", "pl", "cl" already are.)
const STREET_ABBREVIATIONS: Record<string, string> = {
  rd: "road", blvd: "boulevard", ct: "court", hts: "heights", gdns: "gardens",
  pkwy: "parkway", mnr: "manor", ln: "lane", tr: "trail", trl: "trail",
  sq: "square", pt: "point", cir: "circle", cv: "cove", gt: "gate", hl: "hill",
  mt: "mount", mtn: "mountain", pk: "park", vw: "view", rdg: "ridge",
  mdw: "meadow", mdws: "meadows", lndg: "landing", tce: "terrace", ter: "terrace", hwy: "highway",
};

export interface ListingMatch extends ShowingListing {
  status: string | null;
}

/**
 * Find listings by address as typed: "48 glamis green", "38 lissington dr sw",
 * "#134 48 Glamis". Every word has to appear (unit, street number, street name,
 * quadrant, town, in any order); whole-word hits rank above partial ones, so
 * "48" prefers 48 Glamis Green over 148 or 4800. An MLS number works too.
 */
export function searchShowingListings(query: string, limit = 8): ListingMatch[] {
  const tokens = query
    .toLowerCase()
    .replace(/[#,.]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (tokens.length === 0) return [];
  const haystack = "lower(full_address || ' ' || coalesce(city, '') || ' ' || mls_number)";
  const clauses: string[] = [];
  const params: string[] = [];
  for (const t of tokens) {
    const alt = STREET_ABBREVIATIONS[t];
    clauses.push(alt ? `(${haystack} LIKE ? OR ${haystack} LIKE ?)` : `${haystack} LIKE ?`);
    params.push(`%${t}%`, ...(alt ? [`%${alt}%`] : []));
  }
  const rows = sqlite
    .prepare(`SELECT id, full_address AS fullAddress, city, status FROM mls_listings WHERE ${clauses.join(" AND ")} LIMIT 200`)
    .all(...params) as Array<{ id: string; fullAddress: string; city: string | null; status: string | null }>;

  const wordsOf = (r: (typeof rows)[number]) =>
    new Set(`${r.fullAddress} ${r.city ?? ""} ${r.id}`.toLowerCase().replace(/[#,.]/g, " ").split(/\s+/));
  const score = (r: (typeof rows)[number]) => {
    const words = wordsOf(r);
    return tokens.reduce((n, t) => n + (words.has(t) || words.has(STREET_ABBREVIATIONS[t] ?? "") ? 1 : 0), 0);
  };
  return rows
    .map((r) => ({ r, score: score(r), active: (r.status ?? "").toLowerCase() === "active" }))
    .sort((a, b) => b.score - a.score || Number(b.active) - Number(a.active) || a.r.fullAddress.localeCompare(b.r.fullAddress))
    .slice(0, limit)
    .map(({ r }) => ({ ...resolveShowingListing(r.id), status: r.status }));
}

export function mapUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// ---- Who's being shown it -----------------------------------------------------

export interface ShowingClient {
  name: string;
  email: string | null;
  phone: string | null;
}

/** The snapshot on the row, falling back to the linked site lead (portal requests). */
export function showingClient(tour: Tour): ShowingClient | null {
  if (tour.clientName || tour.clientEmail) {
    return { name: tour.clientName || tour.clientEmail || "Client", email: tour.clientEmail, phone: tour.clientPhone };
  }
  const lead = tour.leadId ? storage.getLead(tour.leadId) : undefined;
  return lead ? { name: lead.name, email: lead.email, phone: lead.phone ?? null } : null;
}

function endOf(tour: Tour): string {
  return new Date(Date.parse(tour.scheduledFor) + (tour.durationMinutes || 60) * 60_000).toISOString();
}

// ---- The calendar event --------------------------------------------------------

function eventDescription(tour: Tour, listing: ShowingListing, forClient: boolean, client: ShowingClient | null): string {
  const lines: string[] = [];
  if (listing.summary) lines.push(listing.summary);
  if (listing.mlsNumber) lines.push(`MLS® ${listing.mlsNumber}`);
  if (listing.url) lines.push(`Listing: ${listing.url}`);
  lines.push(`Map: ${mapUrl(listing.address)}`);
  if (tour.notes) lines.push("", tour.notes);
  if (forClient) {
    lines.push("", `${AGENT.name} · ${AGENT.business}`, `${AGENT.phone} · ${AGENT.email}`);
  } else if (client) {
    // Only on Spencer's private copy: the client sees the same event when
    // invited, so their own contact details there would just be noise.
    lines.push("", `Client: ${client.name}`, ...(client.phone ? [`Phone: ${client.phone}`] : []));
  }
  return lines.join("\n");
}

function googleEvent(tour: Tour, listing: ShowingListing, client: ShowingClient | null, inviteClient: boolean) {
  const street = showingStreetLine(listing.address);
  return {
    summary: inviteClient ? `Showing: ${street} with ${AGENT.name}` : `Showing: ${street}${client ? ` — ${client.name}` : ""}`,
    description: eventDescription(tour, listing, inviteClient, client),
    location: listing.address,
    start: { dateTime: tour.scheduledFor, timeZone: SHOWING_TIME_ZONE },
    end: { dateTime: endOf(tour), timeZone: SHOWING_TIME_ZONE },
    attendees: inviteClient && client?.email ? [{ email: client.email, displayName: client.name }] : [],
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    reminders: { useDefault: true },
    extendedProperties: { private: { tourId: String(tour.id) } },
  };
}

// ---- The .ics fallback --------------------------------------------------------------

function icsEscape(s: string): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 line folding: no line longer than 75 octets. */
function icsFold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildShowingIcs(tour: Tour, listing: ShowingListing, client: ShowingClient, cancel: boolean): string {
  const organizerEmail = AGENT.email;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rivers Real Estate//Showings//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancel ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    // Stable per showing: a later file with a higher SEQUENCE updates (or
    // cancels) the event the client already added, rather than adding another.
    `UID:showing-${tour.id}@riversrealestate.ca`,
    `SEQUENCE:${tour.inviteSequence}`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(tour.scheduledFor)}`,
    `DTEND:${icsStamp(endOf(tour))}`,
    `SUMMARY:${icsEscape(`Showing: ${showingStreetLine(listing.address)} with ${AGENT.name}`)}`,
    `DESCRIPTION:${icsEscape(eventDescription(tour, listing, true, client))}`,
    `LOCATION:${icsEscape(listing.address)}`,
    ...(listing.url ? [`URL:${listing.url}`] : []),
    `ORGANIZER;CN=${icsEscape(AGENT.name)}:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${icsEscape(client.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${client.email}`,
    `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`,
    ...(cancel
      ? []
      : ["BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(`Showing: ${showingStreetLine(listing.address)}`)}`, "END:VALARM"]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

async function emailInvite(
  tour: Tour,
  listing: ShowingListing,
  client: ShowingClient,
  kind: "invite" | "update" | "cancel",
): Promise<{ ok: boolean; error?: string }> {
  const ics = buildShowingIcs(tour, listing, client, kind === "cancel");
  const street = showingStreetLine(listing.address);
  const subject =
    kind === "cancel"
      ? `Cancelled: showing at ${street}`
      : kind === "update"
        ? `Updated: showing at ${street} — ${formatInZone(tour.scheduledFor, SHOWING_TIME_ZONE)}`
        : `Showing at ${street} — ${formatInZone(tour.scheduledFor, SHOWING_TIME_ZONE)}`;
  const r = await sendEmail({
    to: client.email!,
    subject,
    html: buildShowingEmailHtml({
      kind,
      clientName: client.name,
      whenLabel: formatInZone(tour.scheduledFor, SHOWING_TIME_ZONE),
      durationMinutes: tour.durationMinutes || 60,
      address: listing.address,
      summary: listing.summary,
      mlsNumber: listing.mlsNumber,
      listingUrl: listing.url,
      photoUrl: listing.photoUrl,
      mapUrl: mapUrl(listing.address),
      note: tour.notes,
      origin: publicOrigin(),
    }),
    replyTo: AGENT.email,
    attachments: [
      {
        filename: kind === "cancel" ? "cancel.ics" : "invite.ics",
        content: Buffer.from(ics, "utf8").toString("base64"),
        contentType: `text/calendar; charset=utf-8; method=${kind === "cancel" ? "CANCEL" : "REQUEST"}`,
      },
    ],
    // Opens and clicks show on the client's CRM timeline (server/tracking.ts).
    track: { kind: "showing", contactFubId: tour.contactFubId },
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// ---- Keeping both calendars in step --------------------------------------------

export interface DeliveryResult {
  /** Spencer's Google Calendar copy. */
  calendar: "synced" | "removed" | "not-connected" | "failed";
  /** The client's invite. */
  client: "invited" | "updated" | "cancelled" | "not-sent" | "failed";
  channel: "google" | "email" | null;
  error?: string;
}

/**
 * Bring Spencer's calendar and the client's invite in line with the row as it
 * now stands. Call after any create or change. `changedTime` says the time or
 * length moved, which is what makes an already-invited client need an update.
 *
 * The rules, in order:
 *   - A client is first invited when the showing becomes "confirmed" (and
 *     notifyClient is on and there's an email). "requested" never invites.
 *   - Once invited they stay on the event through "completed", silently.
 *   - They're told about a time change, and about a cancellation. Nothing else
 *     Spencer edits emails them.
 *   - After a cancellation the invite is closed out; confirming again sends a
 *     fresh one.
 */
export async function syncShowing(userId: number, tourId: number, opts: { changedTime?: boolean } = {}): Promise<DeliveryResult> {
  let tour = storage.getTour(tourId);
  if (!tour) throw new Error("Showing not found");
  const save = (patch: Partial<Tour>) => {
    tour = storage.updateTour(tourId, patch) ?? tour;
  };
  const listing = resolveShowingListing(tour.listingId);
  const client = showingClient(tour);
  const cancelled = tour.status === "cancelled";
  const invited = !!tour.inviteChannel;
  const google = googleCalendarReady(userId);

  const newInvite = !invited && !cancelled && tour.status === "confirmed" && tour.notifyClient && !!client?.email;
  // Sticky once chosen; a new invite prefers Google when it's connected.
  const channel: "google" | "email" | null = invited
    ? (tour.inviteChannel as "google" | "email")
    : newInvite
      ? google && !isOwnAddress(client?.email, userId)
        ? "google"
        : "email"
      : null;
  const clientMustHear = newInvite || (invited && (cancelled || !!opts.changedTime));

  const result: DeliveryResult = { calendar: google ? "synced" : "not-connected", client: "not-sent", channel };

  // 1. Spencer's calendar — and on the google channel, the client's invite too.
  if (google) {
    const sendUpdates = channel === "google" && clientMustHear ? "all" : "none";
    if (cancelled) {
      if (tour.googleEventId) {
        const r = await calendarRequest(userId, "DELETE", `/events/${encodeURIComponent(tour.googleEventId)}?sendUpdates=${sendUpdates}`);
        if (r.ok || r.status === 404 || r.status === 410) save({ googleEventId: null });
        else {
          result.calendar = "failed";
          result.error = r.error;
        }
      }
      if (result.calendar !== "failed") result.calendar = "removed";
    } else {
      const attendee = channel === "google"; // invited, or being invited now
      const event = googleEvent(tour, listing, client, attendee);
      let r = tour.googleEventId
        ? await calendarRequest(userId, "PATCH", `/events/${encodeURIComponent(tour.googleEventId)}?sendUpdates=${sendUpdates}`, event)
        : null;
      // Deleted from Google by hand: make a fresh one rather than failing.
      if (!r || r.status === 404 || r.status === 410) {
        r = await calendarRequest(userId, "POST", `/events?sendUpdates=${sendUpdates}`, event);
      }
      if (r.ok && r.data?.id) save({ googleEventId: r.data.id });
      else {
        result.calendar = "failed";
        result.error = r.error;
      }
    }
  }

  // 2. The client.
  if (channel === "google") {
    if (result.calendar === "failed") {
      // A first invite Google wouldn't take goes by email instead, so the
      // client isn't left without one. An existing Google invite can't be
      // moved to email mid-stream (they'd hold two events), so that's a
      // reported failure.
      if (newInvite) return byEmail("invite");
      if (clientMustHear) {
        result.client = "failed";
        save({ inviteError: (result.error ?? "Google Calendar update failed").slice(0, 300) });
      }
      return result;
    }
    if (newInvite) {
      result.client = "invited";
      save({ inviteChannel: "google", invitedAt: new Date().toISOString(), inviteError: null });
    } else if (invited && cancelled) {
      result.client = "cancelled";
      save({ inviteChannel: null, inviteError: null });
    } else if (invited && opts.changedTime) {
      result.client = "updated";
    }
    return result;
  }
  if (channel === "email") {
    if (newInvite) return byEmail("invite");
    if (invited && cancelled) return byEmail("cancel");
    if (invited && opts.changedTime) return byEmail("update");
  }
  return result;

  async function byEmail(kind: "invite" | "update" | "cancel"): Promise<DeliveryResult> {
    result.channel = "email";
    const current = tour!;
    // A later .ics only replaces an earlier one with a higher SEQUENCE, and
    // that includes a re-invite after a cancellation (same UID).
    save({ inviteSequence: current.invitedAt ? current.inviteSequence + 1 : 0 });
    const sent = await emailInvite(tour!, listing, client!, kind);
    if (!sent.ok) {
      result.client = "failed";
      result.error = sent.error;
      save({ inviteError: (sent.error ?? "Email failed").slice(0, 300) });
      return result;
    }
    result.client = kind === "invite" ? "invited" : kind === "update" ? "updated" : "cancelled";
    if (kind === "invite") save({ inviteChannel: "email", invitedAt: new Date().toISOString(), inviteError: null });
    else if (kind === "cancel") save({ inviteChannel: null, inviteError: null });
    else save({ inviteError: null });
    return result;
  }
}

/**
 * Re-send the client's invite — for "I never got it". On the Google channel
 * the event is re-saved with notifications on, which Google delivers as an
 * updated invitation (removing and re-adding the attendee would email them a
 * cancellation first). On email, a fresh .ics goes out.
 */
export async function resendInvite(userId: number, tourId: number): Promise<DeliveryResult> {
  const tour = storage.getTour(tourId);
  if (!tour) throw new Error("Showing not found");
  const client0 = showingClient(tour);
  if (
    tour.inviteChannel === "google" &&
    tour.googleEventId &&
    googleCalendarReady(userId) &&
    !isOwnAddress(client0?.email, userId)
  ) {
    const listing = resolveShowingListing(tour.listingId);
    const client = showingClient(tour);
    const path = `/events/${encodeURIComponent(tour.googleEventId)}?sendUpdates=all`;
    const r = await calendarRequest(userId, "PATCH", path, googleEvent(tour, listing, client, true));
    if (!r.ok) {
      storage.updateTour(tourId, { inviteError: (r.error ?? "Google refused").slice(0, 300) });
      return { calendar: "failed", client: "failed", channel: "google", error: r.error };
    }
    storage.updateTour(tourId, { invitedAt: new Date().toISOString(), inviteError: null });
    return { calendar: "synced", client: "invited", channel: "google" };
  }
  // Email channel, or a Google invite that can't be reached any more: start
  // the client over on whatever works now.
  storage.updateTour(tourId, { inviteChannel: null, inviteError: null });
  return syncShowing(userId, tourId);
}

/**
 * The admin user whose Google Calendar showings belong on, for requests that
 * don't come from an admin session (the client portal).
 */
export function agentUserId(): number | null {
  const u = storage.getUserByEmail(AGENT.email) ?? storage.getUserById(1);
  return u?.id ?? null;
}

/** Fire-and-forget sync for the portal's routes; never fails the request. */
export function syncShowingInBackground(tourId: number): void {
  const userId = agentUserId();
  if (userId == null) return;
  syncShowing(userId, tourId).catch((e) => console.error(`[showings] background sync #${tourId} failed:`, e?.message ?? e));
}

// ---- What the calendar dashboard shows ---------------------------------------------

export interface ShowingView extends Tour {
  endsAt: string;
  listing: ShowingListing;
  client: ShowingClient | null;
}

export function toShowingView(tour: Tour): ShowingView {
  return { ...tour, endsAt: endOf(tour), listing: resolveShowingListing(tour.listingId), client: showingClient(tour) };
}
