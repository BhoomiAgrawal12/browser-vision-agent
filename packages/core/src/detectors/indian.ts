import { gstinCheckChar, luhnValidate, verhoeffValidate } from "./checksums.js";

/**
 * Validators for Indian identifiers. Each takes text that already looks like
 * a candidate and answers "is this really one?". This is what separates an
 * Aadhaar from an order id and keeps precision high.
 *
 * Every validator returns a strength:
 *   "checksum"  the value passes a mathematical check; near certain
 *   "structure" the value matches strict positional rules; strong
 *   "format"    the value merely fits the shape; needs corroboration
 */
export type ValidationStrength = "checksum" | "structure" | "format";

export interface Validation {
  valid: boolean;
  strength?: ValidationStrength;
  normalized?: string;
}

const NOT_VALID: Validation = { valid: false };

function digitsOf(text: string): string {
  // Strip spaces plus ASCII and unicode dashes (hyphen, en dash, em dash,
  // figure dash): real pages and copied text use all of them.
  return text.replace(/[\s\-\u2010-\u2015]/g, "");
}

/** Aadhaar: 12 digits, first digit 2-9, Verhoeff check digit. */
export function validateAadhaar(text: string): Validation {
  const d = digitsOf(text);
  if (!/^[2-9]\d{11}$/.test(d)) return NOT_VALID;
  if (!verhoeffValidate(d)) return NOT_VALID;
  return { valid: true, strength: "checksum", normalized: d };
}

/**
 * PAN: 5 letters, 4 digits, 1 letter. The 4th character encodes the holder
 * type and only a fixed set is issued, which is a strong positional rule.
 */
const PAN_HOLDER_TYPES = new Set(["A", "B", "C", "F", "G", "H", "J", "L", "P", "T"]);

export function validatePan(text: string): Validation {
  // Scanned cards and forms often space the segments: "ABCPE 1234 F".
  const t = text.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(t)) return NOT_VALID;
  if (!PAN_HOLDER_TYPES.has(t[3]!)) return NOT_VALID;
  return { valid: true, strength: "structure", normalized: t };
}

/** GSTIN: state code 01-38, embedded PAN, entity, letter Z, check character. */
export function validateGstin(text: string): Validation {
  const t = text.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(t)) return NOT_VALID;
  const state = Number(t.slice(0, 2));
  if (state < 1 || state > 38) return NOT_VALID;
  if (!validatePan(t.slice(2, 12)).valid) return NOT_VALID;
  if (gstinCheckChar(t.slice(0, 14)) !== t[14]) return NOT_VALID;
  return { valid: true, strength: "checksum", normalized: t };
}

/** IFSC: 4 letter bank code, a zero, 6 alphanumeric branch code. */
export function validateIfsc(text: string): Validation {
  const t = text.trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(t)) return NOT_VALID;
  return { valid: true, strength: "structure", normalized: t };
}

/**
 * UPI VPA: local@handle. A known payment handle upgrades the strength;
 * an unknown handle still matches as format only (it may be a new PSP,
 * or it may just be an email address, so corroboration is needed).
 */
const UPI_HANDLES = new Set([
  "upi", "ybl", "ibl", "axl", "apl", "yapl", "rapl",
  "paytm", "ptyes", "ptaxis", "pthdfc", "ptsbi",
  "okaxis", "oksbi", "okhdfcbank", "okicici", "okbizaxis",
  "sbi", "axisbank", "axisb", "icici", "hdfcbank", "kotak", "kmbl",
  "federal", "fbl", "aubank", "idfcbank", "yesbank", "barodampay",
  "cnrb", "pnb", "boi", "cbin", "unionbank", "uco", "indianbank",
  "airtel", "freecharge", "mobikwik", "jupiteraxis", "niyoicici",
  "slice", "tapicici", "timecosmos", "waaxis", "wahdfcbank", "waicici", "wasbi",
]);

export function validateUpiVpa(text: string): Validation {
  const t = text.trim().toLowerCase();
  const m = /^([a-z0-9][a-z0-9._\-]{1,48})@([a-z][a-z0-9]{1,30})$/.exec(t);
  if (!m) return NOT_VALID;
  const handle = m[2]!;
  if (UPI_HANDLES.has(handle)) {
    return { valid: true, strength: "structure", normalized: t };
  }
  // Looks like a VPA but the handle is unknown; could equally be an email
  // local part without a TLD. Weak signal on purpose.
  return { valid: true, strength: "format", normalized: t };
}

/** Payment card: 13-19 digits, Luhn valid, known major-industry prefix. */
export function validateCardNumber(text: string): Validation {
  const d = digitsOf(text);
  if (!/^\d{13,19}$/.test(d)) return NOT_VALID;
  // Major industry identifier: card networks live in ranges 2-6 plus 81 (RuPay).
  if (!/^(2|3|4|5|6|81)/.test(d)) return NOT_VALID;
  if (!luhnValidate(d)) return NOT_VALID;
  return { valid: true, strength: "checksum", normalized: d };
}

/** Indian mobile: 10 digits starting 6-9, tolerating +91 / 91 / 0 prefixes. */
export function validateIndianMobile(text: string): Validation {
  let d = digitsOf(text.replace(/^\+/, ""));
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return NOT_VALID;
  return { valid: true, strength: "structure", normalized: d };
}

/** PIN code: 6 digits, first digit 1-8 (9 is reserved for army postal). */
export function validatePinCode(text: string): Validation {
  const d = digitsOf(text);
  if (!/^[1-8]\d{5}$/.test(d)) return NOT_VALID;
  return { valid: true, strength: "structure", normalized: d };
}

/** Bank account: 9-18 digits. No public checksum exists, so format only. */
export function validateBankAccount(text: string): Validation {
  const d = digitsOf(text);
  if (!/^\d{9,18}$/.test(d)) return NOT_VALID;
  return { valid: true, strength: "format", normalized: d };
}

const STATE_CODES = new Set([
  "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ",
  "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP",
  "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "TG",
  "UK", "UA", "UP", "WB",
]);

/** Vehicle registration: state + RTO + series + number, or the BH series. */
export function validateVehicleReg(text: string): Validation {
  const t = text.trim().toUpperCase().replace(/[\s\-]/g, "");
  const bh = /^(\d{2})BH(\d{4})([A-Z]{1,2})$/.exec(t);
  if (bh) return { valid: true, strength: "structure", normalized: t };
  const m = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{4})$/.exec(t);
  if (!m) return NOT_VALID;
  if (!STATE_CODES.has(m[1]!)) return NOT_VALID;
  return { valid: true, strength: "structure", normalized: t };
}

/** Email: pragmatic RFC-lite shape. */
export function validateEmail(text: string): Validation {
  const t = text.trim();
  if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(t)) return NOT_VALID;
  if (t.length > 254) return NOT_VALID;
  return { valid: true, strength: "structure", normalized: t.toLowerCase() };
}
