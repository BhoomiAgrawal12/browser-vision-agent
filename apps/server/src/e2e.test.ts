import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { defaultRegistry } from "@kavach/core/detectors";
import { EgressGate, type PrivacyReceipt } from "@kavach/core/gate";
import { PolicyEngine, type RawRegion } from "@kavach/core/policy";
import {
  SCP_SCHEMA_ID,
  type SanitizedContextPacket,
} from "@kavach/core/schema";
import { Vault } from "@kavach/core/vault";
import { makeServer } from "./server.js";

/**
 * The Tier 0 loop, end to end, no browser: raw regions exactly as the
 * content script produces them from bench/demo/index.html, through the
 * policy engine, the egress gate and the REAL planner service over HTTP.
 *
 * This is the report's week-2 milestone as a permanent regression test:
 * a complete working loop with no vision models at all.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  server = makeServer({ env: {}, log: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));

/** The demo form as the content script perceives it. */
function demoFormRegions(): RawRegion[] {
  const region = (r: Partial<RawRegion> & Pick<RawRegion, "id" | "role" | "label" | "box">): RawRegion => ({
    state: {},
    source: "dom",
    confidence: 0.98,
    evidence: ["structural:role"],
    explained: true,
    ...r,
  });
  return [
    region({
      id: "e1", role: "text", label: null, box: [24, 90, 400, 20],
      rawText: "Application reference: 784512369014",
    }),
    region({
      id: "e2", role: "image", label: "Applicant photo", box: [28, 140, 96, 120],
      source: "vision", confidence: 0.93, evidence: ["visual:face-detector"],
      visualClass: "FACE",
    }),
    region({
      id: "e3", role: "text", label: null, box: [140, 150, 400, 60],
      rawText:
        "The photograph and identity details below were fetched from your profile. " +
        "Contact the helpdesk on 1800-000-000 if anything is incorrect.",
    }),
    region({
      id: "e4", role: "textbox", label: "Full Name *", box: [28, 300, 300, 38],
      state: { filled: true, required: true }, rawValue: "Ramesh Kumar",
    }),
    region({
      id: "e5", role: "textbox", label: "Aadhaar Number *", box: [360, 300, 300, 38],
      state: { filled: true, required: true }, rawValue: "9999 4105 7058",
    }),
    region({
      id: "e6", role: "textbox", label: "Email Address *", box: [28, 360, 300, 38],
      state: { filled: true, required: true }, rawValue: "ramesh.kumar@gmail.com",
      structuralClass: "EMAIL",
    }),
    region({
      id: "e7", role: "textbox", label: "Mobile Number *", box: [360, 360, 300, 38],
      state: { filled: true, required: true }, rawValue: "+91 98765 43210",
      structuralClass: "PHONE_IN",
    }),
    region({
      id: "e8", role: "textbox", label: "Street Address *", box: [28, 420, 632, 38],
      state: { filled: false, required: true }, rawValue: "",
      structuralClass: "ADDRESS",
    }),
    region({
      id: "e9", role: "textbox", label: "City *", box: [28, 480, 300, 38],
      state: { filled: false, required: true }, rawValue: "",
    }),
    region({
      id: "e10", role: "textbox", label: "PIN Code *", box: [360, 480, 300, 38],
      state: { filled: false, required: true }, rawValue: "",
      structuralClass: "PIN_CODE",
    }),
    region({
      id: "e11", role: "button", label: "Proceed to Verification", box: [28, 560, 220, 42],
      state: { disabled: true }, risk: "state_changing",
    }),
  ];
}

function buildPacket(
  sanitized: ReturnType<PolicyEngine["sanitize"]>,
): SanitizedContextPacket {
  return {
    schema: SCP_SCHEMA_ID,
    packet_id: "01JBQ7E2ETESTPACKET1",
    captured_at_ms: Date.now(),
    policy: { mode: "shield", policy_version: "2026.09.1", invariant_floor: true },
    device: { backend: "none", tier: "T0", viewport: { w: 1280, h: 800, dpr: 2 } },
    origin: { class: "government", tls: true, page_kind: "form", lang: "en-IN" },
    visual: { present: false, regions_redacted: sanitized.summary.regionsRedacted },
    elements: sanitized.elements,
    redaction_legend: sanitized.legend,
    task: { intent: sanitized.intent, history: [] },
    untrusted_text: sanitized.untrustedText,
  };
}

