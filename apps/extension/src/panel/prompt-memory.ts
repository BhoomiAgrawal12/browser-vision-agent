import type { PromptAnswer } from "@kavach/core/prompt";
import type { SanitizedContextPacket } from "@kavach/core/schema";
import type { Vault } from "@kavach/core/vault";

export type PromptMemoryElement = Pick<
  SanitizedContextPacket["elements"][number],
  "id" | "role" | "label" | "evidence"
>;

export interface PromptMemoryPacket {
  elements: PromptMemoryElement[];
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
  promptText?: string,
): string[] {
  const label = (element.label ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  const hint = element.evidence.find((item) => item.startsWith("structural:hint=")) ?? "";
  const peers = packet.elements.filter((candidate) => {
    return candidate.role === element.role && candidate.label === element.label;
  });
  const ordinal = Math.max(0, peers.findIndex((candidate) => candidate.id === element.id));
  const keys = [`field|${element.role}|${hint}|${label}|${ordinal}`];
  if (promptText?.trim()) {
    const prompt = promptText.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
    keys.push(`prompt|${element.role}|${prompt}`);
  }
  return keys;
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
