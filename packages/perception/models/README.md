# Vendored models

Every file here is pinned by SHA-256 in `src/models.ts` and reviewed for
licence and provenance before being committed. Loading paths verify the
hash; a mismatch refuses to load.

## ultraface-rfb-320.onnx

| | |
|---|---|
| Source | onnx/models (validated), `vision/body_analysis/ultraface/models/version-RFB-320.onnx` |
| Upstream project | Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB |
| Licence | MIT |
| Bytes | 1,270,727 |
| SHA-256 | `34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017` |
| Input | `input` float32 [1, 3, 240, 320], RGB, normalized (x - 127) / 128 |
| Outputs | `scores` [1, 4420, 2] (background, face), `boxes` [1, 4420, 4] normalized corners |

Post-processing (score threshold + NMS) lives in `src/vision/ultraface.ts`
and is unit tested; the graph already decodes prior boxes.
