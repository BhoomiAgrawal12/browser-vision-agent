import type { Box } from "@kavach/core/schema";

/**
 * The fresh-canvas rule as pure pixel math. We never paint boxes over the
 * original: the output buffer starts life entirely as fill colour, and
 * source pixels are copied in ONLY for spans proven to lie outside every
 * dilated redaction rectangle. A bug in the span logic therefore shows up
 * as missing image, never as leaked pixels.
 *
 * Everything here operates on plain RGBA buffers so the whole module runs
 * and is tested in Node; the browser wrapper only decodes and encodes.
 */

export interface ImageDataLike {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

export interface RedactionRect {
  /** Working-image space. */
  box: Box;
  /** Legend class stamped onto the fill, e.g. "PII:AADHAAR". */
  label?: string;
}

export type Rgb = readonly [number, number, number];

/** Near-black fill: flat, no residual signal, prints well. */
export const FILL_COLOR: Rgb = [16, 18, 22];
/** Stamp colour for the category label drawn on the fill. */
export const STAMP_COLOR: Rgb = [122, 132, 144];

/**
 * Adaptive dilation from the report: text has ascenders, descenders and
 * antialiased fringes, so a glyph-tight box leaks readable edges. Roughly
 * fifteen percent of the box height each side, never less than 2 px.
 */
export function dilation(boxHeight: number): number {
  return Math.max(2, Math.round(boxHeight * 0.15));
}

export function dilate(box: Box, margin: number, width: number, height: number): Box {
  const x1 = Math.max(0, Math.floor(box[0] - margin));
  const y1 = Math.max(0, Math.floor(box[1] - margin));
  const x2 = Math.min(width, Math.ceil(box[0] + box[2] + margin));
  const y2 = Math.min(height, Math.ceil(box[1] + box[3] + margin));
  return [x1, y1, Math.max(0, x2 - x1), Math.max(0, y2 - y1)];
}

export interface ComposeResult {
  image: ImageDataLike;
  /** Dilated, clipped rectangles actually applied, index-aligned with input. */
  appliedRects: Box[];
  /** Where the browser layer may draw category stamps (inside fills only). */
  stampPlacements: { box: Box; label: string }[];
}

/**
 * Compose the sanitized frame. `redactions` are working-image-space rects;
 * each is dilated adaptively before masking.
 */
export function composeSanitized(
  src: ImageDataLike,
  redactions: RedactionRect[],
  fill: Rgb = FILL_COLOR,
): ComposeResult {
  const { width, height } = src;
  const out = new Uint8ClampedArray(src.data.length);

  const appliedRects: Box[] = redactions.map((r) =>
    dilate(r.box, dilation(r.box[3]), width, height),
  );

  // 1. The output begins as pure fill colour everywhere.
  for (let i = 0; i < out.length; i += 4) {
    out[i] = fill[0];
    out[i + 1] = fill[1];
    out[i + 2] = fill[2];
    out[i + 3] = 255;
  }

  // 2. Copy source pixels only into spans outside every redaction.
  for (let y = 0; y < height; y++) {
    // Collect the x-intervals covered by redactions on this row.
    const covered: [number, number][] = [];
    for (const rect of appliedRects) {
      if (rect[2] <= 0 || rect[3] <= 0) continue;
      if (y >= rect[1] && y < rect[1] + rect[3]) {
        covered.push([rect[0], rect[0] + rect[2]]);
      }
    }
    covered.sort((a, b) => a[0] - b[0]);

    let x = 0;
    for (const [cx1, cx2] of covered) {
      if (cx1 > x) copyRowSpan(src, out, y, x, Math.min(cx1, width));
      x = Math.max(x, cx2);
      if (x >= width) break;
    }
    if (x < width) copyRowSpan(src, out, y, x, width);
  }

  const stampPlacements = redactions
    .map((r, i) => ({ box: appliedRects[i]!, label: r.label ?? "" }))
    .filter((p) => p.label && p.box[2] >= 40 && p.box[3] >= 10);

  return { image: { width, height, data: out }, appliedRects, stampPlacements };
}

function copyRowSpan(
  src: ImageDataLike,
  out: Uint8ClampedArray,
  y: number,
  x1: number,
  x2: number,
): void {
  const from = (y * src.width + x1) * 4;
  const to = (y * src.width + x2) * 4;
  out.set(src.data.subarray(from, to), from);
}

export interface VerifyResult {
  ok: boolean;
  failures: { rectIndex: number; x: number; y: number }[];
  pixelsChecked: number;
}

/**
 * The self-check: prove, pixel by pixel, that every redacted rectangle in
 * the composed image contains only fill colour (and optionally stamp
 * colour or fill-stamp blends from antialiased label text). If this fails
 * the frame must not leave the machine.
 */
export function verifyRedactedRegions(
  image: ImageDataLike,
  rects: Box[],
  opts: { fill?: Rgb; stamp?: Rgb | null } = {},
): VerifyResult {
  const fill = opts.fill ?? FILL_COLOR;
  const stamp = opts.stamp === undefined ? STAMP_COLOR : opts.stamp;
  const failures: VerifyResult["failures"] = [];
  let pixelsChecked = 0;

  const lo: Rgb = stamp
    ? [Math.min(fill[0], stamp[0]), Math.min(fill[1], stamp[1]), Math.min(fill[2], stamp[2])]
    : fill;
  const hi: Rgb = stamp
    ? [Math.max(fill[0], stamp[0]), Math.max(fill[1], stamp[1]), Math.max(fill[2], stamp[2])]
    : fill;

  for (const [rectIndex, rect] of rects.entries()) {
    const x1 = Math.max(0, Math.floor(rect[0]));
    const y1 = Math.max(0, Math.floor(rect[1]));
    const x2 = Math.min(image.width, Math.ceil(rect[0] + rect[2]));
    const y2 = Math.min(image.height, Math.ceil(rect[1] + rect[3]));
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        pixelsChecked += 1;
        const i = (y * image.width + x) * 4;
        const r = image.data[i]!;
        const g = image.data[i + 1]!;
        const b = image.data[i + 2]!;
        // Antialiased stamp text blends linearly between fill and stamp,
        // so every legitimate pixel sits channel-wise between the two.
        if (
          r < lo[0] || r > hi[0] ||
          g < lo[1] || g > hi[1] ||
          b < lo[2] || b > hi[2]
        ) {
          if (failures.length < 32) failures.push({ rectIndex, x, y });
        }
      }
    }
  }
  return { ok: failures.length === 0, failures, pixelsChecked };
}
