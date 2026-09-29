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

  type Session = Awaited<ReturnType<OrtNamespace["InferenceSession"]["create"]>>;
  const providers = [...new Set(options.executionProviders ?? ["wasm"])].filter(
    (provider): provider is "webgpu" | "wasm" => provider === "webgpu" || provider === "wasm",
  );
  let session: Session | undefined;
  let backend: "webgpu" | "wasm" | undefined;
  const create = async (provider: "webgpu" | "wasm"): Promise<Session> => {
    return ort.InferenceSession.create(modelSource, { executionProviders: [provider] });
  };
  for (const provider of providers) {
    try {
      session = await create(provider);
      backend = provider;
      break;
    } catch {
      // Report only the provider that actually created a session.
    }
  }
  if (!session) throw new Error("No local inference backend is available");

  return {
    get backend() { return backend!; },
    async run(input: Float32Array) {
      const feeds = { input: new ort.Tensor("float32", input, [1, 3, ULTRAFACE_H, ULTRAFACE_W]) };
      let output: Awaited<ReturnType<Session["run"]>>;
      try {
        output = await session!.run(feeds);
      } catch (error) {
        if (backend !== "webgpu" || !providers.includes("wasm")) throw error;
        // Some devices expose WebGPU but fail when compiling/running this
        // graph. Fall back on the first inference too, not only session setup.
        session = await create("wasm");
        backend = "wasm";
        output = await session.run(feeds);
      }
      return {
        scores: output["scores"]!.data as Float32Array,
        boxes: output["boxes"]!.data as Float32Array,
      };
    },
  };
}
