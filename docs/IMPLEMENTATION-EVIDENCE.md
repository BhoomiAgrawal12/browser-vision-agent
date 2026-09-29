# Dravika implementation evidence (29 September 2026)

These measurements describe this repository's current, conservative implementation; they are not a general claim of perfect PII detection or full Microsoft/Google Forms compatibility.

## What ran

- `npm test`: egress single-door check and **240 passing unit tests** across all workspaces.
- `npm run typecheck`: all five workspaces pass. `npm run build` builds Chrome MV3 and Firefox MV2 extensions.
- `npm run test:browser`: isolated Chromium runs of the **built** panel and content scripts against Google- and Microsoft-style form fixtures. A local preflight lists detected questions without displaying values; cancelling it sends no form packet. After approval, each fixture went through eight planner/gate requests, completed fields below the viewport, rejected a bad date before advancing, corrected it with displayed advice, selected choices, required consent for submission, and kept supplied values out of outbound packets. The panel identifies local processing separately from the configured remote planner. This runner bridges Chrome messaging; it is not an installed-extension browser matrix.
- Read-only inspection of the supplied real `forms.cloud.microsoft` page identified the seven visible controls (Date, Name, Aadhaar, Phone, PAN, Specifications, Address) with stable roles, labels and required states. **No real form was submitted or filled in that inspection.**
- Browser media fixtures: visible PII in a PNG, QR payload, injected PNG GPS/author metadata, and a constructed one-page PDF with a rasterized identity-card fixture (Aadhaar, email, phone, PAN), hidden text, author metadata, JavaScript action, embedded attachment, and text annotation. Local OCR/barcode decode, metadata inspection, full-page masking, fresh PNG re-encoding, decoded-pixel verification, panel preview/clear, and the actual gate/server ran. Original filenames, OCR text, hidden text, QR payload, attachment, annotation, and metadata values were absent from outbound packets. These are synthetic browser fixtures, not a real-document corpus.

## Reproducible numbers

`npm run bench` reports the structure-tier RedactBench corpus: **18 synthetic captures**, 55 positive items. Shield: **49 TP, 0 FP, 6 FN, 89.1% recall, 100% precision**. Fortress: **52 TP, 1 FP, 3 FN, 94.5% recall, 98.1% precision**. Both have zero invariant-class leaks. Shield's misses include free-text address, obfuscated email, and context-dependent DOB; Fortress has one false alarm on an appointment date. This corpus does not measure real-world OCR or scanned-document recall.

A single isolated Chromium run of the synthetic media fixtures (warm bundles, no remote model): printed PNG **2,833 ms / 6,673 outbound bytes**; scanned-ID PDF **5,209 ms / 22,553 outbound bytes**. These are single samples, not p50/p95 or memory measurements. The structure-tier latency benchmark on this Linux Intel i3-6100U runner totals **71.2 ms p50** across its measured local stages, including **54.4 ms p50** for face inference on single-thread WASM. Bundled model and OCR weights are approximately **1.27 MB UltraFace ONNX**, **2.95 MB compressed English language data**, **2.86 MB OCR WASM**. Installed-extension memory, representative scanned-PDF recall, OCR false-positive rate, multi-device latency, and task success on real forms are not measured.

## Safety boundary and present limits

- The form loop uses server-guarded sequential plans, local field resolution and post-input DOM verification. The configured LLM cannot override routine form decisions. Validation failures are handled locally; after three rejected corrections the task stops for manual review.
- Media intake accepts local JPEG, PNG, WebP and PDF files only. The versioned packet sends a **fully flat-filled** PNG plus sanitized typed region descriptors, not a selectively readable screenshot/document. This is safe for unknown signatures/IDs, but limits media understanding for the planner. No original image or PDF container is sent.
- JPEG/PNG/WebP metadata fields are inspected; decoding and fresh PNG encoding remove the original container, including hidden thumbnails. PDF.js renders one selected page and extracts local text; annotations, original PDF objects, layers, attachments, JavaScript, hidden/off-page content and revisions are not copied. Only metadata **field names** appear in the local audit.
- Barcode detection is one-code best-effort. Identity-document labeling is currently an OCR keyword cue, not a validated visual classifier; a signature classifier and QR recall measurement are not implemented. Unexplained content remains fully masked. An image pipeline failure blocks media transmission instead of falling back to an original artifact.
- Browser fixtures run with isolated Chromium and the actual gate/server, not a user's logged-in account. Installed Chrome testing is blocked by managed extension policy in this environment; Firefox MV2 builds and typechecks, but no installed Firefox smoke result is claimed.

## Demo recovery

For the deterministic demo, run `PLANNER_MODE=heuristic npm run dev`, load `apps/extension/dist/chrome`, then refresh the target form. The built-in form at `http://127.0.0.1:8080` and `npm run test:browser` offer reproducible fallbacks when a live cloud form changes structure. If a task or media check fails, inspect the Activity/status pane and privacy receipt; blocked content is not sent. Refresh the extension after rebuilding its files.
