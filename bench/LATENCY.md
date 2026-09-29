# Local pipeline latency

Measured by `npm run bench:latency` on linux/x64, Intel(R) Core(TM) i3-6100U CPU @ 2.30GHz, Node v24.15.0. Real code paths; ONNX runs on the single-threaded wasm backend, which is the conservative bound (WebGPU in the browser is faster). Do not edit by hand.

| Stage | p50 (ms) | p95 (ms) | runs |
|---|---|---|---|
| policy.sanitize (12-capture corpus) |     3.14 |     8.12 | 50 |
| egress gate (validate+tripwire+vault+guard) |     1.11 |     3.96 | 100 |
| tile hashing (1024x580) |     0.37 |     3.90 | 50 |
| compose + self-check (8 redactions) |     9.43 |    63.37 | 30 |
| face preprocess (resize+normalize) |     5.82 |     6.69 | 30 |
| face inference (ultraface, ort wasm) |    54.41 |    64.27 | 20 |
| face postprocess (filter+NMS) |     0.03 |     0.08 | 50 |

Sum of single-frame stage p50s (excluding the 12-capture corpus row): **71.2 ms**. The report's local budget target is 175 ms p50.
