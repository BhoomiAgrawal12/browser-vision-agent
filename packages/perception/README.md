# @kavach/perception

The visual side of Dravika: screen capture, fresh-canvas redaction,
self-check verification, dirty-region tiling, SHA-pinned model delivery and
local face detection.

All of the privacy decisions are made by pure functions over plain RGBA
buffers, so they run and are tested in Node. The browser-specific files only
capture, decode, encode and move pixels between browser objects.

## Entry points

| Import                             | File                     | Runs in        |
| ---------------------------------- | ------------------------ | -------------- |
| `@kavach/perception`               | `index.ts` (compose + tiles) | Node, browser |
| `@kavach/perception/compose`       | `compose.ts`             | Node, browser  |
| `@kavach/perception/tiles`         | `tiles.ts`               | Node, browser  |
| `@kavach/perception/media-metadata`| `media-metadata.ts`      | Node, browser  |
| `@kavach/perception/models`        | `models.ts`              | browser (OPFS) |
| `@kavach/perception/vision`        | `vision/ultraface.ts`    | Node, browser  |
| `@kavach/perception/vision/ort`    | `vision/ort-model.ts`    | Node, browser  |
| `@kavach/perception/browser`       | `browser.ts`             | browser only   |

## Modules

### compose.ts: the fresh-canvas rule

Redaction never draws boxes over the original image. The output buffer
starts out as solid fill colour, and source pixels are copied in only for
spans proven to lie outside every dilated redaction rectangle. A bug in the
span logic therefore shows up as missing image, never as leaked pixels.

- `dilate()` / `dilation()` grow each rectangle by a margin based on its
  height, so anti-aliased glyph edges do not survive.
- `composeSanitized()` builds the output and can stamp each fill with its
  legend label (for example `PII:AADHAAR`).
- `verifyRedactedRegions()` checks the result after composition. If any
  pixel inside a redacted region is not fill colour, the frame is rejected.

### tiles.ts: change detection

The frame is split into a 16x9 grid and each tile is hashed with FNV-1a over
subsampled pixels. `diffTiles()` compares the hashes with the previous
frame. An unchanged frame skips the whole visual pipeline. This is change
detection, not integrity checking, so no cryptographic hash is needed.

### media-metadata.ts

`inspectImageMetadata()` walks JPEG, PNG and WebP containers. It returns
dimensions and the **names** of the metadata blocks being discarded (EXIF,
XMP, IPTC, comments, ...), never their values. `verifyRasterArtifact()`
accepts only a freshly rasterized PNG. Apart from colour-space chunks (`sRGB`,
`gAMA`, `cHRM`, `pHYs`) it must have no metadata left in it, and PDFs or
original containers are rejected.

### models.ts: SHA-pinned model delivery

Model weights are not bundled with the extension.

1. Fetch the model once from the configured host.
2. Check the bytes against the SHA-256 pinned in `MODEL_REGISTRY`.
3. Cache them in the Origin Private File System.
4. Check the hash again on every cache read.

A model that fails the check is discarded, never loaded and never cached.
This module is on the egress allowlist in `tools/check-egress.mjs`.

### vision/

- `ultraface.ts` holds UltraFace RFB-320 pre-processing (RGB 320x240,
  `(x - 127) / 128`) and post-processing (score threshold 0.7, NMS IoU 0.5)
  as pure functions. The model sits behind the `FaceModel` interface.
- `ort-model.ts` adapts an injected `onnxruntime-web` namespace to
  `FaceModel`. Because the namespace is injected, the bundler never has to
  include onnxruntime-web itself. In the browser it runs on the CPU/WASM
  backend and does not need a GPU.

### browser.ts

`captureVisibleTab()` captures the visible tab and downscales it to a
1024px working width. `buildSanitizedVisual()` runs compose and verify, then
encodes the result. If verification fails it throws `SelfCheckFailed`
instead of returning an image.

## Models

The vendored weights, their licences and their hashes are listed in
[`models/README.md`](models/README.md).

## Scripts

```
npm test -w @kavach/perception
npm run typecheck -w @kavach/perception
```
