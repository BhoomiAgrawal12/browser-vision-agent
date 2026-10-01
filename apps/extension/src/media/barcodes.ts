import {
  AztecCodeReader, BarcodeFormat, BinaryBitmap, ChecksumException, DataMatrixReader,
  DecodeHintType, FormatException, HybridBinarizer, MultiFormatOneDReader,
  NotFoundException, PDF417Reader, QRCodeReader, ReaderException, RGBLuminanceSource,
  BitMatrix, type Result, type ResultPoint,
} from "@zxing/library";
import FinderPatternFinder from "@zxing/library/esm/core/qrcode/detector/FinderPatternFinder.js";
import type { ImageDataLike } from "@kavach/perception";
import type { Box } from "@kavach/core/schema";

function pointBox(points: ResultPoint[], width: number, height: number, qr: boolean): Box {
  if (!points.length || points.some((point) => !point || !Number.isFinite(point.getX()) || !Number.isFinite(point.getY()))) return [0, 0, width, height];
  const xs = points.map((point) => point.getX());
  const ys = points.map((point) => point.getY());
  if (qr) {
    if (points.length < 3) return [0, 0, width, height];
    // QR results locate finder centres, not outer edges. Include the missing
    // fourth corner and a conservative border for even the smallest QR version.
    xs.push(xs[0]! + xs[2]! - xs[1]!);
    ys.push(ys[0]! + ys[2]! - ys[1]!);
  }
  const padding = qr ? Math.ceil(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.3) + 4 : 4;
  const left = Math.max(0, Math.floor(Math.min(...xs) - padding));
  const top = Math.max(0, Math.floor(Math.min(...ys) - padding));
  const right = Math.min(width, Math.ceil(Math.max(...xs) + padding));
  const bottom = Math.min(height, Math.ceil(Math.max(...ys) + padding));
  return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
}

export function barcodeRedactionBox(result: Result, width: number, height: number): Box {
  return pointBox(result.getResultPoints(), width, height, result.getBarcodeFormat() === BarcodeFormat.QR_CODE);
}

function bitmapOf(image: ImageDataLike): BinaryBitmap {
  const gray = new Uint8ClampedArray(image.width * image.height);
  for (let i = 0; i < gray.length; i++) gray[i] = (image.data[i * 4]! + image.data[i * 4 + 1]! * 2 + image.data[i * 4 + 2]!) / 4;
  return new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray, image.width, image.height)));
}

function expectedMiss(error: unknown): boolean {
  const kind = error && typeof error === "object" && "getKind" in error && typeof error.getKind === "function" ? error.getKind() : "";
  return error instanceof NotFoundException || error instanceof FormatException || error instanceof ChecksumException || error instanceof ReaderException ||
    ["NotFoundException", "FormatException", "ChecksumException", "ReaderException"].includes(kind);
}

class PrivacyFinder extends FinderPatternFinder {
  hasFinderEvidence(): boolean { return this.getPossibleCenters().some((center) => center.getCount() >= 2); }
}

/** Find QR geometry even when its data/checksum cannot be decoded. */
export function detectBarcodeRegions(image: ImageDataLike): Box[] {
  const bitmap = bitmapOf(image);
  let matrix: BitMatrix;
  try { matrix = bitmap.getBlackMatrix(); } catch (error) {
    if (expectedMiss(error)) return [];
    throw new Error("Local QR localization failed");
  }
  const boxes: Box[] = [];
  const add = (box: Box): void => {
    if (!boxes.some((other) => {
      const intersection = Math.max(0, Math.min(box[0]+box[2], other[0]+other[2])-Math.max(box[0], other[0])) * Math.max(0, Math.min(box[1]+box[3], other[1]+other[3])-Math.max(box[1], other[1]));
      return intersection > Math.min(box[2]*box[3], other[2]*other[3]) * 0.8;
    })) boxes.push(box);
  };
  const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
  for (const inverted of [false, true]) {
    const working = matrix.clone();
    if (inverted) for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) working.flip(x, y);
    for (let count = 0; count < 16; count++) {
      const finder = new PrivacyFinder(working, { foundPossibleResultPoint: () => {} });
      try {
        const info = finder.find(hints);
        const box = pointBox([info.getBottomLeft(), info.getTopLeft(), info.getTopRight()], image.width, image.height, true);
        add(box);
        // Remove found geometry from the search, then look for another code.
        for (let y = box[1]; y < box[1]+box[3]; y++) for (let x = box[0]; x < box[0]+box[2]; x++) working.unset(x, y);
        if (count === 15) return [[0, 0, image.width, image.height]];
      } catch (error) {
        if (!expectedMiss(error)) throw new Error("Local QR localization failed");
        // A credible finder with missing/damaged companions is unresolved
        // sensitive visual content. Withhold the whole frame instead of leaking it.
        if (finder.hasFinderEvidence()) return [[0, 0, image.width, image.height]];
        break;
      }
    }
  }
  // Keep support for other barcode formats. A failed QR decode no longer
  // prevents its geometry from being withheld, and decoded contents stay local.
  const decoded = decodeSupportedBarcode(image);
  if (decoded) add(barcodeRedactionBox(decoded, image.width, image.height));
  return boxes;
}

/** Expected decode misses are normal results, not browser extension errors. */
export function decodeSupportedBarcode(image: ImageDataLike): Result | null {
  const bitmap = bitmapOf(image);
  const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX, BarcodeFormat.PDF_417, BarcodeFormat.AZTEC,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  ]]]);
  // ZXing 0.23's MultiFormatReader logs expected misses as non-ReaderExceptions.
  // Invoke the same supported readers directly so genuine failures still propagate.
  const readers = [new MultiFormatOneDReader(hints), new QRCodeReader(), new DataMatrixReader(), new AztecCodeReader(), new PDF417Reader()];
  for (const reader of readers) {
    try {
      return reader.decode(bitmap, hints);
    } catch (error) {
      if (!expectedMiss(error)) {
        throw new Error("Local barcode detection failed");
      }
    } finally {
      reader.reset();
    }
  }
  return null;
}
