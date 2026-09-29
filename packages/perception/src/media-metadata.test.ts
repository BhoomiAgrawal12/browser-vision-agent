import { describe, expect, it } from "vitest";
import { inspectImageMetadata, verifyRasterArtifact } from "./media-metadata.js";

describe("media metadata boundary", () => {
  it("preflights PNG dimensions before any image decoder is started", () => {
    const png = new Uint8Array(45);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    view.setUint32(8, 13);
    png.set([73, 72, 68, 82], 12);
    view.setUint32(16, 100_000);
    view.setUint32(20, 100_000);
    png.set([8, 2, 0, 0, 0], 24);
    view.setUint32(29, 0); // Chunk CRC is irrelevant to the metadata preflight parser.
    view.setUint32(33, 0); // IEND length.
    png.set([73, 69, 78, 68], 37);
    const metadata = inspectImageMetadata(png);
    expect([metadata.width, metadata.height]).toEqual([100_000, 100_000]);
  });

  it("identifies EXIF/XMP, IPTC and comments without returning their contents", () => {
    const jpeg = new Uint8Array([255,216,255,225,0,8,71,80,83,49,50,51,255,237,0,4,88,89,255,254,0,4,65,66,255,217]);
    const report = inspectImageMetadata(jpeg);
    expect(report.removed).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain("GPS123");
    expect(() => verifyRasterArtifact(jpeg)).toThrow();
  });
  it("rejects PDFs and truncated image metadata", () => {
    expect(() => verifyRasterArtifact(new TextEncoder().encode("%PDF-1.7 author secret"))).toThrow();
    expect(() => inspectImageMetadata(new Uint8Array([255,216,255,225,255,255]))).toThrow("Truncated");
  });
});
