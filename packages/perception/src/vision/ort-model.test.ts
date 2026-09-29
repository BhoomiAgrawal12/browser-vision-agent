import { describe, expect, it, vi } from "vitest";
import { createOrtFaceModel, type OrtNamespace } from "./ort-model.js";

describe("verified face backend reporting", () => {
  it("falls back to WASM when a created WebGPU session fails on inference", async () => {
    const providers: string[] = [];
    const ort = {
      env: { wasm: { numThreads: 4 } },
      Tensor: class { constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {} },
      InferenceSession: {
        create: vi.fn(async (_source: string | Uint8Array, options?: { executionProviders?: string[] }) => {
          const provider = options?.executionProviders?.[0] ?? "wasm";
          providers.push(provider);
          return { run: async () => {
            if (provider === "webgpu") throw new Error("GPU graph compilation failed");
            return { scores: { data: new Float32Array(8840) }, boxes: { data: new Float32Array(17680) } };
          } };
        }),
      },
    } as unknown as OrtNamespace;

    const model = await createOrtFaceModel(ort, new Uint8Array([1]), { executionProviders: ["webgpu", "wasm"] });
    expect(model.backend).toBe("webgpu");
    await model.run(new Float32Array(3 * 240 * 320));
    expect(model.backend).toBe("wasm");
    expect(providers).toEqual(["webgpu", "wasm"]);
  });
});
