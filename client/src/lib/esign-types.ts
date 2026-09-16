// Mirrors of the JSON the deal / e-signature API returns (server/deal-routes.ts).

export type FieldType = "signature" | "initials" | "date" | "text" | "checkbox";
export type SignerRole = "buyer" | "seller" | "agent" | "witness" | "other";

export interface PageSize {
  w: number;
  h: number;
}

export interface FieldView {
  id: number;
  signerId: number;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  label: string | null;
  value: string | null;
  filledAt: string | null;
}

export interface SignerView {
  id: number;
  name: string;
  email: string;
  role: SignerRole;
  orderIndex: number;
  status: "pending" | "sent" | "viewed" | "signed" | "declined";
  consentAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  signatureKind: "drawn" | "typed" | null;
  hasSignature: boolean;
  hasInitials: boolean;
  ip: string | null;
  userAgent: string | null;
  lastEmailAt: string | null;
  signUrl: string;
}

export interface EventView {
  id: number;
  signerId: number | null;
  type: string;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
  at: string;
}

export interface DocumentSummary {
  id: number;
  dealId: number;
  title: string;
  originalFilename: string | null;
  status: "draft" | "sent" | "completed" | "declined" | "voided";
  pageCount: number;
  signingOrder: "parallel" | "sequential";
  sentAt: string | null;
  completedAt: string | null;
  voidedAt: string | null;
  originalSha256: string;
  signedSha256: string | null;
  originalBytes: number;
  signedBytes: number | null;
  createdAt: string;
  updatedAt: string;
  signerCount: number;
  signedCount: number;
}

export interface DocumentDetail extends DocumentSummary {
  message: string | null;
  voidReason: string | null;
  pageSizes: PageSize[];
  deal: { id: number; title: string; address: string | null };
  signers: SignerView[];
  fields: FieldView[];
  events: EventView[];
  canSignNow: number[];
  warning?: string;
}

export interface DealView {
  id: number;
  title: string;
  address: string | null;
  kind: "purchase" | "listing" | "lease" | "other";
  status: "active" | "closed" | "archived";
  leadId: number | null;
  leadName: string | null;
  listingId: string | null;
  mlsNumber: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  awaitingSignature: number;
  completedDocuments: number;
  documents: DocumentSummary[];
}

export interface BackupRun {
  id: number;
  kind: string;
  status: "running" | "ok" | "error";
  dbBytes: number | null;
  dbKey: string | null;
  filesUploaded: number;
  filesBytes: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BackupStatus {
  configured: boolean;
  missing: string[];
  target: string | null;
  keepDays: number | null;
  documentsRoot: string;
  pendingFiles: number;
  running: boolean;
  lastOk: BackupRun | null;
  runs: BackupRun[];
}

/** What the public signer page receives. */
export interface SignerPage {
  document: {
    id: number;
    title: string;
    status: DocumentSummary["status"];
    pageCount: number;
    pageSizes: PageSize[];
    message: string | null;
    signingOrder: "parallel" | "sequential";
    completedAt: string | null;
    originalSha256: string;
    signedSha256: string | null;
    signedBytes: number | null;
  };
  deal: { title: string; address: string | null };
  agent: { name: string; brokerage: string; phone: string; email: string };
  signer: {
    id: number;
    name: string;
    email: string;
    role: SignerRole;
    status: SignerView["status"];
    consentAt: string | null;
    signedAt: string | null;
    declinedAt: string | null;
  };
  others: Array<{ id: number; name: string; role: SignerRole; status: SignerView["status"]; hasSignature: boolean; hasInitials: boolean }>;
  fields: Array<FieldView & { mine: boolean }>;
  canSign: boolean;
  waitingOn: string | null;
}

export const FIELD_LABELS: Record<FieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  date: "Date",
  text: "Text",
  checkbox: "Checkbox",
};

export const ROLE_LABELS: Record<SignerRole, string> = {
  buyer: "Buyer",
  seller: "Seller",
  agent: "Agent",
  witness: "Witness",
  other: "Other",
};

/** Default box sizes as fractions of a US-Letter page. */
export const FIELD_DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  signature: { w: 0.26, h: 0.045 },
  initials: { w: 0.08, h: 0.035 },
  date: { w: 0.16, h: 0.028 },
  text: { w: 0.22, h: 0.028 },
  checkbox: { w: 0.022, h: 0.017 },
};

/** One colour per signer so boxes read at a glance. */
export const SIGNER_COLOURS = ["#D4AF37", "#23412d", "#1d4ed8", "#b91c1c", "#7c3aed", "#0f766e", "#c2410c", "#4b5563"];

export function signerColour(index: number): string {
  return SIGNER_COLOURS[index % SIGNER_COLOURS.length];
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}
