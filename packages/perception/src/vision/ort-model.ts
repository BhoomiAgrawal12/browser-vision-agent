import { ULTRAFACE_H, ULTRAFACE_W, type FaceModel } from "./ultraface.js";

/**
 * Adapter from an onnxruntime-web namespace to the FaceModel interface.
 * The ort object is injected: the extension panel provides the script-tag
 * global, Node tests import the package. Keeping the dependency inverted
 * means no bundler ever has to swallow onnxruntime-web itself.
 */

export interface OrtNamespace {
  env: { wasm: { numThreads: number; wasmPaths?: string }; webgpu?: { adapter?: unknown } };
  Tensor: new (
    type: "float32",
    data: Float32Array,
    dims: number[],
  ) => unknown;
  InferenceSession: {
    create(
      source: string | Uint8Array,
      options?: { executionProviders?: string[]; logSeverityLevel?: number },
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
  /** Injected in tests; null disables GPU probing. */
  gpu?: { requestAdapter(): Promise<unknown | null> } | null;
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
    return ort.InferenceSession.create(modelSource, {
      executionProviders: [provider],
      // The vendored model has non-fatal initializer optimization warnings.
      // Keep those out of the browser's extension error log; actual errors remain visible.
      logSeverityLevel: 3,
    });
  };
  for (const provider of providers) {
    try {
      if (provider === "webgpu") {
        const gpu = options.gpu !== undefined ? options.gpu
          : (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } } | undefined)?.gpu;
        const adapter = await gpu?.requestAdapter();
        if (!adapter) continue;
        // Reuse the verified adapter instead of asking ORT to discover one again.
        if (ort.env.webgpu) ort.env.webgpu.adapter = adapter;
      }
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
