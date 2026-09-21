/**
 * Checksum primitives. These turn noisy pattern matches into near-certain
 * identifications: a random 12 digit number passes the Verhoeff check about
 * 1 time in 10, so requiring it multiplies precision for Aadhaar detection.
 */

// Verhoeff dihedral group tables (used by Aadhaar).
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

/** True if the digit string (including its final check digit) is Verhoeff-valid. */
export function verhoeffValidate(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c]![P[i % 8]![Number(reversed[i])]!]!;
  }
  return c === 0;
}

/** Compute the Verhoeff check digit to append to a digit string. */
export function verhoeffCheckDigit(digits: string): string {
  if (!/^\d+$/.test(digits)) throw new Error("digits only");
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c]![P[(i + 1) % 8]![Number(reversed[i])]!]!;
  }
  return String(INV[c]);
}

/** True if the digit string (including its final check digit) is Luhn-valid. */
export function luhnValidate(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * GSTIN check character over the first 14 characters. Factors alternate
 * 2,1,2,1... starting with 2 on the 14th character and moving left.
 */
export function gstinCheckChar(first14: string): string {
  if (first14.length !== 14) throw new Error("expected 14 characters");
  let sum = 0;
  let factor = 2;
  for (let i = first14.length - 1; i >= 0; i--) {
    const code = B36.indexOf(first14[i]!);
    if (code < 0) throw new Error(`invalid character ${first14[i]}`);
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 2 ? 1 : 2;
  }
  return B36[(36 - (sum % 36)) % 36]!;
}
