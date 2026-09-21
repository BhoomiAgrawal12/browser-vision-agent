import { describe, expect, it } from "vitest";
import {
  centroidDistance,
  clipToImage,
  cssToImage,
  deviceToImage,
  fuse,
  iou,
  unionArea,
  type CoordinateSpace,
  type DomRegion,
  type VisionDetection,
} from "./index.js";

const space: CoordinateSpace = { dpr: 2, scale: 0.5, imageW: 1000, imageH: 600 };

describe("coordinate normalization", () => {
  it("CSS to image applies dpr times scale", () => {
    // dpr 2, scale 0.5: net factor 1.0
    expect(cssToImage([100, 50, 200, 30], space)).toEqual([100, 50, 200, 30]);
    const retina: CoordinateSpace = { dpr: 2, scale: 1, imageW: 2000, imageH: 1200 };
    expect(cssToImage([100, 50, 200, 30], retina)).toEqual([200, 100, 400, 60]);
  });

  it("device to image applies scale only", () => {
    expect(deviceToImage([200, 100, 400, 60], space)).toEqual([100, 50, 200, 30]);
  });

  it("clips boxes to the image and flags partial visibility", () => {
    expect(clipToImage([900, 550, 200, 100], space)).toEqual({
      box: [900, 550, 100, 50],
      partial: true,
    });
    expect(clipToImage([10, 10, 50, 50], space)).toEqual({
      box: [10, 10, 50, 50],
      partial: false,
    });
    expect(clipToImage([2000, 2000, 50, 50], space)).toBeNull();
  });
});

describe("geometry primitives", () => {
  it("iou of identical boxes is 1, disjoint is 0", () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [20, 20, 10, 10])).toBe(0);
  });

  it("iou of half-overlapping boxes", () => {
    // [0,0,10,10] vs [5,0,10,10]: inter 50, union 150
    expect(iou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(1 / 3);
  });

  it("centroid distance", () => {
    expect(centroidDistance([0, 0, 10, 10], [10, 0, 10, 10])).toBe(10);
  });

  it("union area handles overlap correctly", () => {
    expect(unionArea([[0, 0, 10, 10], [5, 0, 10, 10]])).toBe(150);
    expect(unionArea([[0, 0, 10, 10], [20, 20, 10, 10]])).toBe(200);
    expect(unionArea([])).toBe(0);
  });
});

const dom = (id: string, role: DomRegion["role"], cssBox: DomRegion["cssBox"]): DomRegion => ({
  id,
  role,
  cssBox,
  visible: true,
});

const det = (box: VisionDetection["box"], kind: VisionDetection["kind"]): VisionDetection => ({
  box,
  kind,
  score: 0.9,
});

// Net factor 1.0 in `space`, so CSS and image coordinates coincide: test
// geometry without mental arithmetic.
describe("fuse", () => {
  it("matches a detection to the overlapping DOM node by IoU", () => {
    const result = fuse(
      [dom("e1", "button", [100, 100, 200, 40])],
      [det([102, 101, 196, 38], "control")],
      space,
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ domId: "e1", via: "iou" });
    expect(result.unexplained).toHaveLength(0);
  });

  it("accepts a moderate IoU when centroids are near and roles compatible", () => {
    // (15,15) shift on a 200x40 box: IoU 0.407 (below 0.5, above 0.3),
    // centroid distance 21.2 (under the 24 px cap).
    const result = fuse(
      [dom("e1", "textbox", [100, 100, 200, 40])],
      [det([115, 115, 200, 40], "control")],
      space,
    );
    expect(result.matches[0]).toMatchObject({ domId: "e1", via: "iou+centroid" });
  });

  it("refuses the centroid path for incompatible roles", () => {
    // Same geometry, but a media detection over a textbox is not an explanation.
    const result = fuse(
      [dom("e1", "textbox", [100, 100, 200, 40])],
      [det([115, 115, 200, 40], "media")],
      space,
    );
    expect(result.matches).toHaveLength(0);
    expect(result.unexplained).toHaveLength(1);
  });

  it("declares detections with no DOM overlap unexplained: the risk set", () => {
    const result = fuse(
      [dom("e1", "button", [100, 100, 200, 40])],
      [det([600, 400, 150, 100], "media")],
      space,
    );
    expect(result.unexplained).toHaveLength(1);
    expect(result.unexplainedAreaFraction).toBeCloseTo((150 * 100) / (1000 * 600));
    expect(result.explainedAreaFraction).toBeCloseTo(1 - (150 * 100) / (1000 * 600));
  });

  it("lists DOM nodes no detector fired on as structure-only", () => {
    const result = fuse(
      [dom("e1", "button", [100, 100, 200, 40]), dom("e2", "text", [100, 200, 300, 20])],
      [det([100, 100, 200, 40], "control")],
      space,
    );
    expect(result.structureOnly).toEqual(["e2"]);
  });

  it("ignores invisible DOM nodes: hidden nodes explain nothing", () => {
    const result = fuse(
      [{ ...dom("e1", "button", [100, 100, 200, 40]), visible: false }],
      [det([100, 100, 200, 40], "control")],
      space,
    );
    expect(result.matches).toHaveLength(0);
    expect(result.unexplained).toHaveLength(1);
  });

  it("picks the best-overlapping candidate among several", () => {
    const result = fuse(
      [
        dom("e1", "button", [100, 100, 200, 40]),
        dom("e2", "button", [110, 100, 200, 40]),
      ],
      [det([112, 100, 200, 40], "control")],
      space,
    );
    expect(result.matches[0]!.domId).toBe("e2");
  });

  it("empty inputs produce a fully explained scene", () => {
    const result = fuse([], [], space);
    expect(result.explainedAreaFraction).toBe(1);
    expect(result.matches).toHaveLength(0);
  });
});
