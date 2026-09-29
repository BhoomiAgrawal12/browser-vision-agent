/**
 * The blur-recovery attack, self-contained. Demonstrates why Dravika uses
 * destructive flat fills instead of blur: for content drawn from a small
 * known alphabet (digits, in a known font), Gaussian blur preserves
 * enough signal to recover the plaintext by rendering every candidate,
 * blurring it identically, and comparing. A flat fill leaves nothing.
 *
 * Everything is grayscale Float64 buffers; no dependencies.
 */

/* Classic 5x7 bitmap digit font. */
const FONT = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;

export function makeImage(width, height, fill = 1.0) {
  return { width, height, data: new Float64Array(width * height).fill(fill) };
}

/** Draw one digit at (x, y) at integer scale. 0 = ink, 1 = paper. */
export function drawDigit(img, digit, x, y, scale) {
  const rows = FONT[digit];
  for (let gy = 0; gy < GLYPH_H; gy++) {
    for (let gx = 0; gx < GLYPH_W; gx++) {
      if (rows[gy][gx] === "1") {
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x + gx * scale + sx;
            const py = y + gy * scale + sy;
            if (px >= 0 && px < img.width && py >= 0 && py < img.height) {
              img.data[py * img.width + px] = 0;
            }
          }
        }
      }
    }
  }
}

export function cellGeometry(scale, pad) {
  return {
    cellW: GLYPH_W * scale + pad,
    cellH: GLYPH_H * scale + 2 * pad,
  };
}

/** Render a digit string into a fresh image; returns image and cell boxes. */
export function renderDigits(digits, scale = 8, pad = 8) {
  const { cellW, cellH } = cellGeometry(scale, pad);
  const img = makeImage(pad + digits.length * cellW + pad, cellH);
  const cells = [];
  for (let i = 0; i < digits.length; i++) {
    const x = pad + i * cellW;
    drawDigit(img, digits[i], x, pad, scale);
    cells.push({ x, y: 0, w: cellW, h: cellH });
  }
  return { img, cells };
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return { kernel, radius };
}

/** Separable Gaussian blur with edge clamping. */
export function gaussianBlur(img, sigma) {
  const { kernel, radius } = gaussianKernel(sigma);
  const { width, height } = img;
  const tmp = new Float64Array(img.data.length);
  const out = new Float64Array(img.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        acc += img.data[y * width + sx] * kernel[k + radius];
      }
      tmp[y * width + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        acc += tmp[sy * width + x] * kernel[k + radius];
      }
      out[y * width + x] = acc;
    }
  }
  return { width, height, data: out };
}

/** Flat fill a region: what Dravika actually does. */
export function flatFill(img, box, value = 0.07) {
  const out = { width: img.width, height: img.height, data: img.data.slice() };
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      out.data[y * out.width + x] = value;
    }
  }
  return out;
}

function cellDistance(a, b, cell) {
  let sum = 0;
  for (let y = cell.y; y < cell.y + cell.h; y++) {
    for (let x = cell.x; x < cell.x + cell.w; x++) {
      const d = a.data[y * a.width + x] - b.data[y * b.width + x];
      sum += d * d;
    }
  }
  return sum;
}

function expandCell(cell, radius, img) {
  const x = Math.max(0, cell.x - radius);
  const w = Math.min(img.width, cell.x + cell.w + radius) - x;
  return { x, y: cell.y, w, h: cell.h };
}

/**
 * The attack, done the way an attacker would do it. Heavy blur bleeds
 * neighbouring digits into each cell, so isolated-digit probes fail; the
 * fix is coordinate descent: hold the current estimate of every other
 * position fixed, re-render the whole string per candidate, blur it
 * identically, and compare over the cell plus its blur halo. A few
 * sweeps converge. Returns the recovered string and per-cell margins
 * (top-2 score gap relative to the spread).
 */
export function recoverDigits(attacked, cells, scale = 8, pad = 8, sigma = null, passes = 3) {
  const n = cells.length;
  const radius = sigma ? Math.ceil(sigma * 3) : 0;
  const estimate = Array.from({ length: n }, () => "0");
  const margins = new Array(n).fill(0);

  const renderEstimate = () => {
    const { img } = renderDigits(estimate.join(""), scale, pad);
    return sigma ? gaussianBlur(img, sigma) : img;
  };

  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const region = expandCell(cells[i], radius, attacked);
      const scores = [];
      for (const candidate of "0123456789") {
        const previous = estimate[i];
        estimate[i] = candidate;
        scores.push({ candidate, score: cellDistance(attacked, renderEstimate(), region) });
        estimate[i] = previous;
      }
      scores.sort((a, b) => a.score - b.score);
      if (estimate[i] !== scores[0].candidate) {
        estimate[i] = scores[0].candidate;
        changed = true;
      }
      const spread = scores[9].score - scores[0].score;
      margins[i] = spread > 0 ? (scores[1].score - scores[0].score) / spread : 0;
    }
    if (!changed && pass > 0) break;
  }
  return { recovered: estimate.join(""), margins };
}

export function accuracy(recovered, truth) {
  let hits = 0;
  for (let i = 0; i < truth.length; i++) if (recovered[i] === truth[i]) hits++;
  return hits / truth.length;
}
