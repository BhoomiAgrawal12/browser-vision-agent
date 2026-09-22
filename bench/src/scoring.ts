import { iou, unionArea } from "@kavach/core/fusion";
import type { Box } from "@kavach/core/schema";

/**
 * RedactBench scoring: the numbers behind evaluation metrics 2 and 3.
 * Detection quality is precision/recall/F1 per class; redaction quality
 * is pixel coverage of ground truth, the over-mask ratio, and mean IoU.
 * The leak rate (1 - recall on high severity classes) is reported
 * separately because it is the number a privacy system lives or dies by.
 */

export interface GroundTruthItem {
  /** Region geometry in the capture's coordinate space. */
  box: Box;
  cls: string;
  /**
   * True: this is PII and must be redacted (a miss is a false negative).
   * False: this LOOKS like PII but is not (a hit is a false positive).
   * Negatives are what make precision measurable.
   */
  mustRedact: boolean;
  severity?: "invariant" | "high" | "medium";
  note?: string;
}

export interface PredictionItem {
  box: Box;
  cls: string;
}

export interface ClassMetrics {
  cls: string;
  support: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

const MATCH_IOU = 0.5;

function safeDiv(a: number, b: number): number {
  return b === 0 ? (a === 0 ? 1 : 0) : a / b;
}

export interface MatchResult {
  pairs: { gtIndex: number; predIndex: number; iou: number }[];
  unmatchedGt: number[];
  unmatchedPred: number[];
}

/** Greedy best-IoU matching, class-sensitive. */
export function matchDetections(
  groundTruth: GroundTruthItem[],
  predictions: PredictionItem[],
  minIou: number = MATCH_IOU,
): MatchResult {
  const candidates: { gtIndex: number; predIndex: number; iou: number }[] = [];
  for (const [g, gt] of groundTruth.entries()) {
    for (const [p, pred] of predictions.entries()) {
      if (gt.cls !== pred.cls) continue;
      const overlap = iou(gt.box, pred.box);
      if (overlap >= minIou) candidates.push({ gtIndex: g, predIndex: p, iou: overlap });
    }
  }
  candidates.sort((a, b) => b.iou - a.iou);
  const usedGt = new Set<number>();
  const usedPred = new Set<number>();
  const pairs: MatchResult["pairs"] = [];
  for (const c of candidates) {
    if (usedGt.has(c.gtIndex) || usedPred.has(c.predIndex)) continue;
    usedGt.add(c.gtIndex);
    usedPred.add(c.predIndex);
    pairs.push(c);
  }
  return {
    pairs,
    unmatchedGt: groundTruth.map((_, i) => i).filter((i) => !usedGt.has(i)),
    unmatchedPred: predictions.map((_, i) => i).filter((i) => !usedPred.has(i)),
  };
}

export interface DetectionScore {
  perClass: ClassMetrics[];
  micro: Omit<ClassMetrics, "cls" | "support">;
  /** 1 - recall over ground truth marked invariant or high severity. */
  leakRate: number;
  leaks: GroundTruthItem[];
  /** Redactions of items explicitly marked mustRedact false. */
  falseAlarms: GroundTruthItem[];
}

export function scoreDetections(
  groundTruth: GroundTruthItem[],
  predictions: PredictionItem[],
): DetectionScore {
  const positives = groundTruth.filter((g) => g.mustRedact);
  const negatives = groundTruth.filter((g) => !g.mustRedact);

  const match = matchDetections(positives, predictions);
  const matchedPred = new Set(match.pairs.map((p) => p.predIndex));

  // A prediction overlapping a declared negative is a counted false alarm
  // whatever class it claims: masking the order id is the failure.
  const falseAlarms: GroundTruthItem[] = [];
  const negHit = new Set<number>();
  for (const [p, pred] of predictions.entries()) {
    if (matchedPred.has(p)) continue;
    for (const [n, neg] of negatives.entries()) {
      if (!negHit.has(n) && iou(neg.box, pred.box) >= MATCH_IOU) {
        negHit.add(n);
        falseAlarms.push(neg);
        break;
      }
    }
  }

  const classes = [...new Set(positives.map((g) => g.cls))].sort();
  const perClass: ClassMetrics[] = classes.map((cls) => {
    const clsGt = positives.filter((g) => g.cls === cls);
    const tp = match.pairs.filter((p) => positives[p.gtIndex]!.cls === cls).length;
    const fn = clsGt.length - tp;
    const fp = predictions.filter(
      (pred, i) => pred.cls === cls && !matchedPred.has(i),
    ).length;
    const precision = safeDiv(tp, tp + fp);
    const recall = safeDiv(tp, tp + fn);
    return {
      cls,
      support: clsGt.length,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1: safeDiv(2 * precision * recall, precision + recall),
    };
  });

  const tp = perClass.reduce((a, c) => a + c.tp, 0);
  const fn = perClass.reduce((a, c) => a + c.fn, 0);
  const fp = predictions.length - tp;
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);

  const highSev = positives.filter(
    (g) => g.severity === "invariant" || g.severity === "high",
  );
  const highMatched = match.pairs.filter((p) => {
    const g = positives[p.gtIndex]!;
    return g.severity === "invariant" || g.severity === "high";
  }).length;
  const leaks = highSev.filter(
    (g) =>
      !match.pairs.some((p) => positives[p.gtIndex] === g),
  );

  return {
    perClass,
    micro: {
      tp,
      fp,
      fn,
      precision,
      recall,
      f1: safeDiv(2 * precision * recall, precision + recall),
    },
    leakRate: highSev.length === 0 ? 0 : 1 - highMatched / highSev.length,
    leaks,
    falseAlarms,
  };
}

export interface RedactionScore {
  /** Fraction of ground-truth sensitive pixels under a mask. Must be 1. */
  coverage: number;
  /** Fraction of masked pixels that were not sensitive. Lower is better. */
  overMaskRatio: number;
  meanIoU: number;
}

/** Pixel-level redaction quality via rectangle-set areas. */
export function scoreRedaction(
  groundTruthBoxes: Box[],
  maskBoxes: Box[],
): RedactionScore {
  const gtArea = unionArea(groundTruthBoxes);
  const maskArea = unionArea(maskBoxes);
  // Intersection of two rect sets by inclusion-exclusion on unions.
  const inter = gtArea + maskArea - unionArea([...groundTruthBoxes, ...maskBoxes]);

  const match = matchDetections(
    groundTruthBoxes.map((box) => ({ box, cls: "x", mustRedact: true })),
    maskBoxes.map((box) => ({ box, cls: "x" })),
    0.01,
  );
  const meanIoU =
    match.pairs.length === 0
      ? 0
      : match.pairs.reduce((a, p) => a + p.iou, 0) / match.pairs.length;

  return {
    coverage: gtArea === 0 ? 1 : inter / gtArea,
    overMaskRatio: maskArea === 0 ? 0 : (maskArea - inter) / maskArea,
    meanIoU,
  };
}
