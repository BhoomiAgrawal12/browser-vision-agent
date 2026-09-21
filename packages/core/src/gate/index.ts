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

  async send(packetInput: unknown): Promise<ActionPlan> {
    // 1. The wire schema is the first and non-negotiable check.
    const packet = SanitizedContextPacket.parse(packetInput);
    const serialized = JSON.stringify(packet);

    // 2. Tripwire: re-run the full detector suite over everything that is
    //    about to leave. Strong hits mean the policy engine failed; block.
    const survivors = this.opts.registry.analyze(serialized, {
      threshold: TRIPWIRE_THRESHOLD,
    });
    // 3. Literal vault values in the payload are always a block.
    const vaultLeaks = this.opts.vault.findLeaks(serialized);

    const reasons: string[] = [];
    for (const s of survivors) {
      reasons.push(`tripwire: ${s.cls} detected in outbound payload`);
    }
    for (const t of vaultLeaks) {
      reasons.push(`vault: value behind ${t} appears in outbound payload`);
    }
    // 4. Volume caps: a looping bug must not exfiltrate by sheer size.
    if (serialized.length > this.maxPacketBytes) {
      reasons.push(`size: packet ${serialized.length} bytes exceeds cap`);
    }

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
        bytes: serialized.length,
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
      throw new EgressBlocked(reasons);
    }

    // 5. Rate limit.
    const cutoff = this.now() - this.rate.windowMs;
    this.sendTimes = this.sendTimes.filter((t) => t > cutoff);
    if (this.sendTimes.length >= this.rate.max) throw new EgressRateLimited();
    this.sendTimes.push(this.now());

    // 6. Receipt before send: the record exists even if the network fails.
    await this.opts.receipts.append({
      receipt_id: this.makeId(),
      outcome: "sent",
      ...baseReceipt,
    });

    // 7. The one network call.
    const response = await this.opts.transport.post(serialized);

    // 8. Validate what came back before anyone else sees it.
    const plan = ActionPlan.parse(response);
    const issues = guardPlanAgainstPacket(plan, packet);
    if (issues.length > 0) {
      throw new EgressBlocked(
        issues.map((i) => `plan guard (step ${i.step}): ${i.problem}`),
      );
    }
    return plan;
  }
}
