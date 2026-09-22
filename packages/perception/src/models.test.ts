import { beforeEach, describe, expect, it } from "vitest";
import {
  ModelHost,
  ModelVerificationError,
  sha256Bytes,
  type ModelCache,
  type ModelManifest,
} from "./models.js";

function memoryCache(): ModelCache & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, b) => void store.set(k, b),
    delete: async (k) => void store.delete(k),
  };
}

const GOOD_BYTES = new TextEncoder().encode("model weights v1");

let manifest: ModelManifest;
let cache: ReturnType<typeof memoryCache>;
let fetchCount: number;
let served: Uint8Array;
let host: ModelHost;

beforeEach(async () => {
  cache = memoryCache();
  fetchCount = 0;
  served = GOOD_BYTES;
  manifest = {
    name: "test-model",
    version: "1.0",
    url: "https://models.example.org/test.onnx",
    sha256: await sha256Bytes(GOOD_BYTES),
    bytes: GOOD_BYTES.length,
    license: "MIT",
  };
  host = new ModelHost({
    fetchBytes: async () => {
      fetchCount += 1;
      return served;
    },
    cache,
  });
});

describe("ModelHost", () => {
  it("fetches, verifies and caches on first load", async () => {
    const bytes = await host.load(manifest);
    expect(bytes).toEqual(GOOD_BYTES);
    expect(fetchCount).toBe(1);
    expect(cache.store.size).toBe(1);
  });

  it("serves from cache without refetching, re-verifying the hash", async () => {
    await host.load(manifest);
    const again = await host.load(manifest);
    expect(again).toEqual(GOOD_BYTES);
    expect(fetchCount).toBe(1);
  });

  it("rejects tampered downloads and caches nothing", async () => {
    served = new TextEncoder().encode("evil weights");
    await expect(host.load(manifest)).rejects.toThrow(ModelVerificationError);
    expect(cache.store.size).toBe(0);
  });

  it("evicts a tampered cache entry and recovers from a clean fetch", async () => {
    await host.load(manifest);
    cache.store.set("test-model@1.0", new TextEncoder().encode("bitrot"));
    const bytes = await host.load(manifest);
    expect(bytes).toEqual(GOOD_BYTES);
    expect(fetchCount).toBe(2); // refetched after eviction
    expect(cache.store.get("test-model@1.0")).toEqual(GOOD_BYTES);
  });

  it("a wrong pin can never load: verification is not optional", async () => {
    manifest.sha256 = "0".repeat(64);
    await expect(host.load(manifest)).rejects.toThrow(/failed verification/);
  });
});

describe("sha256Bytes", () => {
  it("matches the known digest of the empty input", async () => {
    expect(await sha256Bytes(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
