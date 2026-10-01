import { afterEach, describe, expect, it, vi } from "vitest";
import { BarcodeFormat, QRCodeReader, QRCodeWriter } from "@zxing/library";
import { barcodeRedactionBox, decodeSupportedBarcode, detectBarcodeRegions } from "./barcodes.js";

afterEach(() => vi.restoreAllMocks());

describe("local barcode inspection", () => {
  it("returns no result without console errors for a blank image", () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    expect(decodeSupportedBarcode({ width: 180, height: 180, data: new Uint8ClampedArray(180 * 180 * 4).fill(255) })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("still recognizes a QR code after other readers miss", () => {
    const matrix = new QRCodeWriter().encode("synthetic barcode", BarcodeFormat.QR_CODE, 180, 180, new Map());
    const data = new Uint8ClampedArray(180 * 180 * 4).fill(255);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 180; x++) {
      if (matrix.get(x, y)) data.fill(0, (y * 180 + x) * 4, (y * 180 + x) * 4 + 3);
    }
    const result = decodeSupportedBarcode({ width: 180, height: 180, data })!;
    expect(result.getText()).toBe("synthetic barcode");
    const [left, top, width, height] = barcodeRedactionBox(result, 180, 180);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 180; x++) {
      if (matrix.get(x, y)) expect(x >= left && x < left + width && y >= top && y < top + height).toBe(true);
    }
  });

  it("propagates unexpected decoder failures instead of treating them as a miss", () => {
    vi.spyOn(QRCodeReader.prototype, "decode").mockImplementation(() => { throw new TypeError("decoder defect"); });
    expect(() => decodeSupportedBarcode({ width: 180, height: 180, data: new Uint8ClampedArray(180 * 180 * 4).fill(255) })).toThrow("Local barcode detection failed");
  });

  it("masks a QR region whose damaged data cannot be decoded", () => {
    const matrix = new QRCodeWriter().encode("damaged synthetic private payload", BarcodeFormat.QR_CODE, 180, 180, new Map());
    const data = new Uint8ClampedArray(180 * 180 * 4).fill(255);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 180; x++) if (matrix.get(x, y)) data.fill(0, (y*180+x)*4, (y*180+x)*4+3);
    for (let y = 72; y < 142; y++) for (let x = 72; x < 142; x++) data.fill(255, (y*180+x)*4, (y*180+x)*4+3);
    const image = { width: 180, height: 180, data };
    expect(decodeSupportedBarcode(image)).toBeNull();
    const boxes = detectBarcodeRegions(image);
    expect(boxes.length).toBeGreaterThan(0);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 180; x++) {
      if (data[(y*180+x)*4] === 0) expect(boxes.some(([left, top, width, height]) => x >= left && x < left+width && y >= top && y < top+height)).toBe(true);
    }
  });

  it("covers all QR pixels for multiple codes, including a dense secure-QR-sized payload", () => {
    const width = 680, height = 360;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const codes = [
      { matrix: new QRCodeWriter().encode("small synthetic code", BarcodeFormat.QR_CODE, 180, 180, new Map()), x: 20, y: 30 },
      { matrix: new QRCodeWriter().encode("secure-synthetic-" + "a1B2c3D4".repeat(150), BarcodeFormat.QR_CODE, 300, 300, new Map()), x: 340, y: 30 },
    ];
    for (const { matrix, x: left, y: top } of codes) for (let y = 0; y < matrix.getHeight(); y++) for (let x = 0; x < matrix.getWidth(); x++) {
      if (matrix.get(x, y)) data.fill(0, ((y+top)*width+x+left)*4, ((y+top)*width+x+left)*4+3);
    }
    const boxes = detectBarcodeRegions({ width, height, data });
    expect(boxes.length).toBeGreaterThan(0);
    for (const { matrix, x: left, y: top } of codes) for (let y = 0; y < matrix.getHeight(); y++) for (let x = 0; x < matrix.getWidth(); x++) {
      if (matrix.get(x, y)) expect(boxes.some(([bx, by, bw, bh]) => x+left >= bx && x+left < bx+bw && y+top >= by && y+top < by+bh)).toBe(true);
    }
  });
});
