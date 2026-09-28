#!/usr/bin/env node
/**
 * Build docs/Evaluation-Evidence-Kit.pdf: for each of the five SIH scoring
 * parameters, every asset option (image, table, chart, stat line, live demo
 * moment) the team can drop into the deck, honestly tagged READY (measured,
 * in repo) or ROADMAP (planned, not yet measured).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const A = (n) => join(HERE, "assets", n);

const b64 = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
const IMG = {
  scenegraph: b64(A("evidence-scenegraph.png")),
  loop: b64(A("diagram-loop.png")),
  recall: b64(A("chart-recall.png")),
  corpus: b64(A("evidence-corpus.png")),
  form: b64(A("proto-form.png")),
  formSan: b64(A("proto-form-sanitized.png")),
  blur1: b64(A("attack-1-original.png")),
  blur2: b64(A("attack-2-blurred.png")),
  blur3: b64(A("attack-3-flat-fill.png")),
  redaction: b64(A("diagram-redaction.png")),
  resource: b64(A("evidence-resource.png")),
  ladder: b64(A("diagram-ladder.png")),
  latency: b64(A("chart-latency.png")),
  panel: b64(A("proto-panel.png")),
};

const opt = (kind, status, title, body) => `
  <div class="opt">
    <div class="opt-head">
      <span class="kind ${kind.toLowerCase().replace(" ", "-")}">${kind}</span>
      <span class="status ${status.toLowerCase()}">${status}</span>
      <span class="opt-title">${title}</span>
    </div>
    ${body}
  </div>`;

const img = (src, cap, h = "70mm") =>
  `<img src="${src}" style="max-height:${h}" alt=""><p class="cap">${cap}</p>`;

const say = (t) => `<p class="say"><b>Say this:</b> ${t}</p>`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Kavach Evaluation Evidence Kit</title>
<style>
  @page { size: A4; margin: 13mm 12mm 16mm 12mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #16181d;
         font-size: 9.5pt; line-height: 1.45; margin: 0; }
  h1 { font-size: 22pt; margin: 0 0 4pt; border-bottom: 2.5pt solid #1f4e79; padding-bottom: 6pt; }
  .metric { break-before: page; }
  .metric-head { background: #1f4e79; color: #fff; border-radius: 6pt; padding: 9pt 13pt; margin-bottom: 9pt; }
  .metric-head h2 { margin: 0; font-size: 15pt; }
  .metric-head .weight { float: right; font-size: 19pt; font-weight: 700; }
  .metric-head p { margin: 3pt 0 0; font-size: 9.5pt; color: #d5e2f0; }
  .opt { border: 0.7pt solid #d6dae0; border-radius: 5pt; padding: 8pt 10pt; margin: 0 0 8pt;
         break-inside: avoid; }
  .opt-head { display: flex; gap: 6pt; align-items: baseline; margin-bottom: 5pt; }
  .kind, .status { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.5pt; padding: 1.5pt 6pt;
                   border-radius: 3pt; color: #fff; white-space: nowrap; }
  .kind { background: #5a6470; }
  .kind.image { background: #1f4e79; } .kind.chart { background: #1f4e79; }
  .kind.table { background: #3d5a3d; } .kind.stat { background: #8a6d1a; }
  .kind.live-demo { background: #7b2d26; } .kind.diagram { background: #1f4e79; }
  .status.ready { background: #3d5a3d; } .status.roadmap { background: #9aa2ad; }
  .opt-title { font-size: 10.5pt; font-weight: 650; }
  img { max-width: 100%; display: block; border: 0.6pt solid #e3e6ea; border-radius: 3pt; }
  .two { display: flex; gap: 8pt; } .two > div { flex: 1; min-width: 0; }
  .cap { font-size: 8pt; color: #5a6470; margin: 3pt 0 0; font-style: italic; }
  .say { font-size: 9pt; margin: 5pt 0 0; color: #16181d; background: #eef3f8;
         padding: 5pt 8pt; border-radius: 3pt; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin: 2pt 0; }
  th, td { border: 0.5pt solid #d6dae0; padding: 3.5pt 6pt; text-align: left; }
  th { background: #eef3f8; color: #1f4e79; }
  ul { margin: 3pt 0; padding-left: 14pt; } li { margin-bottom: 2pt; }
  .cover-note { background: #eef3f8; border-radius: 6pt; padding: 10pt 13pt; margin: 10pt 0; }
  code { font-family: Menlo, monospace; font-size: 8pt; background: #f2f3f5; padding: 1pt 4pt;
         border-radius: 2pt; }
</style></head><body>

<h1>Kavach: Evaluation Evidence Kit</h1>
<p>Every asset the deck can use, organised by the five SIH scoring parameters. Each option is
tagged <b>READY</b> (measured, generated from the repo, drop-in) or <b>ROADMAP</b> (planned,
say it as future work, never as a result). Images live in
<code>tools/deck/assets/</code>; every number regenerates from
<code>npm run bench</code>, <code>npm run bench:latency</code> and
<code>npm run demo:deblur</code>.</p>
<div class="cover-note">
<b>Inventory:</b> 5 stat-tile sets · 6 charts · 4 prototype screenshots · 3 attack images ·
9 rendered flowcharts · 4 benchmark tables · 203 automated tests behind the numbers.<br>
<b>Rule of use:</b> one hero asset per slide plus one table or stat row. Do not stack three
charts on one slide.
</div>

<!-- ================= METRIC 1 ================= -->
<div class="metric">
<div class="metric-head"><span class="weight">25%</span>
<h2>1. Accuracy of visual context from screen</h2>
<p>Does the agent truly understand what is on screen: elements, roles, states, geometry?</p></div>

${opt("IMAGE", "READY", "Option A: the scene-graph overlay (hero asset for this metric)",
  img(IMG.scenegraph,
    "evidence-scenegraph.png: how Kavach sees the demo form. 11 regions with ids, roles and " +
    "states from a ~15 ms DOM + accessibility walk; the photo is flagged unexplained (fail closed).") +
  say("Structure explains the whole form in 15 milliseconds with zero models. Pixels are only " +
      "consulted where structure cannot vouch, and anything unexplained is masked, never guessed."))}

${opt("DIAGRAM", "READY", "Option B: the re-grounding loop",
  img(IMG.loop,
    "diagram-loop.png: before any action, the element is re-verified (exists, same role and " +
    "label, geometry within tolerance). Page changed means abort and re-perceive.", "62mm") +
  say("Accuracy is not just seeing correctly once; it is refusing to act on a stale view."))}

${opt("TABLE", "READY", "Option C: perception mechanisms, each pinned by tests",
  `<table><tr><th>Mechanism</th><th>Evidence</th></tr>
  <tr><td>DOM + accessibility walk with roles, labels, states</td><td>~15 ms, measured; happy-dom test suite</td></tr>
  <tr><td>Open shadow-root traversal, hidden/off-screen filtering</td><td>unit tested</td></tr>
  <tr><td>Vision-to-DOM fusion (IoU + centroid + role compatibility)</td><td>15 fusion tests, DPR-safe coordinates</td></tr>
  <tr><td>On-device face pass on the same frame the composer redacts</td><td>12.8 ms measured, real ONNX in CI</td></tr>
  <tr><td>Unexplained pixels fail closed</td><td>policy tests + red team</td></tr>
  <tr><td>Re-grounding before every action</td><td>executor tests</td></tr></table>`)}

${opt("STAT", "ROADMAP", "Option D: explained-area fraction and grounding accuracy",
  `<p>The report defines <i>explained-area fraction</i> (share of visible pixels accounted for by
  structure) and ScreenSpot-style grounding accuracy on a pixel-annotated corpus. The functions
  ship (<code>fusion.explainedAreaFraction</code>); the pixel-level corpus does not yet.
  Present as the metric we will publish, not a number we have.</p>`)}
</div>

<!-- ================= METRIC 2 ================= -->
<div class="metric">
<div class="metric-head"><span class="weight">20%</span>
<h2>2. Recall and precision for detection of sensitive / PII data</h2>
<p>Catch everything sensitive without crying wolf on lookalikes.</p></div>

${opt("CHART", "READY", "Option A: recall by class with the gaps annotated (hero asset)",
  img(IMG.recall,
    "chart-recall.png: 18 classes on the adversarial corpus; every gap named in place and " +
    "pinned by a CI gate.", "88mm") +
  say("We attacked our own benchmark: unicode dashes, spaced-digit evasions, Hindi labels, " +
      "table splits. It found a real detector bug, we fixed it, and the recall that survived " +
      "is 89.1% with every remaining gap published."))}

${opt("CHART", "READY", "Option B: corpus composition (the demographics)",
  img(IMG.corpus,
    "evidence-corpus.png: 18 captures, 55 positives, 12 declared negatives, all synthetic " +
    "personas.", "58mm"))}

${opt("TABLE", "READY", "Option C: headline detection table",
  `<table><tr><th>Mode</th><th>Micro precision</th><th>Micro recall</th><th>Invariant leaks</th><th>False alarms</th></tr>
  <tr><td><b>Shield</b></td><td><b>100%</b></td><td>89.1%</td><td><b>0</b></td><td><b>0</b></td></tr>
  <tr><td>Fortress</td><td>96.3%</td><td><b>94.5%</b></td><td>0</td><td>1 (appointment date)</td></tr></table>
  <p class="cap">Checksummed classes (Aadhaar, PAN, GSTIN, cards, IFSC): 100/100. Support shown per bar in Option A.</p>`)}

${opt("TABLE", "READY", "Option D: the negatives table (what must NOT be masked)",
  `<table><tr><th>Lookalike</th><th>Why it stays visible</th></tr>
  <tr><td>Order id 784512369014</td><td>12 digits, fails Verhoeff</td></tr>
  <tr><td>Ref 8473&ndash;2619&ndash;0459 (en-dash)</td><td>fails Verhoeff</td></tr>
  <tr><td>Card-shaped 4539 1488 0343 6468</td><td>fails Luhn</td></tr>
  <tr><td>Spaced run 7 8 4 5 1 2 3 6 9 0 1 4</td><td>evasion recognizer checksum-rejects it</td></tr>
  <tr><td>Toll-free 1800-000-000, appointment dates, employee ids</td><td>not personal data</td></tr></table>` +
  say("Precision is only real if something is allowed to stay visible. These are on screen in " +
      "the demo, unmasked, on purpose."))}

${opt("CHART", "ROADMAP", "Option E: ablation chart (regex only vs +checksums vs +context vs +cross-region)",
  `<p>A rising ablation bar chart proving each detector layer earns its place. About a day of
  work on the existing registry; strong add if time allows.</p>`)}
</div>

<!-- ================= METRIC 3 ================= -->
<div class="metric">
<div class="metric-head"><span class="weight">20%</span>
<h2>3. Precision of redaction</h2>
<p>Masks in the right place, tight, and genuinely unrecoverable.</p></div>

${opt("IMAGE", "READY", "Option A: the split screen (hero asset)",
  `<div class="two"><div>${`<img src="${IMG.form}" style="max-height:62mm">`}</div>
  <div>${`<img src="${IMG.formSan}" style="max-height:62mm">`}</div></div>
  <p class="cap">proto-form.png vs proto-form-sanitized.png: flat fills with category stamps at
  real element geometry; the application reference and helpline stay readable (precision, not
  paranoia).</p>` +
  say("What you see on the right is everything the server knows. It has never seen anything else."))}

${opt("IMAGE", "READY", "Option B: the blur-recovery attack (the memorable 30 seconds)",
  `<img src="${IMG.blur1}" style="max-height:16mm"><p class="cap">original</p>
   <img src="${IMG.blur2}" style="max-height:16mm"><p class="cap">blurred far past human readability (sigma 14)</p>
   <img src="${IMG.blur3}" style="max-height:16mm"><p class="cap">what Kavach sends</p>
   <p><b>Attack result:</b> blur &rarr; 16/16 digits recovered (100%). Flat fill &rarr; chance level,
   identical candidate ranking in every cell: zero plaintext information.
   Reproduce live: <code>npm run demo:deblur</code></p>` +
  say("Most teams will blur. Blur is not redaction, and we brought the attack that proves it."))}

${opt("DIAGRAM", "READY", "Option C: the fresh-canvas rule and the self-check",
  img(IMG.redaction,
    "diagram-redaction.png: output starts as fill colour; source pixels are copied only into " +
    "spans proven outside every dilated redaction. A span bug loses image, never leaks it.", "60mm"))}

${opt("TABLE", "READY", "Option D: verification facts",
  `<table><tr><th>Guarantee</th><th>Mechanism</th></tr>
  <tr><td>No source pixel inside a claimed redaction</td><td>pixel-level self-check, run twice (pre and post stamp)</td></tr>
  <tr><td>Antialiased fringes covered</td><td>adaptive dilation, ~15% of text height, 2 px floor</td></tr>
  <tr><td>Self-check failure cannot leak</td><td>frame dropped, structure-only sent; task continues</td></tr>
  <tr><td>What was sent is provable</td><td>sha256 of the exact payload in the signed receipt</td></tr>
  <tr><td>Wireframe mode</td><td>schema itself rejects any pixel payload</td></tr></table>`)}

${opt("STAT", "ROADMAP", "Option E: pixel coverage / over-mask / IoU numbers",
  `<p>The scoring functions ship (<code>bench.scoreRedaction</code>: coverage, over-mask ratio,
  mean IoU) and are unit tested; publishing numbers needs the pixel-annotated corpus. Frame as
  the next benchmark release.</p>`)}
</div>

<!-- ================= METRIC 4 ================= -->
<div class="metric">
<div class="metric-head"><span class="weight">20%</span>
<h2>4. Client-side resource utilisation</h2>
<p>Does it run on an ordinary machine without making the fans scream?</p></div>

${opt("CHART", "READY", "Option A: resource footprint tiles (hero asset)",
  img(IMG.resource, "evidence-resource.png", "62mm") +
  say("One 1.27 MB model, one WASM thread, zero GPU required, and Tier 0 needs no models at " +
      "all. The heavy thinking stays on the server by design."))}

${opt("DIAGRAM", "READY", "Option B: the model ladder",
  img(IMG.ladder,
    "diagram-ladder.png: WebGPU to WASM to structure-only; every rung ships and degrades " +
    "gracefully.", "62mm"))}

${opt("TABLE", "READY", "Option C: measured footprint table",
  `<table><tr><th>Item</th><th>Measured</th></tr>
  <tr><td>Face model (only model shipped)</td><td>1.27 MB, SHA-256 pinned, provenance is a CI test</td></tr>
  <tr><td>Inference CPU cost</td><td>12.8 ms on ONE wasm thread (no GPU assumed)</td></tr>
  <tr><td>Sanitized frame on the wire</td><td>~62 KB WebP at 1024 px; Wireframe packet ~9 KB, zero pixels</td></tr>
  <tr><td>Unchanged frames</td><td>tile hash (0.21 ms) skips the entire visual pipeline</td></tr>
  <tr><td>Whole local pipeline</td><td>15.9 ms CPU per frame, single core</td></tr></table>`)}

${opt("TABLE", "ROADMAP", "Option D: three device classes (low / mid / high)",
  `<p>The report commits to CPU%, heap, battery and host-page FPS impact on three machines
  including a no-GPU laptop. Not yet run; present as the measurement plan, with the M5
  single-thread numbers as the current conservative bound.</p>`)}
</div>

<!-- ================= METRIC 5 ================= -->
<div class="metric">
<div class="metric-head"><span class="weight">15%</span>
<h2>5. Overall end-to-end latency of the provided task</h2>
<p>How long from ask to done?</p></div>

${opt("CHART", "READY", "Option A: the latency waterfall (hero asset)",
  img(IMG.latency, "chart-latency.png: per-stage p50/p95 on real code paths.", "82mm") +
  say("The entire privacy layer costs 15.9 milliseconds against a 175 millisecond budget. " +
      "End-to-end latency is dominated by the remote model, exactly as designed."))}

${opt("TABLE", "READY", "Option B: end-to-end budget vs measured",
  `<table><tr><th>Segment</th><th>Status</th><th>Value</th></tr>
  <tr><td>Local perceive + sanitize + gate (per frame)</td><td>measured</td><td><b>15.9 ms p50</b> (budget 175 ms)</td></tr>
  <tr><td>Policy engine over the full 18-capture corpus</td><td>measured</td><td>0.33 ms</td></tr>
  <tr><td>Network + planner round trip</td><td>design budget</td><td>~0.8 to 1.8 s, model-dominated</td></tr>
  <tr><td>Unchanged-frame iteration</td><td>measured mechanism</td><td>visual pipeline skipped entirely</td></tr></table>`)}

${opt("IMAGE", "READY", "Option C: the panel with live timings",
  img(IMG.panel,
    "proto-panel.png: the activity log prints per-step timings during the demo, so latency is " +
    "observed by the judges, not claimed.", "72mm"))}

${opt("STAT", "ROADMAP", "Option D: wall-clock on the 12 benchmark tasks",
  `<p>Task-level end-to-end timings (cold and warm) across the report's 12 task set, per mode.
  Requires the live-browser run harness; the strongest closing number once measured.</p>`)}

<div class="cover-note" style="margin-top:10pt">
<b>Regenerate everything:</b> <code>npm run bench</code> (detection),
<code>npm run bench:latency</code> (stages), <code>npm run demo:deblur</code> (attack),
<code>node tools/deck/gen-assets.mjs</code> + <code>render-charts.mjs</code> +
<code>gen-evidence.mjs</code> (images), <code>node tools/deck/build-deck.mjs</code> (deck).
All 194 tests must be green first: <code>npm test</code>.
</div>
</div>
</body></html>`;

writeFileSync(join(HERE, "evidence-kit.html"), html);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run",
  "--remote-debugging-port=9429","--user-data-dir="+join(HERE,".chrome-kit"),"about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let browser; for(let i=0;i<40&&!browser;i++){try{browser=await puppeteer.connect({browserURL:"http://127.0.0.1:9429", protocolTimeout: 240000});}catch{await sleep(500);}}
const page = await browser.newPage();
await page.goto("file://"+join(HERE,"evidence-kit.html"),{waitUntil:"load", timeout: 240000});
await sleep(800);
await page.pdf({
  path: join(ROOT, "docs", "Evaluation-Evidence-Kit.pdf"),
  format: "A4", printBackground: true, preferCSSPageSize: true,
  displayHeaderFooter: true, headerTemplate: "<div></div>",
  footerTemplate: `<div style="width:100%;font-size:7pt;color:#8a9099;font-family:Arial;
    padding:0 12mm;display:flex;justify-content:space-between;">
    <span>Kavach · Evaluation Evidence Kit</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  margin: { top: "13mm", bottom: "16mm", left: "12mm", right: "12mm" },
  timeout: 240000,
});
console.log("wrote docs/Evaluation-Evidence-Kit.pdf");
await browser.disconnect(); proc.kill();
