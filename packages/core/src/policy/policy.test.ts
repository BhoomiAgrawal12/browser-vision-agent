import { beforeEach, describe, expect, it } from "vitest";
import { defaultRegistry } from "../detectors/recognizers.js";
import { Vault } from "../vault/index.js";
import { PolicyEngine, type RawRegion } from "./index.js";

let vault: Vault;
let engine: PolicyEngine;

beforeEach(() => {
  vault = new Vault();
  engine = new PolicyEngine(defaultRegistry(), vault, "test.1");
});

function region(partial: Partial<RawRegion> & { id: string }): RawRegion {
  return {
    role: "textbox",
    label: null,
    box: [0, 0, 100, 30],
    source: "dom",
    confidence: 0.95,
    evidence: ["structural:role"],
    explained: true,
    ...partial,
  };
}

describe("PolicyEngine: invariant floor", () => {
  it("redacts a password field in every mode", () => {
    for (const mode of ["shield", "fortress", "wireframe"] as const) {
      const v = new Vault();
      const e = new PolicyEngine(defaultRegistry(), v, "test.1");
      const out = e.sanitize(
        [
          region({
            id: "e1",
            role: "password",
            structuralClass: "PASSWORD",
            rawValue: "hunter2secret",
          }),
        ],
        mode,
        "log me in",
      );
      const val = out.elements[0]!.value!;
      expect(val.kind).toBe("placeholder");
      expect(JSON.stringify(out.elements)).not.toContain("hunter2secret");
      expect(out.summary.redactedByClass.PASSWORD).toBe(1);
    }
  });

  it("withholds even the exact length of invariant-class values", () => {
    const out = engine.sanitize(
      [
        region({
          id: "e1",
          role: "password",
          structuralClass: "PASSWORD",
          rawValue: "hunter2secret",
        }),
      ],
      "shield",
      "task",
    );
    const val = out.elements[0]!.value!;
    expect(val).not.toHaveProperty("length");
    expect(val).toMatchObject({ length_bucket: "8_to_16" });
  });
});

describe("PolicyEngine: value analysis without structural hints", () => {
  it("detects and redacts an Aadhaar typed into an unmarked field", () => {
    const out = engine.sanitize(
      [region({ id: "e1", rawValue: "9999 4105 7058" })],
      "shield",
      "task",
    );
    const val = out.elements[0]!.value!;
    expect(val).toMatchObject({ kind: "placeholder", token: "PII:AADHAAR#1" });
    expect(out.legend["PII:AADHAAR"]).toMatchObject({ recoverable_by_client: true });
    expect(JSON.stringify(out)).not.toContain("4105");
  });

  it("leaves a harmless unclassified value visible in shield mode", () => {
    const out = engine.sanitize(
      [region({ id: "e1", rawValue: "2 packets of rice" })],
      "shield",
      "task",
    );
    expect(out.elements[0]!.value).toMatchObject({
      kind: "filled",
      text: "2 packets of rice",
    });
  });

  it("fortress mode refuses to transmit unclassified values", () => {
    const out = engine.sanitize(
      [region({ id: "e1", rawValue: "2 packets of rice" })],
      "fortress",
      "task",
    );
    expect(out.elements[0]!.value).toEqual({ kind: "redacted" });
  });

  it("shield keeps medium severity visible, fortress redacts it", () => {
    // A PIN code with context: medium severity.
    const shield = engine.sanitize(
      [region({ id: "e1", label: "PIN code", rawValue: "380015" })],
      "shield",
      "task",
    );
    expect(shield.elements[0]!.value!.kind).toBe("filled");

    const v2 = new Vault();
    const e2 = new PolicyEngine(defaultRegistry(), v2, "test.1");
    const fortress = e2.sanitize(
      [region({ id: "e1", label: "PIN code", rawValue: "380015" })],
      "fortress",
      "task",
    );
    expect(fortress.elements[0]!.value!.kind).toBe("placeholder");
  });
});

describe("PolicyEngine: label as context", () => {
  it("the field label boosts weak shapes: account number case", () => {
    // Bare digits: no context, stays filled in shield.
    const bare = engine.sanitize(
      [region({ id: "e1", rawValue: "123456789012" })],
      "shield",
      "task",
    );
    expect(bare.elements[0]!.value!.kind).toBe("filled");

    // Same digits under an "Account number" label: redacted.
    const v2 = new Vault();
    const e2 = new PolicyEngine(defaultRegistry(), v2, "test.1");
    const labelled = e2.sanitize(
      [region({ id: "e1", label: "Account number", rawValue: "123456789012" })],
      "shield",
      "task",
    );
    expect(labelled.elements[0]!.value).toMatchObject({
      kind: "placeholder",
      token: "PII:BANK_ACCOUNT#1",
    });
  });
});

