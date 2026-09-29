import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fixturePacket } from "@kavach/core/schema/fixtures";
import { ActionPlan, type ActionPlan as ActionPlanType } from "@kavach/core/schema";
import { heuristicPlan } from "./planner/heuristic.js";
import { makeServer } from "./server.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function packetWithTwoRequiredFields() {
  const packet = fixturePacket();
  const pin = packet.elements.find((element) => element.id === "e15")!;
  packet.elements.push({ ...structuredClone(pin), id: "e16", label: "City", box: [312, 502, 180, 36] });
  return packet;
}

describe("configured form advisory boundary", () => {
  it("uses remote advice only when it agrees with the local next-field action", async () => {
    const packet = fixturePacket();
    const localPlan = heuristicPlan(packet);
    const modelPlan: ActionPlanType = {
      ...localPlan,
      reasoning_summary: "Model-generated note is not shown to the user.",
      // An attempted early submit is ignored; only the first locally matched
      // field action can ever be returned for a form.
      steps: [...localPlan.steps, { action: "click", target_element_id: "e31", requires_confirmation: true }],
    };
    let logs: string[] = [];
    const received: string[] = [];
    const modelServer = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        received.push(JSON.stringify({ authorization: req.headers.authorization, body }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelPlan) } }] }));
      });
    });
    const modelUrl = await listen(modelServer);
    const api = makeServer({
      env: {
        PLANNER_ENDPOINT: `${modelUrl}/chat/completions`,
        PLANNER_MODEL: "configured-chat-model",
        PLANNER_API_KEY: "test-api-key",
        PLANNER_MODE: "model",
      },
      log: (line) => logs.push(line),
    });
    const apiUrl = await listen(api);
    try {
      const health = await (await fetch(`${apiUrl}/health`)).json();
      expect(health).toEqual({
        ok: true,
        planner: "configured:model",
        provider: "remote",
        model_configured: true,
        mode: "model",
        form_flow: "local-sequential-guarded",
      });
      expect(JSON.stringify(health)).not.toContain("test-api-key");

      const response = await fetch(`${apiUrl}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(packet),
      });
      const plan = ActionPlan.parse(await response.json());
      expect(response.status).toBe(200);
      expect(plan.steps).toEqual(localPlan.steps);
      expect(plan.reasoning_summary).toContain("Remote advisory agrees");
      expect(plan.reasoning_summary).not.toContain("Model-generated");
      expect(received).toHaveLength(1);
      expect(received[0]).toContain("Bearer test-api-key");
      expect(received[0]).not.toContain("9999 4105 7058");
      expect(logs.some((line) => line.includes('"planner_used":"configured"'))).toBe(true);
    } finally {
      await close(api);
      await close(modelServer);
    }
  });

  it("falls back to the local field order when remote advice suggests a different valid field", async () => {
    const packet = packetWithTwoRequiredFields();
    const localPlan = heuristicPlan(packet);
    const disagreeingPlan = structuredClone(localPlan);
    disagreeingPlan.steps[0]!.target_element_id = "e16";
    const logs: string[] = [];
    const received: string[] = [];
    const modelServer = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        received.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(disagreeingPlan) } }] }));
      });
    });
    const modelUrl = await listen(modelServer);
    const api = makeServer({
      env: {
        PLANNER_ENDPOINT: `${modelUrl}/chat/completions`,
        PLANNER_MODEL: "configured-chat-model",
        PLANNER_API_KEY: "test-api-key",
        PLANNER_MODE: "model",
      },
      log: (line) => logs.push(line),
    });
    const apiUrl = await listen(api);
    try {
      const response = await fetch(`${apiUrl}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(packet),
      });
      const plan = ActionPlan.parse(await response.json());
      expect(response.status).toBe(200);
      expect(plan.steps).toEqual(localPlan.steps);
      expect(plan.steps[0]?.target_element_id).toBe("e15");
      expect(plan.reasoning_summary).toBe(localPlan.reasoning_summary);
      expect(received).toHaveLength(1);
      expect(logs.some((line) => line.includes("form_advisory_disagreed_with_local_step"))).toBe(true);
      expect(logs.some((line) => line.includes('"planner_used":"heuristic"'))).toBe(true);
    } finally {
      await close(api);
      await close(modelServer);
    }
  });
});
