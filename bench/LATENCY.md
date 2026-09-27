# Local pipeline latency

Measured by `npm run bench:latency` on darwin/arm64, Apple M5, Node v26.7.0. Real code paths; ONNX runs on the single-threaded wasm backend, which is the conservative bound (WebGPU in the browser is faster). Do not edit by hand.

| Stage | p50 (ms) | p95 (ms) | runs |
|---|---|---|---|
| policy.sanitize (12-capture corpus) |     0.33 |     0.69 | 50 |
| egress gate (validate+tripwire+vault+guard) |     0.14 |     0.30 | 100 |
| tile hashing (1024x580) |     0.21 |     0.76 | 50 |
| compose + self-check (8 redactions) |     1.71 |     2.92 | 30 |
| face preprocess (resize+normalize) |     1.01 |     1.17 | 30 |
| face inference (ultraface, ort wasm) |    12.84 |    13.35 | 20 |
| face postprocess (filter+NMS) |     0.01 |     0.02 | 50 |

Sum of single-frame stage p50s (excluding the 12-capture corpus row): **15.9 ms**. The report's local budget target is 175 ms p50.
