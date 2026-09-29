import { describe, expect, it } from "vitest";
import { fixturePacket } from "@kavach/core/schema/fixtures";
import { buildLocalRedactionAudit } from "./redaction-audit.js";

describe("local redaction audit", () => {
  it("shows dispositions and locations without copying any value text", () => {
    const packet = fixturePacket();
    packet.elements.push({
      id: "e55",
      role: "textbox",
      label: "Safe note",
      box: [10, 20, 100, 30],
      value: { kind: "filled", text: "must-not-appear-in-audit" },
      evidence: ["structural:role=textbox"],
      confidence: 1,
      source: "dom",
    });
    packet.task.intent = "Fill the form [provided locally] and preserve PII:EMAIL#2";

    const audit = buildLocalRedactionAudit(packet, ["e14", "e15", "e16"]);
    const json = JSON.stringify(audit);

    expect(audit.scope).toContain("not sent to the planner");
    expect(audit.elements.find((element) => element.element_id === "e14")).toMatchObject({
      action: "replaced_with_placeholder",
      category: "PII:AADHAAR",
      token: "PII:AADHAAR#1",
      value_in_packet: false,
      box_css_px: [312, 402, 280, 36],
    });
    expect(audit.elements.find((element) => element.element_id === "e45")).toMatchObject({
      action: "masked_fail_closed",
      value_in_packet: false,
    });
    expect(audit.elements.find((element) => element.element_id === "e55")).toMatchObject({
      action: "included_as_filled_text",
      value_in_packet: true,
    });
    expect(audit.task_intent).toMatchObject({
      redaction_tokens: ["PII:EMAIL#2"],
      locally_provided_field_ids: ["e14", "e15", "e16"],
    });
    expect(json).not.toContain("must-not-appear-in-audit");
  });
});
