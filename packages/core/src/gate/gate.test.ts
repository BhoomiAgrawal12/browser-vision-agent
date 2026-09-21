import { beforeEach, describe, expect, it } from "vitest";
import { defaultRegistry } from "../detectors/recognizers.js";
import { fixturePacket } from "../schema/fixtures.js";
import { PLAN_SCHEMA_ID, type ActionPlan } from "../schema/plan.js";
import { Vault } from "../vault/index.js";
import {
  EgressBlocked,
  EgressGate,
  EgressRateLimited,
  type PrivacyReceipt,
  type Transport,
} from "./index.js";

function goodPlan(): ActionPlan {
  return {
    schema: PLAN_SCHEMA_ID,
    packet_id: "01JBQ7TESTPACKET0001",
    reasoning_summary: "Fill the pincode, then submit.",
    steps: [
      {
        action: "type",
        target_element_id: "e15",
        value: { kind: "user_prompt", prompt_text: "What is your PIN code?" },
        requires_confirmation: false,
      },
    ],
    needs_more_context: false,
    confidence: 0.9,
  };
}

class FakeTransport implements Transport {
  calls: string[] = [];
  response: unknown = goodPlan();
  async post(serialized: string): Promise<unknown> {
    this.calls.push(serialized);
    return this.response;
  }
}

let transport: FakeTransport;
let receipts: PrivacyReceipt[];
let vault: Vault;
let gate: EgressGate;
let clock: number;

beforeEach(() => {
  transport = new FakeTransport();
  receipts = [];
  vault = new Vault();
  clock = 1_000_000;
  gate = new EgressGate({
    transport,
    registry: defaultRegistry(),
    vault,
    receipts: { append: (r) => void receipts.push(r) },
    rateLimit: { max: 3, windowMs: 60_000 },
    now: () => clock,
    makeId: () => "rcpt_test",
  });
});

