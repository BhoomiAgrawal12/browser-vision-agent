import type { Transport } from "@kavach/core/gate";

/**
 * The client's one network module, allowlisted in tools/check-egress.mjs.
 * Only the EgressGate ever receives an instance of this, so only payloads
 * that survived the gate's tripwire can reach here.
 */

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787/plan";

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