describe("PolicyEngine: fail closed on unexplained regions", () => {
  it("masks vision-only regions with no DOM explanation", () => {
    const out = engine.sanitize(
      [
        region({
          id: "e9",
          role: "canvas",
          source: "vision",
          explained: false,
          confidence: 0.5,
          evidence: [],
        }),
      ],
      "shield",
      "task",
    );
    expect(out.elements[0]!.value).toEqual({ kind: "unexplained_masked" });
    expect(out.elements[0]!.evidence).toContain("fusion:no-dom-node");
    expect(out.summary.unexplainedMasked).toBe(1);
  });
});

describe("PolicyEngine: visual PII", () => {
  it("redacts a face with a stable token and a non-recoverable legend entry", () => {
    const out = engine.sanitize(
      [
        region({
          id: "e4",
          role: "image",
          source: "vision",
          explained: true,
          visualClass: "FACE",
          evidence: ["visual:face-detector"],
        }),
      ],
      "shield",
      "task",
    );
    expect(out.elements[0]!.value).toMatchObject({
      kind: "redacted",
      token: "PII:FACE#1",
    });
    expect(out.legend["PII:FACE"]).toMatchObject({ recoverable_by_client: false });
  });
});

describe("PolicyEngine: text channels", () => {
  it("sanitizes PII out of free text into untrusted_text", () => {
    const out = engine.sanitize(
      [
        region({
          id: "e7",
          role: "text",
          rawText: "Contact Ramesh at ramesh@gmail.com or 9876543210.",
        }),
      ],
      "shield",
      "task",
    );
    const ut = out.untrustedText[0]!;
    expect(ut.src).toBe("e7");
    expect(ut.text).not.toContain("ramesh@gmail.com");
    expect(ut.text).not.toContain("9876543210");
    expect(ut.text).toContain("PII:EMAIL#1");
    expect(ut.text).toContain("PII:PHONE_IN#1");
  });

  it("sanitizes PII out of element labels", () => {
    const out = engine.sanitize(
      [region({ id: "e1", label: "Welcome back, ramesh@gmail.com" })],
      "shield",
      "task",
    );
    expect(out.elements[0]!.label).toContain("PII:EMAIL#1");
    expect(out.elements[0]!.label).not.toContain("ramesh@gmail.com");
  });

  it("sanitizes PII out of the user's task intent", () => {
    const out = engine.sanitize(
      [],
      "shield",
      "Pay 2000 to my friend at ramesh@okicici please",
    );
    expect(out.intent).not.toContain("ramesh@okicici");
    expect(out.intent).toContain("PII:UPI_VPA#1");
  });

  it("the same value gets the same token across channels", () => {
    const out = engine.sanitize(
      [
        region({ id: "e1", rawValue: "ramesh@gmail.com" }),
        region({ id: "e2", role: "text", rawText: "Send updates to ramesh@gmail.com" }),
      ],
      "shield",
      "task",
    );
    const tokenInValue = (out.elements[0]!.value as { token: string }).token;
    expect(tokenInValue).toBe("PII:EMAIL#1");
    expect(out.untrustedText[0]!.text).toContain("PII:EMAIL#1");
  });
});

describe("PolicyEngine: amounts", () => {
  it("replaces amounts with magnitude buckets, never exact figures", () => {
    const out = engine.sanitize(
      [region({ id: "e1", role: "text", rawValue: "₹48,230.11" })],
      "shield",
      "task",
    );
    const val = out.elements[0]!.value!;
    expect(val).toMatchObject({
      kind: "placeholder",
      magnitude_bucket: "1e4_to_1e5",
      currency: "INR",
    });
    expect(val).not.toHaveProperty("length");
    expect(JSON.stringify(out)).not.toContain("48,230");
  });
});

describe("PolicyEngine: vault overflow", () => {
  it("degrades to tokenless redaction when the vault is full", () => {
    const tiny = new Vault({ maxEntries: 1 });
    const e = new PolicyEngine(defaultRegistry(), tiny, "test.1");
    const out = e.sanitize(
      [
        region({ id: "e1", rawValue: "a@x.com" }),
        region({ id: "e2", rawValue: "b@x.com" }),
      ],
      "shield",
      "task",
    );
    expect(out.elements[0]!.value!.kind).toBe("placeholder");
    expect(out.elements[1]!.value!.kind).toBe("redacted");
    expect(out.summary.vaultOverflows).toBe(1);
    expect(JSON.stringify(out)).not.toContain("b@x.com");
  });
});
