import type { PiiClass } from "./schema/pii.js";
import type { PiiSpan, RecognizerRegistry } from "./detectors/recognizers.js";

/** A form field descriptor safe to use for local task-prompt matching. */
export interface PromptField {
  id: string;
  label: string | null;
  structuralClass?: PiiClass;
}

export interface PromptAnswer {
  fieldId: string;
  value: string;
  class?: PiiClass;
  start: number;
  end: number;
}

export interface PromptAnswerExtraction {
  answers: PromptAnswer[];
  /** The task text with locally supplied values removed before policy processing. */
  sanitizedIntent: string;
}

interface KeyMatch {
  field: PromptField;
  alias: string;
  keyStart: number;
  valueStart: number;
}

const CLASS_ALIASES: Partial<Record<PiiClass, string[]>> = {
  AADHAAR: ["aadhaar", "aadhar", "uid"],
  PAN: ["pan"],
  EMAIL: ["email", "email address", "mail", "main"],
  PHONE_IN: ["phone", "phone number", "mobile", "mobile number", "contact number"],
  PIN_CODE: ["pin", "pin code", "pincode", "postal code", "zip"],
  DOB: ["dob", "date of birth", "birth date"],
  PASSWORD: ["password", "passcode"],
  USERNAME: ["username", "user name", "login"],
  ADDRESS: ["address", "street address", "home address"],
  PERSON_NAME: ["name", "full name", "given name", "first name", "last name"],
  BANK_ACCOUNT: ["account", "account number", "bank account"],
  IFSC: ["ifsc", "ifsc code"],
  UPI_VPA: ["upi", "upi id", "vpa"],
};

const LABEL_CLASS_HINTS: [RegExp, PiiClass][] = [
  [/aadha?ar|uidai|\buid\b/i, "AADHAAR"],
  [/\bpan\b|permanent.?account/i, "PAN"],
  [/email|e-mail|mail/i, "EMAIL"],
  [/phone|mobile|contact/i, "PHONE_IN"],
  [/pin|postal|zip/i, "PIN_CODE"],
  [/date.?of.?birth|\bdob\b|birth/i, "DOB"],
  [/passw|pwd/i, "PASSWORD"],
  [/user.?name|login/i, "USERNAME"],
  [/address|street|locality|city/i, "ADDRESS"],
  [/name/i, "PERSON_NAME"],
  [/account|a\/c/i, "BANK_ACCOUNT"],
  [/ifsc/i, "IFSC"],
  [/upi|vpa/i, "UPI_VPA"],
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function inferredClass(field: PromptField): PiiClass | undefined {
  if (field.structuralClass) return field.structuralClass;
  const label = field.label ?? "";
  return LABEL_CLASS_HINTS.find(([pattern]) => pattern.test(label))?.[1];
}

function aliasesFor(field: PromptField): string[] {
  const label = normalize(field.label ?? "").replace(/^\d+\s+/, "");
  const aliases = new Set<string>();
  if (label) aliases.add(label);
  const cls = inferredClass(field);
  const specificName = /\b(first|last|given|family) name\b/.test(label);
  const city = /\b(city|town|locality)\b/.test(label);
  if (!specificName && !city) for (const alias of cls ? CLASS_ALIASES[cls] ?? [] : []) aliases.add(alias);
  if (/comment|remark|note/.test(label)) {
    for (const alias of ["comment", "comments", "commets", "remark", "remarks", "note", "notes"]) {
      aliases.add(alias);
    }
  }
  if (cls === "PERSON_NAME" && !specificName) aliases.add("name");
  if (label.includes("email")) aliases.add("email");
  if (label.includes("phone") || label.includes("mobile")) aliases.add("phone");
  return [...aliases].sort((a, b) => b.length - a.length);
}

function escapePattern(text: string): string {
  return text
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

function isLikelyLeadingName(value: string): boolean {
  const words = value.trim().split(/\s+/);
  const instructionWords = new Set([
    "address",
    "complete",
    "email",
    "enter",
    "fill",
    "form",
    "help",
    "my",
    "name",
    "phone",
    "please",
    "provide",
    "submit",
    "the",
    "this",
    "use",
  ]);
  return (
    words.length > 0 &&
    words.length <= 4 &&
    words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word) && !instructionWords.has(word.toLowerCase()))
  );
}

