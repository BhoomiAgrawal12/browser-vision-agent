import { sha256Hex } from "@kavach/core/gate";
import {
  STAMP_COLOR,
  composeSanitized,
  verifyRedactedRegions,
  type ComposeResult,
  type ImageDataLike,
  type RedactionRect,
  type Rgb,
} from "./compose.js";

/**
 * Browser-only layer: capture, decode, downscale, stamp, encode. All the
 * privacy-bearing math stays in compose.ts where it is unit tested; this
 * file only moves pixels between browser objects.
 */

export interface CaptureFrame {
  image: ImageDataLike;
  /** Downscale factor applied to the raw capture. */
  scale: number;
  /** Raw capture dimensions (device pixels). */
  captureW: number;
  captureH: number;
}

export const WORKING_WIDTH = 1024;

/** Decode a data: URL into bytes without using fetch (egress rule). */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Capture the visible tab and downscale to the working width. Requires
 * the caller to hold the activeTab or tabs permission.
 */
export async function captureVisibleTab(windowId?: number): Promise<CaptureFrame> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const cb = (url?: string) => {
      const err = chrome.runtime.lastError;
      if (err || !url) reject(new Error(err?.message ?? "capture failed"));
      else resolve(url);
    };
    if (windowId !== undefined) {
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }, cb);
    } else {
      chrome.tabs.captureVisibleTab({ format: "png" }, cb);
    }
  });

  const blob = new Blob([dataUrlToBytes(dataUrl) as BlobPart], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, WORKING_WIDTH / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  bitmap.close();

  return {
    image: { width: w, height: h, data: imageData.data },
    scale,
    captureW: bitmap.width,
    captureH: bitmap.height,
  };
}

export interface SanitizedVisual {
  /** WebP bytes of the composed frame. */
  bytes: Uint8Array;
  base64: string;
  sha256: string;
  width: number;
  height: number;
  compose: ComposeResult;
  selfCheck: { ok: boolean; pixelsChecked: number };
}

export class SelfCheckFailed extends Error {
  constructor(detail: string) {
    super(`redaction self-check failed: ${detail}. The frame was not encoded.`);
    this.name = "SelfCheckFailed";
  }
}

function rgbCss(c: Rgb): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * Compose, verify, stamp, verify again, encode. Fail closed: if either
 * verification finds a stray pixel inside a claimed redaction, nothing is
 * encoded and the caller must not send a visual at all.
 */
export async function buildSanitizedVisual(
  frame: CaptureFrame,
  redactions: RedactionRect[],
): Promise<SanitizedVisual> {
  const compose = composeSanitized(frame.image, redactions);

  // Verification 1: pure fill before any stamping.
  const v1 = verifyRedactedRegions(compose.image, compose.appliedRects, { stamp: null });
  if (!v1.ok) {
    const f = v1.failures[0]!;
    throw new SelfCheckFailed(`source pixel at ${f.x},${f.y} in rect ${f.rectIndex}`);
  }

  // Stamp category labels inside the fills, then verify again allowing
  // only fill, stamp and their antialiased blends.
  const canvas = new OffscreenCanvas(compose.image.width, compose.image.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const composed = new Uint8ClampedArray(compose.image.data); // fresh ArrayBuffer for ImageData
  ctx.putImageData(
    new ImageData(composed as ImageDataArray, compose.image.width, compose.image.height),
    0,
    0,
  );
  ctx.fillStyle = rgbCss(STAMP_COLOR);
  ctx.textBaseline = "middle";
  for (const stamp of compose.stampPlacements) {
    const [x, y, w, h] = stamp.box;
    const size = Math.max(9, Math.min(14, Math.floor(h * 0.6)));
    ctx.font = `${size}px system-ui, sans-serif`;
    const text = stamp.label;
    const metrics = ctx.measureText(text);
    if (metrics.width <= w - 8) {
      ctx.fillText(text, x + 4, y + h / 2, w - 8);
    }
  }

  const stamped = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const stampedImage: ImageDataLike = {
    width: canvas.width,
    height: canvas.height,
    data: stamped.data,
  };
  const v2 = verifyRedactedRegions(stampedImage, compose.appliedRects);
  if (!v2.ok) {
    const f = v2.failures[0]!;
    throw new SelfCheckFailed(`post-stamp pixel at ${f.x},${f.y} in rect ${f.rectIndex}`);
  }

  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(bin);
  const sha256 = await sha256Hex(base64);

  return {
    bytes,
    base64,
    sha256,
    width: canvas.width,
    height: canvas.height,
    compose,
    selfCheck: { ok: true, pixelsChecked: v1.pixelsChecked + v2.pixelsChecked },
  };
}
