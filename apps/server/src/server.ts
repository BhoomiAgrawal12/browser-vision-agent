import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  SanitizedContextPacket,
  guardPlanAgainstPacket,
  type ActionPlan,
} from "@kavach/core/schema";
import { heuristicPlan } from "./planner/heuristic.js";
import {
  plannerConfigFromEnv,
  plannerPlan,
  shouldUseConfiguredPlanner,
} from "./planner/remote.js";
import { rescanPacket } from "./rescan.js";

/**
 * The planner service. One meaningful endpoint:
 *
 *   POST /plan    Sanitized Context Packet in, Action Plan out.
 *
 * Pipeline: schema validation -> PII re-scan (reject, do not process) ->
 * deterministic planner (configured model only for ambiguous tasks) ->
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

type SafeLogValue = string | number | boolean | readonly string[];

function auditLog(
  log: (line: string) => void,
  event: string,
  fields: Record<string, SafeLogValue> = {},
): void {
  log(JSON.stringify({ timestamp_ms: Date.now(), event, ...fields }));
}

function packetLogKey(packetId: string): string {
  return `pkt_${createHash("sha256").update(packetId).digest("hex").slice(0, 16)}`;
}

export interface ServerOptions {
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export function makeServer(options: ServerOptions = {}): Server {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const configuredPlanner = plannerConfigFromEnv(env);

  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        json(res, 200, {
          ok: true,
          planner: configuredPlanner
            ? `configured:${configuredPlanner.mode}`
            : "heuristic",
        });
        return;
      }

      if (req.method === "POST" && req.url === "/plan") {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          auditLog(log, "packet_rejected", { reason: "invalid_json" });
          json(res, 400, { error: "invalid JSON" });
          return;
        }

        const result = SanitizedContextPacket.safeParse(parsed);
        if (!result.success) {
          auditLog(log, "packet_rejected", {
            reason: "schema_validation",
            issues: result.error.issues.length,
          });
          json(res, 422, {
            error: "packet failed schema validation",
            issues: result.error.issues.slice(0, 10),
          });
          return;
        }
        const packet = result.data;
        auditLog(log, "packet_received", {
          packet_key: packetLogKey(packet.packet_id),
          mode: packet.policy.mode,
          elements: packet.elements.length,
          redactions: packet.visual.regions_redacted,
          visual: packet.visual.present,
          planner: configuredPlanner ? `configured:${configuredPlanner.mode}` : "heuristic",
        });

        // Defence in depth: a packet carrying raw PII is a broken client.
        const rescanned = rescanPacket(packet);
        if (rescanned.length > 0) {
          auditLog(log, "packet_rejected", {
            packet_key: packetLogKey(packet.packet_id),
            reason: "rescan_detected_pii",
            classes: [...new Set(rescanned.map((i) => i.cls))],
            findings: rescanned.length,
          });
          json(res, 422, {
            error: "packet rejected: sanitization incomplete",
            classes: [...new Set(rescanned.map((i) => i.cls))],
          });
          return;
        }

        const deterministicPlan = heuristicPlan(packet);
        let plan: ActionPlan = deterministicPlan;
        let plannerUsed: "heuristic" | "configured" = "heuristic";
        if (
          configuredPlanner &&
          shouldUseConfiguredPlanner(packet, deterministicPlan, configuredPlanner)
        ) {
          try {
            const configuredPlan = await plannerPlan(packet, configuredPlanner);
            const configuredIssues = guardPlanAgainstPacket(configuredPlan, packet);
            if (configuredIssues.length > 0) {
              auditLog(log, "planner_fallback", {
                packet_key: packetLogKey(packet.packet_id),
                reason: "configured_plan_failed_action_guard",
                issues: configuredIssues.length,
                issue_steps: configuredIssues.slice(0, 4).map((issue) => `${issue.step}:${issue.problem}`),
              });
            } else {
              plan = configuredPlan;
              plannerUsed = "configured";
            }
          } catch (e) {
            auditLog(log, "planner_fallback", {
              packet_key: packetLogKey(packet.packet_id),
              reason: "configured_planner_failed",
              error: e instanceof Error ? e.name : "unknown",
            });
            plan = deterministicPlan;
          }
        }

        // The server guards its own output before it leaves.
        const issues = guardPlanAgainstPacket(plan, packet);
        if (issues.length > 0) {
          auditLog(log, "plan_rejected", {
            packet_key: packetLogKey(packet.packet_id),
            reason: "deterministic_plan_failed_action_guard",
            issues: issues.length,
          });
          json(res, 500, { error: "planner output failed the guard" });
          return;
        }

        auditLog(log, "plan_sent", {
          packet_key: packetLogKey(packet.packet_id),
          steps: plan.steps.length,
          confidence: plan.confidence,
          needs_more_context: plan.needs_more_context,
          planner_used: plannerUsed,
        });
        json(res, 200, plan);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      auditLog(log, "request_error", {
        error: e instanceof Error ? e.name : "unknown",
      });
      // Never echo planner or parser messages: a malformed response can carry
      // page-derived text, and errors are not a safe data channel.
      json(res, 500, { error: "internal planner error" });
    }
  });
}
