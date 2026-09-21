import { describe, expect, it } from "vitest";
import {
  gstinCheckChar,
  luhnValidate,
  verhoeffCheckDigit,
  verhoeffValidate,
} from "./checksums.js";
import {
  validateAadhaar,
  validateBankAccount,
  validateCardNumber,
  validateEmail,
  validateGstin,
  validateIfsc,
  validateIndianMobile,
  validatePan,
  validatePinCode,
  validateUpiVpa,
  validateVehicleReg,
} from "./indian.js";

describe("checksum primitives", () => {
  it("Verhoeff validates the published vector 2363", () => {
    expect(verhoeffValidate("2363")).toBe(true);
    expect(verhoeffValidate("2364")).toBe(false);
    expect(verhoeffCheckDigit("236")).toBe("3");
  });

  it("Verhoeff catches single-digit errors and transpositions", () => {
    const valid = "999941057058"; // UIDAI published test UID
    expect(verhoeffValidate(valid)).toBe(true);
    // every single-digit mutation must fail
    for (let i = 0; i < valid.length; i++) {
      const mutated =
        valid.slice(0, i) + String((Number(valid[i]) + 1) % 10) + valid.slice(i + 1);
      expect(verhoeffValidate(mutated)).toBe(false);
    }
    // adjacent transposition must fail
    expect(verhoeffValidate("999941057085")).toBe(false);
  });

  it("Luhn validates canonical test cards", () => {
    expect(luhnValidate("4111111111111111")).toBe(true);
    expect(luhnValidate("5555555555554444")).toBe(true);
    expect(luhnValidate("4111111111111112")).toBe(false);
  });

  it("GSTIN check char matches the published sample 27AAPFU0939F1ZV", () => {
    expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V");
  });
});

describe("Aadhaar", () => {
  it("accepts a Verhoeff-valid UIDAI test number, with or without spacing", () => {
    expect(validateAadhaar("999941057058")).toMatchObject({
      valid: true,
      strength: "checksum",
      normalized: "999941057058",
    });
    expect(validateAadhaar("9999 4105 7058").valid).toBe(true);
    expect(validateAadhaar("9999-4105-7058").valid).toBe(true);
  });

  it("rejects 12 digit numbers that fail the checksum: the order id case", () => {
    expect(validateAadhaar("784512369014").valid).toBe(false);
    expect(validateAadhaar("999941057059").valid).toBe(false);
  });

  it("rejects numbers starting 0 or 1", () => {
    // structurally excluded by UIDAI even if checksum-consistent
    expect(validateAadhaar("099941057058").valid).toBe(false);
    expect(validateAadhaar("199941057058").valid).toBe(false);
  });
});

describe("PAN", () => {
  it("accepts a well-formed personal PAN", () => {
    expect(validatePan("ABCPE1234F")).toMatchObject({ valid: true, strength: "structure" });
    expect(validatePan("abcpe1234f").normalized).toBe("ABCPE1234F");
  });

  it("rejects an invalid holder-type character in position 4", () => {
    expect(validatePan("ABCXE1234F").valid).toBe(false);
    expect(validatePan("ABCZE1234F").valid).toBe(false);
  });

  it("rejects wrong shapes", () => {
    expect(validatePan("ABCP1234F").valid).toBe(false);
    expect(validatePan("ABCPE12345").valid).toBe(false);
  });
});

describe("GSTIN", () => {
  it("accepts the published sample GSTIN", () => {
    expect(validateGstin("27AAPFU0939F1ZV")).toMatchObject({
      valid: true,
      strength: "checksum",
    });
  });

  it("rejects a wrong check character", () => {
    expect(validateGstin("27AAPFU0939F1ZW").valid).toBe(false);
  });

  it("rejects an out-of-range state code", () => {
    expect(validateGstin("99AAPFU0939F1ZV").valid).toBe(false);
  });

  it("rejects when the embedded PAN is invalid, even with a correct check char", () => {
    // Holder-type char of the embedded PAN is X (not issued); the check char U
    // is recomputed to be correct, so only the PAN rule can reject this one.
    expect(validateGstin("27AAPXU0939F1ZU").valid).toBe(false);
  });
});

