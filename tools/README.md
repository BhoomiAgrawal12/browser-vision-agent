# tools/

Repo-level scripts for local development, build checks, browser
integration tests, and the generators for the report and deck.

## Scripts

| Script               | Run with                                   | Purpose |
| -------------------- | ------------------------------------------ | ------- |
| `check-egress.mjs`   | `npm run check:egress` (part of `npm test`) | Enforces the single-door rule (see below) |
| `start-local.mjs`    | `npm run dev`                              | Loads `.env` / `.env.local` and starts the planner server |
| `forms-browser.mjs`  | `npm run test:browser -w @kavach/extension` | Runs real Chromium form checks against the built bundles |
| `media-browser.mjs`  | `npm run test:browser`                     | Browser-based image and PDF intake checks |
| `inspect-form.mjs`   | `node tools/inspect-form.mjs <form-url>`    | Read-only dump of form control metadata |

### check-egress.mjs

`fetch`, `XMLHttpRequest`, `new WebSocket` and `navigator.sendBeacon` may
appear only in these allowlisted modules:

- `apps/extension/src/transport.ts`: the extension's egress gate transport
- `apps/server/src/planner/remote.ts`: the optional configured planner
- `packages/perception/src/models.ts`: SHA-pinned model download

The script scans every `.ts`, `.tsx`, `.js` and `.mjs` file under
`packages/` and `apps/`, skipping `node_modules`, `dist` and `*.test.ts`. It
strips comments before matching, so documenting a banned API does not count
as calling it. Any match outside the allowlist fails the build.

### start-local.mjs

This script reads `KEY=value` lines from `.env` and `.env.local` in the repo
root, or from the file named by `DRAVIKA_CONFIG`. It then starts
`apps/server/src/main.ts` under `tsx`. A variable already set in the real
environment wins over the file.

### forms-browser.mjs / media-browser.mjs

These use `playwright-core` to drive an isolated Chromium. They load the
built panel and content bundles and talk to a real local planner. Only the
`chrome.*` messaging is bridged, and no personal browser profile is used.
`media-browser.mjs` checks that the server only ever receives freshly
generated PNGs.

### inspect-form.mjs

This loads a form in a headless browser, injects the built content script
and prints the control metadata (id, role, label, required, invalid and
kind). It never prints current field values and never submits. Set
`DRAVIKA_BROWSER` to choose the browser binary. Run `npm run build` first.

## Subprojects

Each subproject has its own README:

- [`attack-deblur/`](attack-deblur/README.md): shows that blur is not
  redaction by recovering a blurred card number. It runs through
  `npm run demo:deblur`.
- [`pdf/`](pdf/README.md): builds the report PDF from Markdown, with
  Mermaid diagrams rendered in headless Chrome.
- [`deck/`](deck/README.md): builds `docs/Dravika-Product-Deck.pptx`
  with every image generated from the repo itself.

Generated output and browser profiles for these tools are covered by the
root `.gitignore`.
