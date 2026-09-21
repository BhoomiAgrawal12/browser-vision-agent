import { describe, expect, it } from "vitest";
import {
  FILL_COLOR,
  STAMP_COLOR,
  composeSanitized,
  dilate,
  dilation,
  verifyRedactedRegions,
  type ImageDataLike,
  type Rgb,
} from "./compose.js";
import { diffTiles, hashTiles } from "./tiles.js";

/** A test frame filled with a gradient so every pixel is distinctive. */
function makeFrame(width: number, height: number): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function pixel(img: ImageDataLike, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

describe("dilation", () => {
  it("is ~15% of box height with a 2px floor", () => {
    expect(dilation(40)).toBe(6);
    expect(dilation(10)).toBe(2);
    expect(dilation(5)).toBe(2);
  });

  it("dilate clips to the image bounds", () => {
    expect(dilate([0, 0, 10, 10], 5, 100, 100)).toEqual([0, 0, 15, 15]);
    expect(dilate([95, 95, 10, 10], 5, 100, 100)).toEqual([90, 90, 10, 10]);
  });
});

describe("composeSanitized: the fresh-canvas rule", () => {
  it("copies source pixels outside redactions, fill inside", () => {
    const src = makeFrame(100, 60);
    const { image, appliedRects } = composeSanitized(src, [
      { box: [40, 20, 20, 10], label: "PII:EMAIL" },
    ]);
    const rect = appliedRects[0]!;
    // Inside the dilated rect: pure fill.
    const cx = rect[0] + Math.floor(rect[2] / 2);
    const cy = rect[1] + Math.floor(rect[3] / 2);
    expect(pixel(image, cx, cy)).toEqual([...FILL_COLOR]);
    // Well outside: identical to the source.
    expect(pixel(image, 5, 5)).toEqual(pixel(src, 5, 5));
    expect(pixel(image, 95, 55)).toEqual(pixel(src, 95, 55));
  });

  it("dilates the mask beyond the requested box", () => {
    const src = makeFrame(100, 60);
    const { image } = composeSanitized(src, [{ box: [40, 20, 20, 10] }]);
    // 1px outside the requested box but inside the 2px dilation: masked.
    expect(pixel(image, 39, 20)).toEqual([...FILL_COLOR]);
    expect(pixel(image, 60, 30)).toEqual([...FILL_COLOR]);
  });

  it("handles overlapping and edge-clipped redactions", () => {
    const src = makeFrame(80, 40);
    const { image, appliedRects } = composeSanitized(src, [
      { box: [0, 0, 30, 20] },
      { box: [20, 10, 30, 20] },
      { box: [70, 30, 30, 30] }, // spills past both edges
    ]);
    for (const rect of appliedRects) {
      const v = verifyRedactedRegions(image, [rect], { stamp: null });
      expect(v.ok).toBe(true);
    }
    // A corner far from all redactions is untouched.
    expect(pixel(image, 60, 2)).toEqual(pixel(src, 60, 2));
  });

  it("with no redactions the output equals the source", () => {
    const src = makeFrame(50, 30);
    const { image } = composeSanitized(src, []);
    expect(image.data).toEqual(src.data);
  });

  it("emits stamp placements only for rects large enough to label", () => {
    const src = makeFrame(200, 100);
    const { stampPlacements } = composeSanitized(src, [
      { box: [10, 10, 100, 24], label: "PII:AADHAAR" },
      { box: [10, 60, 12, 6], label: "PII:EMAIL" }, // too small
      { box: [120, 10, 60, 24] }, // no label
    ]);
    expect(stampPlacements).toHaveLength(1);
    expect(stampPlacements[0]!.label).toBe("PII:AADHAAR");
  });
});

describe("verifyRedactedRegions: the self-check", () => {
  it("passes a correctly composed frame", () => {
    const src = makeFrame(100, 60);
    const { image, appliedRects } = composeSanitized(src, [{ box: [30, 20, 40, 16] }]);
    const v = verifyRedactedRegions(image, appliedRects);
    expect(v.ok).toBe(true);
    expect(v.pixelsChecked).toBeGreaterThan(0);
  });

  it("FAILS when a source pixel survives inside a claimed redaction", () => {
    const src = makeFrame(100, 60);
    const { image, appliedRects } = composeSanitized(src, [{ box: [30, 20, 40, 16] }]);
    // Simulate the bug class this check exists for: one leaked pixel.
    const rect = appliedRects[0]!;
    const i = ((rect[1] + 3) * image.width + rect[0] + 3) * 4;
    image.data[i] = 250;
    const v = verifyRedactedRegions(image, appliedRects);
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toMatchObject({ rectIndex: 0 });
  });

  it("accepts stamp colour and fill-stamp blends, rejects other colours", () => {
    const blend: Rgb = [
      Math.round((FILL_COLOR[0] + STAMP_COLOR[0]) / 2),
      Math.round((FILL_COLOR[1] + STAMP_COLOR[1]) / 2),
      Math.round((FILL_COLOR[2] + STAMP_COLOR[2]) / 2),
    ];
    const img = makeFrame(10, 10);
    // Paint the whole frame as fill, one stamp pixel, one blend pixel.
    const { image } = composeSanitized(img, [{ box: [0, 0, 10, 10] }]);
    const set = (x: number, y: number, c: Rgb) => {
      const i = (y * 10 + x) * 4;
      image.data[i] = c[0];
      image.data[i + 1] = c[1];
      image.data[i + 2] = c[2];
    };
    set(2, 2, STAMP_COLOR);
    set(3, 3, blend);
    expect(verifyRedactedRegions(image, [[0, 0, 10, 10]]).ok).toBe(true);
    set(4, 4, [255, 0, 0]);
    expect(verifyRedactedRegions(image, [[0, 0, 10, 10]]).ok).toBe(false);
  });
});

describe("tile hashing", () => {
  it("identical frames produce zero changed tiles", () => {
    const a = hashTiles(makeFrame(160, 90));
    const b = hashTiles(makeFrame(160, 90));
    const diff = diffTiles(a, b);
    expect(diff.changed).toHaveLength(0);
    expect(diff.changedFraction).toBe(0);
  });

  it("a localized change dirties only nearby tiles", () => {
    const before = makeFrame(160, 90);
    const after = makeFrame(160, 90);
    // Scribble in one corner region.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        after.data[(y * 160 + x) * 4] = 255;
      }
    }
    const diff = diffTiles(hashTiles(before), hashTiles(after));
    expect(diff.changed.length).toBeGreaterThan(0);
    expect(diff.changedFraction).toBeLessThan(0.1);
    expect(diff.changed).toContain(0); // top-left tile
  });

  it("null previous means everything is dirty", () => {
    const diff = diffTiles(null, hashTiles(makeFrame(160, 90)));
    expect(diff.changedFraction).toBe(1);
  });
});
