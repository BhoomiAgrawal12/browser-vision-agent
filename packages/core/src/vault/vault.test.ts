import { describe, expect, it } from "vitest";
import { Vault, VaultFullError } from "./index.js";

describe("Vault", () => {
  it("mints stable tokens: same value, same token", () => {
    const v = new Vault();
    const t1 = v.mint("AADHAAR", "999941057058");
    const t2 = v.mint("AADHAAR", "999941057058");
    expect(t1).toBe("PII:AADHAAR#1");
    expect(t2).toBe(t1);
    expect(v.size).toBe(1);
  });

  it("assigns ordinals per class in discovery order", () => {
    const v = new Vault();
    expect(v.mint("EMAIL", "a@x.com")).toBe("PII:EMAIL#1");
    expect(v.mint("EMAIL", "b@x.com")).toBe("PII:EMAIL#2");
    expect(v.mint("PHONE_IN", "9876543210")).toBe("PII:PHONE_IN#1");
  });

  it("resolves tokens back to values", () => {
    const v = new Vault();
    const t = v.mint("PAN", "ABCPE1234F");
    expect(v.resolve(t)).toBe("ABCPE1234F");
    expect(v.resolve("PII:PAN#99")).toBeUndefined();
  });

  it("throws when the cap is reached instead of dropping silently", () => {
    const v = new Vault({ maxEntries: 2 });
    v.mint("EMAIL", "a@x.com");
    v.mint("EMAIL", "b@x.com");
    expect(() => v.mint("EMAIL", "c@x.com")).toThrow(VaultFullError);
    // re-minting an existing value still works at cap
    expect(v.mint("EMAIL", "a@x.com")).toBe("PII:EMAIL#1");
  });

  it("expires entries after the TTL", () => {
    let clock = 1000;
    const v = new Vault({ ttlMs: 500, now: () => clock });
    const t = v.mint("EMAIL", "a@x.com");
    expect(v.resolve(t)).toBe("a@x.com");
    clock += 501;
    expect(v.resolve(t)).toBeUndefined();
    expect(v.size).toBe(0);
  });

  it("findLeaks reports tokens whose values appear in a payload, never values", () => {
    const v = new Vault();
    const t = v.mint("AADHAAR", "999941057058");
    v.mint("EMAIL", "ramesh@gmail.com");
    const payload = JSON.stringify({ note: "call about 999941057058 today" });
    const leaks = v.findLeaks(payload);
    expect(leaks).toEqual([t]);
    expect(JSON.stringify(leaks)).not.toContain("999941057058");
  });

  it("findLeaks skips values shorter than 4 chars", () => {
    const v = new Vault();
    v.mint("OTP", "123");
    expect(v.findLeaks("price is 123 rupees")).toEqual([]);
  });

  it("findLeaks protects remembered prompt values without exposing them", () => {
    const v = new Vault();
    v.remember("field|email", "ramesh@example.test");

    const leaks = v.findLeaks("planner response: ramesh@example.test");

    expect(leaks).toEqual(["VAULT:REMEMBERED#1"]);
    expect(JSON.stringify(leaks)).not.toContain("ramesh@example.test");
  });

  it("wipe clears everything and restarts ordinals", () => {
    const v = new Vault();
    v.mint("EMAIL", "a@x.com");
    v.remember("field|email", "a@x.com");
    v.wipe();
    expect(v.size).toBe(0);
    expect(v.mint("EMAIL", "z@x.com")).toBe("PII:EMAIL#1");
    expect(v.recall("field|email")).toBeUndefined();
  });

  it("stats counts by class without exposing values", () => {
    const v = new Vault();
    v.mint("EMAIL", "a@x.com");
    v.mint("EMAIL", "b@x.com");
    v.mint("AADHAAR", "999941057058");
    const s = v.stats();
    expect(s.entries).toBe(3);
    expect(s.byClass.EMAIL).toBe(2);
    expect(s.byClass.AADHAAR).toBe(1);
    expect(JSON.stringify(s)).not.toContain("@x.com");
  });

  it("detects JSON-escaped remembered values as well as literal matches", () => {
    const v = new Vault();
    v.remember("note", 'private "quoted"\nanswer');
    expect(v.findLeaks(JSON.stringify({ value: 'private "quoted"\nanswer' }))).toHaveLength(1);
    expect(v.findLeaks(JSON.stringify({ value: "PII:EMAIL#1" }))).toEqual([]);
  });
});
