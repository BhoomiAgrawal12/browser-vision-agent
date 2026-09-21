import { describe, expect, it } from "vitest";
import { defaultRegistry, resolveOverlaps, type PiiSpan } from "./recognizers.js";

const reg = defaultRegistry();

function classes(text: string, threshold?: number): string[] {
  const opts = threshold === undefined ? {} : { threshold };
  return reg.analyze(text, opts).map((s) => s.cls);
}

describe("recognizer registry", () => {
  it("finds a valid Aadhaar in running text", () => {
    const spans = reg.analyze("My Aadhaar number is 9999 4105 7058, please verify.");
    const aadhaar = spans.find((s) => s.cls === "AADHAAR");
    expect(aadhaar).toBeDefined();
    expect(aadhaar!.normalized).toBe("999941057058");
    expect(aadhaar!.confidence).toBeGreaterThanOrEqual(0.99);
    expect(aadhaar!.evidence).toContain("pattern:aadhaar-checksum");
  });

  it("does NOT flag a 12 digit order id as Aadhaar: the precision case", () => {
    const spans = reg.analyze("Your order id 784512369014 has shipped.");
    expect(spans.find((s) => s.cls === "AADHAAR")).toBeUndefined();
  });

  it("finds PAN, GSTIN, IFSC together on a business page", () => {
    const found = classes(
      "Firm PAN ABCPE1234F, GSTIN 27AAPFU0939F1ZV, remit via SBIN0005943.",
    );
    expect(found).toContain("PAN");
    expect(found).toContain("GSTIN");
    expect(found).toContain("IFSC");
  });

  it("finds Luhn-valid cards but not Luhn-invalid digit runs", () => {
    expect(classes("Card: 4111 1111 1111 1111")).toContain("CARD_NUMBER");
    expect(classes("Ref: 4111 1111 1111 1112")).not.toContain("CARD_NUMBER");
  });

  it("distinguishes email from UPI VPA", () => {
    const spans = reg.analyze("Mail ramesh@gmail.com or pay ramesh@okicici today.");
    expect(spans.filter((s) => s.cls === "EMAIL")).toHaveLength(1);
    expect(spans.filter((s) => s.cls === "UPI_VPA")).toHaveLength(1);
  });

  it("finds Indian mobiles with prefixes and separators", () => {
    expect(classes("Call +91 98765 43210 now")).toContain("PHONE_IN");
    expect(classes("Contact: 09876543210")).toContain("PHONE_IN");
  });

  it("six digits alone stay below threshold; with context they surface", () => {
    expect(classes("Batch 380015 processed")).not.toContain("PIN_CODE");
    expect(classes("PIN code: 380015")).toContain("PIN_CODE");
  });

  it("bank account needs context too", () => {
    expect(classes("Tracking 123456789012 in transit")).not.toContain("BANK_ACCOUNT");
    expect(classes("A/C 123456789012 credited")).toContain("BANK_ACCOUNT");
  });

  it("dates surface as DOB only near birth words", () => {
    expect(classes("Valid from 12/05/2020")).not.toContain("DOB");
    expect(classes("DOB: 12/05/1994")).toContain("DOB");
  });

  it("finds INR amounts", () => {
    expect(classes("Balance: ₹48,230.11 available")).toContain("AMOUNT");
    expect(classes("Total Rs. 2,000 due")).toContain("AMOUNT");
  });

  it("finds vehicle registrations including BH series", () => {
    expect(classes("Vehicle GJ 01 AB 1234 registered")).toContain("VEHICLE_REG");
    expect(classes("Plate 22BH1234AB issued")).toContain("VEHICLE_REG");
  });

  it("card beats phone when a digit run matches both: overlap resolution", () => {
    // A 16 digit Luhn-valid card whose interior could look like a mobile.
    const spans = reg.analyze("Use 4111 1111 1111 1111 to pay.");
    expect(spans.filter((s) => s.cls === "CARD_NUMBER")).toHaveLength(1);
    expect(spans.find((s) => s.cls === "PHONE_IN")).toBeUndefined();
  });

  it("a lower threshold surfaces weaker candidates: fortress behaviour", () => {
    expect(classes("Batch 380015 processed", 0.25)).toContain("PIN_CODE");
  });
});

describe("resolveOverlaps", () => {
  const span = (cls: PiiSpan["cls"], start: number, end: number, confidence: number): PiiSpan => ({
    cls,
    start,
    end,
    text: "x".repeat(end - start),
    confidence,
    evidence: [],
  });

  it("keeps the higher-confidence span on overlap", () => {
    const kept = resolveOverlaps([
      span("PHONE_IN", 0, 10, 0.85),
      span("CARD_NUMBER", 0, 16, 0.99),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.cls).toBe("CARD_NUMBER");
  });

  it("keeps non-overlapping spans and sorts by position", () => {
    const kept = resolveOverlaps([
      span("EMAIL", 20, 30, 0.85),
      span("AADHAAR", 0, 12, 0.99),
    ]);
    expect(kept.map((s) => s.cls)).toEqual(["AADHAAR", "EMAIL"]);
  });
});
