import type { FIELD_TYPES, SIGNER_ROLES } from "@shared/schema";

export type FieldType = (typeof FIELD_TYPES)[number];
export type SignerRole = (typeof SIGNER_ROLES)[number];
