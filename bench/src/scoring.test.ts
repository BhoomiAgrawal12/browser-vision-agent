import { describe, expect, it } from "vitest";
import {
  matchDetections,
  scoreDetections,
  scoreRedaction,
  type GroundTruthItem,
  type PredictionItem,
} from "./scoring.js";

const gt = (
  cls: string,
  box: [number, number, number, number],
  mustRedact = true,
  severity?: GroundTruthItem["severity"],
): GroundTruthItem => {
  const item: GroundTruthItem = { cls, box, mustRedact };
  if (severity) item.severity = severity;
  return item;
};
const pred = (cls: string, box: [number, number, number, number]): PredictionItem => ({
  cls,
  box,
});

describe("matchDetections", () => {
  it("matches same-class overlapping boxes and refuses cross-class", () => {
    const m = matchDetections(
      [gt("AADHAAR", [0, 0, 100, 20]), gt("EMAIL", [0, 40, 100, 20])],
      [pred("AADHAAR", [2, 1, 98, 19]), pred("AADHAAR", [0, 40, 100, 20])],
    );
    expect(m.pairs).toHaveLength(1);
    expect(m.unmatchedGt).toEqual([1]);
    expect(m.unmatchedPred).toEqual([1]);
  });

  it("greedy matching pairs each box at most once, best IoU first", () => {
    const m = matchDetections(
      [gt("EMAIL", [0, 0, 100, 20])],
      [pred("EMAIL", [0, 0, 100, 20]), pred("EMAIL", [10, 0, 100, 20])],
    );
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0]!.predIndex).toBe(0);
  });
});

describe("scoreDetections", () => {
  it("computes per-class and micro precision, recall, F1", () => {
    const truth = [
      gt("AADHAAR", [0, 0, 100, 20], true, "invariant"),
      gt("EMAIL", [0, 40, 100, 20], true, "high"),
      gt("EMAIL", [0, 80, 100, 20], true, "high"),
    ];
    const preds = [
      pred("AADHAAR", [0, 0, 100, 20]), // tp
      pred("EMAIL", [0, 40, 100, 20]), // tp
      pred("EMAIL", [0, 200, 100, 20]), // fp (nothing there)
      // second EMAIL missed: fn
    ];
    const s = scoreDetections(truth, preds);
    const email = s.perClass.find((c) => c.cls === "EMAIL")!;
    expect(email).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    expect(email.precision).toBeCloseTo(0.5);
    expect(email.recall).toBeCloseTo(0.5);
    expect(s.micro.tp).toBe(2);
    expect(s.micro.precision).toBeCloseTo(2 / 3);
    expect(s.micro.recall).toBeCloseTo(2 / 3);
  });

  it("leak rate counts only invariant and high severity misses", () => {
    const truth = [
      gt("PASSWORD", [0, 0, 100, 20], true, "invariant"), // missed: a leak
      gt("PERSON_NAME", [0, 40, 100, 20], true, "medium"), // missed: not a leak
      gt("EMAIL", [0, 80, 100, 20], true, "high"), // caught
    ];
    const s = scoreDetections(truth, [pred("EMAIL", [0, 80, 100, 20])]);
    expect(s.leakRate).toBeCloseTo(0.5);
    expect(s.leaks).toHaveLength(1);
    expect(s.leaks[0]!.cls).toBe("PASSWORD");
  });

  it("redacting a declared negative is a false alarm", () => {
    const truth = [
      gt("AADHAAR", [0, 0, 100, 20], false), // an order id: must NOT be masked
    ];
    const s = scoreDetections(truth, [pred("AADHAAR", [0, 0, 100, 20])]);
    expect(s.falseAlarms).toHaveLength(1);
  });

  it("perfect on empty inputs", () => {
    const s = scoreDetections([], []);
    expect(s.micro.precision).toBe(1);
    expect(s.micro.recall).toBe(1);
    expect(s.leakRate).toBe(0);
  });
});

describe("scoreRedaction", () => {
  it("full coverage with exact masks: coverage 1, over-mask 0, IoU 1", () => {
    const boxes: [number, number, number, number][] = [
      [0, 0, 50, 20],
      [100, 0, 50, 20],
    ];
    const s = scoreRedaction(boxes, boxes);
    expect(s.coverage).toBe(1);
    expect(s.overMaskRatio).toBe(0);
    expect(s.meanIoU).toBe(1);
  });

  it("dilated masks: full coverage, some over-mask", () => {
    const s = scoreRedaction([[10, 10, 50, 20]], [[5, 5, 60, 30]]);
    expect(s.coverage).toBe(1);
    expect(s.overMaskRatio).toBeCloseTo((60 * 30 - 50 * 20) / (60 * 30));
    expect(s.meanIoU).toBeCloseTo((50 * 20) / (60 * 30));
  });

  it("a missed region shows up as partial coverage", () => {
    const s = scoreRedaction(
      [
        [0, 0, 50, 20],
        [100, 0, 50, 20],
      ],
      [[0, 0, 50, 20]],
    );
    expect(s.coverage).toBeCloseTo(0.5);
  });
});