describe("EgressGate: happy path", () => {
  it("sends a clean packet and returns the guarded plan", async () => {
    const plan = await gate.send(fixturePacket());
    expect(plan.steps).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!).toMatchObject({
      outcome: "sent",
      packet_id: "01JBQ7TESTPACKET0001",
      verification: { tripwire_passed: true, vault_scan_passed: true },
    });
    expect(receipts[0]!.sent.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("EgressGate: the tripwire", () => {
  it("blocks a packet with raw Aadhaar smuggled in untrusted text", async () => {
    const p = fixturePacket();
    p.untrusted_text.push({ src: "e15", text: "verify 9999 4105 7058 please" });
    await expect(gate.send(p)).rejects.toThrow(EgressBlocked);
    expect(transport.calls).toHaveLength(0);
    expect(receipts[0]!).toMatchObject({
      outcome: "blocked",
      verification: { tripwire_passed: false },
    });
    expect(receipts[0]!.blocked_reasons!.join()).toContain("AADHAAR");
  });

  it("blocks a packet leaking an email through a label", async () => {
    const p = fixturePacket();
    p.elements[1]!.label = "Send to ramesh@gmail.com";
    await expect(gate.send(p)).rejects.toThrow(EgressBlocked);
    expect(transport.calls).toHaveLength(0);
  });

  it("blocks when a vault value appears verbatim in the payload", async () => {
    vault.mint("PERSON_NAME", "Ramesh Kumar");
    const p = fixturePacket();
    p.task.intent = "Say hello to Ramesh Kumar for me";
    await expect(gate.send(p)).rejects.toThrow(EgressBlocked);
    expect(receipts[0]!.verification.vault_scan_passed).toBe(false);
    // The receipt names the token, never the value.
    expect(JSON.stringify(receipts[0])).not.toContain("Ramesh Kumar");
    expect(receipts[0]!.blocked_reasons!.join()).toContain("PII:PERSON_NAME#1");
  });

  it("rejects a malformed packet before anything else", async () => {
    const p = fixturePacket() as Record<string, unknown>;
    p["cookies"] = "session=abc";
    await expect(gate.send(p)).rejects.toThrow();
    expect(transport.calls).toHaveLength(0);
    expect(receipts).toHaveLength(0);
  });
});

describe("EgressGate: visual payload", () => {
  async function packetWithImage(): Promise<ReturnType<typeof fixturePacket>> {
    const p = fixturePacket();
    // Base64 deliberately containing a digit run that WOULD trip the card
    // detector if the gate scanned image bytes as text.
    p.visual.data_b64 = "AAAA4111111111111111AAAA";
    const { sha256Hex } = await import("./index.js");
    p.visual.sha256 = await sha256Hex(p.visual.data_b64);
    return p;
  }

  it("sends an image packet without tripping on base64 digit runs", async () => {
    const plan = await gate.send(await packetWithImage());
    expect(plan.steps).toHaveLength(1);
    expect(receipts[0]!.verification.tripwire_passed).toBe(true);
  });

  it("blocks when the declared sha256 does not match the image bytes", async () => {
    const p = await packetWithImage();
    p.visual.sha256 = "0".repeat(64);
    await expect(gate.send(p)).rejects.toThrow(/sha256 does not match/);
    expect(transport.calls).toHaveLength(0);
  });

  it("still catches raw PII outside the image field of an image packet", async () => {
    const p = await packetWithImage();
    p.untrusted_text.push({ src: "e15", text: "aadhaar 9999 4105 7058" });
    await expect(gate.send(p)).rejects.toThrow(EgressBlocked);
  });

  it("schema rejects image data on a non-present visual", async () => {
    const p = fixturePacket();
    p.policy.mode = "wireframe";
    p.visual = { present: false, regions_redacted: 0, data_b64: "AAAA" };
    await expect(gate.send(p)).rejects.toThrow();
    expect(transport.calls).toHaveLength(0);
  });
});

describe("EgressGate: caps", () => {
  it("blocks oversized packets", async () => {
    const small = new EgressGate({
      transport,
      registry: defaultRegistry(),
      vault,
      receipts: { append: (r) => void receipts.push(r) },
      maxPacketBytes: 500,
      now: () => clock,
      makeId: () => "rcpt_test",
    });
    await expect(small.send(fixturePacket())).rejects.toThrow(EgressBlocked);
    expect(transport.calls).toHaveLength(0);
  });

  it("rate limits within the window and recovers after it", async () => {
    await gate.send(fixturePacket());
    await gate.send(fixturePacket());
    await gate.send(fixturePacket());
    await expect(gate.send(fixturePacket())).rejects.toThrow(EgressRateLimited);
    clock += 61_000;
    await expect(gate.send(fixturePacket())).resolves.toBeDefined();
  });
});

describe("EgressGate: response guarding", () => {
  it("rejects a plan naming an element not in the packet", async () => {
    const bad = goodPlan();
    bad.steps[0]!.target_element_id = "e999";
    transport.response = bad;
    await expect(gate.send(fixturePacket())).rejects.toThrow(/e999/);
  });

  it("rejects a plan with an unknown verb at the schema level", async () => {
    const bad = goodPlan() as unknown as { steps: { action: string }[] };
    bad.steps[0]!.action = "execute_shell";
    transport.response = bad;
    await expect(gate.send(fixturePacket())).rejects.toThrow();
  });

  it("rejects a state-changing click without confirmation", async () => {
    const bad = goodPlan();
    bad.steps = [
      { action: "click", target_element_id: "e31", requires_confirmation: false },
    ];
    transport.response = bad;
    await expect(gate.send(fixturePacket())).rejects.toThrow(/state_changing/);
  });

  it("rejects a response that is not a plan at all", async () => {
    transport.response = { hello: "world" };
    await expect(gate.send(fixturePacket())).rejects.toThrow();
  });
});
