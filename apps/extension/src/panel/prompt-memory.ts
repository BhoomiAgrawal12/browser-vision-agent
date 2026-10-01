import type { PromptAnswer } from "@kavach/core/prompt";
import type { RawRegion } from "@kavach/core/policy";
import type { SanitizedContextPacket } from "@kavach/core/schema";
import type { Vault } from "@kavach/core/vault";

export type PromptMemoryElement = Pick<
  SanitizedContextPacket["elements"][number],
  "id" | "role" | "label" | "evidence"
>;

export interface PromptMemoryPacket {
  elements: PromptMemoryElement[];
}

export interface EnteredTextField extends Pick<PromptMemoryElement, "id" | "role" | "label"> {
  key: string;
  attempts: number;
}

export function normalizePromptLabel(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\*/g, "").replace(/\s+/g, " ").replace(/\s*[:：]\s*$/, "").trim();
}

/** Detect a value the page cleared after the executor successfully set it. */
export function enteredTextFieldKey(regions: Pick<RawRegion, "id" | "label">[], field: Pick<RawRegion, "id" | "label">): string {
  const normalized = normalizePromptLabel(field.label);
  const peers = regions.filter((region) => normalizePromptLabel(region.label) === normalized);
  const ordinal = Math.max(0, peers.findIndex((region) => region.id === field.id));
  return `${normalized}\u0000${ordinal}`;
}

export function lostEnteredTextField(entered: EnteredTextField[], current: RawRegion[]): { region: RawRegion; attempts: number } | undefined {
  for (const field of entered) {
    const normalized = normalizePromptLabel(field.label);
    if (!normalized) continue;
    const exact = current.find((region) => region.id === field.id && normalizePromptLabel(region.label) === normalized);
    const matches = current.filter((region) => normalizePromptLabel(region.label) === normalized);
    const ordinal = Number(field.key.split("\u0000")[1] ?? 0);
    const region = exact ?? matches[ordinal];
    if (!region || region.state?.disabled || region.state?.readonly) continue;
    if (region.state?.filled === true && region.state?.invalid !== true) continue;
    if (region.state?.invalid === true && field.attempts < 2) continue;
    return { region, attempts: field.attempts };
  }
  return undefined;
}

export function promptAnswerForField(
  answers: PromptAnswer[],
  fieldId: string,
  state?: { invalid?: boolean | undefined; filled?: boolean | undefined },
): string | undefined {
  if (state?.invalid === true && state.filled === true) return undefined;
  return answers.find((answer) => answer.fieldId === fieldId)?.value;
}

export function promptMemoryKeys(
  packet: PromptMemoryPacket,
  element: PromptMemoryElement,
): string[] {
  const label = normalizePromptLabel(element.label);
  const hint = element.evidence.find((item) => item.startsWith("structural:hint=")) ?? "";
  const file = element.evidence.includes("structural:input_type=file");
  const peers = packet.elements.filter((candidate) => {
    return (candidate.evidence.includes("structural:input_type=file") === file) &&
      (file || ["textbox", "password", "combobox", "listbox"].includes(candidate.role)) &&
      normalizePromptLabel(candidate.label) === label;
  });
  const ordinal = Math.max(0, peers.findIndex((candidate) => candidate.id === element.id));
  // Never share a generic planner prompt key between different questions.
  // Unlabelled controls cannot safely reuse an answer after their identity changes.
  const identity = label ? `${file ? "file" : "answer"}|${label}|${ordinal}` : `id|${element.id}`;
  return [`field|${element.role}|${hint}|${identity}`, `field-label|${identity}`];
}

/** Seed only client-side memory; these values are never added to the packet. */
export function rememberPromptAnswers(
  packet: PromptMemoryPacket,
  answers: PromptAnswer[],
  vault: Vault,
): void {
  for (const answer of answers) {
    const element = packet.elements.find((candidate) => candidate.id === answer.fieldId);
    if (!element) continue;
    // Choice labels are already public page text (e.g. "Email"). Treating
    // them as secrets makes the leak scan block unrelated field labels.
    if (element.role === "combobox" || element.role === "listbox") continue;
    for (const key of promptMemoryKeys(packet, element)) {
      // A human correction must take precedence over the original task text.
      if (vault.recall(key) === undefined) vault.remember(key, answer.value);
    }
  }
}
