import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  SanitizedContextPacket,
  guardPlanAgainstPacket,
  type ActionPlan,
} from "@kavach/core/schema";
import { heuristicPlan } from "./planner/heuristic.js";
import { ollamaConfigFromEnv, ollamaPlan } from "./planner/ollama.js";
import { rescanPacket } from "./rescan.js";

/**
 * The planner service. One meaningful endpoint:
 *
 *   POST /plan    Sanitized Context Packet in, Action Plan out.
 *
 * Pipeline: schema validation -> PII re-scan (reject, do not process) ->
 * planner (Ollama when configured, deterministic heuristic otherwise) ->
 * output guard -> respond. The server guards its own output so a broken
 * planner can never emit a plan the client would have to distrust.
 */

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export interface ServerOptions {
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export function makeServer(options: ServerOptions = {}): Server {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const ollama = ollamaConfigFromEnv(env);

  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        json(res, 200, {
          ok: true,
          planner: ollama ? `ollama:${ollama.model}` : "heuristic",
        });
        return;
      }

      if (req.method === "POST" && req.url === "/plan") {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          json(res, 400, { error: "invalid JSON" });
          return;
        }

        const result = SanitizedContextPacket.safeParse(parsed);
        if (!result.success) {
          json(res, 422, {
            error: "packet failed schema validation",
            issues: result.error.issues.slice(0, 10),
          });
          return;
        }
        const packet = result.data;

        // Defence in depth: a packet carrying raw PII is a broken client.
        const rescanned = rescanPacket(packet);
        if (rescanned.length > 0) {
          log(
            `REJECTED packet ${packet.packet_id}: re-scan found ` +
              rescanned.map((i) => `${i.cls} at ${i.path}`).join(", "),
          );
          json(res, 422, {
            error: "packet rejected: sanitization incomplete",
            classes: [...new Set(rescanned.map((i) => i.cls))],
          });
          return;
        }

        let plan: ActionPlan;
        if (ollama) {
          try {
            plan = await ollamaPlan(packet, ollama);
          } catch (e) {
            log(`ollama failed (${(e as Error).message}); using heuristic planner`);
            plan = heuristicPlan(packet);
          }
        } else {
          plan = heuristicPlan(packet);
        }

        // The server guards its own output before it leaves.
        const issues = guardPlanAgainstPacket(plan, packet);
        if (issues.length > 0) {
          log(
            `planner produced a guarded-out plan for ${packet.packet_id}: ` +
              issues.map((i) => i.problem).join("; "),
          );
          json(res, 500, { error: "planner output failed the guard" });
          return;
        }

        json(res, 200, plan);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
}
