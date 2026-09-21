import type { ImageDataLike } from "./compose.js";

/**
 * Dirty-region tiling: divide the frame into a grid, hash each tile, and
 * compare against the previous frame. Unchanged frames skip the whole
 * visual pipeline; partially changed frames tell us how much moved.
 * FNV-1a over subsampled pixels: fast, deterministic, no crypto needed
 * (this is change detection, not integrity).
 */

export const DEFAULT_COLS = 16;
export const DEFAULT_ROWS = 9;
/** Sample every Nth pixel in each axis inside a tile. */
const SAMPLE_STRIDE = 4;

export function hashTiles(
  image: ImageDataLike,
  cols: number = DEFAULT_COLS,
  rows: number = DEFAULT_ROWS,
): Uint32Array {
  const hashes = new Uint32Array(cols * rows);
  const tileW = image.width / cols;
  const tileH = image.height / rows;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      let h = 0x811c9dc5;
      const x1 = Math.floor(tx * tileW);
      const y1 = Math.floor(ty * tileH);
      const x2 = Math.floor((tx + 1) * tileW);
      const y2 = Math.floor((ty + 1) * tileH);
      for (let y = y1; y < y2; y += SAMPLE_STRIDE) {
        for (let x = x1; x < x2; x += SAMPLE_STRIDE) {
          const i = (y * image.width + x) * 4;
          // Fold RGB (alpha is always 255 in captures).
          h ^= image.data[i]!;
          h = Math.imul(h, 0x01000193);
          h ^= image.data[i + 1]!;
          h = Math.imul(h, 0x01000193);
          h ^= image.data[i + 2]!;
          h = Math.imul(h, 0x01000193);
        }
      }
      hashes[ty * cols + tx] = h >>> 0;
    }
  }
  return hashes;
}

export interface TileDiff {
  changed: number[];
  changedFraction: number;
}

export function diffTiles(previous: Uint32Array | null, current: Uint32Array): TileDiff {
  if (!previous || previous.length !== current.length) {
    return {
      changed: [...current.keys()],
      changedFraction: 1,
    };
  }
  const changed: number[] = [];
  for (let i = 0; i < current.length; i++) {
    if (previous[i] !== current[i]) changed.push(i);
  }
  return { changed, changedFraction: changed.length / current.length };
}
