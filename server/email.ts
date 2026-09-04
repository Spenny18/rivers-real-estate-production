// Minimal Resend REST wrapper — calls the public API directly so we don't
// add a runtime dependency. Returns true on success, false on send failure.
//
// Required env vars:
//   RESEND_API_KEY        — from resend.com -> API Keys
//   RESEND_FROM_EMAIL     — verified sender (e.g. spencer@riversrealestate.ca
//                           if domain is verified, else onboarding@resend.dev)
//   SPENCER_NOTIFY_EMAIL  — optional CC for every outbound (default = from address)

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not set" };
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    return { ok: false, error: "RESEND_FROM_EMAIL not set" };
  }
  const cc = input.cc ?? process.env.SPENCER_NOTIFY_EMAIL;
  const body: any = {
    from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
  };
  if (input.text) body.text = input.text;
  if (cc && cc !== input.to) body.cc = [cc];
  if (input.replyTo) body.reply_to = input.replyTo;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      return { ok: false, error: `Resend ${r.status}: ${errText}` };
    }
    const data: any = await r.json();
    return { ok: true, id: data?.id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "fetch failed" };
  }
}

// HTML helpers ---------------------------------------------------------------

const BRAND = {
  black: "#0a0a0a",
  forest: "#23412d",
  gold: "#D4AF37",
  paper: "#fafafa",
  mute: "#6b7280",
  border: "#e5e7eb",
};

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

interface ListingRow {
  id: string;
  fullAddress: string;
  listPrice: number;
  beds: number;
  baths: number;
  sqft: number | null;
  neighbourhood: string | null;
  heroImage: string | null;
  previousPrice?: number | null;
}

interface SnapshotData {
  newListings: number;
  sold: number;
  terminated: number;
  priceReductions: number;
}

