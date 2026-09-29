import { describe, expect, it } from "vitest";
import { type PromptAnswer } from "@kavach/core/prompt";
import { Vault } from "@kavach/core/vault";
import {
  promptAnswerForField,
  promptMemoryKeys,
  rememberPromptAnswers,
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
});
