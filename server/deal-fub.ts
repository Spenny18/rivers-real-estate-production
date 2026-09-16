// The deal's link to Follow Up Boss.
//
// The CRM mirror is read-only by design (see README), so this is the one
// place the app writes to FUB on its own: when a document completes or is
// declined, a note lands on the linked person so the CRM timeline shows it
// without anyone retyping. Best-effort — a failed note is logged, never
// surfaced to a signer.

import { fubConfigured, fubPost } from "./fub-client";
import type { Deal } from "@shared/schema";

export const FUB_PERSON_URL = (fubId: string) => `https://app.followupboss.com/2/people/view/${encodeURIComponent(fubId)}`;

export async function noteOnFub(deal: Pick<Deal, "crmContactFubId">, subject: string, body: string): Promise<{ ok: boolean; error?: string }> {
  if (!deal.crmContactFubId) return { ok: false, error: "deal has no FUB contact" };
  if (!fubConfigured()) return { ok: false, error: "FUB_API_KEY not set" };
  const personId = Number(deal.crmContactFubId);
  if (!Number.isFinite(personId)) return { ok: false, error: "bad contact id" };
  const r = await fubPost("/notes", { personId, subject: subject.slice(0, 200), body: body.slice(0, 5000), isHtml: false });
  if (!r.ok) {
    console.error("[deal-fub] note failed:", r.status, r.error);
    return { ok: false, error: r.error };
  }
  return { ok: true };
}
