import {
  ActionPlan,
  guardPlanAgainstPacket,
} from "../schema/plan.js";
import { SanitizedContextPacket } from "../schema/scp.js";
import type { RecognizerRegistry } from "../detectors/recognizers.js";
import type { Vault } from "../vault/index.js";

/**
 * The Egress Gate: the only code in the entire system allowed to talk to
 * the network. Everything else is unrepresentable: the transport function
 * is injected here and nowhere else, and an ESLint rule bans fetch and
 * XMLHttpRequest in every other module.
 *
 * Order of operations is deliberate:
 *   validate -> tripwire -> vault scan -> caps -> receipt -> send -> guard.
 * The receipt is written BEFORE the send so the record exists even if the
 * network fails, and it is written on blocks too.
 */

export class EgressBlocked extends Error {
  constructor(readonly reasons: string[]) {
    super(`egress blocked: ${reasons.join("; ")}. Nothing was sent.`);
    this.name = "EgressBlocked";
  }
}

export class EgressRateLimited extends Error {
  constructor() {
    super("egress rate limit reached; try again shortly. Nothing was sent.");
    this.name = "EgressRateLimited";
  }
}

export interface PrivacyReceipt {
  receipt_id: string;
  packet_id: string;
  timestamp_ms: number;
  mode: string;
  policy_version: string;
  outcome: "sent" | "blocked";
  blocked_reasons?: string[];
  sent: {
    bytes: number;
    payload_sha256: string;
    image_included: boolean;
    image_sha256?: string;
  };
  redactions: { total: number; by_legend_class: Record<string, number> };
  verification: {
    tripwire_passed: boolean;
    vault_scan_passed: boolean;
  };
}

export type EgressAuditStage =
  | "schema"
  | "tripwire"
  | "vault"
  | "visual"
  | "size"
  | "rate_limit"
  | "receipt"
  | "network"
  | "response";

export type EgressAuditOutcome = "pass" | "blocked" | "error";

/** Structured, payload-free evidence for the Phase 0 security workflow. */
export interface EgressAuditEvent {
  timestamp_ms: number;
  packet_id?: string;
  stage: EgressAuditStage;
  outcome: EgressAuditOutcome;
  detail?: string;
  metrics?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditSink {
  append(event: EgressAuditEvent): Promise<void> | void;
}

export interface Transport {
  /** POST the serialized packet; return the parsed JSON response body. */
  post(serialized: string): Promise<unknown>;
}

export interface ReceiptSink {
  append(receipt: PrivacyReceipt): Promise<void> | void;
}

export interface EgressGateOptions {
  transport: Transport;
  registry: RecognizerRegistry;
  vault: Vault;
  receipts: ReceiptSink;
  audit?: AuditSink;
  maxPacketBytes?: number;
  /** Requests allowed per window. */
  rateLimit?: { max: number; windowMs: number };
  now?: () => number;
  /** Injectable id source for receipts. */
  makeId?: () => string;
}

const DEFAULT_MAX_PACKET_BYTES = 2 * 1024 * 1024;
/** Only strong, validated detections block at the last line. */
const TRIPWIRE_THRESHOLD = 0.8;
const SAFE_PACKET_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{20,26})$/i;

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultMakeId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "rcpt_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function serializeAttempt(input: unknown): { text: string; bytes: number } {
  try {
    const text = JSON.stringify(input) ?? "undefined";
    return { text, bytes: new TextEncoder().encode(text).byteLength };
  } catch {
    const text = "<unserializable>";
    return { text, bytes: new TextEncoder().encode(text).byteLength };
  }
}

export class EgressGate {
  private readonly maxPacketBytes: number;
  private readonly rate: { max: number; windowMs: number };
  private readonly now: () => number;
  private readonly makeId: () => string;
  private sendTimes: number[] = [];

  constructor(private readonly opts: EgressGateOptions) {
    this.maxPacketBytes = opts.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
    this.rate = opts.rateLimit ?? { max: 30, windowMs: 60_000 };
    this.now = opts.now ?? Date.now;
    this.makeId = opts.makeId ?? defaultMakeId;
  }

  private async audit(
    event: Omit<EgressAuditEvent, "timestamp_ms">,
  ): Promise<void> {
    if (!this.opts.audit) return;
    try {
      await this.opts.audit.append({ timestamp_ms: this.now(), ...event });
    } catch {
      // Audit collection must not alter the privacy decision or network path.
    }
  }

