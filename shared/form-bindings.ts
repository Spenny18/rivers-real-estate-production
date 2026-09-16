// What a fill box on a form template can be bound to.
//
// A form template is a blank AREA form (PDF) with two kinds of boxes drawn
// on it: fill boxes, printed with deal data before the document is created,
// and sign boxes, which become signature/initials/date boxes for the
// signers. Every fill box carries a value key. Keys in this catalogue are
// filled from the deal, the parties, the MLS listing or the agent's own
// details; everything else is typed once on the review screen. The same key
// on several boxes (the address at the top of each page) prints the same
// value in each.
//
// Shared by the template editor, the review screen and the server, so the
// three agree on labels, groups and how a value is printed.

export const FILL_TYPES = ["text", "multiline", "money", "date", "checkbox"] as const;
export type FillType = (typeof FILL_TYPES)[number];

export type BindingGroup = "property" | "buyer" | "seller" | "offer" | "conveyancing" | "amendment" | "agreement" | "listing" | "agent" | "document";

export type BindingSource =
  | "deal" // the deal record or its MLS listing
  | "party" // typed on the review screen; becomes the signer too
  | "agent" // server/brand.ts
  | "listing" // the MLS listing's brokerage
  | "manual" // typed on the review screen, carried forward to the next form
  | "auto"; // filled by the server when the document is created

export interface Binding {
  key: string;
  label: string;
  group: BindingGroup;
  type: FillType;
  source: BindingSource;
  /** Shown under the input on the review screen. */
  hint?: string;
}

