import { z } from "zod";

/**
 * The PII taxonomy. Every detector, policy rule, placeholder token and
 * redaction legend entry names one of these classes. Adding a class here is
 * a schema change and must bump the wire version.
 */
export const PII_CLASSES = [
  // Credentials and secrets
  "PASSWORD",
  "OTP",
  "API_KEY",
  // Government identity (India first)
  "AADHAAR",
  "PAN",
  "GSTIN",
  "VOTER_ID",
  "PASSPORT_IN",
  "DRIVING_LICENCE",
  "VEHICLE_REG",
  // Financial
  "CARD_NUMBER",
  "BANK_ACCOUNT",
  "IFSC",
  "UPI_VPA",
  "AMOUNT",
  // Contact and identity
  "EMAIL",
  "PHONE_IN",
  "PIN_CODE",
  "PERSON_NAME",
  "USERNAME",
  "ADDRESS",
  "DOB",
  // Visual
  "FACE",
  "SIGNATURE",
  "QR_BARCODE",
  "ID_DOCUMENT",
] as const;

export const PiiClass = z.enum(PII_CLASSES);
export type PiiClass = z.infer<typeof PiiClass>;

/**
 * Severity drives policy. INVARIANT classes are redacted in every mode,
 * regardless of user settings: this is the invariant floor from the report.
 */
export type PiiSeverity = "invariant" | "high" | "medium";

export const PII_SEVERITY: Record<PiiClass, PiiSeverity> = {
  PASSWORD: "invariant",
  OTP: "invariant",
  API_KEY: "invariant",
  AADHAAR: "invariant",
  PAN: "invariant",
  GSTIN: "high",
  VOTER_ID: "invariant",
  PASSPORT_IN: "invariant",
  DRIVING_LICENCE: "invariant",
  VEHICLE_REG: "high",
  CARD_NUMBER: "invariant",
  BANK_ACCOUNT: "invariant",
  IFSC: "high",
  UPI_VPA: "high",
  AMOUNT: "high",
  EMAIL: "high",
  PHONE_IN: "high",
  PIN_CODE: "medium",
  PERSON_NAME: "medium",
  USERNAME: "medium",
  ADDRESS: "high",
  DOB: "high",
  FACE: "invariant",
  SIGNATURE: "invariant",
  QR_BARCODE: "invariant",
  ID_DOCUMENT: "invariant",
};

export function isInvariantClass(cls: PiiClass): boolean {
  return PII_SEVERITY[cls] === "invariant";
}

/**
 * Placeholder tokens: "PII:AADHAAR#1". Stable within a session (same value,
 * same token), never stable across sessions (per-session vault salt).
 */
const TOKEN_RE = /^PII:([A-Z_]+)#(\d+)$/;

export function formatToken(cls: PiiClass, ordinal: number): string {
  return `PII:${cls}#${ordinal}`;
}

export function parseToken(token: string): { cls: PiiClass; ordinal: number } | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const parsed = PiiClass.safeParse(m[1]);
  if (!parsed.success) return null;
  return { cls: parsed.data, ordinal: Number(m[2]) };
}

export const PlaceholderToken = z
  .string()
  .refine((t) => parseToken(t) !== null, { message: "not a valid placeholder token" });

/**
 * Human and machine readable description of each class, used to build the
 * redaction_legend that travels in every packet. The server never has to
 * guess what a placeholder means.
 */
export const PII_LEGEND: Record<PiiClass, string> = {
  PASSWORD: "a secret credential; the field is filled but the value is withheld",
  OTP: "a one-time passcode",
  API_KEY: "a machine credential or token",
  AADHAAR: "a 12 digit Indian government identity number",
  PAN: "a 10 character Indian tax identity code",
  GSTIN: "a 15 character Indian business tax number",
  VOTER_ID: "an Indian voter identity number",
  PASSPORT_IN: "an Indian passport number",
  DRIVING_LICENCE: "an Indian driving licence number",
  VEHICLE_REG: "an Indian vehicle registration number",
  CARD_NUMBER: "a payment card number",
  BANK_ACCOUNT: "a bank account number",
  IFSC: "an Indian bank branch routing code",
  UPI_VPA: "a UPI payment address",
  AMOUNT: "a monetary amount; a magnitude bucket may be provided instead",
  EMAIL: "an email address",
  PHONE_IN: "an Indian phone number",
  PIN_CODE: "an Indian postal code",
  PERSON_NAME: "a person's name",
  USERNAME: "an account username or handle",
  ADDRESS: "a physical address",
  DOB: "a date of birth",
  FACE: "a human face image",
  SIGNATURE: "a handwritten signature image",
  QR_BARCODE: "a QR code or barcode; may encode identity or payment data",
  ID_DOCUMENT: "an image of an identity document",
};
