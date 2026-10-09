/**
 * Home evaluation widget — server proxy + lead capture.
 *
 * Replaces the Gnowise WordPress plugin. The React form posts an address
 * + contact details here; we POST to Gnowise's AVM API, save a lead row
 * (source = "home_eval") so Spencer sees the inbound in /admin/leads
 * (and downstream in FUB via the pixel + lead-alert cron), email him the
 * estimate, and return the price band to the client.
 *
 * Env vars:
 *   GNOWISE_API_KEY — required; set via `fly secrets set GNOWISE_API_KEY=...`
 *   GNOWISE_ENDPOINT — optional; defaults to the AVM endpoint per Gnowise
 *                     API docs. Override if Gnowise reissues the URL.
 */
import type { Express, Request, Response } from "express";
import { db, storage } from "./storage";
import { leads } from "@shared/schema";
import { sendEmail } from "./email";

// The doc Spencer was given (swcalgaryhomes-API-doc.pdf) defines TWO
// endpoints to use in sequence. Per Amir: "you just need the api endpoint
// and key" — so we now hit the documented endpoints directly with the
// minimal payload the doc spells out, instead of the WP plugin's router.
//
// Endpoint A: "Address to Value" — primary AVM
// Endpoint B: "Property Information to Value and Prediction" — fallback
//             called only when A doesn't return data
const GNOWISE_FORECAST_ENDPOINT =
  "https://2dbgwzjfcj.execute-api.ca-central-1.amazonaws.com/forecastclient";
const GNOWISE_OFFMARKET_ENDPOINT =
  "https://bnvj1sypu4.execute-api.ca-central-1.amazonaws.com/offmarketclient";

// Legacy router (was the previous default — kept for env-var override).
const DEFAULT_GNOWISE_ENDPOINT = GNOWISE_FORECAST_ENDPOINT;

// The router can return EITHER shape — the "forecast" shape (Estimate /
// ValueLow / ValueHigh) or the "offmarket" shape (gnowise_value / value_low
// / value_high). We normalise to one internal shape before responding.
interface GnowiseReportNormalised {
  Estimate: number;
  RiskOfDecline?: number | null;
  ValueHigh: number;
  ValueLow: number;
}
interface GnowiseReportForecast {
  Estimate?: number;
  RiskOfDecline?: number;
  ValueHigh?: number;
  ValueLow?: number;
}
interface GnowiseReportOffmarket {
  gnowise_value?: number;
  risk_of_decline?: number;
  value_high?: number;
  value_low?: number;
}
type GnowiseReportRaw = GnowiseReportForecast & GnowiseReportOffmarket;
interface GnowiseResponse {
  Request?: Record<string, unknown>;
  Parameters?: Record<string, unknown>;
  Report?: GnowiseReportRaw;
  error?: string;
}

function normaliseReport(raw: GnowiseReportRaw | undefined): GnowiseReportNormalised | null {
  if (!raw) return null;
  const estimate = raw.Estimate ?? raw.gnowise_value;
  const valueHigh = raw.ValueHigh ?? raw.value_high;
  const valueLow = raw.ValueLow ?? raw.value_low;
  const risk = raw.RiskOfDecline ?? raw.risk_of_decline ?? null;
  if (!Number.isFinite(estimate) || !Number.isFinite(valueHigh) || !Number.isFinite(valueLow)) {
    return null;
  }
  return {
    Estimate: estimate as number,
    ValueHigh: valueHigh as number,
    ValueLow: valueLow as number,
    RiskOfDecline: risk,
  };
}