function keyMatches(prompt: string, fields: PromptField[]): KeyMatch[] {
  const matches: KeyMatch[] = [];
  for (const field of fields) {
    for (const alias of aliasesFor(field)) {
      const pattern = new RegExp(
        `(?:^|\\b)(?:(?:and|then|fill|enter|provide|use)\\s+)?(${escapePattern(alias)})\\s*(?::|=|-|\\bis\\b|\\bwith\\b|\\bto\\b)\\s*`,
        "gi",
      );
      for (const match of prompt.matchAll(pattern)) {
        const keyStart = match.index ?? 0;
        const matchedAlias = match[1] ?? alias;
        const aliasOffset = match[0].toLowerCase().lastIndexOf(matchedAlias.toLowerCase());
        matches.push({
          field,
          alias,
          keyStart: keyStart + Math.max(0, aliasOffset),
          valueStart: keyStart + match[0].length,
        });
      }
    }
  }

  // Natural-language location clauses often omit the field name and separator.
  // Only apply these to a uniquely labelled city/town/locality field.
  const locationFields = fields.filter((field) => /\b(city|town|locality)\b/i.test(field.label ?? ""));
  if (locationFields.length === 1) {
    const field = locationFields[0]!;
    const pattern = /\b(?:i\s+(?:live|reside|stay)(?:\s+in)?|(?:live|reside|stay)\s+in)\s+/gi;
    for (const match of prompt.matchAll(pattern)) {
      const keyStart = match.index ?? 0;
      matches.push({
        field,
        alias: match[0].trim(),
        keyStart,
        valueStart: keyStart + match[0].length,
      });
    }
  }

  const nameFields = fields.filter((field) => inferredClass(field) === "PERSON_NAME");
  if (nameFields.length === 1 && !matches.some((match) => match.field.id === nameFields[0]!.id)) {
    const firstKey = [...matches]
      .filter((match) => match.keyStart > 0)
      .sort((a, b) => a.keyStart - b.keyStart)[0];
    const leading = firstKey ? trimValue(prompt, 0, firstKey.keyStart) : null;
    if (leading && isLikelyLeadingName(leading.value)) {
      matches.push({
        field: nameFields[0]!,
        alias: "leading name",
        keyStart: leading.start,
        valueStart: leading.start,
      });
    }
  }

  return matches
    .sort((a, b) => a.valueStart - b.valueStart || b.alias.length - a.alias.length)
    .filter((match, index, all) => {
      const sameStart = all.filter((candidate) => candidate.valueStart === match.valueStart);
      const longest = Math.max(...sameStart.map((candidate) => candidate.alias.length));
      if (match.alias.length < longest) return false;
      const uniqueFields = new Set(sameStart.filter((candidate) => candidate.alias.length === longest).map((candidate) => candidate.field.id));
      if (uniqueFields.size > 1) return false;
      return !all.slice(0, index).some((candidate) => {
        return candidate.valueStart === match.valueStart && candidate.field.id === match.field.id;
      });
    });
}

function trimValue(prompt: string, start: number, end: number): { value: string; start: number; end: number } | null {
  let valueStart = start;
  let valueEnd = end;
  while (valueStart < valueEnd && /\s/.test(prompt[valueStart]!)) valueStart += 1;
  while (valueEnd > valueStart && /\s/.test(prompt[valueEnd - 1]!)) valueEnd -= 1;

  let value = prompt.slice(valueStart, valueEnd).replace(/^(?:and|then|my)\s+/i, "").trim();
  value = value.replace(/[;,|]+$/, "").trim();
  value = value.replace(/\s+(?:and|then|my)$/i, "").trim();
  value = value.replace(/[;,|]+$/, "").trim();
  if (!value) return null;

  const offset = prompt.slice(valueStart, valueEnd).indexOf(value);
  const exactStart = offset >= 0 ? valueStart + offset : valueStart;
  return { value, start: exactStart, end: exactStart + value.length };
}

