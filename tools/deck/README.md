# Deck generator

Builds `docs/Kavach-SIH2026-Deck.pptx` (22 slides, 16:9) with every image
generated from the repo itself.

## One time setup

```
cd tools/deck
npm install
curl -sL -o mermaid.min.js https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js
```

## Build

```
node gen-assets.mjs    # renders diagrams + prototype screenshots into assets/
node build-deck.mjs    # writes docs/Kavach-SIH2026-Deck.pptx
```

`gen-assets.mjs` drives headless Chrome to render nine flowcharts from the
mermaid sources in docs/REPORT.md, screenshots the demo form (plain and with
composer-style sanitization overlays at real element geometry), screenshots
the built extension panel with representative session state, and runs the
blur attack tool for its images. Chrome path is hardcoded for macOS.

The deck embeds the measured numbers from bench/RESULTS.md and
bench/LATENCY.md; regenerate those first if the pipeline changed.
