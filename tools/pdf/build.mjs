import { readFileSync, writeFileSync } from 'node:fs';
import { marked } from 'marked';

const SRC = process.argv[2];
const OUT = process.argv[3];

const md = readFileSync(SRC, 'utf8');

// Keep mermaid blocks as <pre class="mermaid"> so mermaid can render them in page.
const renderer = new marked.Renderer();
const origCode = renderer.code.bind(renderer);
renderer.code = function (token) {
  const lang = (token.lang || '').trim();
  const text = token.text;
  if (lang === 'mermaid') {
    return `<div class="diagram"><pre class="mermaid">${text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></div>`;
  }
  return origCode(token);
};

marked.setOptions({ renderer, gfm: true, breaks: true });
let body = marked.parse(md);

// Wrap tables so wide ones can shrink instead of overflowing the page.
body = body.replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, '</table></div>');

const mermaidJs = readFileSync(new URL('./node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Dravika Product and Technical Report</title>
<style>
  @page { size: A4 portrait; margin: 16mm 14mm 18mm 14mm; }
  @page wide { size: A4 landscape; margin: 12mm 12mm 14mm 12mm; }
  :root {
    --ink: #16181d;
    --ink-soft: #4a5058;
    --rule: #d6dae0;
    --accent: #1f4e79;
    --accent-soft: #eef3f8;
    --code-bg: #f5f6f8;
  }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: var(--ink);
    font-size: 9.6pt;
    line-height: 1.5;
    margin: 0;
  }

  h1, h2, h3, h4, h5 { color: var(--ink); line-height: 1.22; text-wrap: balance; }
  h1 {
    font-size: 23pt; margin: 0 0 6pt; letter-spacing: -0.4pt;
    border-bottom: 2.5pt solid var(--accent); padding-bottom: 7pt;
    break-before: page; page-break-before: always;
  }
  h1:first-of-type { break-before: avoid; page-break-before: avoid; }
  h2 {
    font-size: 15pt; margin: 22pt 0 8pt; color: var(--accent);
    border-bottom: 0.6pt solid var(--rule); padding-bottom: 4pt;
    break-after: avoid; page-break-after: avoid;
  }
  h3 { font-size: 11.6pt; margin: 15pt 0 5pt; break-after: avoid; page-break-after: avoid; }
  h4 { font-size: 10.2pt; margin: 11pt 0 4pt; color: var(--ink-soft); break-after: avoid; page-break-after: avoid; }

  /* Part headings start a fresh page */
  hr { display: none; }

  p { margin: 0 0 7pt; orphans: 3; widows: 3; }
  ul, ol { margin: 0 0 8pt; padding-left: 16pt; }
  li { margin-bottom: 2.5pt; }
  blockquote {
    margin: 9pt 0; padding: 8pt 12pt;
    background: var(--accent-soft);
    border-left: 3pt solid var(--accent);
    font-style: normal;
  }
  blockquote p:last-child { margin-bottom: 0; }
  strong { font-weight: 650; }
  a { color: var(--accent); text-decoration: none; word-break: break-word; }

  code {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 8.4pt; background: var(--code-bg);
    padding: 0.5pt 3pt; border-radius: 2.5pt;
  }
  pre {
    background: var(--code-bg); border: 0.6pt solid var(--rule);
    border-radius: 4pt; padding: 8pt 10pt; overflow: hidden;
    font-size: 7.6pt; line-height: 1.42;
    white-space: pre-wrap; word-break: break-word;
    break-inside: avoid-page; page-break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: inherit; }

  .tablewrap { break-inside: avoid-page; page-break-inside: avoid; margin: 9pt 0; }
  table { width: 100%; border-collapse: collapse; font-size: 8.2pt; table-layout: auto; }
  th, td { border: 0.5pt solid var(--rule); padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: var(--accent-soft); font-weight: 650; color: var(--accent); }
  tbody tr:nth-child(even) { background: #fafbfc; }
  td code { font-size: 7.4pt; }

  .diagram {
    break-inside: avoid-page; page-break-inside: avoid;
    margin: 12pt 0; padding: 10pt 6pt;
    border: 0.6pt solid var(--rule); border-radius: 5pt;
    background: #fcfcfd; text-align: center;
  }
  .diagram svg { max-width: 100% !important; height: auto !important; }
  pre.mermaid { background: none; border: none; padding: 0; }

  /* Diagrams that are much wider than they are tall get their own landscape
     page, otherwise their labels shrink to an unreadable size on A4 portrait. */
  .diagram.wide {
    page: wide;
    break-before: page; page-break-before: always;
    break-after: page;  page-break-after: always;
  }
  .diagram.wide .caption,
  .diagram .caption {
    font-size: 7.6pt; color: var(--ink-soft); margin-top: 5pt;
    letter-spacing: 0.3pt; text-transform: uppercase;
  }
</style>
</head>
<body>
${body}
<script>${mermaidJs}</script>
<script>
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose',
    htmlLabels: true,
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
    sequence: { useMaxWidth: true },
    themeVariables: {
      fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif',
      fontSize: '13px',
      primaryColor: '#eef3f8',
      primaryTextColor: '#16181d',
      primaryBorderColor: '#1f4e79',
      lineColor: '#5a6470',
      secondaryColor: '#f3f0ea',
      tertiaryColor: '#fbfbfc',
      clusterBkg: '#f7f8fa',
      clusterBorder: '#c9ced6'
    }
  });
  (async () => {
    try {
      await mermaid.run({ querySelector: 'pre.mermaid' });
    } catch (e) {
      document.title = 'MERMAID_ERROR: ' + e.message;
    }
    // Decide orientation per diagram from its rendered aspect ratio.
    document.querySelectorAll('.diagram').forEach((d, i) => {
      const svg = d.querySelector('svg');
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = 'Diagram ' + (i + 1);
      d.appendChild(cap);
      if (!svg) return;
      const vb = svg.viewBox && svg.viewBox.baseVal;
      const w = vb ? vb.width : 0, h = vb ? vb.height : 0;
      if (w && h && w / h > 1.55) d.classList.add('wide');
    });
    document.body.setAttribute('data-ready', '1');
  })();
</script>
</body></html>`;

writeFileSync(OUT, html);
console.log('wrote', OUT, (html.length / 1024 / 1024).toFixed(1) + ' MB');
