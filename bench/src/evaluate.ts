import { defaultRegistry } from "@kavach/core/detectors";
import { PolicyEngine } from "@kavach/core/policy";
import { PII_SEVERITY, parseToken, type PiiClass, type PrivacyMode } from "@kavach/core/schema";
import { Vault } from "@kavach/core/vault";
import { CORPUS, type Capture } from "./corpus.js";
import {
  scoreDetections,
  type DetectionScore,
  type GroundTruthItem,
  type PredictionItem,
} from "./scoring.js";

/**
 * Run the live policy engine over the corpus and score it. This is the
 * evaluation harness for metric 2 (detection) at the structure tier;
 * every prediction is derived from what the pipeline actually emits, not
 * from any internal debug channel.
 */

export interface CaptureResult {
  id: string;
  slice: string;
  predictions: PredictionItem[];
  score: DetectionScore;
}

export interface EvaluationResult {
  mode: PrivacyMode;
  captures: CaptureResult[];
  overall: DetectionScore;
  invariantLeaks: GroundTruthItem[];
}

const TOKEN_RE = /PII:([A-Z_]+)#\d+/g;

function predictionsFrom(
  capture: Capture,
  sanitized: ReturnType<PolicyEngine["sanitize"]>,
): PredictionItem[] {
  const preds: PredictionItem[] = [];
  const boxOf = new Map(capture.regions.map((r) => [r.id, r.box]));

  for (const el of sanitized.elements) {
    const v = el.value;
    if (!v) continue;
    if (v.kind === "unexplained_masked") {
      preds.push({ box: el.box, cls: "UNEXPLAINED" });
    } else if ((v.kind === "placeholder" || v.kind === "redacted") && "token" in v && v.token) {
      preds.push({ box: el.box, cls: v.token.split("#")[0]!.replace("PII:", "") });
    } else if (v.kind === "redacted") {
      preds.push({ box: el.box, cls: "REDACTED" });
    }
    // Tokens substituted into labels count as detections on that element.
    if (el.label) {
      for (const m of el.label.matchAll(TOKEN_RE)) {
        preds.push({ box: el.box, cls: m[1]! });
      }
    }
  }

  // Tokens inside sanitized free text are detections on the source region.
  for (const ut of sanitized.untrustedText) {
    const box = boxOf.get(ut.src);
    if (!box) continue;
    const seen = new Set<string>();
    for (const m of ut.text.matchAll(TOKEN_RE)) {
      if (!seen.has(m[1]!)) {
        seen.add(m[1]!);
        preds.push({ box, cls: m[1]! });
      }
    }
  }
  return preds;
}

/** Offset per capture so boxes never collide across captures. */
function offset(items: { box: [number, number, number, number] }[], dy: number) {
  return items.map((i) => ({
    ...i,
    box: [i.box[0], i.box[1] + dy, i.box[2], i.box[3]] as [number, number, number, number],
  }));
}

export function evaluate(mode: PrivacyMode): EvaluationResult {
  const captures: CaptureResult[] = [];
  const allGt: GroundTruthItem[] = [];
  const allPred: PredictionItem[] = [];

  for (const [i, capture] of CORPUS.entries()) {
    const vault = new Vault();
    const policy = new PolicyEngine(defaultRegistry(), vault, "bench.1");
    const sanitized = policy.sanitize(capture.regions, mode, "benchmark run");
    const predictions = predictionsFrom(capture, sanitized);
    captures.push({
      id: capture.id,
      slice: capture.slice,
      predictions,
      score: scoreDetections(capture.groundTruth, predictions),
    });
    const dy = i * 100_000;
    allGt.push(...(offset(capture.groundTruth, dy) as GroundTruthItem[]));
    allPred.push(...(offset(predictions, dy) as PredictionItem[]));
  }

  const overall = scoreDetections(allGt, allPred);
  const invariantLeaks = overall.leaks.filter((l) => {
    const parsed = parseToken(`PII:${l.cls}#1`);
    const severity = l.severity ?? (parsed ? PII_SEVERITY[parsed.cls as PiiClass] : undefined);
    return severity === "invariant";
  });
  return { mode, captures, overall, invariantLeaks };
}