describe("Tier 0 end to end: demo form through policy, gate and live server", () => {
  it("completes the loop with zero raw PII on the wire", async () => {
    const vault = new Vault();
    const registry = defaultRegistry();
    const policy = new PolicyEngine(registry, vault, "2026.09.1");
    const receipts: PrivacyReceipt[] = [];
    let onWire = "";

    const gate = new EgressGate({
      transport: {
        post: async (serialized) => {
          onWire = serialized;
          const res = await fetch(`${base}/plan`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: serialized,
          });
          expect(res.status).toBe(200);
          return res.json();
        },
      },
      registry,
      vault,
      receipts: { append: (r) => void receipts.push(r) },
    });

    const sanitized = policy.sanitize(
      demoFormRegions(),
      "shield",
      "Help me complete this address verification form",
    );
    const packet = buildPacket(sanitized);
    const plan = await gate.send(packet);

    // 1. The plan is useful: it asks the user for the empty required fields.
    const fillTargets = plan.steps
      .filter((s) => s.action === "type")
      .map((s) => s.target_element_id);
    expect(fillTargets).toContain("e8"); // street address
    expect(fillTargets).toContain("e9"); // city
    expect(fillTargets).toContain("e10"); // pin code
    for (const step of plan.steps) {
      expect(step.value?.kind).toBe("user_prompt");
    }

    // 2. Zero raw PII crossed the wire. The strings the user could be hurt
    //    by are simply absent from the payload the server received.
    expect(onWire).not.toContain("999941057058");
    expect(onWire).not.toContain("9999 4105 7058");
    expect(onWire).not.toContain("ramesh.kumar@gmail.com");
    expect(onWire).not.toContain("9876543210");

    // 3. Meaning was preserved: typed placeholders and the legend travel.
    expect(onWire).toContain("PII:AADHAAR#1");
    expect(onWire).toContain("PII:EMAIL#1");
    expect(onWire).toContain("PII:PHONE_IN#1");
    expect(onWire).toContain("PII:FACE#1");
    expect(onWire).toContain("redaction_legend");

    // 4. Precision: the 12 digit application reference is NOT an Aadhaar
    //    (fails Verhoeff) and stayed readable for the server. Likewise the
    //    toll-free helpline is not an Indian mobile (starts with 1) and is
    //    public page content, not the user's PII; masking it would be
    //    over-redaction.
    expect(onWire).toContain("784512369014");
    expect(onWire).toContain("1800-000-000");

    // 5. The vault can rehydrate what the placeholders stand for.
    expect(vault.resolve("PII:AADHAAR#1")).toBe("999941057058");
    expect(vault.resolve("PII:EMAIL#1")).toBe("ramesh.kumar@gmail.com");

    // 6. The receipt records the send faithfully.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!).toMatchObject({
      outcome: "sent",
      verification: { tripwire_passed: true, vault_scan_passed: true },
    });
    expect(receipts[0]!.redactions.by_legend_class["PII:AADHAAR"]).toBe(1);
  });

  it("after the user fills the fields, the plan clicks submit with confirmation", async () => {
    const vault = new Vault();
    const registry = defaultRegistry();
    const policy = new PolicyEngine(registry, vault, "2026.09.1");
    const gate = new EgressGate({
      transport: {
        post: async (serialized) => {
          const res = await fetch(`${base}/plan`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: serialized,
          });
          return res.json();
        },
      },
      registry,
      vault,
      receipts: { append: () => undefined },
    });

    // Second iteration: the user has filled the fields, the button enabled.
    const regions = demoFormRegions().map((r) => {
      if (r.id === "e8") return { ...r, state: { filled: true, required: true }, rawValue: "12 MG Road" };
      if (r.id === "e9") return { ...r, state: { filled: true, required: true }, rawValue: "Ahmedabad" };
      if (r.id === "e10") return { ...r, state: { filled: true, required: true }, rawValue: "380015" };
      if (r.id === "e11") return { ...r, state: { disabled: false } };
      return r;
    });

    const sanitized = policy.sanitize(regions, "shield", "Complete the form");
    const plan = await gate.send(buildPacket(sanitized));

    expect(plan.steps[0]).toMatchObject({
      action: "click",
      target_element_id: "e11",
      requires_confirmation: true,
    });
  });
});
