#!/usr/bin/env node
/**
 * The demo: "blur is not redaction, and we can prove it."
 *
 *   node tools/attack-deblur/attack.mjs              run and write images
 *   node tools/attack-deblur/attack.mjs --self-test  assert the outcome
 *
 * A card-like number is rendered, blurred heavily, then recovered by
 * brute force over the digit alphabet. The same attack against Dravika's
 * flat fill recovers nothing but noise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  accuracy,
  flatFill,
  gaussianBlur,
  recoverDigits,
  renderDigits,
} from "./lib.mjs";
import { encodeGrayPng } from "./png.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = join(HERE, "out");
const SELF_TEST = process.argv.includes("--self-test");

// A digit-diverse, Luhn-valid test card: every digit 0-9 must be won on
// signal, not repetition.
const TRUTH = "4539148803436467";
const SCALE = 8;
const PAD = 8;
const SIGMA = 14; // heavy blur: glyph stroke is 8px, kernel radius is 42px

const { img: original, cells } = renderDigits(TRUTH, SCALE, PAD);

// Attack 1: the blurred "redaction" most teams will ship.
const blurred = gaussianBlur(original, SIGMA);
const blurResult = recoverDigits(blurred, cells, SCALE, PAD, SIGMA);
const blurAcc = accuracy(blurResult.recovered, TRUTH);
const blurMargin = blurResult.margins.reduce((a, b) => a + b, 0) / cells.length;

// Attack 2: Dravika's destructive flat fill over the whole number.
const region = {
  x: cells[0].x,
  y: 0,
  w: cells[cells.length - 1].x + cells[cells.length - 1].w - cells[0].x,
  h: original.height,
};
const filled = flatFill(original, region);
const fillResult = recoverDigits(filled, cells, SCALE, PAD, null);
const fillAcc = accuracy(fillResult.recovered, TRUTH);
// The tell that a redaction carries no plaintext signal: every cell ranks
// the candidates identically, so the "recovered" string is one repeated
// digit chosen by geometry alone, independent of what was underneath.
const fillDistinct = new Set(fillResult.recovered).size;

console.log("Blur-recovery attack");
console.log("====================");
console.log(`ground truth:      ${TRUTH}`);
console.log("");
console.log(`GAUSSIAN BLUR (sigma ${SIGMA}):`);
console.log(`  recovered:       ${blurResult.recovered}`);
console.log(`  digit accuracy:  ${(blurAcc * 100).toFixed(0)}%`);
console.log(`  decision margin: ${blurMargin.toFixed(3)} (higher = clearer signal)`);
console.log("");
console.log("FLAT FILL (what Dravika sends):");
console.log(`  recovered:       ${fillResult.recovered}`);
console.log(`  digit accuracy:  ${(fillAcc * 100).toFixed(0)}% (chance level is 10%)`);
console.log(
  `  distinct digits: ${fillDistinct} of ${cells.length} cells: every cell ranks ` +
    "candidates identically, so the fill carries zero information about the plaintext",
);

if (!SELF_TEST) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "1-original.png"), encodeGrayPng(original));
  writeFileSync(join(OUT, "2-blurred.png"), encodeGrayPng(blurred));
  writeFileSync(join(OUT, "3-flat-fill.png"), encodeGrayPng(filled));
  const { img: recoveredImg } = renderDigits(blurResult.recovered, SCALE, PAD);
  writeFileSync(join(OUT, "4-recovered-from-blur.png"), encodeGrayPng(recoveredImg));
  console.log(`\nimages written to ${OUT}`);
}

if (SELF_TEST) {
  const failures = [];
  if (blurAcc !== 1) failures.push(`blur recovery expected 100%, got ${blurAcc * 100}%`);
  if (fillAcc > 0.3) failures.push(`flat fill leaked signal: ${fillAcc * 100}% recovered`);
  if (fillDistinct !== 1) {
    failures.push(
      `flat fill cells recovered ${fillDistinct} distinct digits; ` +
        "content-independent recovery should be constant",
    );
  }
  if (failures.length > 0) {
    console.error("\nSELF-TEST FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("\nself-test passed: blur breaks, flat fill holds");
}
