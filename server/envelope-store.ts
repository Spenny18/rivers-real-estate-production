// Data access for envelopes: several of a deal's documents sent for signature
// together (see dealEnvelopes in shared/schema.ts). Nothing here knows about
// HTTP or email; the routes and the signing flow live in deal-routes.ts.
//
// The model, in one paragraph: an envelope doesn't replace any part of a
// document. Every document keeps its own signer rows, fields, signing order,
// signed PDF and certificate. The envelope adds one row per *person*
// (deal_envelope_recipients), matched to that person's signer row on each
// document by email, with one token that opens all of their documents at once.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "./storage";
import {
  dealDocuments,
  dealEnvelopeRecipients,
  dealEnvelopes,
  type DealEnvelope,
  type DealEnvelopeRecipient,
  type DealSigner,
} from "@shared/schema";
import { loadBundle, newSignerToken, nowIso, signersWhoCanSignNow, type Bundle } from "./deal-store";

export function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function getEnvelope(id: number): DealEnvelope | undefined {
  return db.select().from(dealEnvelopes).where(eq(dealEnvelopes.id, id)).get();
}

export function listEnvelopesForDeal(dealId: number): DealEnvelope[] {
  return db.select().from(dealEnvelopes).where(eq(dealEnvelopes.dealId, dealId)).orderBy(asc(dealEnvelopes.id)).all();
}

export function touchEnvelope(id: number, patch: Partial<DealEnvelope>): DealEnvelope {
  return db.update(dealEnvelopes).set({ ...patch, updatedAt: nowIso() }).where(eq(dealEnvelopes.id, id)).returning().get();
}

export function recipientsOf(envelopeId: number): DealEnvelopeRecipient[] {
  return db.select().from(dealEnvelopeRecipients).where(eq(dealEnvelopeRecipients.envelopeId, envelopeId)).orderBy(asc(dealEnvelopeRecipients.id)).all();
}

export function recipientByToken(token: string): DealEnvelopeRecipient | undefined {
  if (!token || token.length < 20 || token.length > 128) return undefined;
  return db.select().from(dealEnvelopeRecipients).where(eq(dealEnvelopeRecipients.token, token)).get();
}

export function updateRecipient(id: number, patch: Partial<DealEnvelopeRecipient>) {
  db.update(dealEnvelopeRecipients).set(patch).where(eq(dealEnvelopeRecipients.id, id)).run();
}

/** The envelope's documents, fully loaded, in the order they were added. */
export function envelopeBundles(envelopeId: number): Bundle[] {
  const docs = db.select({ id: dealDocuments.id }).from(dealDocuments).where(eq(dealDocuments.envelopeId, envelopeId)).orderBy(asc(dealDocuments.id)).all();
  return docs.map((d) => loadBundle(d.id)).filter((b): b is Bundle => !!b);
}

/** This person's signer row on a document, if they sign it. */
export function signerFor(b: Bundle, email: string): DealSigner | undefined {
  const e = normEmail(email);
  return b.signers.find((s) => normEmail(s.email) === e);
}

/** Every distinct person who signs any of these documents, by email. */
export function peopleIn(bundles: Bundle[]): Array<{ name: string; email: string }> {
  const seen = new Map<string, { name: string; email: string }>();
  for (const b of bundles) for (const s of b.signers) if (!seen.has(normEmail(s.email))) seen.set(normEmail(s.email), { name: s.name, email: s.email });
  return Array.from(seen.values());
}

export function createEnvelope(input: {
  dealId: number;
  title: string;
  message: string | null;
  documentIds: number[];
  people: Array<{ name: string; email: string }>;
}): DealEnvelope {
  const at = nowIso();
  const tx = db.transaction((t) => {
    const env = t
      .insert(dealEnvelopes)
      .values({ dealId: input.dealId, title: input.title, message: input.message, status: "sent", sentAt: at, createdAt: at, updatedAt: at })
      .returning()
      .get();
    t.update(dealDocuments).set({ envelopeId: env.id, updatedAt: at }).where(inArray(dealDocuments.id, input.documentIds)).run();
    for (const p of input.people) {
      t.insert(dealEnvelopeRecipients)
        .values({ envelopeId: env.id, name: p.name, email: p.email, token: newSignerToken(), status: "pending", createdAt: at })
        .run();
    }
    return env;
  });
  return tx;
}

export interface RecipientProgress {
  total: number;
  signed: number;
  /** Documents this person can sign right now (their turn, open). */
  canSignNow: number[];
  /** Documents where someone else has to sign first. */
  waiting: number[];
  declined: boolean;
}

export function progressFor(recipient: Pick<DealEnvelopeRecipient, "email">, bundles: Bundle[]): RecipientProgress {
  const out: RecipientProgress = { total: 0, signed: 0, canSignNow: [], waiting: [], declined: false };
  for (const b of bundles) {
    const s = signerFor(b, recipient.email);
    if (!s) continue;
    out.total += 1;
    if (s.status === "signed") out.signed += 1;
    else if (s.status === "declined") out.declined = true;
    else if (b.document.status === "sent") {
      if (signersWhoCanSignNow(b).some((x) => x.id === s.id)) out.canSignNow.push(b.document.id);
      else out.waiting.push(b.document.id);
    }
  }
  return out;
}

/**
 * The envelope's status follows its documents: completed when every one is,
 * declined as soon as any is. Voided is set directly and never changed back.
 */
export function refreshEnvelopeStatus(envelopeId: number): DealEnvelope {
  const env = getEnvelope(envelopeId)!;
  if (env.status === "voided") return env;
  const docs = envelopeBundles(envelopeId).map((b) => b.document);
  if (docs.some((d) => d.status === "declined") && env.status !== "declined") return touchEnvelope(envelopeId, { status: "declined" });
  if (docs.length && docs.every((d) => d.status === "completed") && env.status !== "completed") {
    return touchEnvelope(envelopeId, { status: "completed", completedAt: nowIso() });
  }
  return env;
}

/** Draft documents of a deal that aren't already in an envelope. */
export function draftDocumentIds(dealId: number): number[] {
  return db
    .select({ id: dealDocuments.id })
    .from(dealDocuments)
    .where(and(eq(dealDocuments.dealId, dealId), eq(dealDocuments.status, "draft")))
    .all()
    .map((r) => r.id);
}
