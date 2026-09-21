import type { SanitizedContextPacket } from "./scp.js";
import { SCP_SCHEMA_ID } from "./scp.js";

/**
 * A canonical, valid Sanitized Context Packet used across tests: a
 * government form with a filled Aadhaar placeholder, an empty pincode
 * field, a disabled state-changing submit button, a redacted face image
 * and a fail-closed masked canvas region.
 */
export function fixturePacket(): SanitizedContextPacket {
  return {
    schema: SCP_SCHEMA_ID,
    packet_id: "01JBQ7TESTPACKET0001",
    captured_at_ms: 1758200000000,
    policy: { mode: "shield", policy_version: "2026.09.1", invariant_floor: true },
    device: {
      backend: "webgpu",
      tier: "T2",
      viewport: { w: 1512, h: 856, dpr: 2 },
    },
    origin: { class: "government", tls: true, page_kind: "form_multi_step", lang: "en-IN" },
    visual: {
      present: true,
      format: "image/webp",
      w: 1024,
      h: 580,
      sha256: "9f2c".padEnd(64, "0"),
      redaction_overlay: "flat_fill",
      regions_redacted: 2,
    },
    elements: [
      {
        id: "e14",
        role: "textbox",
        label: "Aadhaar Number",
        box: [312, 402, 280, 36],
        state: { filled: true, disabled: false, required: true },
        value: {
          kind: "placeholder",
          token: "PII:AADHAAR#1",
          length: 12,
          format_valid: true,
          masked: true,
        },
        evidence: ["structural:aria-label", "pattern:aadhaar-verhoeff"],
        confidence: 0.98,
        source: "dom+vision",
      },
      {
        id: "e15",
        role: "textbox",
        label: "Pincode",
        box: [312, 452, 140, 36],
        state: { filled: false, required: true },
        value: { kind: "empty" },
        evidence: ["structural:autocomplete=postal-code"],
        confidence: 0.99,
        source: "dom",
      },
      {
        id: "e31",
        role: "button",
        label: "Proceed to Verification",
        box: [620, 700, 210, 44],
        state: { disabled: true },
        evidence: ["structural:role"],
        confidence: 1.0,
        source: "dom",
        risk: "state_changing",
      },
      {
        id: "e44",
        role: "image",
        label: null,
        box: [900, 120, 120, 150],
        value: { kind: "redacted", token: "PII:FACE#1" },
        evidence: ["visual:face-detector"],
        confidence: 0.93,
        source: "vision",
      },
      {
        id: "e45",
        role: "canvas",
        label: null,
        box: [100, 600, 400, 200],
        value: { kind: "unexplained_masked" },
        evidence: ["fusion:no-dom-node"],
        confidence: 0.5,
        source: "vision",
        note: "masked by fail-closed rule",
      },
    ],
    redaction_legend: {
      "PII:AADHAAR": {
        shape: "a 12 digit Indian government identity number",
        recoverable_by_client: true,
      },
      "PII:FACE": { shape: "a human face image", recoverable_by_client: false },
    },
    task: {
      intent: "Complete the address verification step of this application form",
      history: [
        { step: 1, action: "click", element_label: "Start Application", result: "ok" },
        { step: 2, action: "type", element_label: "Full Name", result: "ok" },
      ],
    },
    untrusted_text: [{ src: "e15", text: "Please enter your details below." }],
  };
}
