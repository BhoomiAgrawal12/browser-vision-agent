#!/usr/bin/env node
/**
 * Generate every image the deck embeds:
 *  - flowchart PNGs rendered from the mermaid sources in docs/REPORT.md
 *  - prototype screenshots: demo form, sanitized overlay, panel UI
 *  - the blur-attack images from tools/attack-deblur
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const ASSETS = join(HERE, "assets");
mkdirSync(ASSETS, { recursive: true });

const CHROME = process.env.DRAVIKA_BROWSER ?? ["/usr/bin/google-chrome", "/opt/brave.com/brave-origin/brave", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
if (!CHROME) throw new Error("Set DRAVIKA_BROWSER to a Chrome/Brave executable.");
const PORT = 9412;

/* ---- pick diagrams out of the report by a distinctive substring ---- */

const report = readFileSync(join(ROOT, "docs/REPORT.md"), "utf8");
const blocks = [...report.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

const WANTED = [
  ["arch", "USER'S MACHINE (trusted)"],
  ["boundary", "TRUSTED ZONE"],
  ["perception", "Channel S: structure"],
  ["policy", "Four independent evidence sources"],
  ["loop", "RE-GROUNDING CHECK"],
  ["ladder", "Capability probe on install"],
  ["modes", "Shield (default)"],
  ["injection", "Structural envelope"],
  ["redaction", "Fresh canvas rule"],
];

const picked = WANTED.map(([name, needle]) => {
  const src = blocks.find((b) => b.includes(needle));
  if (!src) throw new Error(`diagram not found for ${name} (needle: ${needle})`);
  return { name, src };
});

const mermaidJs = readFileSync(join(HERE, "node_modules/mermaid/dist/mermaid.min.js"), "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const diagramPage = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; font-family: -apple-system, Helvetica, Arial, sans-serif; }
  .d { display: inline-block; padding: 18px; background: #ffffff; }
</style></head><body>
${picked.map((p) => `<div class="d" id="${p.name}"><pre class="mermaid">${esc(p.src)}</pre></div>`).join("\n")}
<script>${mermaidJs}</script>
<script>
  mermaid.initialize({
    startOnLoad: false, theme: "base", securityLevel: "loose",
    flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis" },
    sequence: { useMaxWidth: false },
    themeVariables: {
      fontFamily: "-apple-system, Helvetica Neue, Arial, sans-serif", fontSize: "14px",
      primaryColor: "#eef3f8", primaryTextColor: "#16181d", primaryBorderColor: "#1f4e79",
      lineColor: "#5a6470", secondaryColor: "#f3f0ea", tertiaryColor: "#fbfbfc",
      clusterBkg: "#f7f8fa", clusterBorder: "#c9ced6"
    }
  });
  mermaid.run({ querySelector: "pre.mermaid" }).then(() => document.body.setAttribute("data-ready", "1"));
</script></body></html>`;

writeFileSync(join(HERE, "diagrams.html"), diagramPage);

/* ---- drive Chrome ---- */

const chromeProc = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=" + join(HERE, ".chrome"),
  "--allow-file-access-from-files",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` }); }
  catch { await sleep(500); }
}
if (!browser) { chromeProc.kill(); throw new Error("no chrome"); }

