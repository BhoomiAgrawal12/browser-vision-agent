# Rebuilding the PDF

The PDF is generated from the Markdown source, so edit the Markdown and re-run this.
Mermaid diagrams are rendered by a real headless Chrome, which is why the output is
vector rather than screenshots.

## Setup

```
npm ci --prefix tools/pdf
```

Mermaid is bundled from the pinned package and inlined into the intermediate HTML.

## Build

```
node tools/pdf/build.mjs docs/REPORT.md /tmp/dravika-report.html
node tools/pdf/print.mjs /tmp/dravika-report.html docs/REPORT.pdf
```

## Notes

- `build.mjs` converts Markdown to HTML, keeps ```mermaid blocks as `<pre class="mermaid">`,
  and carries the print stylesheet (A4, type scale, table and code styling).
- After Mermaid renders, any diagram wider than about 1.55:1 is tagged `.wide` and placed
  on its own A4 landscape page. Without that, wide flowcharts shrink to unreadable labels.
- `print.mjs` starts Chrome with a debugging port, waits for `body[data-ready="1"]`
  (set once every diagram has rendered), then prints with a page-number footer.
- Set `DRAVIKA_BROWSER` when Chrome/Brave is not found at a standard path.
