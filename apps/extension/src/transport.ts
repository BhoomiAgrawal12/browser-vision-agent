import type { Transport } from "@kavach/core/gate";

/**
 * The client's one network module, allowlisted in tools/check-egress.mjs.
 * Only the EgressGate ever receives an instance of this, so only payloads
 * that survived the gate's tripwire can reach here.
 */

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787/plan";

export interface PlannerHealth {
  ok: true;
  planner: string;
  provider: "local" | "remote";
  model_configured: boolean;
  mode: "heuristic" | "auto" | "model";
  form_flow: "local-sequential-guarded";
}

/** Read provider metadata only; never includes a task or page content. */
export async function getPlannerHealth(url: string = DEFAULT_SERVER_URL): Promise<PlannerHealth> {
  const health = new URL(url);
  health.pathname = "/health";
  health.search = "";
  health.hash = "";
  const response = await fetch(health, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`planner health returned ${response.status}`);
  const value = await response.json() as Partial<PlannerHealth>;
  if (value.ok !== true || !value.planner || !value.provider || !value.form_flow) {
    throw new Error("planner health response is invalid");
  }
  return value as PlannerHealth;
}

export function makeTransport(url: string = DEFAULT_SERVER_URL): Transport {
  return {
    async post(serialized: string): Promise<unknown> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serialized,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        throw new Error(`planner returned ${res.status}`);
      }
      return res.json();
    },
  };
}