try {
  /* diagrams */
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 2400, height: 1600, deviceScaleFactor: 2 });
    await page.goto("file://" + join(HERE, "diagrams.html"), { waitUntil: "load" });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 120000 });
    await sleep(500);
    for (const { name } of picked) {
      const el = await page.$(`#${name}`);
      await el.screenshot({ path: join(ASSETS, `diagram-${name}.png`) });
      console.log(`diagram-${name}.png`);
    }
    await page.close();
  }

  /* demo form, plain and with the composer-style sanitization overlay */
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1180, height: 940, deviceScaleFactor: 2 });
    await page.goto("file://" + join(ROOT, "bench/demo/index.html"), { waitUntil: "load" });
    await sleep(300);
    await page.screenshot({ path: join(ASSETS, "proto-form.png") });
    console.log("proto-form.png");

    // Flat fills with category stamps at the real element geometry: the
    // same visual the fresh-canvas composer produces.
    await page.evaluate(() => {
      const mask = (sel, label) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const pad = Math.max(2, Math.round(r.height * 0.15));
        const d = document.createElement("div");
        d.style.cssText =
          `position:fixed;left:${r.left - pad}px;top:${r.top - pad}px;` +
          `width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px;` +
          "background:rgb(16,18,22);color:rgb(122,132,144);display:flex;" +
          "align-items:center;padding-left:8px;font:12px system-ui;z-index:9999;";
        d.textContent = label;
        document.body.append(d);
      };
      mask("#name", "PII:PERSON_NAME");
      mask("#aadhaar", "PII:AADHAAR");
      mask("#email", "PII:EMAIL");
      mask("#mobile", "PII:PHONE_IN");
      mask("svg", "PII:FACE");
    });
    await page.screenshot({ path: join(ASSETS, "proto-form-sanitized.png") });
    console.log("proto-form-sanitized.png");
    await page.close();
  }

  /* panel UI with representative session state */
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 980, deviceScaleFactor: 2 });
    await page.goto("file://" + join(ROOT, "apps/extension/dist/chrome/panel.html"), {
      waitUntil: "load",
    });
    await sleep(400);
    const sanitizedUrl = "file://" + join(ASSETS, "proto-form-sanitized.png");
    await page.evaluate((previewSrc) => {
      const $ = (id) => document.getElementById(id);
      const preview = $("visual-preview");
      preview.src = previewSrc;
      preview.hidden = false;
      $("task").value = "Help me complete this form";
      $("stat-blocked").textContent = "7";
      $("stat-sent").textContent = "2";
      $("stat-bytes").textContent = "9,412";
      const log = $("log");
      const line = (t, c) => {
        const d = document.createElement("div");
        if (c) d.className = c;
        d.textContent = t;
        log.append(d);
      };
      line("● iteration 1: perceiving…", "dim");
      line("  11 regions from structure");
      line("  face detector ready (ultraface-rfb-320, on-device)", "dim");
      line("  1 face(s) detected on-device in 14 ms", "ok");
      line("  sanitized: 7 redactions, 0 unexplained masked");
      line("  visual: 7 region(s) destroyed, self-check 96,410 px, 61,204 B webp");
      line("  sending through the egress gate…", "dim");
      line("  plan: 3 required fields are empty (Street Address, City, PIN Code)…", "ok");
      const receipts = $("receipts");
      const r = document.createElement("div");
      r.className = "receipt";
      r.innerHTML =
        '<div class="head"><span>SENT · shield · 9,412 B</span></div>' +
        "<div>7 redactions (AADHAAR×1 EMAIL×1 PHONE_IN×1 FACE×1…) · sha256 9f2c1a44be08…</div>";
      receipts.append(r);
      $("export-receipts").disabled = false;
      $("packet-view").textContent = JSON.stringify(
        {
          schema: "dravika.scp/1.0",
          policy: { mode: "shield", invariant_floor: true },
          origin: { class: "government", tls: true },
          visual: { present: true, sha256: "9f2c1a…", regions_redacted: 7 },
          elements: [
            { id: "e2", role: "textbox", label: "Aadhaar Number",
              value: { kind: "placeholder", token: "PII:AADHAAR#1" } },
            { id: "e10", role: "textbox", label: "PIN Code", value: { kind: "empty" } },
          ],
          redaction_legend: {
            "PII:AADHAAR": { shape: "a 12 digit Indian government identity number" },
          },
        },
        null,
        1,
      );
    }, sanitizedUrl);
    await sleep(400);
    await page.screenshot({ path: join(ASSETS, "proto-panel.png") });
    console.log("proto-panel.png");
    await page.close();
  }
} finally {
  await browser.disconnect();
  chromeProc.kill();
}

/* blur attack images */
execFileSync(process.execPath, [join(ROOT, "tools/attack-deblur/attack.mjs")], {
  stdio: "ignore",
});
for (const f of ["1-original.png", "2-blurred.png", "3-flat-fill.png"]) {
  copyFileSync(join(ROOT, "tools/attack-deblur/out", f), join(ASSETS, `attack-${f}`));
  console.log(`attack-${f}`);
}
console.log("assets complete");
