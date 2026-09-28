#!/usr/bin/env node
/**
 * Build the Kavach SIH deck: docs/Kavach-SIH2026-Deck.pptx
 * Everything embedded is generated from the repo itself: diagrams from the
 * report's mermaid sources, screenshots of the running prototype, images
 * from the blur attack, and the measured numbers from bench/.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Pptx from "pptxgenjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const A = (name) => join(HERE, "assets", name);

/* palette */
const INK = "16181D";
const NAVY = "1F4E79";
const RED = "7B2D26";
const GREEN = "3D5A3D";
const SOFT = "5A6470";
const BG_SOFT = "EEF3F8";
const RULE = "D6DAE0";
const FONT = "Arial";

const W = 13.33;
const H = 7.5;

function pngSize(path) {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** Fit an image into a box, centered, preserving aspect. */
function fit(path, x, y, boxW, boxH) {
  const { w, h } = pngSize(path);
  const scale = Math.min(boxW / w, boxH / h);
  const outW = w * scale;
  const outH = h * scale;
  return { path, x: x + (boxW - outW) / 2, y: y + (boxH - outH) / 2, w: outW, h: outH };
}

const pptx = new Pptx();
pptx.defineLayout({ name: "WIDE", width: W, height: H });
pptx.layout = "WIDE";
pptx.author = "Team Kavach";
pptx.title = "Kavach: On-Device Visual Perception for Light-weight Browser Agents";

pptx.defineSlideMaster({
  title: "BODY",
  background: { color: "FFFFFF" },
  objects: [
    { rect: { x: 0, y: 0, w: W, h: 0.09, fill: { color: NAVY } } },
    {
      text: {
        text: "KAVACH",
        options: {
          x: W - 1.4, y: H - 0.42, w: 1.1, h: 0.3, fontFace: FONT, fontSize: 9,
          color: SOFT, align: "right", charSpacing: 3,
        },
      },
    },
  ],
  slideNumber: { x: 0.35, y: H - 0.42, fontFace: FONT, fontSize: 9, color: SOFT },
});

function slide() {
  return pptx.addSlide({ masterName: "BODY" });
}

function title(s, kicker, main) {
  s.addText(kicker.toUpperCase(), {
    x: 0.55, y: 0.28, w: 12.2, h: 0.3, fontFace: FONT, fontSize: 11,
    color: NAVY, bold: true, charSpacing: 2,
  });
  s.addText(main, {
    x: 0.5, y: 0.55, w: 12.3, h: 0.62, fontFace: FONT, fontSize: 26,
    color: INK, bold: true,
  });
}

function bullets(s, items, opts = {}) {
  const runs = [];
  for (const item of items) {
    if (typeof item === "string") {
      runs.push({
        text: item,
        options: { bullet: { code: "2022", indent: 12 }, breakLine: true, fontSize: opts.size ?? 13.5, color: INK },
      });
    } else {
      runs.push({
        text: item.t,
        options: {
          bullet: item.sub ? { code: "2013", indent: 10 } : { code: "2022", indent: 12 },
          indentLevel: item.sub ? 1 : 0,
          breakLine: true,
          fontSize: item.size ?? (item.sub ? 12 : opts.size ?? 13.5),
          color: item.color ?? (item.sub ? SOFT : INK),
          bold: item.bold ?? false,
        },
      });
    }
  }
  s.addText(runs, {
    x: opts.x ?? 0.55, y: opts.y ?? 1.45, w: opts.w ?? 6.1, h: opts.h ?? 5.4,
    fontFace: FONT, valign: "top", lineSpacingMultiple: 1.18,
  });
}

function tag(s, x, y, w, text, color = NAVY) {
  s.addText(text, {
    x, y, w, h: 0.32, fontFace: FONT, fontSize: 10.5, bold: true, color: "FFFFFF",
    fill: { color }, align: "center", valign: "middle",
  });
}

const g2 = (t) => ({ text: t, options: { fontFace: FONT, fontSize: 10.5, valign: "middle", color: "3D5A3D", bold: true } });
const th = { fontFace: FONT, fontSize: 11, bold: true, color: "FFFFFF", fill: { color: NAVY }, valign: "middle" };
const td = { fontFace: FONT, fontSize: 10.5, color: INK, valign: "middle" };

/* ============ 1. Title ============ */
{
  const s = pptx.addSlide();
  s.background = { color: NAVY };
  s.addText("KAVACH", {
    x: 0.8, y: 2.1, w: 11.7, h: 1.1, fontFace: FONT, fontSize: 60, bold: true,
    color: "FFFFFF", charSpacing: 6,
  });
  s.addText("A local eye. A remote brain. An unbreakable filter in between.", {
    x: 0.85, y: 3.25, w: 11.6, h: 0.5, fontFace: FONT, fontSize: 20, color: "C9D8E8", italic: true,
  });
  s.addText(
    "SIH 2026  |  On-Device Visual Perception for Light-weight Browser Agents\n" +
      "Problem statement by ISRO, Space Applications Centre (SAC), Ahmedabad",
    { x: 0.85, y: 4.35, w: 11.6, h: 0.8, fontFace: FONT, fontSize: 14, color: "E8EEF5" },
  );
  s.addText(
    "Working prototype  |  github.com/BhoomiAgrawal12/browser-vision-agent  |  203 automated tests",
    { x: 0.85, y: 6.6, w: 11.6, h: 0.4, fontFace: FONT, fontSize: 12, color: "9FB4CB" },
  );
}

/* ============ 2. Problem ============ */
{
  const s = slide();
  title(s, "The problem", "AI browser agents see everything, and send everything");
  bullets(s, [
    { t: "Agentic AI needs the user's visual context (the screen) to help with real workflows.", },
    { t: "Today's agents (Operator, computer-use APIs) ship raw screenshots to cloud servers:", },
    { t: "passwords, Aadhaar and PAN numbers, faces, bank balances all leave the machine", sub: true },
    { t: "unacceptable for government, banking, healthcare and enterprise use", sub: true },
    { t: "Local machines cannot host a full reasoning pipeline; the cloud brain is still needed.", },
    { t: "The PS asks for the bridge: a browser-local vision agent that sanitizes everything sensitive BEFORE any network request, feeding a redaction-aware server.", bold: true },
  ], { w: 7.1 });
  s.addText("Evaluation weights", {
    x: 8.0, y: 1.5, w: 4.7, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: NAVY,
  });
  s.addTable(
    [
      [{ text: "Metric", options: th }, { text: "Weight", options: th }],
      [{ text: "Accuracy of visual context", options: td }, { text: "25%", options: td }],
      [{ text: "PII detection recall + precision", options: td }, { text: "20%", options: td }],
      [{ text: "Precision of redaction", options: td }, { text: "20%", options: td }],
      [{ text: "Client resource utilisation", options: td }, { text: "20%", options: td }],
      [{ text: "End-to-end latency", options: td }, { text: "15%", options: td }],
    ],
    { x: 8.0, y: 1.9, w: 4.7, colW: [3.5, 1.2], border: { pt: 0.5, color: RULE }, rowH: 0.42 },
  );
  s.addText("40% of the marks are privacy quality. Both are measurable. We measured them.", {
    x: 8.0, y: 4.9, w: 4.7, h: 0.9, fontFace: FONT, fontSize: 12.5, italic: true, color: RED,
  });
}

/* ============ 3. Solution ============ */
{
  const s = slide();
  title(s, "Our solution", "Redaction is not a filter. It is a contract.");
  const cards = [
    ["1. The wire format is a specification", "Every redacted value becomes a typed placeholder (PII:AADHAAR#1). The packet carries its own redaction legend, so the server knows exactly what kind of value is absent from every slot."],
    ["2. Unknown means sensitive", "We never ask \"is this PII?\". We ask \"can this region be positively explained as safe?\" and mask when the answer is no. Fail closed, never open."],
    ["3. Nothing leaves without passing one door", "Exactly one function in the codebase may touch the network. The build fails if fetch appears anywhere else. Every payload is re-scanned at the door."],
    ["4. Every claim is measured", "Purpose-built benchmark, red team suite, latency waterfall, privacy receipts. Numbers, not vibes, and the numbers are CI gates."],
  ];
  cards.forEach(([head, body], i) => {
    const x = 0.55 + (i % 2) * 6.25;
    const y = 1.55 + Math.floor(i / 2) * 2.75;
    s.addShape("rect", { x, y, w: 5.95, h: 2.5, fill: { color: BG_SOFT }, line: { color: RULE, width: 0.75 } });
    s.addText(head, { x: x + 0.25, y: y + 0.18, w: 5.5, h: 0.4, fontFace: FONT, fontSize: 14.5, bold: true, color: NAVY });
    s.addText(body, { x: x + 0.25, y: y + 0.62, w: 5.5, h: 1.75, fontFace: FONT, fontSize: 11.5, color: INK, lineSpacingMultiple: 1.12 });
  });
}

/* ============ 4. Architecture ============ */
{
  const s = slide();
  title(s, "System architecture", "Local eye, remote brain, one door between them");
  s.addImage(fit(A("diagram-arch.png"), 0.4, 1.35, 12.5, 5.7));
}

/* ============ 5. Trust boundary ============ */
{
  const s = slide();
  title(s, "The trust boundary", "What may cross, and what never can");
  s.addImage(fit(A("diagram-boundary.png"), 0.4, 1.3, 9.0, 5.8));
  bullets(s, [
    { t: "The real URL never leaves: it can carry account numbers and session tokens. Only an origin class (\"banking\", \"government\") crosses.", },
    { t: "Cookies, input values and the token-to-value vault are unrepresentable in the wire schema.", },
    { t: "Wireframe mode: the schema itself rejects any pixel payload. Zero-pixel egress is provable, not probabilistic.", bold: true },
  ], { x: 9.55, y: 1.7, w: 3.35, size: 11.5 });
}

/* ============ 6. Perception ============ */
{
  const s = slide();
  title(s, "Perception pipeline", "Structure first, vision for the gaps, fail closed on the rest");
  s.addImage(fit(A("diagram-perception.png"), 0.4, 1.3, 10.2, 5.9));
  bullets(s, [
    { t: "DOM + accessibility tree explain ~90% of a form page in ~15 ms.", },
    { t: "Vision runs on the pixels structure cannot vouch for.", },
    { t: "A region no channel explains is UNEXPLAINED and gets masked. Risk and accuracy share one insight.", bold: true },
  ], { x: 10.7, y: 1.7, w: 2.3, size: 10.5 });
}

/* ============ 7. Policy engine ============ */
{
  const s = slide();
  title(s, "Policy and redaction engine", "Four independent guards, one invariant floor");
  s.addImage(fit(A("diagram-policy.png"), 0.4, 1.3, 10.2, 5.9));
  bullets(s, [
    { t: "Structural, pattern+checksum, semantic and visual evidence combine into a confidence score.", },
    { t: "The invariant floor redacts credentials, government IDs and faces in every mode, whatever the user picks.", },
    { t: "Amounts become magnitude buckets; secrets hide even their length.", },
  ], { x: 10.7, y: 1.7, w: 2.3, size: 10.5 });
}

/* ============ 8. Indian identifier pack ============ */
{
  const s = slide();
  title(s, "Precision weapon", "Indian identifiers validated by real checksums");
  s.addTable(
    [
      [
        { text: "Identifier", options: th }, { text: "Validation", options: th },
        { text: "Identifier", options: th }, { text: "Validation", options: th },
      ],
      [
        { text: "Aadhaar", options: td }, { text: "Verhoeff checksum", options: td },
        { text: "Payment cards", options: td }, { text: "Luhn + network prefix", options: td },
      ],
      [
        { text: "PAN", options: td }, { text: "Holder-type position rules", options: td },
        { text: "Mobile (IN)", options: td }, { text: "Prefix rules + normalization", options: td },
      ],
      [
        { text: "GSTIN", options: td }, { text: "Check char + embedded PAN", options: td },
        { text: "PIN code", options: td }, { text: "Range + label context gate", options: td },
      ],
      [
        { text: "IFSC", options: td }, { text: "Structural rule (5th char 0)", options: td },
        { text: "UPI VPA", options: td }, { text: "PSP handle allowlist", options: td },
      ],
      [
        { text: "Vehicle reg.", options: td }, { text: "State codes + BH series", options: td },
        { text: "Email / DOB", options: td }, { text: "Shape + context boosting", options: td },
      ],
    ],
    { x: 0.55, y: 1.5, w: 12.2, border: { pt: 0.5, color: RULE }, rowH: 0.5 },
  );
  bullets(s, [
    { t: "A checksum turns a noisy pattern match into near-certainty: a random 12-digit number passes Verhoeff about 1 time in 10.", },
    { t: "Order id 784512369014 fails Verhoeff and stays visible; Aadhaar 9999 4105 7058 passes and is destroyed. Recall AND precision.", bold: true },
    { t: "Split values are caught too: an Aadhaar spread across two spans on one line is reassembled by the cross-region scan and both spans are redacted.", },
    { t: "All checksum implementations verified against published vectors (UIDAI test UID, sample GSTIN, canonical test cards).", },
  ], { y: 4.85, w: 12.2, size: 12.5 });
}

/* ============ 9. Wire contract ============ */
{
  const s = slide();
  title(s, "The wire contract", "The Sanitized Context Packet tells the server what it cannot see");
  const snippet = [
    '"policy":   { "mode": "shield", "invariant_floor": true },',
    '"origin":   { "class": "government", "tls": true },        // never the hostname',
    '"visual":   { "present": true, "sha256": "9f2c1a...",      // hash-verified at the gate',
    '              "regions_redacted": 7 },',
    '"elements": [',
    '  { "id": "e2", "role": "textbox", "label": "Aadhaar Number",',
    '    "value": { "kind": "placeholder", "token": "PII:AADHAAR#1",',
    '               "format_valid": true },',
    '    "evidence": ["structural:aria-label", "pattern:aadhaar-verhoeff"] },',
    '  { "id": "e10", "role": "textbox", "label": "PIN Code",',
    '    "value": { "kind": "empty" }, "state": { "required": true } } ],',
    '"redaction_legend": {',
    '  "PII:AADHAAR": { "shape": "a 12 digit Indian government identity number",',
    '                   "recoverable_by_client": true } }',
  ].join("\n");
  s.addShape("rect", { x: 0.55, y: 1.45, w: 8.1, h: 5.35, fill: { color: "1C1F26" } });
  s.addText(snippet, {
    x: 0.75, y: 1.6, w: 7.8, h: 5.05, fontFace: "Courier New", fontSize: 10.5,
    color: "E8EAED", valign: "top", lineSpacingMultiple: 1.05,
  });
  bullets(s, [
    { t: "The legend travels IN the packet: the server is told the redaction scheme, exactly as the PS requires.", bold: true },
    { t: "value.kind is an enum: filled, empty, placeholder, redacted, unexplained_masked. The planner branches on it.", },
    { t: "Every redaction carries its evidence, so any masking decision is auditable.", },
    { t: "Same value, same token, so the server reasons about one entity coherently without ever seeing it.", },
    { t: "Server answers with element IDs from a closed verb list. Never coordinates.", },
  ], { x: 8.95, y: 1.55, w: 3.8, size: 11.5 });
}

/* ============ 10. Loop ============ */
{
  const s = slide();
  title(s, "One iteration, end to end", "Perceive, sanitize, gate, plan, re-ground, execute");
  s.addImage(fit(A("diagram-loop.png"), 0.4, 1.3, 10.4, 5.9));
  bullets(s, [
    { t: "The re-grounding check verifies the element still exists, still matches, and hasn't moved before touching it. If the page changed, abort and re-perceive. Never guess.", },
    { t: "State-changing actions always require explicit human approval, whatever the server says.", },
  ], { x: 10.9, y: 1.8, w: 2.1, size: 10.5 });
}

/* ============ 11. Irreversible redaction ============ */
{
  const s = slide();
  title(s, "Redaction that cannot be undone", "The fresh-canvas rule and the self-check");
  s.addImage(fit(A("diagram-redaction.png"), 0.4, 1.3, 8.6, 5.9));
  bullets(s, [
    { t: "The output buffer starts as fill colour; source pixels are copied only into spans proven outside every dilated redaction.", },
    { t: "A bug in the span logic loses image. It can never leak it.", bold: true },
    { t: "Before anything is encoded, a pixel-level self-check proves each redacted rectangle holds only fill and stamp colours. If it fails, nothing is sent.", },
    { t: "Boxes are dilated ~15% of text height so antialiased fringes and descenders die too.", },
  ], { x: 9.15, y: 1.7, w: 3.75, size: 11.5 });
}

/* ============ 12. Blur attack ============ */
{
  const s = slide();
  title(s, "Why flat fill, not blur", "We built the attack that breaks blur, live in the repo");
  const rows = [
    ["attack-1-original.png", "The card number as rendered", INK],
    ["attack-2-blurred.png", "Blurred far past human readability (sigma 14)", RED],
    ["attack-3-flat-fill.png", "What Kavach actually sends", GREEN],
  ];
  rows.forEach(([img, cap, color], i) => {
    const y = 1.4 + i * 1.32;
    s.addImage(fit(A(img), 0.55, y, 7.6, 1.05));
    s.addText(cap, { x: 8.3, y: y + 0.3, w: 4.4, h: 0.5, fontFace: FONT, fontSize: 12.5, color, bold: true });
  });
  s.addShape("rect", { x: 0.55, y: 5.55, w: 12.2, h: 1.35, fill: { color: BG_SOFT }, line: { color: RULE, width: 0.75 } });
  s.addText(
    [
      { text: "Coordinate-descent recovery over the digit alphabet:  ", options: { fontSize: 13, color: INK } },
      { text: "blur -> 16/16 digits recovered (100%).  ", options: { fontSize: 13, bold: true, color: RED } },
      { text: "Flat fill -> constant string at chance level; every cell ranks candidates identically: zero plaintext information. ", options: { fontSize: 13, bold: true, color: GREEN } },
      { text: " Reproduce: npm run demo:deblur", options: { fontSize: 11, italic: true, color: SOFT } },
    ],
    { x: 0.8, y: 5.65, w: 11.7, h: 1.15, fontFace: FONT, valign: "middle" },
  );
}

/* ============ 13. On-device model ============ */
{
  const s = slide();
  title(s, "On-device vision, shipped", "A real model runs inside the extension, and its provenance is a test");
  bullets(s, [
    { t: "UltraFace RFB-320 face detector, MIT licence, 1.27 MB, vendored into the extension.", bold: true },
    { t: "SHA-256 pinned in source; CI hashes the committed bytes against the pin on every run. Tampered weights cannot load.", },
    { t: "Pre/post-processing (bilinear resize, CHW normalize, NMS) are pure functions with Node tests, including real inference on the actual graph.", },
    { t: "Runs via onnxruntime-web: WebGPU when available, WASM fallback. No network at inference time, ever.", },
    { t: "Wired end to end: capture -> detect -> PII:FACE token -> pixels destroyed by the composer. Faces inside images the DOM vouched for are now caught by pixels.", bold: true },
    { t: "Model ladder (right): every tier degrades gracefully; Tier 0 works with no GPU and no models at all.", },
  ], { w: 6.7 });
  s.addImage(fit(A("diagram-ladder.png"), 7.5, 1.35, 5.4, 5.7));
}

/* ============ 14. Prototype: split screen ============ */
{
  const s = slide();
  title(s, "Prototype", "What you see vs. what the server sees");
  tag(s, 0.55, 1.4, 2.6, "YOUR SCREEN", NAVY);
  tag(s, 6.75, 1.4, 3.4, "WHAT THE SERVER RECEIVES", RED);
  s.addImage(fit(A("proto-form.png"), 0.45, 1.8, 6.1, 5.1));
  s.addImage(fit(A("proto-form-sanitized.png"), 6.75, 1.8, 6.1, 5.1));
  s.addText(
    "Flat fills with category stamps at real element geometry. The application reference (12 digits, fails Verhoeff) and the helpline stay readable: precision, not paranoia.",
    { x: 0.55, y: 6.95, w: 12.2, h: 0.4, fontFace: FONT, fontSize: 11.5, italic: true, color: SOFT },
  );
}

/* ============ 15. Prototype: panel ============ */
{
  const s = slide();
  title(s, "Prototype", "The side panel: live leak meter, receipts, and the outbound payload");
  s.addImage(fit(A("proto-panel.png"), 8.35, 1.15, 4.6, 5.85));
  bullets(s, [
    { t: "The orchestrator lives in the panel: perceive, sanitize, gate, plan, resolve, re-ground, execute.", },
    { t: "\"What the server sees\" shows the exact outbound payload, including the redacted frame. Nothing else exists to show.", bold: true },
    { t: "Live counters: values redacted, requests, bytes out, and raw PII egress pinned at zero.", },
    { t: "Every send produces a privacy receipt: payload hash, image hash, per-class redaction counts, tripwire and vault verdicts. Exportable as JSON for audit.", },
    { t: "Values the server needs but cannot see are requested from the user by field name (user_prompt). Secrets re-enter only with explicit consent.", },
    { t: "Vault is memory-only, wiped on origin change and tab close.", },
  ], { w: 7.4 });
}

/* ============ 16. Modes ============ */
{
  const s = slide();
  title(s, "Three privacy modes", "Including one where zero pixels leave, provably");
  s.addImage(fit(A("diagram-modes.png"), 0.4, 1.4, 12.5, 3.6));
  s.addShape("rect", { x: 0.55, y: 5.25, w: 12.2, h: 1.65, fill: { color: "2E2640" } });
  s.addText(
    [
      { text: "WIREFRAME MODE   ", options: { fontSize: 15, bold: true, color: "C9BEE8" } },
      { text: "The schema rejects any pixel payload when mode is wireframe. Not \"our detector probably caught everything\": a machine-checkable guarantee, verifiable in the network tab. Fastest mode, smallest payload, and the one a government deployment would mandate.", options: { fontSize: 12.5, color: "FFFFFF" } },
    ],
    { x: 0.85, y: 5.4, w: 11.6, h: 1.35, fontFace: FONT, valign: "middle", lineSpacingMultiple: 1.15 },
  );
}

/* ============ 17. Security ============ */
{
  const s = slide();
  title(s, "Adversarial by design", "Prompt injection is confined, not just detected");
  s.addImage(fit(A("diagram-injection.png"), 0.4, 1.3, 7.3, 5.9));
  bullets(s, [
    { t: "Page text is quarantined as data; the planner prompt wraps it in a never-follow envelope.", },
    { t: "Even a fully compromised server can only name element IDs that exist in the packet, from a closed verb list, and risky actions still need a human click.", bold: true },
    { t: "Red team suite in CI: split PII, injection in page content, hostile server responses, smuggling via notes and history, oversized packets, lookalike negatives. 10 scenarios, all defences hold.", },
    { t: "Server re-scans every packet independently: defence in depth against a broken client.", },
  ], { x: 7.85, y: 1.6, w: 5.0, size: 12 });
}

/* ============ 18. The benchmark ============ */
{
  const s = slide();
  title(s, "The benchmark", "Every claim measured, every number a CI gate");

  const tiles = [
    ["100%", "micro precision, Shield", GREEN],
    ["0", "invariant-class leaks", GREEN],
    ["0", "false alarms on negatives", GREEN],
    ["15.9 ms", "local pipeline p50 (175 ms budget)", NAVY],
    ["10 / 10", "red team defences hold", NAVY],
  ];
  tiles.forEach(([num, cap, color], i) => {
    const x = 0.55 + i * 2.47;
    s.addShape("rect", { x, y: 1.32, w: 2.32, h: 1.0, fill: { color: BG_SOFT }, line: { color: RULE, width: 0.75 } });
    s.addText(num, { x, y: 1.4, w: 2.32, h: 0.5, fontFace: FONT, fontSize: 21, bold: true, color, align: "center" });
    s.addText(cap, { x: x + 0.06, y: 1.86, w: 2.2, h: 0.42, fontFace: FONT, fontSize: 8.8, color: SOFT, align: "center" });
  });

  s.addText("Detection quality (RedactBench-Web adversarial corpus, Shield tier)", {
    x: 0.55, y: 2.55, w: 6.3, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: NAVY,
  });
  const g = (t) => ({ text: t, options: { ...td, color: GREEN, bold: true } });
  s.addTable(
    [
      [{ text: "Class group", options: th }, { text: "Support", options: th },
       { text: "Precision", options: th }, { text: "Recall", options: th }],
      [{ text: "Checksummed IDs: Aadhaar, PAN, GSTIN", options: td }, { text: "14", options: td }, g("100%"), g("100%")],
      [{ text: "Financial: card, IFSC, bank a/c, UPI, amounts", options: td }, { text: "13", options: td }, g("100%"), g("100%")],
      [{ text: "Phone (IN), incl. spaced-digit evasion", options: td }, { text: "6", options: td }, g("100%"), g("100%")],
      [{ text: "Visual: faces, QR, unexplained media", options: td }, { text: "8", options: td }, g("100%"), g("100%")],
      [{ text: "Email (obfuscated [at]/[dot]: known gap)", options: td }, { text: "6", options: td }, { text: "100%", options: td }, { text: "83.3%", options: td }],
      [{ text: "DOB (table-cell context: Fortress catches)", options: td }, { text: "2", options: td }, { text: "100%", options: td }, { text: "50%", options: td }],
      [{ text: "Address in free text (NER tier pending)", options: td }, { text: "2", options: td }, { text: "100%", options: td }, { text: "50%", options: td }],
      [{ text: "Names, PIN code (documented gaps)", options: td }, { text: "3", options: td }, { text: "n/a", options: td }, { text: "0%", options: td }],
      [{ text: "Vehicle registration", options: td }, { text: "1", options: td }, g("100%"), g("100%")],
      [{ text: "micro average", options: { ...td, bold: true } }, { text: "55", options: { ...td, bold: true } },
       { text: "100%", options: { ...td, bold: true, color: GREEN } }, { text: "89.1%", options: { ...td, bold: true } }],
    ],
    { x: 0.55, y: 2.9, w: 6.3, colW: [3.6, 0.8, 0.95, 0.95], border: { pt: 0.5, color: RULE }, rowH: 0.4 },
  );
  s.addText(
    "Fortress mode: recall 94.5% (catches PIN codes and table-cell DOB) at the cost of one bounded false alarm. " +
      "Adversarial negatives (en-dash lookalikes, Luhn-fail cards, spaced order ids, employee ids) must NOT be masked, and are not. Reproduce: npm run bench",
    { x: 0.55, y: 6.6, w: 6.3, h: 0.75, fontFace: FONT, fontSize: 9.5, italic: true, color: SOFT },
  );
  s.addImage(fit(A("chart-latency.png"), 7.05, 2.35, 5.75, 4.6));
}

/* ============ 19. Benchmark visuals ============ */
{
  const s = slide();
  title(s, "The benchmark, continued", "Recall per class, and what the numbers protect");
  s.addImage(fit(A("chart-recall.png"), 0.4, 1.3, 6.6, 5.7));

  s.addText("Blur-recovery attack (metric: redaction precision)", {
    x: 7.25, y: 1.45, w: 5.5, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: NAVY,
  });
  s.addTable(
    [
      [{ text: "Redaction", options: th }, { text: "Digits recovered", options: th }, { text: "Signal", options: th }],
      [{ text: "Gaussian blur (sigma 14)", options: td }, { text: "16 / 16 (100%)", options: { ...td, bold: true, color: RED } }, { text: "fully recoverable", options: td }],
      [{ text: "Kavach flat fill", options: td }, { text: "1 / 16 (chance)", options: { ...td, bold: true, color: GREEN } }, { text: "zero plaintext info", options: td }],
    ],
    { x: 7.25, y: 1.8, w: 5.5, colW: [2.1, 1.9, 1.5], border: { pt: 0.5, color: RULE }, rowH: 0.42 },
  );

  s.addText("Red team (report section 6.3, executable)", {
    x: 7.25, y: 3.25, w: 5.5, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: NAVY,
  });
  s.addTable(
    [
      [{ text: "Attack", options: th }, { text: "Result", options: th }],
      [{ text: "PII split across adjacent DOM nodes", options: td }, g2("caught, reassembled")],
      [{ text: "Prompt injection in page content", options: td }, g2("quarantined")],
      [{ text: "Compromised server names foreign element", options: td }, g2("plan rejected")],
      [{ text: "PII smuggled via notes / history fields", options: td }, g2("gate blocks")],
      [{ text: "Leaky packet sent straight to server", options: td }, g2("422, never processed")],
      [{ text: "700-element packet / 1000-region page", options: td }, g2("capped, bounded")],
      [{ text: "Checksum-invalid lookalikes (order ids)", options: td }, g2("NOT masked")],
    ],
    { x: 7.25, y: 3.6, w: 5.5, colW: [3.6, 1.9], border: { pt: 0.5, color: RULE }, rowH: 0.35 },
  );
  s.addText(
    "Suite footprint: 203 automated tests · model 1.27 MB, SHA-pinned (provenance is a test) · " +
      "corpus: 18 captures, 55 annotated positives + adversarial lookalike negatives (unicode dashes, " +
      "digit-spacing evasions, Hindi labels, table splits) · regenerate: npm run bench, npm run bench:latency",
    { x: 7.25, y: 6.25, w: 5.5, h: 1.0, fontFace: FONT, fontSize: 9.5, italic: true, color: SOFT },
  );
}

/* ============ 20. Engineering discipline ============ */
{
  const s = slide();
  title(s, "Engineering discipline", "The boundary is enforced by the build, not by promises");
  bullets(s, [
    { t: "203 automated tests across schema, detectors, policy, vault, gate, fusion, perception, server, benchmark and red team.", bold: true },
    { t: "check-egress fails the build if fetch or any network API appears outside three allowlisted transport modules.", },
    { t: "One zod schema package is imported by both client and server: the wire contract cannot drift.", },
    { t: "Model provenance is a test: the vendored ONNX bytes are hashed against the pinned SHA in CI.", },
    { t: "Benchmark numbers are regression gates: recall dropping or a new leak class fails CI.", },
    { t: "Licence hygiene: Apache-2.0/MIT stack throughout. No AGPL weights (OmniParser's detector is AGPL: we checked, and declined).", },
    { t: "Fully offline capable: deterministic heuristic planner needs no model; optional local Ollama/OpenAI-compatible endpoint for the model brain.", },
  ], { w: 7.3 });
  s.addShape("rect", { x: 8.15, y: 1.5, w: 4.65, h: 5.3, fill: { color: "1C1F26" } });
  s.addText(
    [
      { text: "kavach/\n", options: { bold: true, color: "8AB4E8" } },
      { text: " packages/core       schema | detectors | policy\n                     vault | gate | fusion\n", options: {} },
      { text: " packages/perception compose | tiles | vision\n                     models (SHA-pinned)\n", options: {} },
      { text: " apps/extension      Chrome MV3 + Firefox\n", options: {} },
      { text: " apps/server         planner + re-scan + guard\n", options: {} },
      { text: " bench/              RedactBench | red team\n                     latency\n", options: {} },
      { text: " tools/              check-egress | attack-deblur\n", options: {} },
      { text: "\n 24 commits | every stage tested first", options: { color: "9AA2AD", italic: true } },
    ],
    { x: 8.35, y: 1.7, w: 4.3, h: 4.9, fontFace: "Courier New", fontSize: 10.5, color: "E8EAED", valign: "top" },
  );
}

/* ============ 21. Why we win ============ */
{
  const s = slide();
  title(s, "Why this wins", "Every evaluation metric has evidence behind it");
  s.addTable(
    [
      [{ text: "Metric", options: th }, { text: "Our evidence", options: th }],
      [{ text: "Visual context accuracy (25%)", options: td },
       { text: "DOM+vision fusion, explained-area metric, re-grounding before every action", options: td }],
      [{ text: "PII recall + precision (20%)", options: td },
       { text: "Measured on an adversarial corpus: 100% precision, 0 invariant leaks, checksum-perfect IDs, published gap list", options: td }],
      [{ text: "Redaction precision (20%)", options: td },
       { text: "Fresh-canvas rule, pixel self-check before send, adaptive dilation, blur attack demo", options: td }],
      [{ text: "Client resources (20%)", options: td },
       { text: "1.27 MB model, dirty-region skip, tier ladder to zero-model Tier 0, single-thread WASM numbers", options: td }],
      [{ text: "End-to-end latency (15%)", options: td },
       { text: "15.9 ms local p50 vs 175 ms budget, measured and reproducible", options: td }],
    ],
    { x: 0.55, y: 1.5, w: 12.2, colW: [3.6, 8.6], border: { pt: 0.5, color: RULE }, rowH: 0.52 },
  );
  bullets(s, [
    { t: "Standouts no other team will have: Wireframe mode (provable zero-pixel egress), the live blur-recovery attack, privacy receipts with hash proofs, checksum-validated Indian identifier pack, and a benchmark whose numbers are CI gates.", bold: true },
    { t: "Roadmap: text-region detection (DBNet) through the same pinned-model path, NER tier for names and addresses, Devanagari text masking, NPU via WebNN, Tier 3 local VLM.", },
  ], { y: 4.95, w: 12.2, size: 12.5 });
}

/* ============ 22. Close ============ */
{
  const s = pptx.addSlide();
  s.background = { color: NAVY };
  s.addText("Zero raw PII bytes on the wire.\nAnd we can prove it.", {
    x: 0.85, y: 2.3, w: 11.6, h: 1.6, fontFace: FONT, fontSize: 38, bold: true, color: "FFFFFF",
  });
  s.addText(
    "Repository:  github.com/BhoomiAgrawal12/browser-vision-agent\n" +
      "Full design report: docs/REPORT.md (61-page PDF included)\n" +
      "Run it: npm install && npm test  |  node bench/demo/serve.mjs  |  npm run dev -w @kavach/server",
    { x: 0.85, y: 4.4, w: 11.6, h: 1.2, fontFace: FONT, fontSize: 14, color: "C9D8E8", lineSpacingMultiple: 1.4 },
  );
  s.addText("Kavach  |  SIH 2026  |  ISRO Space Applications Centre problem statement", {
    x: 0.85, y: 6.6, w: 11.6, h: 0.4, fontFace: FONT, fontSize: 12, color: "9FB4CB" },
  );
}

const OUT = join(ROOT, "docs", "Kavach-SIH2026-Deck.pptx");
await pptx.writeFile({ fileName: OUT });
console.log("wrote", OUT);