export function buildLeadAlertHtml(opts: {
  leadName: string;
  alertLabel: string;
  origin: string;
  newListings: ListingRow[];
  priceReductions: ListingRow[];
  snapshot: SnapshotData;
  daysBack: number;
}): string {
  const { leadName, alertLabel, origin, newListings, priceReductions, snapshot, daysBack } = opts;
  const listingCard = (l: ListingRow, kind: "new" | "reduced") => {
    const url = `${origin}/mls/${l.id}`;
    const photo = l.heroImage
      ? l.heroImage.startsWith("http")
        ? l.heroImage
        : `${origin}${l.heroImage}`
      : "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=600&h=400&fit=crop";
    return `
      <a href="${url}" style="text-decoration:none;color:${BRAND.black};display:block;border:1px solid ${BRAND.border};border-radius:2px;overflow:hidden;margin-bottom:14px;">
        <img src="${photo}" alt="" width="100%" style="display:block;width:100%;max-width:100%;height:auto;" />
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;">
          <tr>
            <td style="padding:14px 16px;">
              <div style="font-family:'Playfair Display',Georgia,serif;font-size:22px;font-weight:600;color:${BRAND.black};letter-spacing:-0.01em;">
                ${
                  kind === "reduced" && l.previousPrice
                    ? `<span style="text-decoration:line-through;color:${BRAND.mute};font-size:16px;font-weight:400;margin-right:8px;">${fmtPrice(l.previousPrice)}</span>${fmtPrice(l.listPrice)}`
                    : fmtPrice(l.listPrice)
                }
              </div>
              <div style="font-family:'Manrope',Arial,sans-serif;font-size:14px;color:${BRAND.black};margin-top:4px;">${l.fullAddress}</div>
              <div style="font-family:'Manrope',Arial,sans-serif;font-size:12px;color:${BRAND.mute};margin-top:6px;letter-spacing:0.05em;">
                ${l.beds} BD · ${l.baths} BA${l.sqft ? ` · ${l.sqft.toLocaleString("en-CA")} SQFT` : ""}${l.neighbourhood ? ` · ${l.neighbourhood.toUpperCase()}` : ""}
              </div>
            </td>
          </tr>
        </table>
      </a>
    `;
  };

  const newSection = newListings.length
    ? `
      <h2 style="font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:600;color:${BRAND.black};margin:32px 0 16px;letter-spacing:-0.01em;">
        New listings · ${newListings.length}
      </h2>
      ${newListings.map((l) => listingCard(l, "new")).join("")}
    `
    : "";

  const reducedSection = priceReductions.length
    ? `
      <h2 style="font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:600;color:${BRAND.black};margin:32px 0 16px;letter-spacing:-0.01em;">
        Price reductions · ${priceReductions.length}
      </h2>
      ${priceReductions.map((l) => listingCard(l, "reduced")).join("")}
    `
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.paper};font-family:'Manrope',Arial,sans-serif;color:${BRAND.black};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BRAND.border};">
        <tr>
          <td style="padding:32px 36px 16px;text-align:center;">
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:14px;font-weight:600;letter-spacing:0.18em;color:${BRAND.gold};text-transform:uppercase;">
              RIVERS REAL ESTATE
            </div>
            <div style="font-family:'Manrope',Arial,sans-serif;font-size:11px;letter-spacing:0.18em;color:${BRAND.mute};margin-top:4px;">
              LUXURY HOMES CALGARY
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 36px 8px;">
            <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:30px;font-weight:600;color:${BRAND.black};margin:8px 0;letter-spacing:-0.01em;">
              Your ${alertLabel} update.
            </h1>
            <p style="font-family:'Manrope',Arial,sans-serif;font-size:15px;color:${BRAND.mute};line-height:1.5;margin:8px 0 0;">
              Hi ${leadName.split(" ")[0]} — here's what's moved in your saved search over the last ${daysBack} days.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 36px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.border};">
              <tr>
                ${stat("New", snapshot.newListings)}
                ${stat("Sold", snapshot.sold)}
                ${stat("Terminated", snapshot.terminated)}
                ${stat("Reduced", snapshot.priceReductions)}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 36px 24px;">
            ${newSection}
            ${reducedSection}
            ${
              !newSection && !reducedSection
                ? `<p style="font-family:'Manrope',Arial,sans-serif;font-size:14px;color:${BRAND.mute};margin:32px 0;text-align:center;font-style:italic;">No new matches in the last ${daysBack} days. I'll keep watching.</p>`
                : ""
            }
          </td>
        </tr>
        <tr>
          <td style="padding:24px 36px 32px;border-top:1px solid ${BRAND.border};text-align:center;">
            <p style="font-family:'Manrope',Arial,sans-serif;font-size:14px;color:${BRAND.black};line-height:1.5;margin:0 0 6px;">
              Contact Spencer 🤵
            </p>
            <p style="font-family:'Playfair Display',Georgia,serif;font-size:18px;font-weight:600;color:${BRAND.black};margin:0;letter-spacing:-0.005em;">
              Spencer Rivers
            </p>
            <p style="font-family:'Manrope',Arial,sans-serif;font-size:11px;color:${BRAND.mute};letter-spacing:0.12em;margin:4px 0 0;">
              REALTOR® · RIVERS REAL ESTATE · (403) 966-9237
            </p>
          </td>
        </tr>
      </table>
      <p style="font-family:'Manrope',Arial,sans-serif;font-size:11px;color:${BRAND.mute};margin:16px 0 0;max-width:600px;text-align:center;">
        You're receiving this because Spencer set up an MLS alert for you. Reply to unsubscribe.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function stat(label: string, value: number): string {
  return `
    <td width="25%" style="padding:14px 8px;text-align:center;border-right:1px solid ${BRAND.border};">
      <div style="font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:600;color:${BRAND.black};letter-spacing:-0.01em;">${value}</div>
      <div style="font-family:'Manrope',Arial,sans-serif;font-size:10px;letter-spacing:0.16em;color:${BRAND.mute};text-transform:uppercase;margin-top:2px;">${label}</div>
    </td>
  `;
}

