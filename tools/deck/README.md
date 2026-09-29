# Deck generator

Builds `docs/Dravika-Product-Deck.pptx` (22 slides, 16:9) with every image
generated from the repo itself.

## Setup

```
npm ci --prefix tools/deck
```

## Build

```
node gen-assets.mjs    # renders diagrams + prototype screenshots into assets/
node build-deck.mjs    # writes docs/Dravika-Product-Deck.pptx
```

`gen-assets.mjs` drives headless Chrome to render nine flowcharts from the
mermaid sources in docs/REPORT.md, screenshots the demo form (plain and with
composer-style sanitization overlays at real element geometry), screenshots
the built extension panel with representative session state, and runs the
blur attack tool for its images. Set `DRAVIKA_BROWSER` if Chrome/Brave is not
found at a standard Linux or macOS path.

The deck embeds the measured numbers from bench/RESULTS.md and
bench/LATENCY.md; regenerate those first if the pipeline changed.
