# @kavach/bench

RedactBench-Web is the evaluation harness for Dravika. It runs the real
policy engine, egress gate and perception code over an annotated corpus and
reports detection quality, redaction quality and per-stage latency.

## Layout

```
src/corpus.ts      annotated captures (ground truth, negatives, severity)
src/evaluate.ts    runs the live policy engine over the corpus
src/scoring.ts     precision/recall/F1, coverage, over-mask, IoU, leak rate
src/run.ts         CLI: evaluates shield and fortress, writes RESULTS.md
src/latency.ts     CLI: per-stage p50/p95 timings, writes LATENCY.md
demo/index.html    demo form used for the manual extension walkthrough
demo/serve.mjs     static server for the demo form
RESULTS.md         generated: detection results per privacy mode
LATENCY.md         generated: local pipeline latency
```

`RESULTS.md` and `LATENCY.md` are generated files. Do not edit them by hand;
run the scripts again instead.

## Corpus

Each capture is a page as the content script sees it: regions with their raw
values, plus human ground truth:

- **Positives**: what must be redacted, and with which PII class.
- **Negatives**: values that must *not* be redacted, such as a 12-digit
  application reference that fails the Verhoeff check. Without negatives,
  precision could not be measured.
- **Severity**: feeds the leak rate.

All personal data is synthetic. Aadhaar values come from the UIDAI published
test range, and names and contacts are invented. v0 works at the structure
level. When pixel captures are added, the same ground-truth schema will gain
image files and pixel-space boxes.

## Metrics

| Metric               | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| Precision/Recall/F1  | Per class, plus a micro average over all classes               |
| Leak rate            | 1 - recall on invariant and high-severity classes              |
| Invariant leaks      | Count of invariant-class misses; this must stay at 0           |
| False alarms         | Redactions of declared negatives                               |
| Coverage             | Share of ground-truth pixels covered by redaction              |
| Over-mask ratio      | Redacted area outside ground truth                             |
| Mean IoU             | Box agreement between predicted and true regions               |

The leak rate is reported separately because a privacy system succeeds or
fails on that number. Every prediction comes from what the pipeline actually
emits, never from an internal debug channel.

## Latency

`latency.ts` times the real code paths: the policy engine, the gate with an
instant transport, tile hashing, compose plus self-check, and UltraFace
inference through onnxruntime-web's single-threaded WASM backend. Running
WASM in Node approximates the extension's WASM fallback, so the numbers are
a conservative upper bound.

## Running

```
npm run bench            # from the repo root: evaluate and rewrite RESULTS.md
npm run bench:latency    # from the repo root: time stages and rewrite LATENCY.md
npm test -w @kavach/bench

node bench/demo/serve.mjs [port]   # demo form, default http://127.0.0.1:8080
```