// Stat-focused snapshot email — no listing cards. Used for alertType=snapshot.
export function buildMarketSnapshotHtml(opts: {
  leadName: string;
  alertLabel: string;
  origin: string;
  snapshot: SnapshotData & { averageListPrice: number; averageSoldPrice: number };
  daysBack: number;
}): string {
  const { leadName, alertLabel, origin, snapshot, daysBack } = opts;
  const fmtPriceLong = (n: number) =>
    n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `$${Math.round(n / 1_000)}K`
        : `$${n}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.paper};font-family:'Manrope',Arial,sans-serif;color:${BRAND.black};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BRAND.border};">
        <tr>
          <td style="padding:32px 36px 16px;text-align:center;">
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:14px;font-weight:600;letter-spacing:0.18em;color:${BRAND.gold};text-transform:uppercase;">
              RIVERS REAL ESTATE
            </div>
            <div style="font-family:'Manrope',Arial,sans-serif;font-size:11px;letter-spacing:0.18em;color:${BRAND.mute};margin-top:4px;">
              ${daysBack}-DAY MARKET SNAPSHOT
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 36px 8px;">
            <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:30px;font-weight:600;color:${BRAND.black};margin:8px 0;letter-spacing:-0.01em;">
              ${alertLabel} · last ${daysBack} days.
            </h1>
            <p style="font-family:'Manrope',Arial,sans-serif;font-size:15px;color:${BRAND.mute};line-height:1.5;margin:8px 0 0;">
              Hi ${leadName.split(" ")[0]} — here's how your slice of the Calgary market has moved.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 36px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.border};">
              <tr>
                ${stat("New", snapshot.newListings)}
                ${stat("Sold", snapshot.sold)}
                ${stat("Terminated", snapshot.terminated)}
                ${stat("Reduced", snapshot.priceReductions)}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 36px 8px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="50%" style="padding-right:8px;">
                  <div style="font-family:'Manrope',Arial,sans-serif;font-size:10px;letter-spacing:0.16em;color:${BRAND.mute};text-transform:uppercase;">AVERAGE LIST</div>
                  <div style="font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:600;color:${BRAND.black};margin-top:4px;letter-spacing:-0.01em;">${snapshot.averageListPrice ? fmtPriceLong(snapshot.averageListPrice) : "—"}</div>
                </td>
                <td width="50%" style="padding-left:8px;">
                  <div style="font-family:'Manrope',Arial,sans-serif;font-size:10px;letter-spacing:0.16em;color:${BRAND.mute};text-transform:uppercase;">AVERAGE SOLD</div>
                  <div style="font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:600;color:${BRAND.black};margin-top:4px;letter-spacing:-0.01em;">${snapshot.averageSoldPrice ? fmtPriceLong(snapshot.averageSoldPrice) : "—"}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 36px 32px;border-top:1px solid ${BRAND.border};text-align:center;">
            <a href="${origin}/contact" style="display:inline-block;padding:11px 22px;background:${BRAND.black};color:#fff;text-decoration:none;font-family:'Manrope',Arial,sans-serif;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;">Get in touch</a>
            <p style="font-family:'Manrope',Arial,sans-serif;font-size:14px;color:${BRAND.black};line-height:1.5;margin:24px 0 6px;">
              Contact Spencer 🤵
            </p>
            <p style="font-family:'Playfair Display',Georgia,serif;font-size:18px;font-weight:600;color:${BRAND.black};margin:0;letter-spacing:-0.005em;">
              Spencer Rivers
            </p>
            <p style="font-family:'Manrope',Arial,sans-serif;font-size:11px;color:${BRAND.mute};letter-spacing:0.12em;margin:4px 0 0;">
              REALTOR® · RIVERS REAL ESTATE · (403) 966-9237
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Instant-valuation report email (Gnowise v2 widget on /home-evaluation).
export function buildValuationEmailHtml(opts: {
  recipientFirstName?: string;
  address: string;
  estimate: number;
  valueLow?: number;
  valueHigh?: number;
  /** 0..1 — higher is better. Replaces the old risk_of_decline. */
  confidence?: number;
  estimatedLease?: number;
  capRate?: number;
  parameters?: Record<string, any>;
  origin: string;
}): string {
  const {
    recipientFirstName,
    address,
    estimate,
    valueLow,
    valueHigh,
    confidence,
    estimatedLease,
    capRate,
    parameters,
    origin,
  } = opts;
  const fmt = (n: number) =>
    "$" + Math.round(n).toLocaleString("en-CA");
  const greeting = recipientFirstName
    ? `Hi ${recipientFirstName} —`
    : `Here's your estimate —`;
  const confidenceLabel =
    typeof confidence === "number"
      ? confidence >= 0.8
        ? "High"
        : confidence >= 0.5
          ? "Moderate"
          : "Lower (local data is thin)"
      : null;

  const paramRow = (label: string, value: any) =>
    value
      ? `<tr><td style="padding:6px 16px 6px 0;color:${BRAND.mute};font-size:13px;width:140px;">${label}</td><td style="padding:6px 0;font-size:14px;color:${BRAND.black};">${value}</td></tr>`
      : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.paper};font-family:'Manrope',Arial,sans-serif;color:${BRAND.black};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BRAND.border};">
        <tr><td style="padding:32px 36px 16px;text-align:center;">
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:14px;font-weight:600;letter-spacing:0.18em;color:${BRAND.gold};text-transform:uppercase;">RIVERS REAL ESTATE</div>
          <div style="font-family:'Manrope',Arial,sans-serif;font-size:11px;letter-spacing:0.18em;color:${BRAND.mute};margin-top:4px;">INSTANT HOME EVALUATION</div>
        </td></tr>
        <tr><td style="padding:0 36px 8px;">
          <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:600;color:${BRAND.black};margin:8px 0 4px;letter-spacing:-0.01em;line-height:1.15;">${greeting}</h1>
          <p style="font-family:'Manrope',Arial,sans-serif;font-size:14px;color:${BRAND.mute};line-height:1.5;margin:8px 0 4px;">Algorithmic estimate for <strong style="color:${BRAND.black};font-weight:500;">${address}</strong>.</p>
        </td></tr>
        <tr><td style="padding:18px 36px 0;">
          <div style="border:1px solid ${BRAND.border};border-left:4px solid ${BRAND.forest};padding:20px 22px;background:#fafafa;">
            <div style="font-family:'Manrope',Arial,sans-serif;font-size:10px;letter-spacing:0.18em;color:${BRAND.mute};text-transform:uppercase;">Estimated value</div>
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:42px;font-weight:600;color:${BRAND.black};letter-spacing:-0.02em;margin-top:4px;">${fmt(estimate)}</div>
            ${
              valueLow != null && valueHigh != null
                ? `<div style="font-family:'Manrope',Arial,sans-serif;font-size:13px;color:${BRAND.mute};margin-top:8px;">Likely range <strong style="color:${BRAND.black};">${fmt(valueLow)}</strong> &ndash; <strong style="color:${BRAND.black};">${fmt(valueHigh)}</strong></div>`
                : ""
            }
            ${confidenceLabel ? `<div style="font-family:'Manrope',Arial,sans-serif;font-size:12px;color:${BRAND.mute};margin-top:6px;">Model confidence: <strong style="color:${BRAND.black};">${confidenceLabel}</strong></div>` : ""}
            ${
              typeof estimatedLease === "number" || typeof capRate === "number"
                ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid ${BRAND.border};font-size:12px;color:${BRAND.mute};">
                    ${typeof estimatedLease === "number" ? `Estimated monthly rent: <strong style="color:${BRAND.black};">${fmt(estimatedLease)}</strong>` : ""}
                    ${typeof estimatedLease === "number" && typeof capRate === "number" ? " · " : ""}
                    ${typeof capRate === "number" ? `Cap rate: <strong style="color:${BRAND.black};">${(capRate * 100).toFixed(2)}%</strong>` : ""}
                  </div>`
                : ""
            }
          </div>
        </td></tr>
        ${
          parameters
            ? `<tr><td style="padding:20px 36px 0;">
                <div style="font-family:'Manrope',Arial,sans-serif;font-size:10px;letter-spacing:0.18em;color:${BRAND.mute};text-transform:uppercase;margin-bottom:8px;">Property details (inferred)</div>
                <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                  ${paramRow("Type", parameters.PropertyType ?? parameters.property_type)}
                  ${paramRow("Style", parameters.Style ?? parameters.BuildingStyle ?? parameters.style)}
                  ${paramRow("Bedrooms", parameters.Bedrooms ?? parameters.bedrooms)}
                  ${paramRow("Washrooms", parameters.Washrooms ?? parameters.Bathrooms ?? parameters.washrooms)}
                  ${paramRow(
                    "Interior",
                    (parameters.RoomsArea ?? parameters.rooms_area)
                      ? `${(parameters.RoomsArea ?? parameters.rooms_area).toLocaleString("en-CA")} sqft`
                      : null,
                  )}
                  ${paramRow(
                    "Lot",
                    (parameters.LotArea ?? parameters.lot_area) && (parameters.LotArea ?? parameters.lot_area) > 0
                      ? `${(parameters.LotArea ?? parameters.lot_area).toLocaleString("en-CA")} sqft`
                      : null,
                  )}
                  ${paramRow("Basement", parameters.Basement ?? parameters.BasementType ?? parameters.basement)}
                  ${paramRow(
                    "Pool",
                    (parameters.Pool ?? parameters.PoolType) && (parameters.Pool ?? parameters.PoolType) !== "None"
                      ? parameters.Pool ?? parameters.PoolType
                      : null,
                  )}
                  ${paramRow("Age", parameters.Age ?? parameters.age)}
                  ${paramRow("AC", parameters.AC ?? parameters.ac)}
                </table>
              </td></tr>`
            : ""
        }
        <tr><td style="padding:24px 36px;background:${BRAND.paper};border-top:1px solid ${BRAND.border};margin-top:24px;">
          <p style="font-family:'Manrope',Arial,sans-serif;font-size:14px;color:${BRAND.black};line-height:1.6;margin:0 0 16px;">
            This number is algorithmic. For a Calgary-specific market analysis with hand-picked comparables and a recommended list price, request the hand-prepared version.
          </p>
          <a href="${origin}/home-evaluation#manual-evaluation" style="display:inline-block;padding:11px 22px;background:${BRAND.black};color:#fff;text-decoration:none;font-family:'Manrope',Arial,sans-serif;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;">Request hand-prepared analysis</a>
        </td></tr>
        <tr><td style="padding:24px 36px 32px;border-top:1px solid ${BRAND.border};text-align:center;">
          <p style="font-family:'Manrope',Arial,sans-serif;font-size:14px;color:${BRAND.black};line-height:1.5;margin:0 0 6px;">Chat soon, cheers!</p>
          <p style="font-family:'Playfair Display',Georgia,serif;font-size:18px;font-weight:600;color:${BRAND.black};margin:0;letter-spacing:-0.005em;">Spencer Rivers</p>
          <p style="font-family:'Manrope',Arial,sans-serif;font-size:11px;color:${BRAND.mute};letter-spacing:0.12em;margin:4px 0 0;">REALTOR® · RIVERS REAL ESTATE · (403) 966-9237</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}


// ---- Booking emails (the /book scheduler) ----------------------------------

export interface BookingEmailData {
  /** "Buyer Consultation" */
  eventName: string;
  /** Already formatted in the recipient's zone, e.g. "Thursday, October 9, 2025 at 2:00 PM MDT" */
  whenLabel: string;
  durationMinutes: number;
  locationLabel: string;
  inviteeName: string;
  inviteeEmail: string;
  inviteePhone?: string | null;
  notes?: string | null;
  question?: string | null;
  answer?: string | null;
  manageUrl: string;
  origin: string;
}

function bookingShell(opts: {
  eyebrow: string;
  heading: string;
  intro: string;
  accent: string;
  body: string;
  origin: string;
}): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.paper};font-family:'Manrope',Arial,sans-serif;color:${BRAND.black};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BRAND.border};">
        <tr><td style="padding:32px 36px 12px;text-align:center;">
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:14px;font-weight:600;letter-spacing:0.18em;color:${BRAND.gold};text-transform:uppercase;">RIVERS REAL ESTATE</div>
          <div style="font-size:11px;letter-spacing:0.18em;color:${BRAND.mute};margin-top:4px;">${opts.eyebrow}</div>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:600;margin:8px 0 4px;letter-spacing:-0.01em;line-height:1.15;">${opts.heading}</h1>
          <p style="font-size:14px;color:${BRAND.mute};line-height:1.6;margin:8px 0 0;">${opts.intro}</p>
        </td></tr>
        ${opts.body}
        <tr><td style="padding:24px 36px 32px;border-top:1px solid ${BRAND.border};margin-top:16px;">
          <div style="font-size:12px;color:${BRAND.mute};line-height:1.6;">
            Spencer Rivers · REALTOR® · Rivers Real Estate<br />
            <a href="tel:+14039669237" style="color:${BRAND.forest};text-decoration:none;">(403) 966-9237</a> ·
            <a href="${opts.origin}" style="color:${BRAND.forest};text-decoration:none;">luxuryhomescalgary.ca</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function detailRows(d: BookingEmailData, accent: string): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:7px 16px 7px 0;color:${BRAND.mute};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;width:110px;vertical-align:top;">${label}</td><td style="padding:7px 0;font-size:14px;color:${BRAND.black};line-height:1.5;">${value}</td></tr>`;
  return `
    <tr><td style="padding:20px 36px 0;">
      <div style="border:1px solid ${BRAND.border};border-left:4px solid ${accent};padding:18px 22px;background:#fafafa;">
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
          ${row("What", escapeAttr(d.eventName))}
          ${row("When", escapeAttr(d.whenLabel))}
          ${row("Length", `${d.durationMinutes} minutes`)}
          ${row("Where", escapeAttr(d.locationLabel))}
          ${d.notes ? row("Notes", escapeAttr(d.notes)) : ""}
          ${d.question && d.answer ? row(escapeAttr(d.question).slice(0, 40), escapeAttr(d.answer)) : ""}
        </table>
      </div>
    </td></tr>`;
}

