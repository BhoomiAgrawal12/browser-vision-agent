import { describe, expect, it } from "vitest";
import { fixturePacket } from "./fixtures.js";
import { SanitizedContextPacket, legendKey } from "./scp.js";
import {
  ActionPlan,
  PLAN_SCHEMA_ID,
  guardPlanAgainstPacket,
  type ActionPlan as Plan,
} from "./plan.js";
import { formatToken, parseToken, isInvariantClass } from "./pii.js";

describe("SanitizedContextPacket schema", () => {
  it("accepts the canonical fixture", () => {
    const result = SanitizedContextPacket.safeParse(fixturePacket());
    expect(result.success).toBe(true);
  });

  it("rejects a wireframe packet that carries pixels", () => {
    const p = fixturePacket();
    p.policy.mode = "wireframe";
    const result = SanitizedContextPacket.safeParse(p);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("wireframe mode forbids");
  });

  it("accepts a wireframe packet with no pixels", () => {
    const p = fixturePacket();
    p.policy.mode = "wireframe";
    p.visual = { present: false, regions_redacted: 0 };
    expect(SanitizedContextPacket.safeParse(p).success).toBe(true);
  });

  it("rejects a present visual without a hash", () => {
    const p = fixturePacket();
    delete p.visual.sha256;
    expect(SanitizedContextPacket.safeParse(p).success).toBe(false);
  });

  it("rejects a placeholder whose class is missing from the legend", () => {
    const p = fixturePacket();
    p.elements[0]!.value = { kind: "placeholder", token: "PII:PAN#1" };
    const result = SanitizedContextPacket.safeParse(p);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("PII:PAN");
  });

  it("rejects unknown top-level fields (strict wire format)", () => {
    const p = fixturePacket() as Record<string, unknown>;
    p["cookies"] = "session=abc";
    expect(SanitizedContextPacket.safeParse(p).success).toBe(false);
  });

  it("rejects a real hostname sneaking into origin (enum only)", () => {
    const p = fixturePacket();
    (p.origin as { class: string }).class = "netbanking.example.com";
    expect(SanitizedContextPacket.safeParse(p).success).toBe(false);
  });

  it("rejects invariant_floor false: the floor is not negotiable", () => {
    const p = fixturePacket();
    (p.policy as { invariant_floor: boolean }).invariant_floor = false;
    expect(SanitizedContextPacket.safeParse(p).success).toBe(false);
  });
});

describe("placeholder tokens", () => {
  it("round-trips format and parse", () => {
    const t = formatToken("AADHAAR", 3);
    expect(t).toBe("PII:AADHAAR#3");
    expect(parseToken(t)).toEqual({ cls: "AADHAAR", ordinal: 3 });
  });

  it("rejects malformed and unknown-class tokens", () => {
    expect(parseToken("AADHAAR#3")).toBeNull();
    expect(parseToken("PII:NOTACLASS#1")).toBeNull();
    expect(parseToken("PII:AADHAAR#x")).toBeNull();
  });

  it("marks credential and identity classes as invariant", () => {
    expect(isInvariantClass("PASSWORD")).toBe(true);
    expect(isInvariantClass("AADHAAR")).toBe(true);
    expect(isInvariantClass("FACE")).toBe(true);
    expect(isInvariantClass("PIN_CODE")).toBe(false);
  });

  it("builds legend keys", () => {
    expect(legendKey("AADHAAR")).toBe("PII:AADHAAR");
  });
});

function validPlan(): Plan {
  return {
    schema: PLAN_SCHEMA_ID,
    packet_id: "01JBQ7TESTPACKET0001",
    reasoning_summary: "Pincode is empty and required; fill it, then submit.",
    steps: [
      {
        action: "type",
        target_element_id: "e15",
        value: { kind: "user_prompt", prompt_text: "What is your PIN code?" },
        requires_confirmation: false,
      },
      {
        action: "click",
        target_element_id: "e31",
        requires_confirmation: true,
        confirmation_reason: "This submits your application to the portal.",
      },
    ],
    needs_more_context: false,
    confidence: 0.86,
  };
}

describe("ActionPlan schema and guard", () => {
  it("accepts a valid plan against the fixture packet", () => {
    const plan = ActionPlan.parse(validPlan());
    expect(guardPlanAgainstPacket(plan, fixturePacket())).toEqual([]);
  });

  it("rejects a step that types without a value", () => {
    const p = validPlan();
    delete p.steps[0]!.value;
    expect(ActionPlan.safeParse(p).success).toBe(false);
  });

  it("rejects raw coordinates: there is no field for them", () => {
    const p = validPlan() as unknown as Record<string, unknown>;
    (p["steps"] as Record<string, unknown>[])[0]!["x"] = 400;
    expect(ActionPlan.safeParse(p).success).toBe(false);
  });

  it("guard rejects an element id not present in the packet", () => {
    const plan = ActionPlan.parse(validPlan());
    plan.steps[0]!.target_element_id = "e999";
    const issues = guardPlanAgainstPacket(plan, fixturePacket());
    expect(issues.some((i) => i.problem.includes("e999"))).toBe(true);
  });

  it("guard rejects a state-changing click without confirmation", () => {
    const plan = ActionPlan.parse(validPlan());
    plan.steps[1]!.requires_confirmation = false;
    const issues = guardPlanAgainstPacket(plan, fixturePacket());
    expect(issues.some((i) => i.problem.includes("state_changing"))).toBe(true);
  });

  it("guard rejects typing into a button", () => {
    const plan = ActionPlan.parse(validPlan());
    plan.steps[0]!.target_element_id = "e31";
    plan.steps[0]!.requires_confirmation = true;
    const issues = guardPlanAgainstPacket(plan, fixturePacket());
    expect(issues.some((i) => i.problem.includes('type into role "button"'))).toBe(true);
  });

  it("guard rejects a plan answering a different packet", () => {
    const plan = ActionPlan.parse(validPlan());
    plan.packet_id = "01JBQ7DIFFERENTPACKET";
    const issues = guardPlanAgainstPacket(plan, fixturePacket());
    expect(issues.some((i) => i.problem.includes("different packet"))).toBe(true);
  });

  it("guard rejects placeholder values on non-type actions", () => {
    const plan = ActionPlan.parse(validPlan());
    plan.steps[1] = {
      action: "click",
      target_element_id: "e31",
      value: { kind: "placeholder", token: "PII:AADHAAR#1" },
      requires_confirmation: true,
    };
    const issues = guardPlanAgainstPacket(plan, fixturePacket());
    expect(issues.some((i) => i.problem.includes("placeholder values"))).toBe(true);
  });

  it("guard binds a placeholder to the element that owns it", () => {
    const plan = ActionPlan.parse(validPlan());
    plan.steps[0]!.value = { kind: "placeholder", token: "PII:AADHAAR#1" };
    const issues = guardPlanAgainstPacket(plan, fixturePacket());
    expect(issues.some((i) => i.problem.includes("belongs to element e14"))).toBe(true);
  });

  it("guard rejects guessed, missing, and non-recoverable placeholders", () => {
    const missing = ActionPlan.parse(validPlan());
    missing.steps[0]!.value = { kind: "placeholder", token: "PII:AADHAAR#99" };
    expect(guardPlanAgainstPacket(missing, fixturePacket()).some((i) => i.problem.includes("not present"))).toBe(true);

    const unavailable = ActionPlan.parse(validPlan());
    unavailable.steps[0]!.value = { kind: "placeholder", token: "PII:FACE#1" };
    expect(guardPlanAgainstPacket(unavailable, fixturePacket()).some((i) => i.problem.includes("not recoverable"))).toBe(true);
  });
});
