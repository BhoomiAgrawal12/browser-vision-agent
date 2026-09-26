import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SCORE_THRESHOLD,
  ULTRAFACE_H,
  ULTRAFACE_W,
  detectFaces,
  postprocess,
  preprocess,
  type FaceModel,
} from "./ultraface.js";
import { ULTRAFACE_MANIFEST, sha256Bytes } from "../models.js";
import type { ImageDataLike } from "../compose.js";

function solidFrame(width: number, height: number, rgb: [number, number, number]): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return { width, height, data };
}

describe("preprocess", () => {
  it("normalizes a solid frame to (value - 127) / 128 in CHW planes", () => {
    const input = preprocess(solidFrame(640, 480, [255, 127, 0]));
    const plane = ULTRAFACE_W * ULTRAFACE_H;
    expect(input.length).toBe(3 * plane);
    expect(input[0]).toBeCloseTo(1); // R plane: (255-127)/128
    expect(input[plane]).toBeCloseTo(0); // G plane: (127-127)/128
    expect(input[2 * plane]).toBeCloseTo(-127 / 128); // B plane
  });

  it("bilinear resize preserves a horizontal gradient monotonically", () => {
    const frame = solidFrame(640, 480, [0, 0, 0]);
    for (let y = 0; y < 480; y++) {
      for (let x = 0; x < 640; x++) {
        frame.data[(y * 640 + x) * 4] = Math.round((x / 639) * 255);
      }
    }
    const input = preprocess(frame);
    const mid = Math.floor(ULTRAFACE_H / 2) * ULTRAFACE_W;
    for (let x = 1; x < ULTRAFACE_W; x++) {
      expect(input[mid + x]!).toBeGreaterThanOrEqual(input[mid + x - 1]!);
    }
  });
});

function tensorsFor(
  entries: { face: number; corners: [number, number, number, number] }[],
): { scores: Float32Array; boxes: Float32Array } {
  const scores = new Float32Array(4420 * 2);
  const boxes = new Float32Array(4420 * 4);
  entries.forEach((e, i) => {
    scores[i * 2] = 1 - e.face;
    scores[i * 2 + 1] = e.face;
    boxes.set(e.corners, i * 4);
  });
  return { scores, boxes };
}

describe("postprocess", () => {
  it("keeps confident detections and scales them to frame space", () => {
    const { scores, boxes } = tensorsFor([
      { face: 0.95, corners: [0.25, 0.25, 0.5, 0.75] },
    ]);
    const faces = postprocess(scores, boxes, 1000, 600);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.box[0]).toBeCloseTo(250);
    expect(faces[0]!.box[1]).toBeCloseTo(150);
    expect(faces[0]!.box[2]).toBeCloseTo(250); // (0.5-0.25)*1000
    expect(faces[0]!.box[3]).toBeCloseTo(300); // (0.75-0.25)*600
  });

  it("drops sub-threshold scores", () => {
    const { scores, boxes } = tensorsFor([
      { face: SCORE_THRESHOLD - 0.05, corners: [0.1, 0.1, 0.2, 0.2] },
    ]);
    expect(postprocess(scores, boxes, 320, 240)).toHaveLength(0);
  });

  it("NMS suppresses overlapping boxes, keeping the highest score", () => {
    const { scores, boxes } = tensorsFor([
      { face: 0.8, corners: [0.11, 0.11, 0.31, 0.31] }, // heavy overlap, lower
      { face: 0.9, corners: [0.1, 0.1, 0.3, 0.3] },
      { face: 0.85, corners: [0.6, 0.6, 0.8, 0.8] }, // disjoint: kept
    ]);
    const faces = postprocess(scores, boxes, 320, 240);
    expect(faces).toHaveLength(2);
    expect(faces[0]!.score).toBeCloseTo(0.9);
    expect(faces[1]!.score).toBeCloseTo(0.85);
  });

  it("clamps boxes to the frame", () => {
    const { scores, boxes } = tensorsFor([
      { face: 0.9, corners: [-0.1, -0.1, 0.5, 1.2] },
    ]);
    const [face] = postprocess(scores, boxes, 100, 100);
    expect(face!.box[0]).toBe(0);
    expect(face!.box[1]).toBe(0);
    expect(face!.box[1] + face!.box[3]).toBeLessThanOrEqual(100);
  });
});

describe("the vendored model", () => {
  const modelPath = fileURLToPath(
    new URL("../../models/ultraface-rfb-320.onnx", import.meta.url),
  );

  it("matches its pinned SHA-256: provenance is a test", async () => {
    const bytes = new Uint8Array(readFileSync(modelPath));
    expect(bytes.length).toBe(ULTRAFACE_MANIFEST.bytes);
    expect(await sha256Bytes(bytes)).toBe(ULTRAFACE_MANIFEST.sha256);
  });

  it("runs real inference and reports no faces on a blank frame", async () => {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(modelPath);
    const model: FaceModel = {
      async run(input) {
        const out = await session.run({
          input: new ort.Tensor("float32", input, [1, 3, ULTRAFACE_H, ULTRAFACE_W]),
        });
        return {
          scores: out["scores"]!.data as Float32Array,
          boxes: out["boxes"]!.data as Float32Array,
        };
      },
    };
    const faces = await detectFaces(solidFrame(640, 480, [180, 180, 180]), model);
    expect(faces).toHaveLength(0);
  }, 30_000);
});
