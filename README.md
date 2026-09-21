# Kavach

A privacy-preserving vision agent that runs in your browser. A local eye, a remote brain,
and an unbreakable filter in between.

Built for SIH 2026 problem statement "On-device Visual Perception for Light-weight Browser
Agents" (ISRO Space Applications Centre).

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

Tier 0 is the structure-only loop: no vision models yet, everything works from
the DOM and accessibility data, PII is caught by validators and checksums.

```
npm install
npm test                      # 127 tests incl. the end-to-end loop
node bench/demo/serve.mjs     # demo form at http://127.0.0.1:8080
npm run dev -w @kavach/server # planner at http://127.0.0.1:8787
npm run build -w @kavach/extension
```

Then load the extension:

- **Chrome**: chrome://extensions, enable Developer mode, "Load unpacked",
  pick `apps/extension/dist/chrome`. Click the Kavach toolbar icon to open
  the side panel.
- **Firefox**: about:debugging, "This Firefox", "Load Temporary Add-on",
  pick `apps/extension/dist/firefox/manifest.json`. Open the Kavach sidebar.

Open the demo form, type "Help me complete this form" in the panel, press Run.
Watch the "What the server sees" pane: the Aadhaar, email, phone and face are
typed placeholders; the 12 digit application reference survives untouched
because it fails the Verhoeff checksum. Every request produces a receipt.

To use a model instead of the deterministic planner, run Ollama and start the
server with `OLLAMA_URL=http://127.0.0.1:11434 npm run dev -w @kavach/server`.

## The single-door rule

`npm run check:egress` (part of `npm test`) fails the build if `fetch` or any
other network API appears outside the two allowlisted transport modules. The
EgressGate is the only path to the network, and everything it sends passed a
schema check, a full detector re-scan and a vault leak scan first.

Node 20+ required.