function selectTypedValue(
  trimmed: { value: string; start: number; end: number },
  cls: PiiClass | undefined,
  registry: RecognizerRegistry,
): { value: string; start: number; end: number } {
  if (!cls) return trimmed;
  const span = registry
    .analyze(trimmed.value, { threshold: 0.3 })
    .find((candidate) => candidate.cls === cls);
  if (!span) return trimmed;
  return {
    value: span.text,
    start: trimmed.start + span.start,
    end: trimmed.start + span.end,
  };
}

function overlaps(a: Pick<PromptAnswer, "start" | "end">, b: Pick<PiiSpan, "start" | "end">): boolean {
  return a.start < b.end && b.start < a.end;
}

function replaceAnswers(prompt: string, answers: PromptAnswer[]): string {
  return [...answers]
    .sort((a, b) => b.start - a.start)
    .reduce((text, answer) => {
      return `${text.slice(0, answer.start)}[provided locally]${text.slice(answer.end)}`;
    }, prompt);
}

/**
 * Extract only explicit field/value pairs and recognized typed values from a
 * task prompt. The returned raw values remain local; sanitizedIntent is what
 * should be passed to PolicyEngine and the planner.
 */
export function extractPromptAnswers(
  prompt: string,
  fields: PromptField[],
  registry: RecognizerRegistry,
): PromptAnswerExtraction {
  const answers: PromptAnswer[] = [];
  const matches = keyMatches(prompt, fields);

  for (const [index, match] of matches.entries()) {
    if (answers.some((answer) => answer.fieldId === match.field.id)) continue;
    const next = matches[index + 1];
    let end = next?.keyStart ?? prompt.length;
    const cls = inferredClass(match.field);
    // Scalar values must not swallow later, unrecognized clauses or fields
    // absent from this page. Addresses/comments can contain comma-separated text.
    const scalar = cls === "PERSON_NAME" || cls === "EMAIL" || cls === "PHONE_IN" || cls === "DOB" || cls === "PIN_CODE" || /\b(city|town|locality)\b/i.test(match.field.label ?? "");
    const remainder = prompt.slice(match.valueStart, end);
    const boundary = scalar ? /[,;\n|]/.exec(remainder) : /[,;\n|]\s*(?:my\s+)?[\p{L} ]{1,40}\s*(?::|=|\bis\b)/u.exec(remainder);
    if (boundary) end = match.valueStart + boundary.index;
    const trimmed = trimValue(prompt, match.valueStart, end);
    if (!trimmed) continue;
    if (match.alias === "main" && !registry.analyze(trimmed.value, { threshold: 0.3 }).some((span) => span.cls === "EMAIL")) continue;
    const selected = selectTypedValue(trimmed, cls, registry);
    answers.push({
      fieldId: match.field.id,
      value: selected.value,
      start: selected.start,
      end: selected.end,
      ...(cls ? { class: cls } : {}),
    });
  }

  const usedSpans = answers.map((answer) => ({ start: answer.start, end: answer.end }));
  const spans = registry.analyze(prompt, { threshold: 0.3 });
  for (const field of fields) {
    if (answers.some((answer) => answer.fieldId === field.id)) continue;
    const cls = inferredClass(field);
    if (!cls) continue;
    const candidates = spans.filter((candidate) => {
      if (candidate.cls !== cls || usedSpans.some((used) => overlaps(used, candidate))) return false;
      const unresolvedSameClass = fields.filter((candidateField) => {
        return (
          candidateField.id !== field.id &&
          !answers.some((answer) => answer.fieldId === candidateField.id) &&
          inferredClass(candidateField) === cls
        );
      });
      return unresolvedSameClass.length === 0;
    });
    const span = candidates.length === 1 ? candidates[0] : undefined;
    if (!span) continue;
    answers.push({
      fieldId: field.id,
      value: span.text,
      class: cls,
      start: span.start,
      end: span.end,
    });
    usedSpans.push({ start: span.start, end: span.end });
  }

  return { answers, sanitizedIntent: replaceAnswers(prompt, answers) };
}
