import { ULTRAFACE_H, ULTRAFACE_W, type FaceModel } from "./ultraface.js";

/**
 * Adapter from an onnxruntime-web namespace to the FaceModel interface.
 * The ort object is injected: the extension panel provides the script-tag
 * global, Node tests import the package. Keeping the dependency inverted
 * means no bundler ever has to swallow onnxruntime-web itself.
 */

export interface OrtNamespace {
  env: { wasm: { numThreads: number; wasmPaths?: string } };
  Tensor: new (
    type: "float32",
    data: Float32Array,
    dims: number[],
  ) => unknown;
  InferenceSession: {
    create(
      source: string | Uint8Array,
      options?: { executionProviders?: string[] },
    ): Promise<{
      run(feeds: Record<string, unknown>): Promise<
        Record<string, { data: unknown }>
      >;
    }>;
  };
}

export interface OrtFaceModelOptions {
  /** Where the ort wasm assets live, e.g. "ort/" inside the extension. */
  wasmPaths?: string;
  /** Try these in order; ort falls through automatically. */
  executionProviders?: string[];
}

export async function createOrtFaceModel(
  ort: OrtNamespace,
  modelSource: string | Uint8Array,
  options: OrtFaceModelOptions = {},
): Promise<FaceModel> {
  // Extension pages are not cross-origin isolated, so no SharedArrayBuffer:
  // single-threaded wasm avoids a noisy failed upgrade path.
  ort.env.wasm.numThreads = 1;
  if (options.wasmPaths) ort.env.wasm.wasmPaths = options.wasmPaths;

  const session = await ort.InferenceSession.create(modelSource, {
    executionProviders: options.executionProviders ?? ["wasm"],
  });

  return {
    async run(input: Float32Array) {
      const output = await session.run({
        input: new ort.Tensor("float32", input, [1, 3, ULTRAFACE_H, ULTRAFACE_W]),
      });
      return {
        scores: output["scores"]!.data as Float32Array,
        boxes: output["boxes"]!.data as Float32Array,
      };
    },
  };
}
