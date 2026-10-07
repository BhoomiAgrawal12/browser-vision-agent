# @kavach/extension

The Dravika browser extension. It does local perception, applies the
privacy policy and sends requests only through the egress gate. One codebase
builds both Chrome and Firefox.

## Build targets

`build.mjs` produces both targets with esbuild:

| Target          | Manifest | Background            | UI                 |
| --------------- | -------- | --------------------- | ------------------ |
| `dist/chrome`   | MV3      | service worker        | side panel         |
| `dist/firefox`  | MV2      | background page       | sidebar action     |

Extension pages run the on-device models as WebAssembly, so the CSP allows
`'wasm-unsafe-eval'`. Host permissions cover the local planner
(`127.0.0.1:8787` / `localhost:8787`), Microsoft Forms and Google Forms.

The build also copies the offline OCR, PDF and barcode assets and checks
their size and SHA-256 against `media-assets.json`. A mismatch fails the
build. Provenance and licences are listed in [MEDIA_ASSETS.md](MEDIA_ASSETS.md).

## Architecture

```
 side panel (orchestrator)            content script (eyes + hands)
 ─────────────────────────            ─────────────────────────────
 panel/panel.ts                       content/content.ts
   perceive  ───── messages.ts ────►    content/perceive.ts
   sanitize (PolicyEngine + Vault)
   gate (EgressGate + transport.ts) ──► local planner server
   resolve placeholders locally
   re-ground + execute ── messages.ts ► content/execute.ts
```

The orchestration loop runs in the **side panel**, not the background. An
MV3 service worker can be killed at any time, and that would wipe the
in-memory vault. The panel is a real, long-lived page, so the vault
survives. `background/background.ts` only connects the toolbar button to the
panel.

Raw values may cross the panel/content-script boundary
(`shared/messages.ts`), but they never cross the network boundary.

## Source map

### `content/`

- `perceive.ts`: Tier 0 perception. It walks the DOM, including open shadow
  roots, and describes each meaningful node as a `RawRegion`.
- `execute.ts`: the executor. Before touching an element it checks that the
  element still matches the description the plan was made from. If it does
  not, it aborts and the panel perceives the page again. It never guesses.
- `form-controls.ts`: DOM adapters shared by perception, execution and the
  check that runs after input.
- `content.ts`: content-script entry point that wires perceive and execute
  to the message protocol.

### `panel/`

- `panel.ts`: the orchestrator loop (perceive, sanitize, gate, plan,
  resolve, re-ground, execute, repeat) and the panel UI.
- `prompt-memory.ts`: notices when a page clears a value right after the
  executor set it.
- `redaction-audit.ts`: a local-only explanation of what happened to each
  part of the packet. It never contains raw values.
- `file-prompt.ts`: one dialog per upload question. Invalid choices stay in
  the same dialog.
- `visual-preview.ts`: owns the preview URL and its loading, empty, ready
  and error states.
- `sanitized-upload.ts`: uploads only a freshly generated file made from
  verified sanitized pixels.
- `upload-reviewed.ts`: matches the reviewed question against the live page
  instead of the snapshot taken before review.

### `media/`

- `pipeline.ts`: the local image and PDF pipeline: decode, OCR, barcode and
  face detection, masking, then re-encoding.
- `barcodes.ts`: finds QR finder-pattern geometry even when the payload or
  checksum cannot be decoded.
- `assets.ts`: the pinned bytes for every bundled media asset.
- `panel.ts`: the read-only media output in the sidebar.

### Other

- `shared/messages.ts`: the typed message protocol between panel and
  content script.
- `transport.ts`: the extension's only network module. Only the
  `EgressGate` gets an instance of it. It is allowlisted in
  `tools/check-egress.mjs`.

## Loading the build

- **Chrome**: open `chrome://extensions`, turn on Developer mode, click
  "Load unpacked" and choose `dist/chrome`.
- **Firefox**: open `about:debugging`, choose "This Firefox", click "Load
  Temporary Add-on" and choose `dist/firefox/manifest.json`.

## Scripts

```
npm run build -w @kavach/extension         # both targets into dist/
npm test -w @kavach/extension              # vitest + happy-dom unit tests
npm run test:browser -w @kavach/extension  # build, then Chromium form checks
npm run typecheck -w @kavach/extension
```
