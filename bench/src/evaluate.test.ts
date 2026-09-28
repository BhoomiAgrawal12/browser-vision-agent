import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";

/**
 * The benchmark as a regression gate. These thresholds are the currently
 * measured performance of the structure tier; any change that degrades
 * them fails CI. Raise them when new tiers land, never lower them
 * quietly.
 */

describe("RedactBench regression gates: shield", () => {
  const result = evaluate("shield");

  it("zero invariant-class leaks: credentials and government identity never slip", () => {
    expect(result.invariantLeaks).toHaveLength(0);
  });

  it("zero false alarms on declared negatives: precision is real", () => {
    expect(result.overall.falseAlarms).toHaveLength(0);
    expect(result.overall.micro.precision).toBe(1);
  });

  it("micro recall at or above the measured 89% (adversarial corpus)", () => {
    expect(result.overall.micro.recall).toBeGreaterThanOrEqual(0.89);
  });

  it("checksum-validated classes are perfect", () => {
    for (const cls of ["AADHAAR", "PAN", "GSTIN", "CARD_NUMBER", "IFSC"]) {
      const m = result.overall.perClass.find((c) => c.cls === cls);
      expect(m, cls).toBeDefined();
      expect(m!.precision, cls).toBe(1);
      expect(m!.recall, cls).toBe(1);
    }
  });

  it("the known gaps are exactly the documented ones", () => {
    const missedClasses = result.overall.leaks.map((l) => l.cls).sort();
    // ADDRESS: free text awaits the NER tier. EMAIL: the obfuscated
    // [at]/[dot] variant awaits a normalization pass. DOB: context sitting
    // in a separate table cell is below the shield threshold (fortress
    // catches it). Nothing else may join this list.
    expect(missedClasses).toEqual(["ADDRESS", "DOB", "EMAIL"]);
  });
});

describe("RedactBench regression gates: fortress", () => {
  const result = evaluate("fortress");

  it("zero invariant-class leaks", () => {
    expect(result.invariantLeaks).toHaveLength(0);
  });

  it("recall improves over shield (stricter mode catches more)", () => {
    const shield = evaluate("shield");
    expect(result.overall.micro.recall).toBeGreaterThanOrEqual(
      shield.overall.micro.recall,
    );
  });

  it("over-redaction stays bounded: at most one false alarm on this corpus", () => {
    expect(result.overall.falseAlarms.length).toBeLessThanOrEqual(1);
  });
});
