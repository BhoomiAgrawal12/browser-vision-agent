import { describe, expect, it } from "vitest";
import { type PromptAnswer } from "@kavach/core/prompt";
import type { RawRegion } from "@kavach/core/policy";
import { Vault } from "@kavach/core/vault";
import {
  promptAnswerForField,
  lostEnteredTextField,
  enteredTextFieldKey,
  normalizePromptLabel,
  promptMemoryKeys,
  rememberPromptAnswers,
  type EnteredTextField,
  type PromptMemoryElement,
  type PromptMemoryPacket,
} from "./prompt-memory.js";

const packet: PromptMemoryPacket = {
  elements: [
    {
      id: "e1",
      role: "textbox",
      label: "Email address",
      evidence: ["structural:hint=email"],
    },
    {
      id: "e2",
      role: "textbox",
      label: "Phone number",
      evidence: ["structural:hint=phone_in"],
    },
  ],
};

describe("prompt answer memory", () => {
  it("remembers a locally extracted answer using the packet field identity", () => {
    const vault = new Vault();
    const answer: PromptAnswer = {
      fieldId: "e1",
      value: "ramesh@example.test",
      class: "EMAIL",
      start: 0,
      end: 20,
    };

    rememberPromptAnswers(packet, [answer], vault);

    expect(vault.recall(promptMemoryKeys(packet, packet.elements[0]!)[0]!)).toBe("ramesh@example.test");
    expect(vault.recall(promptMemoryKeys(packet, packet.elements[1]!)[0]!)).toBeUndefined();
  });

  it("uses a supplied value for an empty invalid-required field", () => {
    const answer: PromptAnswer = {
      fieldId: "e1",
      value: "user@example.test",
      class: "EMAIL",
      start: 0,
      end: 17,
    };

    expect(promptAnswerForField([answer], "e1", { invalid: false, filled: false })).toBe(
      "user@example.test",
    );
  });

  it("does not reuse a supplied value after a filled value was rejected", () => {
    const answer: PromptAnswer = {
      fieldId: "e1",
      value: "user@example.test",
      class: "EMAIL",
      start: 0,
      end: 17,
    };

    expect(promptAnswerForField([answer], "e1", { invalid: true, filled: true })).toBeUndefined();
  });

  it("keeps a remembered answer when the page changes its required marker or control role", () => {
    const vault = new Vault();
    const first: PromptMemoryElement = { id: "e3", role: "textbox", label: "Name *", evidence: [] };
    const next: PromptMemoryElement = { id: "e8", role: "combobox", label: "Name", evidence: [] };
    const answer: PromptAnswer = { fieldId: "e3", value: "Asha Rao", class: "PERSON_NAME", start: 0, end: 8 };
    rememberPromptAnswers({ elements: [first] }, [answer], vault);
    const nextKey = promptMemoryKeys({ elements: [next] }, next)[1]!;
    expect(vault.recall(nextKey)).toBe("Asha Rao");
    expect(normalizePromptLabel(" Name *: ")).toBe("name");
  });

  it("reports a successfully typed field that the page clears without a validation error", () => {
    const enteredRegion = { id: "e1", role: "textbox" as const, label: "Name *" };
    const regions = [{ id: "e9", role: "textbox" as const, label: "Name", state: { filled: false, invalid: false } }] as unknown as RawRegion[];
    const entered: EnteredTextField[] = [{ ...enteredRegion, key: enteredTextFieldKey([enteredRegion], enteredRegion), attempts: 1 }];
    expect(lostEnteredTextField(entered, regions)).toMatchObject({ attempts: 1, region: { label: "Name", state: { filled: false } } });
    expect(lostEnteredTextField(entered, [{ ...regions[0]!, state: { filled: true } }])).toBeUndefined();
    expect(lostEnteredTextField([{ ...entered[0]!, attempts: 2 }], [{ ...regions[0]!, state: { filled: false, invalid: true } }])).toMatchObject({ attempts: 2 });
  });

  it("does not mix answers for duplicate labels with different roles or missing labels", () => {
    const text: PromptMemoryElement = { id: "e1", role: "textbox", label: "Name", evidence: [] };
    const choice: PromptMemoryElement = { id: "e2", role: "combobox", label: "Name", evidence: [] };
    const duplicate = { elements: [text, choice] };
    const vault = new Vault();
    rememberPromptAnswers(duplicate, [{ fieldId: "e1", value: "Test Person", class: "PERSON_NAME", start: 0, end: 11 }], vault);
    expect(promptMemoryKeys(duplicate, text)[1]).not.toEqual(promptMemoryKeys(duplicate, choice)[1]);
    expect(vault.recall(promptMemoryKeys(duplicate, choice)[1]!)).toBeUndefined();
    const unnamed = { ...text, label: null };
    expect(promptMemoryKeys({ elements: [unnamed] }, unnamed)).not.toEqual(promptMemoryKeys({ elements: [{ ...unnamed, id: "e3" }] }, { ...unnamed, id: "e3" }));
  });

  it("detects delayed invalidation even when the typed value remains filled", () => {
    const field = { id: "e1", role: "textbox" as const, label: "Name" };
    const region = { ...field, state: { filled: true, invalid: true } } as unknown as RawRegion;
    expect(lostEnteredTextField([{ ...field, key: enteredTextFieldKey([field], field), attempts: 2 }], [region])).toMatchObject({ region });
  });
});