export const PARTY_ROLES = ["buyer", "seller"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
export const PARTY_ATTRS = ["name", "email", "phone", "address"] as const;
export type PartyAttr = (typeof PARTY_ATTRS)[number];
/** How many buyers / sellers a template can address. */
export const MAX_PARTIES = 4;

export function partyKey(role: PartyRole, index: number, attr: PartyAttr): string {
  return `${role}.${index}.${attr}`;
}

/** buyer.2.email → { role: "buyer", index: 2, attr: "email" }, else null. */
export function parsePartyKey(key: string): { role: PartyRole; index: number; attr: PartyAttr } | null {
  const m = /^(buyer|seller)\.([1-9])\.(name|email|phone|address)$/.exec(key);
  if (!m) return null;
  return { role: m[1] as PartyRole, index: Number(m[2]), attr: m[3] as PartyAttr };
}

const ORDINAL = ["", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth"];

function partyBindings(role: PartyRole): Binding[] {
  const out: Binding[] = [];
  const who = role === "buyer" ? "buyer" : "seller";
  for (let i = 1; i <= MAX_PARTIES; i++) {
    const prefix = `${ORDINAL[i]} ${who}`;
    out.push(
      { key: partyKey(role, i, "name"), label: `${prefix} — full name`, group: role, type: "text", source: "party" },
      { key: partyKey(role, i, "email"), label: `${prefix} — email`, group: role, type: "text", source: "party" },
      { key: partyKey(role, i, "phone"), label: `${prefix} — phone`, group: role, type: "text", source: "party" },
      { key: partyKey(role, i, "address"), label: `${prefix} — mailing address`, group: role, type: "text", source: "party" },
    );
  }
  return out;
}

export const BINDINGS: Binding[] = [
  // Property — from the deal, topped up from the MLS listing when the deal
  // carries an MLS number that is in the Pillar 9 mirror.
  { key: "property.address", label: "Property address (one line)", group: "property", type: "text", source: "deal" },
  { key: "property.street", label: "Street address (no city)", group: "property", type: "text", source: "deal" },
  { key: "property.city", label: "City / town", group: "property", type: "text", source: "deal" },
  { key: "property.province", label: "Province", group: "property", type: "text", source: "deal" },
  { key: "property.postal", label: "Postal code", group: "property", type: "text", source: "deal" },
  { key: "property.mls", label: "MLS® number", group: "property", type: "text", source: "deal" },
  { key: "property.listPrice", label: "List price", group: "property", type: "money", source: "deal" },
  { key: "property.type", label: "Property type", group: "property", type: "text", source: "deal" },
  { key: "property.legalPlan", label: "Legal description — plan", group: "property", type: "text", source: "manual" },
  { key: "property.legalBlock", label: "Legal description — block", group: "property", type: "text", source: "manual" },
  { key: "property.legalLot", label: "Legal description — lot", group: "property", type: "text", source: "manual" },
  { key: "property.legalOther", label: "Legal description — other (unit / condo plan)", group: "property", type: "text", source: "manual" },
  { key: "property.title", label: "Title number", group: "property", type: "text", source: "manual" },

  ...partyBindings("buyer"),
  ...partyBindings("seller"),

  // The offer — typed once, carried forward to the counter and the amendment.
  { key: "offer.price", label: "Purchase price", group: "offer", type: "money", source: "manual" },
  { key: "offer.completionDay", label: "Completion day", group: "offer", type: "date", source: "manual" },
  { key: "offer.unattachedGoods", label: "Unattached goods included", group: "offer", type: "multiline", source: "manual" },
  { key: "offer.attachedGoods", label: "Attached goods excluded", group: "offer", type: "multiline", source: "manual" },
  { key: "offer.depositHolder", label: "Deposit trustee (brokerage)", group: "offer", type: "text", source: "manual" },
  { key: "offer.deposit", label: "Initial deposit", group: "offer", type: "money", source: "manual" },
  { key: "offer.depositMethod", label: "Initial deposit — method of payment", group: "offer", type: "text", source: "manual", hint: "e.g. bank draft, wire transfer, direct deposit" },
  { key: "offer.depositDueTime", label: "Initial deposit due — time", group: "offer", type: "text", source: "manual", hint: "e.g. 11:59 p" },
  { key: "offer.depositDueDate", label: "Initial deposit due — date", group: "offer", type: "date", source: "manual" },
  { key: "offer.additionalDeposit", label: "Additional deposit", group: "offer", type: "money", source: "manual" },
  { key: "offer.additionalDepositMethod", label: "Additional deposit — method of payment", group: "offer", type: "text", source: "manual" },
  { key: "offer.additionalDepositDueTime", label: "Additional deposit due — time", group: "offer", type: "text", source: "manual", hint: "e.g. 11:59 p" },
  { key: "offer.additionalDepositDueDate", label: "Additional deposit due — date", group: "offer", type: "date", source: "manual" },
  { key: "offer.dowerTime", label: "Dower consent due — time", group: "offer", type: "text", source: "manual", hint: "e.g. 11:59 p" },
  { key: "offer.dowerDate", label: "Dower consent due — date", group: "offer", type: "date", source: "manual" },
  { key: "offer.downPaymentPercent", label: "Financing — down payment (%)", group: "offer", type: "text", source: "manual", hint: "Just the number, e.g. 20" },
  { key: "offer.financingConditionDay", label: "Financing condition day", group: "offer", type: "date", source: "manual" },
  { key: "offer.inspectionConditionDay", label: "Property inspection condition day", group: "offer", type: "date", source: "manual" },
  { key: "offer.saleConditionTime", label: "Sale of buyer's property — time", group: "offer", type: "text", source: "manual", hint: "e.g. 11:59 p" },
  { key: "offer.saleConditionDay", label: "Sale of buyer's property — condition day", group: "offer", type: "date", source: "manual" },
  { key: "offer.buyerConditions", label: "Additional buyer's conditions", group: "offer", type: "multiline", source: "manual" },
  { key: "offer.buyerConditionsTime", label: "Additional buyer's conditions — time", group: "offer", type: "text", source: "manual", hint: "e.g. 11:59 p" },
  { key: "offer.buyerConditionsDay", label: "Additional buyer's conditions — condition day", group: "offer", type: "date", source: "manual" },
  { key: "offer.sellerConditions", label: "Seller's conditions", group: "offer", type: "multiline", source: "manual" },
  { key: "offer.sellerConditionsTime", label: "Seller's conditions — time", group: "offer", type: "text", source: "manual", hint: "e.g. 11:59 p" },
  { key: "offer.sellerConditionsDay", label: "Seller's conditions — condition day", group: "offer", type: "date", source: "manual" },
  { key: "offer.otherAttachment", label: "Other attached document", group: "offer", type: "text", source: "manual" },
  { key: "offer.additionalTerms", label: "Additional terms", group: "offer", type: "multiline", source: "manual" },
  { key: "offer.openUntilTime", label: "Offer open until — time", group: "offer", type: "text", source: "manual", hint: "e.g. 9:00 p" },
  { key: "offer.openUntilDate", label: "Offer open until — date", group: "offer", type: "date", source: "manual" },
  { key: "offer.contractProvidedBy", label: "Brokerage providing the contract to lawyers", group: "offer", type: "text", source: "manual", hint: "seller's or buyer's" },

  // Conveyancing: the lawyers on each side.
  { key: "conveyancing.sellerLawyer", label: "Seller's lawyer", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.sellerLawyerFirm", label: "Seller's lawyer — firm", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.sellerLawyerAddress", label: "Seller's lawyer — address", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.sellerLawyerPhone", label: "Seller's lawyer — phone", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.sellerLawyerEmail", label: "Seller's lawyer — email", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.buyerLawyer", label: "Buyer's lawyer", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.buyerLawyerFirm", label: "Buyer's lawyer — firm", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.buyerLawyerAddress", label: "Buyer's lawyer — address", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.buyerLawyerPhone", label: "Buyer's lawyer — phone", group: "conveyancing", type: "text", source: "manual" },
  { key: "conveyancing.buyerLawyerEmail", label: "Buyer's lawyer — email", group: "conveyancing", type: "text", source: "manual" },

  // Amendments, addenda and notices refer back to the contract they change.
  { key: "amendment.delete", label: "Amendment — delete", group: "amendment", type: "multiline", source: "manual" },
  { key: "amendment.insert", label: "Amendment — insert", group: "amendment", type: "multiline", source: "manual" },
  { key: "addendum.terms", label: "Addendum — additional terms", group: "amendment", type: "multiline", source: "manual" },
  { key: "notice.party", label: "Notice given by (seller or buyer)", group: "amendment", type: "text", source: "manual" },
  { key: "notice.conditions", label: "Conditions waived or satisfied", group: "amendment", type: "multiline", source: "manual" },

  // Representation agreements.
  { key: "agreement.startDate", label: "Agreement begins — date", group: "agreement", type: "date", source: "manual" },
  { key: "agreement.startTime", label: "Agreement begins — time", group: "agreement", type: "text", source: "manual", hint: "e.g. 12:01 a" },
  { key: "agreement.endDate", label: "Agreement ends — date", group: "agreement", type: "date", source: "manual" },
  { key: "agreement.endTime", label: "Agreement ends — time", group: "agreement", type: "text", source: "manual", hint: "e.g. 11:59 p" },
  { key: "agreement.fee", label: "Fee", group: "agreement", type: "text", source: "manual" },
  { key: "agreement.retainer", label: "Retainer", group: "agreement", type: "money", source: "manual" },

  // Listing brokerage, from the MLS mirror.
  { key: "listing.brokerage", label: "Listing brokerage", group: "listing", type: "text", source: "listing" },
  { key: "listing.brokerageAddress", label: "Listing brokerage — address", group: "listing", type: "text", source: "manual" },
  { key: "listing.agent", label: "Listing agent", group: "listing", type: "text", source: "listing" },
  { key: "listing.agentPhone", label: "Listing agent phone", group: "listing", type: "text", source: "listing" },
  { key: "listing.agentEmail", label: "Listing agent email", group: "listing", type: "text", source: "manual" },

  // The agent's own details.
  { key: "agent.name", label: "Agent name", group: "agent", type: "text", source: "agent" },
  { key: "agent.brokerage", label: "Brokerage", group: "agent", type: "text", source: "agent" },
  { key: "agent.phone", label: "Agent phone", group: "agent", type: "text", source: "agent" },
  { key: "agent.email", label: "Agent email", group: "agent", type: "text", source: "agent" },
  { key: "agent.address", label: "Brokerage address", group: "agent", type: "text", source: "agent" },

  // Filled when the document is created, or typed once per deal.
  { key: "document.number", label: "Contract / agreement number", group: "document", type: "text", source: "manual", hint: "Printed in the top-right of every page" },
  { key: "document.date", label: "Today's date", group: "document", type: "date", source: "auto" },
  { key: "document.year", label: "Today's year (two digits)", group: "document", type: "text", source: "auto" },
];

export const BINDING_BY_KEY: Record<string, Binding> = Object.fromEntries(BINDINGS.map((b) => [b.key, b]));

export const BINDING_GROUP_LABELS: Record<BindingGroup, string> = {
  property: "Property",
  buyer: "Buyers",
  seller: "Sellers",
  offer: "The offer",
  conveyancing: "Conveyancing",
  amendment: "Amendment / notice",
  agreement: "Representation agreement",
  listing: "Listing brokerage",
  agent: "Agent",
  document: "Document",
};

export const CUSTOM_PREFIX = "custom.";

export function isCustomKey(key: string): boolean {
  return key.startsWith(CUSTOM_PREFIX);
}

/** "Second deposit due" → custom.second-deposit-due */
export function customKeyFor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${CUSTOM_PREFIX}${slug || "field"}`;
}

export function bindingLabel(key: string, label?: string | null): string {
  return BINDING_BY_KEY[key]?.label ?? label ?? key.replace(CUSTOM_PREFIX, "").replace(/-/g, " ");
}

// ---- Printing -----------------------------------------------------------------------
//
// A fill box's `format` picks how a money or date value is printed, because
// the blank on the form already carries part of it: AREA prints "$" before
// the price, and its date blanks read "____________, 20___" so the month and
// day go in one box and the last two digits of the year in another.

export const MONEY_FORMATS = [
  { id: "dollar", label: "$650,000.00" },
  { id: "plain", label: "650,000.00 (the form prints the $)" },
  { id: "whole", label: "$650,000" },
] as const;

export const DATE_FILL_FORMATS = [
  { id: "long", label: "October 15, 2026" },
  { id: "short", label: "Oct 15, 2026" },
  { id: "month-day", label: "October 15 (for a “, 20__” blank)" },
  { id: "yy", label: "26 (just the two-digit year)" },
  { id: "iso", label: "2026-10-15" },
  { id: "numeric", label: "15/10/2026" },
] as const;

export const DEFAULT_MONEY_FORMAT = "dollar";
export const DEFAULT_DATE_FILL_FORMAT = "long";

/** "650000" | "$650,000" | "650,000.5" → "$650,000.50"; anything unparseable prints as typed. */
export function formatMoney(raw: string, format: string | null | undefined = DEFAULT_MONEY_FORMAT): string {
  const s = raw.trim();
  if (!s) return "";
  const cleaned = s.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return s;
  const n = Number(cleaned);
  const digits = format === "whole" ? 0 : 2;
  const num = n.toLocaleString("en-CA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return format === "plain" ? num : `$${num}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-15" → "October 15, 2026" (or the chosen format); anything else prints as typed. */
export function formatDateValue(raw: string, format: string | null | undefined = DEFAULT_DATE_FILL_FORMAT): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return raw.trim();
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return raw.trim();
  const day = Number(m[3]);
  switch (format) {
    case "short":
      return `${month.slice(0, 3)} ${day}, ${m[1]}`;
    case "month-day":
      return `${month} ${day}`;
    case "yy":
      return m[1].slice(-2);
    case "iso":
      return `${m[1]}-${m[2]}-${m[3]}`;
    case "numeric":
      return `${m[3]}/${m[2]}/${m[1]}`;
    case "long":
    default:
      return `${month} ${day}, ${m[1]}`;
  }
}

/** The text printed in a fill box for a stored value. */
export function formatFillValue(type: FillType, raw: string | null | undefined, format?: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  switch (type) {
    case "money":
      return formatMoney(s, format);
    case "date":
      return formatDateValue(s, format);
    case "checkbox":
      return s === "true" ? "true" : "";
    default:
      return s;
  }
}

/** Today's date in Calgary as YYYY-MM-DD, for document.date. */
export function todayIso(at: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
