/**
 * SHA-pinned model delivery. Model weights are not bundled with the
 * extension (store size limits, review times); they are fetched once,
 * verified against a hash pinned in this source file, cached in the
 * Origin Private File System, and re-verified on every cache read.
 *
 * This module is on the egress allowlist: fetching model bytes from the
 * operator-configured host is the extension's only network use besides
 * the EgressGate transport. A model that fails verification is discarded,
 * never loaded, never cached.
 */

export interface ModelManifest {
  name: string;
  version: string;
  url: string;
  /** Pinned SHA-256 of the exact bytes. Changing a model changes this line. */
  sha256: string;
  bytes: number;
  license: string;
}

/**
 * The registry is intentionally empty until real models are vetted: an
 * entry here is a statement that the exact bytes at that hash were
 * reviewed for licence and provenance. Example shape:
 *
 * {
 *   name: "ultraface-320",
 *   version: "1.0",
 *   url: "https://models.example.org/ultraface-version-RFB-320.onnx",
 *   sha256: "<pinned>",
 *   bytes: 1_263_000,
 *   license: "MIT",
 * }
 */
export const MODEL_REGISTRY: ModelManifest[] = [];

export class ModelVerificationError extends Error {
  constructor(name: string, detail: string) {
    super(`model "${name}" failed verification: ${detail}. The bytes were discarded.`);
    this.name = "ModelVerificationError";
  }
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ModelCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ModelHostDeps {
  fetchBytes: (url: string) => Promise<Uint8Array>;
  cache: ModelCache;
}

export class ModelHost {
  constructor(private readonly deps: ModelHostDeps) {}

  private key(m: ModelManifest): string {
    return `${m.name}@${m.version}`;
  }

  /**
   * Return verified model bytes, from cache when possible. Every path,
   * cached or fetched, ends in a hash comparison against the pinned
   * value; there is no way to obtain unverified bytes from this class.
   */
  async load(manifest: ModelManifest): Promise<Uint8Array> {
    const key = this.key(manifest);

    const cached = await this.deps.cache.get(key);
    if (cached) {
      if ((await sha256Bytes(cached)) === manifest.sha256) return cached;
      // A corrupted or tampered cache entry is evicted, then re-fetched.
      await this.deps.cache.delete(key);
    }

    const fetched = await this.deps.fetchBytes(manifest.url);
    const actual = await sha256Bytes(fetched);
    if (actual !== manifest.sha256) {
      throw new ModelVerificationError(
        manifest.name,
        `expected sha256 ${manifest.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
      );
    }
    await this.deps.cache.put(key, fetched);
    return fetched;
  }
}

/* Browser defaults. */

export function browserFetchBytes(url: string): Promise<Uint8Array> {
  return fetch(url, { redirect: "error" })
    .then((res) => {
      if (!res.ok) throw new Error(`model host returned ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => new Uint8Array(buf));
}

/** OPFS-backed cache; falls back to memory when OPFS is unavailable. */
export function opfsCache(): ModelCache {
  const memory = new Map<string, Uint8Array>();
  const dir = () => navigator.storage.getDirectory();
  const hasOpfs =
    typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;

  if (!hasOpfs) {
    return {
      get: async (k) => memory.get(k) ?? null,
      put: async (k, b) => void memory.set(k, b),
      delete: async (k) => void memory.delete(k),
    };
  }

  const fileName = (key: string) => key.replace(/[^a-zA-Z0-9@.-]/g, "_") + ".bin";
  return {
    async get(key) {
      try {
        const handle = await (await dir()).getFileHandle(fileName(key));
        const file = await handle.getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
    async put(key, bytes) {
      const handle = await (await dir()).getFileHandle(fileName(key), { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as ArrayBuffer);
      await writable.close();
    },
    async delete(key) {
      try {
        await (await dir()).removeEntry(fileName(key));
      } catch {
        // already absent
      }
    },
  };
}

export function defaultModelHost(): ModelHost {
  return new ModelHost({ fetchBytes: browserFetchBytes, cache: opfsCache() });
}
