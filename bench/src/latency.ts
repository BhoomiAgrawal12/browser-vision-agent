import { writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { defaultRegistry } from "@kavach/core/detectors";
import { EgressGate } from "@kavach/core/gate";
import { PolicyEngine } from "@kavach/core/policy";
import { SCP_SCHEMA_ID, type SanitizedContextPacket } from "@kavach/core/schema";
import { Vault } from "@kavach/core/vault";
import {
  composeSanitized,
  hashTiles,
  verifyRedactedRegions,
  type ImageDataLike,
  type RedactionRect,
} from "@kavach/perception";
import {
  ULTRAFACE_H,
  ULTRAFACE_W,
  postprocess,
  preprocess,
} from "@kavach/perception/vision";
import { CORPUS } from "./corpus.js";

/**
 * Local pipeline latency: p50/p95 per stage, measured on the real code
 * paths (real policy engine, real gate with an instant transport, real
 * ONNX inference through onnxruntime-web's wasm backend). Node's wasm
 * path approximates the extension's wasm fallback; the WebGPU path in a
 * browser is faster, so these numbers are the conservative bound.
 */

const WORKING_W = 1024;
const WORKING_H = 580;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function measure(
  name: string,
  iterations: number,
  warmup: number,
  fn: () => Promise<void> | void,
): Promise<{ name: string; p50: number; p95: number; n: number }> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return { name, p50: percentile(samples, 50), p95: percentile(samples, 95), n: iterations };
}

function syntheticFrame(): ImageDataLike {
  const data = new Uint8ClampedArray(WORKING_W * WORKING_H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i / 4) % 251;
    data[i + 1] = (i / 7) % 241;
    data[i + 2] = (i / 11) % 239;
    data[i + 3] = 255;
  }
  return { width: WORKING_W, height: WORKING_H, data };
}

function packetFor(sanitized: ReturnType<PolicyEngine["sanitize"]>): SanitizedContextPacket {
  return {
    schema: SCP_SCHEMA_ID,
    packet_id: "01JBQ7LATENCYPACKET1",
    captured_at_ms: Date.now(),
    policy: { mode: "shield", policy_version: "bench.1", invariant_floor: true },
    device: { backend: "wasm", tier: "T1", viewport: { w: 1280, h: 800, dpr: 1 } },
    origin: { class: "government", tls: true, page_kind: "form", lang: "en-IN" },
    visual: { present: false, regions_redacted: sanitized.summary.regionsRedacted },
    elements: sanitized.elements,
    redaction_legend: sanitized.legend,
    task: { intent: sanitized.intent, history: [] },
    untrusted_text: sanitized.untrustedText,
  };
}

const results: { name: string; p50: number; p95: number; n: number }[] = [];

// Stage 1: policy engine over the whole corpus (12 captures per run).
{
  const registry = defaultRegistry();
  results.push(
    await measure("policy.sanitize (12-capture corpus)", 50, 5, () => {
      for (const capture of CORPUS) {
        const policy = new PolicyEngine(registry, new Vault(), "bench.1");
        policy.sanitize(capture.regions, "shield", "benchmark");
      }
    }),
  );
}

// Stage 2: the egress gate end to end with an instant transport.
{
  const registry = defaultRegistry();
  const vault = new Vault();
  const policy = new PolicyEngine(registry, vault, "bench.1");
  const sanitized = policy.sanitize(CORPUS[0]!.regions, "shield", "benchmark");
  const packet = packetFor(sanitized);
  const plan = {
    schema: "kavach.plan/1.0",
    packet_id: packet.packet_id,
    reasoning_summary: "done",
    steps: [{ action: "done", requires_confirmation: false }],
    needs_more_context: false,
    confidence: 0.9,
  };
  const gate = new EgressGate({
    transport: { post: async () => plan },
    registry,
    vault,
    receipts: { append: () => undefined },
    rateLimit: { max: 1_000_000, windowMs: 1 },
  });
  results.push(
    await measure("egress gate (validate+tripwire+vault+guard)", 100, 10, async () => {
      await gate.send(packet);
    }),
  );
}

// Stage 3: tile hashing and composition on a working-size frame.
{
  const frame = syntheticFrame();
  results.push(await measure("tile hashing (1024x580)", 50, 5, () => void hashTiles(frame)));

  const redactions: RedactionRect[] = Array.from({ length: 8 }, (_, i) => ({
    box: [40 + i * 110, 60 + (i % 3) * 140, 100, 36],
    label: "PII:EMAIL",
  }));
  results.push(
    await measure("compose + self-check (8 redactions)", 30, 3, () => {
      const { image, appliedRects } = composeSanitized(frame, redactions);
      verifyRedactedRegions(image, appliedRects, { stamp: null });
    }),
  );
}

// Stage 4: face detection, pure stages and real ONNX inference.
{
  const frame = syntheticFrame();
  results.push(
    await measure("face preprocess (resize+normalize)", 30, 3, () => void preprocess(frame)),
  );

  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  const modelPath = join(
    fileURLToPath(new URL("..", import.meta.url)),
    "../packages/perception/models/ultraface-rfb-320.onnx",
  );
  const session = await ort.InferenceSession.create(modelPath);
  const input = preprocess(frame);
  let lastOutput: { scores: Float32Array; boxes: Float32Array } | null = null;
  results.push(
    await measure("face inference (ultraface, ort wasm)", 20, 3, async () => {
      const out = await session.run({
        input: new ort.Tensor("float32", input, [1, 3, ULTRAFACE_H, ULTRAFACE_W]),
      });
      lastOutput = {
        scores: out["scores"]!.data as Float32Array,
        boxes: out["boxes"]!.data as Float32Array,
      };
    }),
  );
  results.push(
    await measure("face postprocess (filter+NMS)", 50, 5, () => {
      postprocess(lastOutput!.scores, lastOutput!.boxes, WORKING_W, WORKING_H);
    }),
  );
}

const fmt = (v: number) => v.toFixed(2).padStart(8);
const lines: string[] = [];
lines.push("# Local pipeline latency");
lines.push("");
lines.push(
  `Measured by \`npm run bench:latency\` on ${platform()}/${arch()}, ` +
    `${cpus()[0]?.model ?? "unknown CPU"}, Node ${process.version}. ` +
    "Real code paths; ONNX runs on the single-threaded wasm backend, which is " +
    "the conservative bound (WebGPU in the browser is faster). Do not edit by hand.",
);
lines.push("");
lines.push("| Stage | p50 (ms) | p95 (ms) | runs |");
lines.push("|---|---|---|---|");
for (const r of results) {
  lines.push(`| ${r.name} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${r.n} |`);
}
lines.push("");
const localBudget = results
  .filter((r) => !r.name.startsWith("policy.sanitize"))
  .reduce((a, r) => a + r.p50, 0);
lines.push(
  `Sum of single-frame stage p50s (excluding the 12-capture corpus row): ` +
    `**${localBudget.toFixed(1)} ms**. The report's local budget target is 175 ms p50.`,
);
lines.push("");

const doc = lines.join("\n");
writeFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "LATENCY.md"), doc);
console.log(doc);
