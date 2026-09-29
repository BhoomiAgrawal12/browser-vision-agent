/** Container inspection returns dimensions and metadata field names, never values. */
export function inspectImageMetadata(bytes: Uint8Array): { format: "jpeg" | "png" | "webp"; removed: string[]; width?: number; height?: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  const removed = new Set<string>();
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    let width: number | undefined;
    let height: number | undefined;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) throw new Error("Malformed JPEG segments");
      const marker = bytes[at + 1]!;
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(at + 2);
      if (length < 2 || at + 2 + length > bytes.length) throw new Error("Truncated JPEG metadata");
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = view.getUint16(at + 5);
        width = view.getUint16(at + 7);
      }
      if (marker === 0xe1) removed.add("EXIF/XMP (including GPS, device, dates and thumbnails)");
      else if (marker === 0xed) removed.add("IPTC/Photoshop metadata");
      else if (marker === 0xfe) removed.add("JPEG comments");
      else if (marker >= 0xe0 && marker <= 0xef) removed.add("JPEG application metadata");
      at += 2 + length;
    }
    return { format: "jpeg", removed: [...removed], ...(width ? { width } : {}), ...(height ? { height } : {}) };
  }
  if (bytes.length >= 8 && ascii(1, 3) === "PNG" && bytes[0] === 137) {
    let at = 8;
    let width: number | undefined;
    let height: number | undefined;
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at);
      const type = ascii(at + 4, 4);
      if (at + 12 + length > bytes.length) throw new Error("Truncated PNG chunk");
      if (type === "IHDR" && length === 13) {
        width = view.getUint32(at + 8);
        height = view.getUint32(at + 12);
      }
      if (!["IHDR", "IDAT", "IEND"].includes(type)) removed.add(type);
      at += length + 12;
      if (type === "IEND") break;
    }
    return { format: "png", removed: [...removed], ...(width ? { width } : {}), ...(height ? { height } : {}) };
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    let width: number | undefined;
    let height: number | undefined;
    for (let at = 12; at + 8 <= bytes.length;) {
      const type = ascii(at, 4);
      const length = view.getUint32(at + 4, true);
      if (at + 8 + length > bytes.length) throw new Error("Truncated WebP chunk");
      if (["EXIF", "XMP ", "ICCP"].includes(type)) removed.add(type.trim());
      if (type === "VP8X" && length >= 10) {
        width = 1 + bytes[at + 12]! + (bytes[at + 13]! << 8) + (bytes[at + 14]! << 16);
        height = 1 + bytes[at + 15]! + (bytes[at + 16]! << 8) + (bytes[at + 17]! << 16);
      } else if (type === "VP8 " && length >= 10 && bytes[at + 11] === 0x9d && bytes[at + 12] === 0x01 && bytes[at + 13] === 0x2a) {
        width = (bytes[at + 14]! | (bytes[at + 15]! << 8)) & 0x3fff;
        height = (bytes[at + 16]! | (bytes[at + 17]! << 8)) & 0x3fff;
      } else if (type === "VP8L" && length >= 5 && bytes[at + 8] === 0x2f) {
        width = 1 + bytes[at + 9]! + ((bytes[at + 10]! & 0x3f) << 8);
        height = 1 + (bytes[at + 10]! >> 6) + (bytes[at + 11]! << 2) + ((bytes[at + 12]! & 0x0f) << 10);
      }
      at += 8 + length + (length % 2);
    }
    return { format: "webp", removed: [...removed], ...(width ? { width } : {}), ...(height ? { height } : {}) };
  }
  throw new Error("Only JPEG, PNG and WebP images are supported");
}

/** Require a freshly rasterized artifact; PDFs/original image containers fail. */
export function verifyRasterArtifact(bytes: Uint8Array): void {
  const metadata = inspectImageMetadata(bytes);
  if (metadata.format !== "png" || metadata.removed.some((name) => !["sRGB", "gAMA", "cHRM", "pHYs"].includes(name))) {
    throw new Error("Sanitized artifact must be a PNG without private metadata");
  }
}
