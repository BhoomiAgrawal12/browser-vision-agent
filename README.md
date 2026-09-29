# Dravika

A privacy-preserving vision agent that runs in your browser. A local eye, a remote brain,
and an unbreakable filter in between.

Designed for privacy-preserving browser task assistance with on-device perception and guarded actions.

## The idea in one paragraph

A browser extension looks at the current page using the DOM, the accessibility tree, and
small on-device vision models. Everything sensitive is destroyed locally before anything
leaves the machine: values become typed placeholders (PII:AADHAAR#1), pixels get flat-filled
on a fresh canvas, and anything that cannot be positively explained is masked by default.
The server receives a formal, versioned Sanitized Context Packet, is told the redaction
scheme in the packet itself, and answers with actions that name element IDs, never
coordinates. One function in the whole codebase is allowed to touch the network.

Full design: [docs/REPORT.md](docs/REPORT.md) (or the [PDF](docs/REPORT.pdf)).

## Layout

```
packages/core        pure TypeScript, zero browser APIs: schemas, detectors, policy, vault, gate, fusion
packages/perception  model loading and inference (WebGPU / WASM)
packages/ui          side panel UI
apps/extension       Chrome MV3 + Firefox builds from one codebase
apps/server          planner service; shares the zod schemas with the client
bench/               RedactBench-Web corpus, red team suite, task runner
docs/                the full report, threat model, data policy
tools/               build utilities
```

## Running the Tier 0 demo

Tier 0 is the structure-only fallback: the DOM and accessibility data drive
the form loop, and PII is caught by validators and checksums. Shield and
Fortress also run the bundled UltraFace face detector locally through
ONNX Runtime Web, preferring WebGPU and falling back to WASM; Wireframe sends
zero pixels. If capture or model assets are unavailable, the structure-only
path remains available and unexplained media stays masked.

```
npm install
npm test                      # workspace tests incl. the end-to-end loop
node bench/demo/serve.mjs     # demo form at http://127.0.0.1:8080
npm run dev # builds the extensions and starts the local planner
npm run build # builds Chrome MV3 and Firefox MV2 extensions
```

Then load the extension:

- **Chrome**: chrome://extensions, enable Developer mode, "Load unpacked",
  pick `apps/extension/dist/chrome`. Click the Dravika toolbar icon to open
  the side panel.
- **Firefox**: about:debugging, "This Firefox", "Load Temporary Add-on",
  pick `apps/extension/dist/firefox/manifest.json`. Open the Dravika sidebar.

Open the demo form, type "Help me complete this form" in the panel, press Run.
Watch the "What the server sees" pane: Aadhaar, email, and phone become typed
placeholders, while detected faces are represented as redacted visual regions;
the 12 digit application reference survives untouched because it fails the
Verhoeff checksum. Every request produces a receipt.

An optional remote planner can be configured through an OpenAI-compatible chat
endpoint. Copy `.env.example` to `.env`, set the endpoint, model and API key,
then run `npm run dev`. The panel identifies local processing separately from
any remote planner. Remote advice receives sanitized context only; form order,
answer collection, validation, confirmation and execution remain locally guarded.
Leave the endpoint unset to use the local heuristic planner. Do not commit `.env`.

## The single-door rule

`npm run check:egress` (part of `npm test`) fails the build if `fetch` or any
other network API appears outside the two allowlisted transport modules. The
EgressGate is the only path to the network, and everything it sends passed a
schema check, a full detector re-scan and a vault leak scan first.

Node 20+ required.

## Local image/PDF inspection

The side panel accepts a local JPEG, PNG, WebP or PDF file (up to 20 MiB, PDF
pages 1–50). Press **Inspect locally** to see the original page alongside a
verified **fully masked** raster and a value-free audit of metadata field names,
OCR/text-region counts, and discarded PDF features. English OCR and model
assets are bundled and SHA-pinned; an integrity or pixel check failure blocks
the media send. **Send sanitized page** sends only the new PNG plus redacted
region descriptors through the existing gate. The original file, extracted
text and metadata values never go to the planner. Full masking prioritizes
privacy over understanding photographs or scanned text.

Run `npm run test:browser` for the isolated Chromium form and media pipeline
checks. See [implementation evidence](docs/IMPLEMENTATION-EVIDENCE.md) for
measured results and limitations. For predictable form steps, use
`PLANNER_MODE=heuristic npm run dev` after stopping any previous planner.
