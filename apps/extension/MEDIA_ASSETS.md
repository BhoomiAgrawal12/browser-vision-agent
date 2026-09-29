# Offline media assets

All files below are copied from exact versions in `package-lock.json` into the
extension build. `build.mjs` verifies both byte size and SHA-256 against
`media-assets.json`; the browser independently verifies every asset before
media processing via the model host's pinned hash check. A corrupt file blocks
processing. No OCR model download is performed at runtime.

| Asset | Upstream package/version | License |
|---|---|---|
| English traineddata (best_int) | `@tesseract.js-data/eng@1.0.0` | MIT |
| OCR worker | `tesseract.js@7.0.0` | Apache-2.0 |
| OCR core JS + WASM | `tesseract.js-core@7.0.0` | Apache-2.0 |
| PDF.js worker | `pdfjs-dist@6.3.289` | Apache-2.0 |
| ZXing barcode runtime (bundled) | `@zxing/library@0.23.0` | Apache-2.0 |
| UltraFace ONNX | Pinned separately in `packages/perception/models/README.md` | MIT |

The English traineddata is an OCR aid, not a proof of recall. The current media
pipeline masks all pixels regardless of OCR/barcode/model results; it does not
claim to detect every document or signature.