// Province inferred from Canadian postal code first letter. Gnowise's
// router accepts this as a payload field and the WP plugin always sends it
// when it can be derived.
function provinceFromPostal(postal: string): string | null {
  const p = postal.trim().toUpperCase();
  if (!p) return null;
  const c = p[0];
  if (c === "T") return "AB";
  if (c === "V") return "BC";
  if (c === "R") return "MB";
  if (c === "E") return "NB";
  if (c === "A") return "NL";
  if (c === "B") return "NS";
  if (c === "K" || c === "L" || c === "M" || c === "N" || c === "P") return "ON";
  if (c === "C") return "PE";
  if (c === "G" || c === "H" || c === "J") return "QC";
  if (c === "S") return "SK";
  if (c === "Y") return "YT";
  if (c === "X") return "NT";
  return null;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000).toLocaleString()}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function registerHomeValueRoutes(app: Express) {
  app.post("/api/home-value", async (req: Request, res: Response) => {
    const apiKey = process.env.GNOWISE_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: "service_not_configured",
        message: "Home valuation service is being set up. Please try again shortly.",
      });
    }

    const body = req.body || {};
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const address = String(body.address || "").trim();
    const aptUnit = String(body.aptUnit || "").trim();
    const isCondo = body.isCondo === true || body.isCondo === "true";
    const condition = Number(body.condition) || 3;
    const lat = typeof body.lat === "number" ? body.lat : null;
    const lng = typeof body.lng === "number" ? body.lng : null;
    const postalCode = String(body.postalCode || "").trim();
    const city = String(body.city || "Calgary").trim();

    if (!firstName) return res.status(400).json({ error: "missing_firstName" });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "invalid_email" });
    if (!address) return res.status(400).json({ error: "missing_address" });

    // Normalize the address into Gnowise's expected format. Their API docs
    // show inputs like "299 Chaplin Crescent M5P 1B1 Toronto" — single line,
    // postal code inline, no province/country, no commas. Google's formatted
    // address comes through as e.g. "38 Elmont Cove Southwest, Calgary, AB,
    // Canada" — we need to strip ", AB", ", Canada", drop the trailing
    // city, abbreviate cardinal suffixes, and re-append the postal code.
    function normaliseForGnowise(raw: string): string {
      let s = raw
        .replace(/,\s*Canada\b/gi, "")
        .replace(/,\s*AB\b/gi, "")
        .replace(/,\s*Alberta\b/gi, "")
        .replace(/,\s*Calgary\b/gi, "")
        .replace(/\bSouthwest\b/gi, "SW")
        .replace(/\bSoutheast\b/gi, "SE")
        .replace(/\bNorthwest\b/gi, "NW")
        .replace(/\bNortheast\b/gi, "NE")
        .replace(/\s*,\s*/g, " ") // collapse remaining commas to spaces
        .replace(/\s{2,}/g, " ")
        .trim();
      // Re-append the postal code + city if we have them and they're not
      // already in the string. Gnowise expects: "<street> <postal> <city>".
      if (postalCode && !s.toUpperCase().includes(postalCode.toUpperCase())) {
        s = `${s} ${postalCode}`;
      }
      if (city && !new RegExp(`\\b${city}\\b`, "i").test(s)) {
        s = `${s} ${city}`;
      }
      return s.trim();
    }
    const gnowiseAddress = normaliseForGnowise(address);
    console.log(`[home-value] gnowise input: "${gnowiseAddress}"`);

    // ENDPOINT A — Address to Value (per Gnowise API doc page 2).
    // The doc-minimal body is JUST these four fields: Address (with postal
    // + city inline, no commas), AptNum, IsCondo, Condition. No PostalCode,
    // no PropertyType, no Forecast/Comparables — those are WP-plugin extras
    // that the documented endpoint doesn't ask for.
    const docPayloadA = {
      Address: gnowiseAddress,
      AptNum: aptUnit,
      IsCondo: isCondo,
      Condition: condition,
    };

    // WP proxy path (kept as a tested-and-working escape hatch — only used
    // if both GNOWISE_PROXY_URL and GNOWISE_PROXY_SECRET are set on Fly).
    const proxyUrl = process.env.GNOWISE_PROXY_URL || "";
    const proxySecret = process.env.GNOWISE_PROXY_SECRET || "";
    const useProxy = proxyUrl !== "" && proxySecret !== "";

    // Keys per the API doc page 2 + page 5 (different key per endpoint).
    // Forecast key falls back to GNOWISE_API_KEY for backward compat; the
    // offmarket key is its own env var so it can be rotated independently.
    const forecastKey = apiKey;
    const offmarketKey =
      process.env.GNOWISE_API_KEY_OFFMARKET ||
      "PhLKsjdufba6TVXlqnji53hEHgzerAPb8vXsLPr0";

    // Allow env overrides for the endpoints in case Gnowise reissues URLs.
    const forecastUrl = process.env.GNOWISE_ENDPOINT || GNOWISE_FORECAST_ENDPOINT;
    const offmarketUrl =
      process.env.GNOWISE_ENDPOINT_OFFMARKET || GNOWISE_OFFMARKET_ENDPOINT;

    let report: GnowiseReportNormalised | null = null;
    let gnowiseRaw: GnowiseResponse | null = null;

    // ---- ATTEMPT 1: ENDPOINT A (forecastclient) ----
    if (useProxy) {
      // Proxy path — route through luxuryhomescalgary.ca's WP plugin.
      console.log(`[home-value] calling WP proxy: ${proxyUrl}`);
      try {
        const r = await fetch(proxyUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-LHC-Proxy-Secret": proxySecret,
          },
          body: JSON.stringify(docPayloadA),
        });
        if (r.ok) {
          gnowiseRaw = (await r.json()) as GnowiseResponse;
          report = normaliseReport(gnowiseRaw.Report);
        } else {
          const text = await r.text();
          console.error(`[home-value] proxy ${r.status}:`, text.slice(0, 300));
        }
      } catch (e: any) {
        console.error("[home-value] proxy fetch failed:", e?.message);
      }
    } else {
      // Direct path — hit the documented AWS forecastclient endpoint.
      console.log(`[home-value] A: forecastclient — ${JSON.stringify(docPayloadA)}`);
      try {
        const r = await fetch(forecastUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-api-key": forecastKey,
          },
          body: JSON.stringify(docPayloadA),
        });
        if (r.ok) {
          gnowiseRaw = (await r.json()) as GnowiseResponse;
          report = normaliseReport(gnowiseRaw.Report);
          if (!report) {
            console.warn(
              "[home-value] forecastclient 200 but no Report — will try offmarketclient",
            );
          }
        } else {
          const text = await r.text();
          console.error(
            `[home-value] forecastclient ${r.status}:`,
            text.slice(0, 300),
          );
        }
      } catch (e: any) {
        console.error("[home-value] forecastclient fetch failed:", e?.message);
      }
    }

    // ---- ATTEMPT 2: ENDPOINT B (offmarketclient) — doc-prescribed fallback ----
    // Per the doc: "if the first API doesn't provide response as the result
    // of insufficient property information in Gnowise coverage". We hit this
    // whenever Attempt 1 failed for any reason — bad address, network, 403,
    // or 200 with no Report. The schema-array body is positional (16 fields,
    // most empty/default for a no-attribute walk-in lead).
    if (!report && !useProxy) {
      // Schema order per doc page 5:
      // [Address, PostalCode, AptNum, City, NumBedrooms, NumDens,
      //  NumBathrooms, NumParkingSpaces, Pool, BasementType, NumKitchens,
      //  PropertyType, BuildingStyle, RoomsArea, LotArea, Condition]
      const postalCompact = postalCode
        ? postalCode.replace(/\s+/g, "").toUpperCase()
        : "";
      const schemaArr: Array<string | number | null> = [
        address || "",                        // Address (full, comma-separated OK here)
        postalCompact,                        // PostalCode
        aptUnit || "",                        // AptNum
        city || "Calgary",                    // City
        "",                                   // NumBedrooms (unknown)
        "",                                   // NumDens
        "",                                   // NumBathrooms
        "",                                   // NumParkingSpaces
        isCondo ? null : "None",              // Pool
        isCondo ? "" : "Finished",            // BasementType (best-guess default)
        "",                                   // NumKitchens
        isCondo ? "Condo Apt" : "Detached",   // PropertyType
        isCondo ? "Apartment" : "2-Storey",   // BuildingStyle
        "",                                   // RoomsArea (sq.ft)
        "",                                   // LotArea (sq.ft)
        String(condition),                    // Condition
      ];
      const docPayloadB = { schema: schemaArr };
      console.log(
        `[home-value] B: offmarketclient — ${JSON.stringify(docPayloadB)}`,
      );
      try {
        const r = await fetch(offmarketUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-api-key": offmarketKey,
          },
          body: JSON.stringify(docPayloadB),
        });
        if (r.ok) {
          gnowiseRaw = (await r.json()) as GnowiseResponse;
          report = normaliseReport(gnowiseRaw.Report);
          if (!report) {
            console.warn(
              "[home-value] offmarketclient 200 but no Report — falling back to manual",
            );
          }
        } else {
          const text = await r.text();
          console.error(
            `[home-value] offmarketclient ${r.status}:`,
            text.slice(0, 300),
          );
        }
      } catch (e: any) {
        console.error("[home-value] offmarketclient fetch failed:", e?.message);
      }
    }

    // Save a lead so this shows up in /admin/leads and flows to FUB. We
    // store the address + estimate band inside the message body so Spencer
    // sees context the moment he opens the lead.
    const name = [firstName, lastName].filter(Boolean).join(" ") || firstName;
    const estimateLine = report
      ? `Estimate: ${fmt(report.Estimate)} (${fmt(report.ValueLow)}–${fmt(report.ValueHigh)})`
      : "Estimate: not available";
    const message = [
      `Home evaluation request via riversrealestate.ca`,
      ``,
      `Address: ${address}${aptUnit ? ` Unit ${aptUnit}` : ""}`,
      `Property type: ${isCondo ? "Condo / Apartment" : "House"}`,
      estimateLine,
    ].join("\n");
    try {
      const row = db
        .insert(leads)
        .values({
          name,
          email,
          phone: phone || null,
          source: "home_eval",
          status: "new",
          message,
        } as any)
        .returning()
        .get();
      storage.onLeadCreated?.(row);
    } catch (e) {
      console.error("[home-value] save lead failed:", e);
    }

    // Email the LEAD. Two variants: one with the auto-estimate (when
    // Gnowise gave us a report), one without (when Gnowise was down or
    // didn't have data for the address — Spencer will hand-prepare the
    // estimate and follow up within 24h).
    try {
      const firstNameForGreeting = firstName.split(/\s+/)[0] || "there";
      const fullAddress = `${address}${aptUnit ? " Unit " + aptUnit : ""}`;
      const brandHeader =
        `<div style="font-family:'Manrope',sans-serif;font-size:11px;letter-spacing:0.22em;color:#6b7280;margin-bottom:14px;">RIVERS REAL ESTATE · HOME VALUATION</div>`;
      const signature =
        `<p style="margin:24px 0 6px;">— Spencer Rivers</p>` +
        `<p style="margin:0 0 24px;font-size:13px;color:#6b7280;">REALTOR® · Rivers Real Estate · (403) 966-9237 · spencer@riversrealestate.ca</p>` +
        `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0;" />` +
        `<p style="margin:0;font-size:11px;color:#6b7280;">You're receiving this because you requested a home valuation at <a href="https://riversrealestate.ca" style="color:#6b7280;">riversrealestate.ca</a>. Reply to unsubscribe from any further follow-up.</p>`;

      let leadHtml: string;
      let leadText: string;

      if (report) {
        // Auto-estimate variant — full AVM result.
        leadHtml =
          `<div style="font-family:'Manrope',Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0a0a0a;line-height:1.55;">` +
          brandHeader +
          `<p style="font-family:'Playfair Display',Georgia,serif;font-size:28px;line-height:1.15;margin:0 0 16px;">Hi ${firstNameForGreeting},</p>` +
          `<p style="margin:0 0 16px;">Here's the automated estimate for your home at <strong>${fullAddress}</strong>:</p>` +
          `<div style="padding:24px 20px;background:#fafafa;border-left:3px solid #D4AF37;margin:18px 0;">` +
          `<div style="font-family:'Manrope',sans-serif;font-size:10px;letter-spacing:0.22em;color:#6b7280;">ESTIMATED MARKET VALUE</div>` +
          `<div style="font-family:'Playfair Display',Georgia,serif;font-size:42px;line-height:1;margin-top:6px;">${fmt(report.Estimate)}</div>` +
          `<div style="font-size:13px;color:#6b7280;margin-top:8px;">Range ${fmt(report.ValueLow)} – ${fmt(report.ValueHigh)}</div>` +
          `</div>` +
          `<p style="margin:18px 0;">This is a great starting point — the number is generated by an automated model that compares recent sales of similar homes nearby. What it can't see: finishes, view, layout, the specific block you're on, and timing. Those are usually the difference between the auto-estimate and a real listing price.</p>` +
          `<p style="margin:18px 0;">I'll follow up within one business day to refine the number based on what's specific to your home — no pressure, no obligation. If you'd rather book a 15-minute call now, just hit reply or call/text me directly at (403) 966-9237.</p>` +
          signature +
          `</div>`;
        leadText = [
          `Hi ${firstNameForGreeting},`,
          ``,
          `Here's the automated estimate for ${fullAddress}:`,
          ``,
          `Estimate: ${fmt(report.Estimate)}`,
          `Range: ${fmt(report.ValueLow)} – ${fmt(report.ValueHigh)}`,
          ``,
          `This is a starting point — the model compares recent sales of similar homes. I'll follow up within one business day to refine it based on what's specific to your home. No pressure, no obligation.`,
          ``,
          `Reply or call/text (403) 966-9237 anytime.`,
          ``,
          `— Spencer Rivers`,
          `REALTOR® · Rivers Real Estate`,
          `(403) 966-9237 · spencer@riversrealestate.ca`,
        ].join("\n");
      } else {
        // Fallback variant — Spencer-prepared estimate coming within 24h.
        // No mention of "the model is down"; this reads like a high-touch
        // bespoke service which is actually a better story for a luxury
        // agent than an instant auto-number anyway.
        leadHtml =
          `<div style="font-family:'Manrope',Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0a0a0a;line-height:1.55;">` +
          brandHeader +
          `<p style="font-family:'Playfair Display',Georgia,serif;font-size:28px;line-height:1.15;margin:0 0 16px;">Hi ${firstNameForGreeting},</p>` +
          `<p style="margin:0 0 16px;">Thanks for requesting a valuation on your home at <strong>${fullAddress}</strong>.</p>` +
          `<div style="padding:20px;background:#fafafa;border-left:3px solid #D4AF37;margin:18px 0;">` +
          `<p style="margin:0;font-family:'Playfair Display',Georgia,serif;font-size:20px;line-height:1.3;">Your custom valuation will arrive within 24 hours.</p>` +
          `</div>` +
          `<p style="margin:18px 0;">Rather than a generic auto-estimate, I hand-prepare each valuation based on what's specific to your home — finishes, view, layout, the exact block you're on, and what's actually sold nearby in the last 90 days. That usually gives a much tighter and more useful number than what an automated model can produce.</p>` +
          `<p style="margin:18px 0;">If you'd rather chat sooner, just hit reply or call/text me directly at (403) 966-9237 — happy to do a quick 15-minute call, no pressure or obligation.</p>` +
          signature +
          `</div>`;
        leadText = [
          `Hi ${firstNameForGreeting},`,
          ``,
          `Thanks for requesting a valuation on your home at ${fullAddress}.`,
          ``,
          `Your custom valuation will arrive within 24 hours.`,
          ``,
          `Rather than a generic auto-estimate, I hand-prepare each valuation based on what's specific to your home — finishes, view, layout, the exact block you're on, and what's actually sold nearby in the last 90 days. That usually gives a much tighter and more useful number than what an automated model can produce.`,
          ``,
          `If you'd rather chat sooner, reply or call/text (403) 966-9237.`,
          ``,
          `— Spencer Rivers`,
          `REALTOR® · Rivers Real Estate`,
          `(403) 966-9237 · spencer@riversrealestate.ca`,
        ].join("\n");
      }

      await sendEmail({
        to: email,
        subject: report
          ? `Your home valuation: ${address}`
          : `Thanks ${firstNameForGreeting} — your custom valuation is on the way`,
        html: leadHtml,
        text: leadText,
        replyTo: process.env.SPENCER_NOTIFY_EMAIL || "spencer@riversrealestate.ca",
        track: { kind: "valuation" },
      });
    } catch (e) {
      console.error("[home-value] lead email failed:", e);
    }

    // Notify Spencer. Best-effort — don't fail the request if mail bounces.
    try {
      const notifyTo = process.env.SPENCER_NOTIFY_EMAIL || "spencer@riversrealestate.ca";
      const html =
        `<div style="font-family:'Manrope',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0a0a0a;line-height:1.55;">` +
        `<p style="font-family:'Playfair Display',Georgia,serif;font-size:22px;margin:0 0 12px;">Home valuation request</p>` +
        `<p style="margin:0 0 8px;"><strong>From:</strong> ${name} &lt;${email}&gt;${phone ? " · " + phone : ""}</p>` +
        `<p style="margin:0 0 8px;"><strong>Address:</strong> ${address}${aptUnit ? " Unit " + aptUnit : ""}</p>` +
        `<p style="margin:0 0 8px;"><strong>Property type:</strong> ${isCondo ? "Condo / Apartment" : "House"}</p>` +
        (report
          ? `<p style="margin:18px 0;padding:14px 16px;background:#fafafa;border-left:3px solid #D4AF37;"><strong>Auto-estimate:</strong> ${fmt(report.Estimate)}<br/><span style="color:#6b7280;">Range ${fmt(report.ValueLow)} – ${fmt(report.ValueHigh)}</span></p>`
          : `<p style="margin:18px 0;color:#6b7280;">Gnowise returned no estimate. Manual follow-up needed.</p>`) +
        `<p style="margin:18px 0;"><a href="https://riversrealestate.ca/admin/leads" style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#fff;text-decoration:none;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;">REVIEW LEAD</a></p>` +
        `</div>`;
      await sendEmail({
        to: notifyTo,
        subject: `Home valuation: ${address}`,
        html,
        text: `${name} (${email}${phone ? ", " + phone : ""}) requested a valuation for ${address}${aptUnit ? " Unit " + aptUnit : ""}.\n\n${estimateLine}\n\nReview at https://riversrealestate.ca/admin/leads`,
        replyTo: email,
      });
    } catch (e) {
      console.error("[home-value] notify failed:", e);
    }

    res.json({
      ok: true,
      report: report
        ? {
            estimate: report.Estimate,
            estimateFormatted: fmt(report.Estimate),
            valueLow: report.ValueLow,
            valueLowFormatted: fmt(report.ValueLow),
            valueHigh: report.ValueHigh,
            valueHighFormatted: fmt(report.ValueHigh),
            riskOfDecline: report.RiskOfDecline ?? null,
          }
        : null,
    });
  });
}
