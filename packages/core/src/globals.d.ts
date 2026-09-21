/**
 * The core package compiles without the DOM lib so browser APIs cannot
 * creep in. These two globals are universal web platform APIs that exist
 * in every target runtime (browsers, workers, Node 20+), declared narrowly
 * here instead of opening the whole DOM surface.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare const crypto: {
  subtle: {
    digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  };
  getRandomValues<T extends Uint8Array>(array: T): T;
};
