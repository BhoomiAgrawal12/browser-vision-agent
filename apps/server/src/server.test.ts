import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { fixturePacket } from "@kavach/core/schema/fixtures";
import { ActionPlan, guardPlanAgainstPacket } from "@kavach/core/schema";
import { makeServer } from "./server.js";
import { heuristicPlan } from "./planner/heuristic.js";

let server: Server;
let base: string;
const logs: string[] = [];

beforeAll(async () => {
  server = makeServer({ env: {}, log: (l) => void logs.push(l) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function hasLogEvent(event: string): boolean {
  return logs.some((line) => {
    try {
      return (JSON.parse(line) as { event?: string }).event === event;
    } catch {
      return false;
    }
  });
}

describe("planner service", () => {
  it("reports health with the active planner", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      planner: "heuristic",
      provider: "local",
      model_configured: false,
      mode: "heuristic",
      form_flow: "local-sequential-guarded",
    });
  });

  it("plans against the fixture packet: asks the user for the empty pincode", async () => {
    const { status, json } = await post(fixturePacket());
    expect(status).toBe(200);
    const plan = ActionPlan.parse(json);
    expect(plan.packet_id).toBe(fixturePacket().packet_id);
    expect(plan.steps[0]).toMatchObject({
      action: "type",
      target_element_id: "e15",
      value: { kind: "user_prompt" },
    });
    expect(hasLogEvent("packet_received")).toBe(true);
    expect(hasLogEvent("plan_sent")).toBe(true);
  });

  it("rejects invalid JSON", async () => {
    const { status } = await post("{nope");
    expect(status).toBe(400);
  });

  it("rejects a schema-invalid packet with details", async () => {
    const bad = fixturePacket() as Record<string, unknown>;
    bad["cookies"] = "session=abc";
    const { status, json } = await post(bad);
    expect(status).toBe(422);
    expect((json as { error: string }).error).toContain("schema");
    expect(hasLogEvent("packet_rejected")).toBe(true);
  });

  it("rejects a packet whose sanitization leaked raw PII, and logs it", async () => {
    const leaky = fixturePacket();
    leaky.untrusted_text.push({ src: "e15", text: "reach me at ramesh@gmail.com" });
    const { status, json } = await post(leaky);
    expect(status).toBe(422);
    expect((json as { classes: string[] }).classes).toContain("EMAIL");
    expect(hasLogEvent("packet_rejected")).toBe(true);
    expect(logs.join()).not.toContain("ramesh@gmail.com");
  });

  it("hashes client packet ids before writing them to logs", async () => {
    const packet = fixturePacket();
    packet.packet_id = "ramesh@gmail.com.packet";
    const { status } = await post(packet);
    expect(status).toBe(422);
    expect(logs.join()).not.toContain("ramesh@gmail.com.packet");
    expect(logs.some((line) => line.includes('"packet_key":"pkt_'))).toBe(true);
  });

  it("404s elsewhere", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("heuristic planner directly", () => {
  it("clicks the primary action when required fields are filled", () => {
    const p = fixturePacket();
    // Fill the pincode and enable the button.
    p.elements[1]!.value = { kind: "filled", text: "380015" };
    p.elements[1]!.state = { filled: true, required: true };
    p.elements[2]!.state = { disabled: false };
    const plan = heuristicPlan(p);
    expect(plan.steps[0]).toMatchObject({
      action: "click",
      target_element_id: "e31",
      requires_confirmation: true, // e31 carries risk: state_changing
    });
    expect(plan.steps[0]!.confirmation_reason).toContain("state changing");
  });

  it("suggests a scroll when the only button is disabled and nothing is fillable", () => {
    const p = fixturePacket();
    p.elements[1]!.value = { kind: "filled", text: "380015" };
    p.elements[1]!.state = { filled: true, required: true };
    // e31 stays disabled
    const plan = heuristicPlan(p);
    expect(plan.steps[0]!.action).toBe("scroll");
    expect(plan.needs_more_context).toBe(true);
  });

  it("plans only the first pending field", () => {
    const p = fixturePacket();
    p.elements = Array.from({ length: 8 }, (_, i) => ({
      id: `e${i + 1}`,
      role: "textbox" as const,
      label: `Field ${i + 1}`,
      box: [0, i * 40, 200, 30] as [number, number, number, number],
      state: { required: true, filled: false },
      value: { kind: "empty" as const },
      evidence: [],
      confidence: 0.9,
      source: "dom" as const,
    }));
    const plan = heuristicPlan(p);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ action: "type", target_element_id: "e1" });
  });

  it("keeps text, file, choice, and invalid questions in page order", () => {
    const packet = fixturePacket();
    const base = packet.elements[1]!;
    packet.elements = [
      { ...base, id: "e1", label: "Name", evidence: [], value: { kind: "empty" }, state: { required: true } },
      { ...base, id: "e2", role: "button", label: "Upload document", risk: "state_changing", evidence: ["structural:input_type=file"], value: { kind: "empty" }, state: { required: true } },
      { ...base, id: "e3", role: "combobox", label: "Country", evidence: [], value: { kind: "empty" }, state: { required: true, invalid: true } },
      { ...packet.elements[2]!, state: { disabled: false } },
    ];
    for (const [index, action] of ["type", "click", "select"].entries()) {
      const plan = heuristicPlan(packet);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({ action, target_element_id: `e${index + 1}` });
      expect(guardPlanAgainstPacket(plan, packet)).toEqual([]);
      packet.elements[index]!.state = { required: true, filled: true };
      packet.elements[index]!.value = { kind: "filled", text: "already answered" };
    }
    expect(heuristicPlan(packet).steps[0]?.target_element_id).toBe("e31");
  });
});
