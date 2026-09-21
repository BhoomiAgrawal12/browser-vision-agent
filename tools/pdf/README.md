# Rebuilding the PDF

The PDF is generated from the Markdown source, so edit the Markdown and re-run this.
Mermaid diagrams are rendered by a real headless Chrome, which is why the output is
vector rather than screenshots.

## One time setup

```
cd tools
npm init -y
npm install marked@14 puppeteer-core@23
curl -sL -o mermaid.min.js https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js
```

`mermaid.min.js` is inlined into the intermediate HTML, so the render does not need
a network connection once it is downloaded.

## Build

```
node build.mjs "../SIH2026 On-Device Vision Agent Report.md" report.html
node print.mjs  "$(pwd)/report.html" "../SIH2026 On-Device Vision Agent Report.pdf"
```

## Notes

- `build.mjs` converts Markdown to HTML, keeps ```mermaid blocks as `<pre class="mermaid">`,
  and carries the print stylesheet (A4, type scale, table and code styling).
- After Mermaid renders, any diagram wider than about 1.55:1 is tagged `.wide` and placed
  on its own A4 landscape page. Without that, wide flowcharts shrink to unreadable labels.
- `print.mjs` starts Chrome with a debugging port, waits for `body[data-ready="1"]`
  (set once every diagram has rendered), then prints with a page-number footer.
- Chrome path is hardcoded in `print.mjs` for macOS. Change `CHROME` for another OS.
