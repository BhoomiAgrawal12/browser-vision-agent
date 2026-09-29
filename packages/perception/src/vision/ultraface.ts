import type { Box } from "@kavach/core/schema";
import type { ImageDataLike } from "../compose.js";

/**
 * UltraFace (version-RFB-320) pre and post-processing as pure functions,
 * so every privacy-bearing decision here runs under Node tests. The ONNX
 * session itself hides behind the FaceModel interface; the browser layer
 * supplies onnxruntime-web, tests supply canned tensors.
 *
 * Model contract (see models/README.md):
 *   input  "input"  float32 [1, 3, 240, 320], RGB, (x - 127) / 128
 *   output "scores" [1, 4420, 2]  (background, face)
 *   output "boxes"  [1, 4420, 4]  normalized corners x1,y1,x2,y2
 */

export const ULTRAFACE_W = 320;
export const ULTRAFACE_H = 240;
const NUM_ANCHORS = 4420;

/** Reference defaults from the upstream implementation. */
export const SCORE_THRESHOLD = 0.7;
export const NMS_IOU = 0.5;

export interface FaceDetection {
  /** Working-image space box [x, y, w, h]. */
  box: Box;
  score: number;
}

export interface FaceModel {
  backend?: "webgpu" | "wasm";
  /** Run the graph on a [1,3,240,320] CHW float tensor. */
  run(input: Float32Array): Promise<{ scores: Float32Array; boxes: Float32Array }>;
}

/**
 * Bilinear-resize an RGBA frame to the model's input and normalize into
 * CHW planes. Pure math: no canvas, so it is testable and identical
 * across environments.
 */
export function preprocess(frame: ImageDataLike): Float32Array {
  const out = new Float32Array(3 * ULTRAFACE_H * ULTRAFACE_W);
  const sx = frame.width / ULTRAFACE_W;
  const sy = frame.height / ULTRAFACE_H;
  const plane = ULTRAFACE_H * ULTRAFACE_W;

  for (let y = 0; y < ULTRAFACE_H; y++) {
    const fy = Math.min(frame.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(frame.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < ULTRAFACE_W; x++) {
      const fx = Math.min(frame.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(frame.width - 1, x0 + 1);
      const wx = fx - x0;

      const i00 = (y0 * frame.width + x0) * 4;
      const i01 = (y0 * frame.width + x1) * 4;
      const i10 = (y1 * frame.width + x0) * 4;
      const i11 = (y1 * frame.width + x1) * 4;
      const idx = y * ULTRAFACE_W + x;

      for (let c = 0; c < 3; c++) {
        const top = frame.data[i00 + c]! * (1 - wx) + frame.data[i01 + c]! * wx;
        const bottom = frame.data[i10 + c]! * (1 - wx) + frame.data[i11 + c]! * wx;
        out[c * plane + idx] = (top * (1 - wy) + bottom * wy - 127) / 128;
      }
    }
  }
  return out;
}

function boxIou(a: readonly number[], b: readonly number[]): number {
  const ix = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
  const iy = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = (a[2]! - a[0]!) * (a[3]! - a[1]!);
  const areaB = (b[2]! - b[0]!) * (b[3]! - b[1]!);
  return inter / (areaA + areaB - inter);
}

/**
 * Score filter + hard NMS, then scale normalized corners into the
 * working-image space of the original frame.
 */
export function postprocess(
  scores: Float32Array,
  boxes: Float32Array,
  frameW: number,
  frameH: number,
  opts: { scoreThreshold?: number; nmsIou?: number } = {},
): FaceDetection[] {
  const threshold = opts.scoreThreshold ?? SCORE_THRESHOLD;
  const nmsIou = opts.nmsIou ?? NMS_IOU;
  const anchors = Math.min(NUM_ANCHORS, scores.length / 2, boxes.length / 4);

  const candidates: { corners: number[]; score: number }[] = [];
  for (let i = 0; i < anchors; i++) {
    const score = scores[i * 2 + 1]!;
    if (score < threshold) continue;
    candidates.push({
      corners: [boxes[i * 4]!, boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!],
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  const kept: typeof candidates = [];
  for (const c of candidates) {
    if (kept.every((k) => boxIou(k.corners, c.corners) <= nmsIou)) kept.push(c);
  }

  return kept.map((k) => {
    const x1 = Math.max(0, Math.min(1, k.corners[0]!)) * frameW;
    const y1 = Math.max(0, Math.min(1, k.corners[1]!)) * frameH;
    const x2 = Math.max(0, Math.min(1, k.corners[2]!)) * frameW;
    const y2 = Math.max(0, Math.min(1, k.corners[3]!)) * frameH;
    return { box: [x1, y1, x2 - x1, y2 - y1] as Box, score: k.score };
  });
}

/** The full stage: preprocess, run, postprocess. */
export async function detectFaces(
  frame: ImageDataLike,
  model: FaceModel,
  opts: { scoreThreshold?: number; nmsIou?: number } = {},
): Promise<FaceDetection[]> {
  const input = preprocess(frame);
  const { scores, boxes } = await model.run(input);
  return postprocess(scores, boxes, frame.width, frame.height, opts);
}
