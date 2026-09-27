import type { PiiClass } from "../schema/pii.js";
import {
  validateAadhaar,
  validateBankAccount,
  validateCardNumber,
  validateEmail,
  validateGstin,
  validateIfsc,
  validateIndianMobile,
  validatePan,
  validatePinCode,
  validateUpiVpa,
  validateVehicleReg,
  type Validation,
} from "./indian.js";

/**
 * Presidio-style analyzer: a registry of small independent recognizers,
 * each finding one class of thing, each returning spans with a confidence.
 * Context words near a span boost its confidence, which is how a six digit
 * number becomes a PIN code when the label says so and stays a nothing
 * otherwise.
 */

export interface PiiSpan {
  cls: PiiClass;
  start: number;
  end: number;
  text: string;
  confidence: number;
  evidence: string[];
  normalized?: string;
}

export interface Recognizer {
  name: string;
  cls: PiiClass;
  recognize(text: string): PiiSpan[];
}

const STRENGTH_CONFIDENCE: Record<NonNullable<Validation["strength"]>, number> = {
  checksum: 0.99,
  structure: 0.85,
  format: 0.5,
};

export interface PatternRecognizerSpec {
  name: string;
  cls: PiiClass;
  pattern: RegExp;
  validate?: (candidate: string) => Validation;
  /** Base confidence when there is no validator (or validator returns format). */
  baseConfidence?: number;
  /**
   * When true, the validator only filters candidates and never raises
   * confidence. Use for weak shapes (six digit numbers, plain digit runs)
   * where passing structural rules is not evidence of the class: only
   * context can lift those above the threshold.
   */
  validatorAsGate?: boolean;
  /** Words that, appearing near the span, boost confidence. */
  contextWords?: string[];
  contextBoost?: number;
  /** Window in characters searched before and after the span for context. */
  contextWindow?: number;
}

const DEFAULT_CONTEXT_WINDOW = 48;
const DEFAULT_CONTEXT_BOOST = 0.35;

export function makePatternRecognizer(spec: PatternRecognizerSpec): Recognizer {
  const pattern = new RegExp(
    spec.pattern.source,
    spec.pattern.flags.includes("g") ? spec.pattern.flags : spec.pattern.flags + "g",
  );
  const contextWords = (spec.contextWords ?? []).map((w) => w.toLowerCase());
  const window = spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const boost = spec.contextBoost ?? DEFAULT_CONTEXT_BOOST;

  return {
    name: spec.name,
    cls: spec.cls,
    recognize(text: string): PiiSpan[] {
      const spans: PiiSpan[] = [];
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const candidate = m[0];
        const start = m.index;
        const end = start + candidate.length;
        const evidence: string[] = [`pattern:${spec.name}`];

        let confidence = spec.baseConfidence ?? 0.4;
        let normalized: string | undefined;

        if (spec.validate) {
          const v = spec.validate(candidate);
          if (!v.valid) continue;
          if (v.strength && !spec.validatorAsGate) {
            confidence = Math.max(confidence, STRENGTH_CONFIDENCE[v.strength]);
            evidence.push(`pattern:${spec.name}-${v.strength}`);
          }
          if (v.normalized !== undefined) normalized = v.normalized;
        }

        if (contextWords.length > 0) {
          const before = text.slice(Math.max(0, start - window), start).toLowerCase();
          const after = text.slice(end, end + window).toLowerCase();
          const hit = contextWords.find((w) => before.includes(w) || after.includes(w));
          if (hit) {
            confidence = Math.min(0.99, confidence + boost);
            evidence.push(`pattern:context=${hit.replace(/[^a-z0-9/]/g, "")}`);
          }
        }

        const span: PiiSpan = {
          cls: spec.cls,
          start,
          end,
          text: candidate,
          confidence,
          evidence,
        };
        if (normalized !== undefined) span.normalized = normalized;
        spans.push(span);
      }
      return spans;
    },
  };
}