  async send(packetInput: unknown): Promise<ActionPlan> {
    // 1. The wire schema is the first and non-negotiable check.
    const parsed = SanitizedContextPacket.safeParse(packetInput);
    if (!parsed.success) {
      const attempted = serializeAttempt(packetInput);
      await this.opts.receipts.append({
        receipt_id: this.makeId(),
        packet_id: "unknown",
        timestamp_ms: this.now(),
        mode: "unknown",
        policy_version: "unknown",
        outcome: "blocked",
        blocked_reasons: ["schema: packet failed schema validation"],
        sent: {
          bytes: attempted.bytes,
          payload_sha256: await sha256Hex(attempted.text),
          image_included: false,
        },
        redactions: { total: 0, by_legend_class: {} },
        verification: { tripwire_passed: false, vault_scan_passed: false },
      });
      await this.audit({
        stage: "schema",
        outcome: "blocked",
        detail: "packet failed schema validation",
        metrics: { issues: parsed.error.issues.length },
      });
      await this.audit({
        stage: "receipt",
        outcome: "blocked",
        detail: "schema-failure receipt recorded",
      });
      throw parsed.error;
    }
    const packet = parsed.data;
    await this.audit({
      stage: "schema",
      outcome: "pass",
      packet_id: packet.packet_id,
      detail: "packet validated",
      metrics: { elements: packet.elements.length, visual: packet.visual.present },
    });
    const serialized = JSON.stringify(packet);
    const serializedBytes = new TextEncoder().encode(serialized).byteLength;

    // The image travels as base64, whose random digit runs would trip the
    // text detectors. Its safety is proven by the composer's pixel-level
    // self-check; here we scan everything EXCEPT the image bytes, and
    // independently verify the image hash so the receipt stays honest.
    const scannable = JSON.stringify({
      ...packet,
      // Random packet IDs, timestamps and hashes can accidentally look like
      // phone/account numbers when detectors read serialized JSON as prose.
      // They are machine generated, not user content. Every user/page-derived
      // field remains in this scan.
      packet_id: SAFE_PACKET_ID.test(packet.packet_id) ? undefined : packet.packet_id,
      captured_at_ms: undefined,
      visual: { ...packet.visual, sha256: undefined, data_b64: undefined },
    });
    const vaultScannable = packet.visual.data_b64 === undefined ? serialized : JSON.stringify({
      ...packet, visual: { ...packet.visual, data_b64: undefined },
    });

    // 2. Tripwire: re-run the full detector suite over everything that is
    //    about to leave. Strong hits mean the policy engine failed; block.
    const survivors = this.opts.registry.analyze(scannable, {
      threshold: TRIPWIRE_THRESHOLD,
    });
    // 3. Literal vault values in the payload are always a block.
    const vaultLeaks = this.opts.vault.findLeaks(vaultScannable);

    await this.audit({
      stage: "tripwire",
      outcome: survivors.length === 0 ? "pass" : "blocked",
      packet_id: packet.packet_id,
      detail: survivors.length === 0 ? "no strong PII detections" : "strong PII detection found",
      metrics: { detections: survivors.length },
    });
    await this.audit({
      stage: "vault",
      outcome: vaultLeaks.length === 0 ? "pass" : "blocked",
      packet_id: packet.packet_id,
      detail: vaultLeaks.length === 0 ? "no vault values found" : "vault value found",
      metrics: { leaks: vaultLeaks.length },
    });

    const reasons: string[] = [];
    if (packet.visual.data_b64 !== undefined) {
      const actual = await sha256Hex(packet.visual.data_b64);
      if (actual !== packet.visual.sha256) {
        reasons.push("visual: sha256 does not match the image payload");
      }
      await this.audit({
        stage: "visual",
        outcome: actual === packet.visual.sha256 ? "pass" : "blocked",
        packet_id: packet.packet_id,
        detail: actual === packet.visual.sha256 ? "visual hash verified" : "visual hash mismatch",
      });
    } else {
      await this.audit({
        stage: "visual",
        outcome: "pass",
        packet_id: packet.packet_id,
        detail: "no visual payload",
      });
    }
    for (const s of survivors) {
      reasons.push(`tripwire: ${s.cls} detected in outbound payload`);
    }
    for (const t of vaultLeaks) {
      reasons.push(`vault: value behind ${t} appears in outbound payload`);
    }
    // 4. Volume caps: a looping bug must not exfiltrate by sheer size.
    if (serializedBytes > this.maxPacketBytes) {
      reasons.push(`size: packet ${serializedBytes} bytes exceeds cap`);
    }
    await this.audit({
      stage: "size",
      outcome: serializedBytes <= this.maxPacketBytes ? "pass" : "blocked",
      packet_id: packet.packet_id,
      detail: serializedBytes <= this.maxPacketBytes ? "packet within size cap" : "packet exceeds size cap",
      metrics: { bytes: serializedBytes, max_bytes: this.maxPacketBytes },
    });

    const byClass: Record<string, number> = {};
    for (const el of packet.elements) {
      const v = el.value;
      if (v && (v.kind === "placeholder" || v.kind === "redacted") && "token" in v && v.token) {
        const key = v.token.split("#")[0]!;
        byClass[key] = (byClass[key] ?? 0) + 1;
      }
    }

    const baseReceipt = {
      packet_id: packet.packet_id,
      timestamp_ms: this.now(),
      mode: packet.policy.mode,
      policy_version: packet.policy.policy_version,
      sent: {
        bytes: serializedBytes,
        payload_sha256: await sha256Hex(serialized),
        image_included: packet.visual.present,
        ...(packet.visual.sha256 ? { image_sha256: packet.visual.sha256 } : {}),
      },
      redactions: {
        total: packet.visual.regions_redacted,
        by_legend_class: byClass,
      },
      verification: {
        tripwire_passed: survivors.length === 0,
        vault_scan_passed: vaultLeaks.length === 0,
      },
    };

    if (reasons.length > 0) {
      await this.opts.receipts.append({
        receipt_id: this.makeId(),
        outcome: "blocked",
        blocked_reasons: reasons,
        ...baseReceipt,
      });
      await this.audit({
        stage: "receipt",
        outcome: "blocked",
        packet_id: packet.packet_id,
        detail: "blocked receipt recorded",
        metrics: { reasons: reasons.length },
      });
      await this.audit({
        stage: "network",
        outcome: "blocked",
        packet_id: packet.packet_id,
        detail: "request not sent",
      });
      throw new EgressBlocked(reasons);
    }

    // 5. Rate limit.
    const cutoff = this.now() - this.rate.windowMs;
    this.sendTimes = this.sendTimes.filter((t) => t > cutoff);
    if (this.sendTimes.length >= this.rate.max) {
      const reason = "rate_limit: request window exceeded";
      await this.opts.receipts.append({
        receipt_id: this.makeId(),
        outcome: "blocked",
        blocked_reasons: [reason],
        ...baseReceipt,
      });
      await this.audit({
        stage: "rate_limit",
        outcome: "blocked",
        packet_id: packet.packet_id,
        detail: "request rate limit reached",
        metrics: { max: this.rate.max, window_ms: this.rate.windowMs },
      });
      await this.audit({
        stage: "receipt",
        outcome: "blocked",
        packet_id: packet.packet_id,
        detail: "rate-limit receipt recorded",
      });
      await this.audit({
        stage: "network",
        outcome: "blocked",
        packet_id: packet.packet_id,
        detail: "request not sent",
      });
      throw new EgressRateLimited();
    }
    this.sendTimes.push(this.now());

    // 6. Receipt before send: the record exists even if the network fails.
    await this.opts.receipts.append({
      receipt_id: this.makeId(),
      outcome: "sent",
      ...baseReceipt,
    });
    await this.audit({
      stage: "receipt",
      outcome: "pass",
      packet_id: packet.packet_id,
      detail: "sent receipt recorded before network request",
    });

    // 7. The one network call.
    let response: unknown;
    try {
      response = await this.opts.transport.post(serialized);
      await this.audit({
        stage: "network",
        outcome: "pass",
        packet_id: packet.packet_id,
        detail: "request sent and response received",
      });
    } catch (error) {
      await this.audit({
        stage: "network",
        outcome: "error",
        packet_id: packet.packet_id,
        detail: "planner request failed",
      });
      throw error;
    }

    // 8. Validate what came back before anyone else sees it.
    let plan: ActionPlan;
    try {
      plan = ActionPlan.parse(response);
    } catch (error) {
      await this.audit({
        stage: "response",
        outcome: "blocked",
        packet_id: packet.packet_id,
        detail: "planner response failed schema validation",
      });
      throw error;
    }
    const issues = guardPlanAgainstPacket(plan, packet);
    const planSerialized = JSON.stringify(plan);
    const planFindings = this.opts.registry.analyze(planSerialized, {
      threshold: TRIPWIRE_THRESHOLD,
    });
    const planVaultLeaks = this.opts.vault.findLeaks(planSerialized);
    if (issues.length > 0 || planFindings.length > 0 || planVaultLeaks.length > 0) {
      await this.audit({
        stage: "response",
        outcome: "blocked",
        packet_id: packet.packet_id,
        detail: "planner response failed the action or privacy guard",
        metrics: {
          issues: issues.length,
          tripwire_detections: planFindings.length,
          vault_leaks: planVaultLeaks.length,
        },
      });
      const reasons = issues.map((i) => `plan guard (step ${i.step}): ${i.problem}`);
      reasons.push(...planFindings.map((finding) => `response tripwire: ${finding.cls} detected`));
      reasons.push(...planVaultLeaks.map((token) => `response vault: value behind ${token} appears in plan`));
      throw new EgressBlocked(reasons);
    }
    await this.audit({
      stage: "response",
      outcome: "pass",
      packet_id: packet.packet_id,
      detail: "planner response validated and guarded",
      metrics: { steps: plan.steps.length },
    });
    return plan;
  }
}