function escapeAttr(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Confirmation sent to the person who booked. */
export function buildBookingConfirmationHtml(d: BookingEmailData): string {
  const firstName = d.inviteeName.trim().split(/\s+/)[0] || "there";
  return bookingShell({
    eyebrow: "BOOKING CONFIRMED",
    heading: `You're on the calendar, ${escapeAttr(firstName)}.`,
    intro: `Your ${escapeAttr(d.eventName.toLowerCase())} with Spencer Rivers is confirmed. A calendar invitation is attached to this thread — add it so you get a reminder.`,
    accent: BRAND.forest,
    origin: d.origin,
    body: `
      ${detailRows(d, BRAND.forest)}
      <tr><td style="padding:22px 36px 0;">
        <a href="${d.manageUrl}" style="display:inline-block;background:${BRAND.black};color:#fff;text-decoration:none;font-size:12px;letter-spacing:0.16em;padding:14px 26px;text-transform:uppercase;">Reschedule or cancel</a>
      </td></tr>
      <tr><td style="padding:16px 36px 8px;">
        <p style="font-size:13px;color:${BRAND.mute};line-height:1.6;margin:0;">Plans change — no hard feelings. Use the link above and the slot goes straight back into the calendar.</p>
      </td></tr>`,
  });
}

/** The heads-up Spencer gets the moment something is booked. */
export function buildBookingAgentNotificationHtml(d: BookingEmailData): string {
  return bookingShell({
    eyebrow: "NEW BOOKING",
    heading: `${escapeAttr(d.inviteeName)} booked a ${escapeAttr(d.eventName.toLowerCase())}.`,
    intro: `Contact: <a href="mailto:${escapeAttr(d.inviteeEmail)}" style="color:${BRAND.forest};">${escapeAttr(d.inviteeEmail)}</a>${
      d.inviteePhone ? ` · <a href="tel:${escapeAttr(d.inviteePhone)}" style="color:${BRAND.forest};">${escapeAttr(d.inviteePhone)}</a>` : ""
    }`,
    accent: BRAND.gold,
    origin: d.origin,
    body: `
      ${detailRows(d, BRAND.gold)}
      <tr><td style="padding:22px 36px 0;">
        <a href="${d.origin}/admin/scheduling" style="display:inline-block;background:${BRAND.black};color:#fff;text-decoration:none;font-size:12px;letter-spacing:0.16em;padding:14px 26px;text-transform:uppercase;">Open scheduling</a>
      </td></tr>`,
  });
}

/** Sent to both sides when a booking is cancelled. */
export function buildBookingCancellationHtml(
  d: BookingEmailData & { reason?: string | null; bookAgainUrl: string; toAgent?: boolean },
): string {
  return bookingShell({
    eyebrow: "BOOKING CANCELLED",
    heading: d.toAgent
      ? `${escapeAttr(d.inviteeName)} cancelled.`
      : "Your booking is cancelled.",
    intro: d.toAgent
      ? `The slot is free again and has been removed from your calendar.`
      : `Your ${escapeAttr(d.eventName.toLowerCase())} has been cancelled and the time released. Book another whenever you're ready.`,
    accent: BRAND.mute,
    origin: d.origin,
    body: `
      ${detailRows(d, BRAND.mute)}
      ${
        d.reason
          ? `<tr><td style="padding:16px 36px 0;"><p style="font-size:13px;color:${BRAND.mute};line-height:1.6;margin:0;"><strong style="color:${BRAND.black};">Reason:</strong> ${escapeAttr(d.reason)}</p></td></tr>`
          : ""
      }
      ${
        d.toAgent
          ? ""
          : `<tr><td style="padding:22px 36px 0;">
              <a href="${d.bookAgainUrl}" style="display:inline-block;background:${BRAND.black};color:#fff;text-decoration:none;font-size:12px;letter-spacing:0.16em;padding:14px 26px;text-transform:uppercase;">Book a new time</a>
            </td></tr>`
      }`,
  });
}

/** Sent to both sides when a booking moves to a new time. */
export function buildBookingRescheduleHtml(
  d: BookingEmailData & { previousWhenLabel: string; toAgent?: boolean },
): string {
  return bookingShell({
    eyebrow: "BOOKING MOVED",
    heading: d.toAgent
      ? `${escapeAttr(d.inviteeName)} moved their booking.`
      : "Your booking has a new time.",
    intro: `Was <span style="text-decoration:line-through;">${escapeAttr(d.previousWhenLabel)}</span> — now <strong style="color:${BRAND.black};">${escapeAttr(d.whenLabel)}</strong>.`,
    accent: BRAND.forest,
    origin: d.origin,
    body: `
      ${detailRows(d, BRAND.forest)}
      <tr><td style="padding:22px 36px 0;">
        <a href="${d.toAgent ? `${d.origin}/admin/scheduling` : d.manageUrl}" style="display:inline-block;background:${BRAND.black};color:#fff;text-decoration:none;font-size:12px;letter-spacing:0.16em;padding:14px 26px;text-transform:uppercase;">${d.toAgent ? "Open scheduling" : "Manage booking"}</a>
      </td></tr>`,
  });
}