/** Overlap resolution: highest confidence wins; ties break to the longer span. */
export function resolveOverlaps(spans: PiiSpan[]): PiiSpan[] {
  const sorted = [...spans].sort(
    (a, b) => b.confidence - a.confidence || b.end - b.start - (a.end - a.start),
  );
  const kept: PiiSpan[] = [];
  for (const s of sorted) {
    if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export class RecognizerRegistry {
  private recognizers: Recognizer[] = [];

  register(r: Recognizer): this {
    this.recognizers.push(r);
    return this;
  }

  /**
   * Run every recognizer, resolve overlaps, and keep spans at or above the
   * threshold. A lower threshold is stricter privacy (more redaction);
   * Fortress mode passes a lower value than Shield.
   */
  analyze(text: string, opts: { threshold?: number } = {}): PiiSpan[] {
    const threshold = opts.threshold ?? 0.5;
    const all: PiiSpan[] = [];
    for (const r of this.recognizers) all.push(...r.recognize(text));
    return resolveOverlaps(all).filter((s) => s.confidence >= threshold);
  }
}

/** The default registry: every Indian-first recognizer, wired with context. */
export function defaultRegistry(): RecognizerRegistry {
  const reg = new RecognizerRegistry();

  // Digit-spacing evasion: "9 9 9 9 4 1 0 5 7 0 5 8" defeats plain digit
  // patterns. Collapse single-spaced digit runs and hand the result to the
  // checksum validators; only validated hits fire, so an order id spaced
  // the same way stays untouched.
  reg.register({
    name: "digit-spacing",
    cls: "AADHAAR",
    recognize(text: string): PiiSpan[] {
      const spans: PiiSpan[] = [];
      for (const m of text.matchAll(/(?<!\d)(?<!\d )\d(?: \d){9,18}(?! ?\d)/g)) {
        const collapsed = m[0].replace(/ /g, "");
        const candidates: [PiiClass, Validation][] = [
          ["AADHAAR", validateAadhaar(collapsed)],
          ["CARD_NUMBER", validateCardNumber(collapsed)],
          ["PHONE_IN", validateIndianMobile(collapsed)],
        ];
        const hit = candidates.find(([, v]) => v.valid && v.strength !== "format");
        if (!hit) continue;
        spans.push({
          cls: hit[0],
          start: m.index,
          end: m.index + m[0].length,
          text: m[0],
          confidence: hit[1].strength === "checksum" ? 0.99 : 0.85,
          evidence: ["pattern:digit-spacing-evasion"],
          ...(hit[1].normalized !== undefined ? { normalized: hit[1].normalized } : {}),
        });
      }
      return spans;
    },
  });

  reg.register(
    makePatternRecognizer({
      name: "aadhaar",
      cls: "AADHAAR",
      pattern: /(?<!\d)\d{4}[\s\-‐-―]?\d{4}[\s\-‐-―]?\d{4}(?!\d)/,
      validate: validateAadhaar,
      contextWords: ["aadhaar", "aadhar", "uid", "uidai", "आधार"],
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "pan",
      cls: "PAN",
      pattern: /\b[A-Za-z]{5}[ ]?\d{4}[ ]?[A-Za-z]\b/,
      validate: validatePan,
      contextWords: ["pan", "permanent account"],
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "gstin",
      cls: "GSTIN",
      pattern: /\b\d{2}[A-Za-z]{5}\d{4}[A-Za-z][1-9A-Za-z][Zz][0-9A-Za-z]\b/,
      validate: validateGstin,
      contextWords: ["gst", "gstin"],
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "ifsc",
      cls: "IFSC",
      pattern: /\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/,
      validate: validateIfsc,
      contextWords: ["ifsc", "branch", "neft", "rtgs", "imps"],
      // IFSC shape collides with ordinary uppercase words rarely, but the
      // validator's structure rule is already strong.
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "card",
      cls: "CARD_NUMBER",
      pattern: /(?<!\d)(?:\d[ \-‐-―]?){12,18}\d(?!\d)/,
      validate: validateCardNumber,
      contextWords: ["card", "credit", "debit", "visa", "mastercard", "rupay"],
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "email",
      cls: "EMAIL",
      pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
      validate: validateEmail,
      contextWords: ["email", "e-mail", "mail id"],
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "upi",
      cls: "UPI_VPA",
      // No dot in the handle: full emails belong to the email recognizer.
      pattern: /\b[a-z0-9][a-z0-9._-]{1,48}@[a-z][a-z0-9]{1,30}\b(?!\.)/i,
      validate: validateUpiVpa,
      contextWords: ["upi", "vpa", "pay", "gpay", "phonepe", "paytm"],
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "phone-in",
      cls: "PHONE_IN",
      pattern: /(?<![\d@])(?:\+91[\s-]?|91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d@])/,
      validate: validateIndianMobile,
      contextWords: ["phone", "mobile", "contact", "whatsapp", "call", "sms", "मोबाइल", "फ़ोन", "फोन", "दूरभाष"],
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "pincode",
      cls: "PIN_CODE",
      // Six digits are everywhere; without context this stays below the
      // default threshold and is dropped. That is deliberate.
      pattern: /(?<!\d)[1-8]\d{5}(?!\d)/,
      validate: validatePinCode,
      validatorAsGate: true,
      baseConfidence: 0.3,
      contextWords: ["pin", "pincode", "pin code", "postal", "zip", "पिन", "पिनकोड", "डाक"],
      contextBoost: 0.45,
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "bank-account",
      cls: "BANK_ACCOUNT",
      pattern: /(?<![\d-])\d{9,18}(?![\d-])/,
      validate: validateBankAccount,
      validatorAsGate: true,
      baseConfidence: 0.25,
      contextWords: ["account", "a/c", "acct", "acc no", "khata", "खाता", "खाता संख्या"],
      contextBoost: 0.5,
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "vehicle-reg",
      cls: "VEHICLE_REG",
      pattern: /\b[A-Za-z]{2}[\s-]?\d{1,2}[\s-]?[A-Za-z]{1,3}[\s-]?\d{4}\b|\b\d{2}[\s-]?BH[\s-]?\d{4}[\s-]?[A-Za-z]{1,2}\b/,
      validate: validateVehicleReg,
      baseConfidence: 0.45,
      contextWords: ["vehicle", "registration", "rc", "number plate"],
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "dob",
      cls: "DOB",
      pattern: /\b(?:[0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)\d{2}|(?:19|20)\d{2}[\/\-.][01]?\d[\/\-.][0-3]?\d)\b/,
      baseConfidence: 0.3,
      contextWords: ["dob", "birth", "born", "janm"],
      contextBoost: 0.5,
    }),
  );

  reg.register(
    makePatternRecognizer({
      name: "amount-inr",
      cls: "AMOUNT",
      pattern: /(?:₹|Rs\.?|INR)\s?(?:\d{1,3}(?:,\d{2,3})+|\d{1,7})(?:\.\d{1,2})?\b/,
      baseConfidence: 0.8,
      contextWords: ["balance", "amount", "total", "due", "paid", "salary"],
      contextBoost: 0.15,
    }),
  );

  return reg;
}