describe("IFSC", () => {
  it("accepts real-shaped codes", () => {
    expect(validateIfsc("SBIN0005943")).toMatchObject({ valid: true, strength: "structure" });
    expect(validateIfsc("hdfc0000123").normalized).toBe("HDFC0000123");
  });
  it("rejects a non-zero fifth character", () => {
    expect(validateIfsc("SBIN1005943").valid).toBe(false);
  });
});

describe("UPI VPA", () => {
  it("upgrades known handles to structure strength", () => {
    expect(validateUpiVpa("ramesh.kumar@okicici")).toMatchObject({
      valid: true,
      strength: "structure",
    });
    expect(validateUpiVpa("9876543210@ybl").valid).toBe(true);
  });
  it("keeps unknown handles at format strength", () => {
    expect(validateUpiVpa("someone@unknownpsp")).toMatchObject({
      valid: true,
      strength: "format",
    });
  });
  it("rejects full email addresses (dot in domain)", () => {
    expect(validateUpiVpa("a@gmail.com").valid).toBe(false);
  });
});

describe("card numbers", () => {
  it("accepts Luhn-valid cards with separators", () => {
    expect(validateCardNumber("4111 1111 1111 1111")).toMatchObject({
      valid: true,
      strength: "checksum",
      normalized: "4111111111111111",
    });
  });
  it("rejects Luhn-valid strings outside card prefixes", () => {
    // 9-prefix is not a card network even when Luhn-consistent
    expect(validateCardNumber("9111111111111117").valid).toBe(false);
  });
  it("rejects Luhn failures", () => {
    expect(validateCardNumber("4111111111111112").valid).toBe(false);
  });
});

describe("Indian mobile", () => {
  it("normalizes +91, 91 and 0 prefixes", () => {
    expect(validateIndianMobile("+91 98765 43210").normalized).toBe("9876543210");
    expect(validateIndianMobile("919876543210").normalized).toBe("9876543210");
    expect(validateIndianMobile("09876543210").normalized).toBe("9876543210");
  });
  it("rejects numbers not starting 6-9", () => {
    expect(validateIndianMobile("5876543210").valid).toBe(false);
  });
});

describe("PIN code", () => {
  it("accepts civilian PIN codes", () => {
    expect(validatePinCode("380015").valid).toBe(true);
    expect(validatePinCode("110001").valid).toBe(true);
  });
  it("rejects leading 0 and 9", () => {
    expect(validatePinCode("080015").valid).toBe(false);
    expect(validatePinCode("980015").valid).toBe(false);
  });
});

describe("bank account", () => {
  it("is deliberately weak: format strength only", () => {
    expect(validateBankAccount("123456789012")).toMatchObject({
      valid: true,
      strength: "format",
    });
    expect(validateBankAccount("12345678").valid).toBe(false);
  });
});

describe("vehicle registration", () => {
  it("accepts standard and BH-series plates", () => {
    expect(validateVehicleReg("GJ 01 AB 1234").valid).toBe(true);
    expect(validateVehicleReg("MH12DE1433").valid).toBe(true);
    expect(validateVehicleReg("22BH1234AB").valid).toBe(true);
  });
  it("rejects unknown state codes", () => {
    expect(validateVehicleReg("ZZ01AB1234").valid).toBe(false);
  });
});

describe("email", () => {
  it("accepts and lowercases ordinary addresses", () => {
    expect(validateEmail("Ramesh.Kumar@Gmail.com").normalized).toBe("ramesh.kumar@gmail.com");
  });
  it("rejects VPA-like strings without a TLD", () => {
    expect(validateEmail("ramesh@okicici").valid).toBe(false);
  });
});
