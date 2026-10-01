#!/usr/bin/env node
/** Real Chromium DOM + built panel/content bundles + real local planner.
 * Only chrome.* messaging is bridged; no personal browser profile is used.
 * Run: npm run test:browser -w @kavach/extension
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { makeServer } from "../apps/server/src/server.ts";
import { BarcodeFormat, QRCodeWriter } from "@zxing/library";

const dist = fileURLToPath(new URL("../apps/extension/dist/chrome/", import.meta.url));
const executablePath = process.env.DRAVIKA_BROWSER ?? ["/opt/brave.com/brave-origin/brave", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
if (!executablePath) throw new Error("Set DRAVIKA_BROWSER to your Chromium/Chrome/Brave executable.");
const planner = makeServer({ env: { PLANNER_MODE: "model", PLANNER_ENDPOINT: "http://127.0.0.1:1/model-must-not-be-used-for-forms" }, log: () => {} });
await new Promise((resolve) => planner.listen(0, "127.0.0.1", resolve));
const plannerUrl = `http://127.0.0.1:${planner.address().port}`;
const previewBundle = await build({
  entryPoints: [fileURLToPath(new URL("../apps/extension/src/panel/visual-preview.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});
const assets = createServer((req, res) => {
  const asset = req.url?.replace(/^\//, "") ?? "";
  if (/^(media\/[^/]+|media\.js|media-pipeline\.js|ort\/(?:ort\.min\.js|ort-wasm-simd-threaded(?:\.jsep)?\.(?:mjs|wasm))|models\/ultraface-rfb-320\.onnx)$/.test(asset)) {
    res.setHeader("content-type", /\.m?js$/.test(asset) ? "text/javascript" : asset.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    res.end(readFileSync(dist + asset));
    return;
  }
  const filename = req.url === "/panel.html" ? "panel.html" : req.url === "/panel.js" ? "panel.js" : req.url === "/panel.css" ? "panel.css" : null;
  if (filename) { res.setHeader("content-type", filename.endsWith("js") ? "text/javascript" : filename.endsWith("css") ? "text/css" : "text/html"); res.end(readFileSync(dist + filename)); }
  else if (req.url === "/visual-preview.js") { res.setHeader("content-type", "text/javascript"); res.end(previewBundle.outputFiles[0].text); }
  else { res.setHeader("content-type", "text/html"); res.end("<!doctype html><body></body>"); }
});
await new Promise((resolve) => assets.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${assets.address().port}`;
function pdfFixture() {
  const matrix = new QRCodeWriter().encode("pdf-qr-private-8753", BarcodeFormat.QR_CODE, 180, 180, new Map());
  const rectangles = [];
  for (let y = 0; y < matrix.height; y++) for (let x = 0; x < matrix.width; x++) {
    if (matrix.get(x, y)) rectangles.push(`${450+x} ${240-30-y-1} 1 1 re f`);
  }
  const content = `BT /F1 20 Tf 18 190 Td (Aadhaar: 9999 4105 7058) Tj ET 0 0 0 rg ${rectangles.join(" ")}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
const browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
let activePanel;
try {
  for (const provider of ["google", "microsoft"]) {
    const context = await browser.newContext();
    const packets = [];
    await context.route("http://127.0.0.1:8787/**", async (route) => {
      const body = route.request().postData();
      if (!body) {
        await route.fulfill({
          status: 200,
          headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" },
          body: JSON.stringify({ ok: true, planner: "configured:model", provider: "remote", model_configured: true, mode: "model", form_flow: "local-sequential-guarded" }),
        });
        return;
      }
      packets.push(JSON.parse(body));
      const response = await fetch(plannerUrl + "/plan", { method: "POST", headers: { "content-type": "application/json" }, body });
      await route.fulfill({ status: response.status, body: await response.text(), headers: { "access-control-allow-origin": "*", "content-type": "application/json" } });
    });
    const form = await context.newPage();
    await form.goto(base + "/form");
    const attr = provider === "google" ? 'role="listitem"' : 'data-automation-id="questionItem"';
    const title = provider === "google" ? 'role="heading"' : 'data-automation-id="questionTitle"';
    await form.setContent(`<!doctype html><style>input,textarea,[role=combobox],[role=radiogroup]{display:block;width:300px;min-height:30px}section{padding:15px}</style>
      <form>
      <section ${attr}><div ${title}>Name *</div><input id="name" placeholder="Enter your answer" aria-required="true"></section>
      <section ${attr}><div ${title}>Date *</div><input id="date" ${provider === "microsoft" ? 'role="combobox" aria-haspopup="dialog" aria-expanded="false"' : ''} required aria-describedby="date-help date-error"><div id="date-help">Use DD/MM/YYYY.</div><div id="date-error" role="alert" hidden>Use DD/MM/YYYY. Enter a real date.</div></section>
      <section ${attr}><div ${title}>Email *</div><input id="email" type="email" required placeholder="Your answer"></section>
      <section ${attr}><div ${title}>${provider === "google" ? "Profile Photo" : "PDF Document"} *</div><p>Upload 1 supported file. Max 10 MB.</p><button id="upload" type="button">Add file</button><input id="proof" name="proof" type="file" accept="${provider === "google" ? "image/png" : "application/pdf"}" required style="display:none"></section>
      <div style="height:1100px"></div>
      <section ${attr}><div ${title}>City *</div><input id="city" required></section>
      <section ${attr}><div ${title}>Country *</div>${provider === "google" ? '<div id="country" role="listbox" tabindex="0" aria-expanded="false" aria-required="true" aria-valuetext=""><div role="option" data-value="" aria-selected="true">Choose</div><div role="option" data-value="in" aria-selected="false" hidden>India</div></div>' : '<select id="country" required><option value="">Choose</option><option value="in">India</option></select>'}</section>
      <section ${attr}><div ${title}>Contact preference *</div><div role="radiogroup" id="contact" aria-required="true"><div role="radio" aria-checked="false">Phone</div><div role="radio" aria-checked="false">Email</div></div></section>
      <section ${attr}><div ${title}>Optional attachment</div><input id="optional-file" type="file"></section>
      <button type="submit">Submit</button></form>
      <script>
        window.steps=[]; window.submissions=0;
        for(const el of document.querySelectorAll('input,select')) el.addEventListener('change',()=>window.steps.push(el.id));
        document.querySelector('#date').addEventListener('blur',()=>setTimeout(()=>{ const el=document.querySelector('#date'); const bad=el.value!=='25/12/2000'; el.setAttribute('aria-invalid',String(bad));document.querySelector('#date-error').hidden=!bad; },180));
        for(const el of document.querySelectorAll('[role=radio]')) el.addEventListener('click',()=>{for(const r of document.querySelectorAll('[role=radio]'))r.setAttribute('aria-checked',String(el===r));});
        const dropdown=document.querySelector('#country[role=listbox]');
        if(dropdown){ dropdown.addEventListener('click',()=>{dropdown.setAttribute('aria-expanded','true');for(const o of dropdown.children)o.hidden=false;});for(const o of dropdown.children)o.addEventListener('click',e=>{e.stopPropagation();for(const sibling of dropdown.children)sibling.setAttribute('aria-selected',String(sibling===o));dropdown.setAttribute('aria-valuetext',o.textContent);dropdown.setAttribute('aria-expanded','false');}); }
        document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submissions++;});
      </script>`);
    await form.evaluate(() => {
      window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.listener = fn; }, removeListener: () => {} } } };
    });
    await form.addScriptTag({ path: dist + "content.js" });
    const panel = await context.newPage();
    activePanel = panel;
    await panel.exposeFunction("sendToForm", (message) => form.evaluate((msg) => new Promise((resolve) => window.listener(msg, {}, resolve)), message));
    await panel.addInitScript(({ url }) => {
      const event = () => ({ addListener: () => {} });
      window.chrome = {
        runtime: {},
        tabs: { query: async () => [{ id: 1, url }], sendMessage: (_id, msg, _options, cb) => window.sendToForm(msg).then(cb), onRemoved: event(), onActivated: event(), onUpdated: event() },
      };
    }, { url: base + "/form" });
    await panel.setViewportSize({ width: 360, height: 820 });
    await panel.goto(base + "/panel.html");
    await panel.waitForFunction(() => document.querySelector("#planner-status")?.textContent?.includes("Remote planner advisory"));
    assert.match(await panel.locator("#planner-status").innerText(), /form actions guarded locally/);
    assert.equal(await panel.locator('section input[type="file"]').count(), 0, "the sidebar must not contain a file picker");
    assert.equal(await panel.locator("#media-send, #media-inspect").count(), 0, "the sidebar has no standalone media-send controls");
    await panel.locator("#packet-view").evaluate((node) => { node.textContent = JSON.stringify({ packet: "x".repeat(900) }, null, 2); });
    for (const width of [360, 320, 280]) {
      await panel.setViewportSize({ width, height: 820 });
      const layout = await panel.evaluate(() => {
        const rect = (selector) => {
          const element = document.querySelector(selector);
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
        };
        const previewImage = document.querySelector("#visual-preview");
        const previewEmpty = document.querySelector("#visual-preview-empty");
        const packet = document.querySelector("#packet-view");
        return {
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          preview: { hidden: previewImage.hidden, display: getComputedStyle(previewImage).display, emptyVisible: getComputedStyle(previewEmpty).display !== "none" },
          packet: { maxHeight: getComputedStyle(packet).maxHeight, overflowY: getComputedStyle(packet).overflowY, whiteSpace: getComputedStyle(packet).whiteSpace, width: packet.clientWidth, scrollWidth: packet.scrollWidth, scrollHeight: packet.scrollHeight, clientHeight: packet.clientHeight },
        };
      });
      assert.ok(layout.documentWidth <= width, `panel overflows at ${width}px: ${JSON.stringify(layout)}`);
      assert.equal(layout.preview.hidden, true, "no-frame state must not leave a broken image visible");
      assert.equal(layout.preview.display, "none", "hidden image must remain hidden in author CSS");
      assert.equal(layout.preview.emptyVisible, true, "no-frame state must be explained");
      assert.equal(layout.packet.overflowY, "auto");
      assert.equal(layout.packet.whiteSpace, "pre-wrap");
      assert.ok(parseFloat(layout.packet.maxHeight) <= 240);
      assert.ok(layout.packet.scrollWidth <= layout.packet.width + 1, `packet JSON overflows horizontally at ${width}px`);
      assert.ok(layout.packet.scrollHeight > layout.packet.clientHeight, "long packet should stay in a bounded scroll area");
    }
    await panel.setViewportSize({ width: 360, height: 820 });
    const previewStates = await panel.evaluate(async (moduleUrl) => {
      const frame = document.querySelector("#visual-preview-state");
      const image = document.querySelector("#visual-preview");
      const empty = document.querySelector("#visual-preview-empty");
      const error = document.querySelector("#visual-preview-error");
      const initial = { state: frame.dataset.previewState, hidden: image.hidden, emptyVisible: getComputedStyle(empty).display !== "none" };
      const { createVisualPreview } = await import(moduleUrl);
      const preview = createVisualPreview({ frame, image, empty, error });
      const canvas = document.createElement("canvas");
      canvas.width = 8; canvas.height = 6;
      const context = canvas.getContext("2d");
      context.fillStyle = "#eaf5ec"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#23643d"; context.fillRect(2, 2, 3, 2);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
      if (!blob || blob.type !== "image/webp") throw new Error("Chromium did not create the WebP preview fixture");
      const waitForState = (state) => new Promise((resolve, reject) => {
        if (frame.dataset.previewState === state) { resolve(); return; }
        const observer = new MutationObserver(() => {
          if (frame.dataset.previewState === state) { clearTimeout(timeout); observer.disconnect(); resolve(); }
        });
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Preview never entered ${state} state`)); }, 3000);
        observer.observe(frame, { attributes: true, attributeFilter: ["data-preview-state"] });
      });
      const ready = waitForState("ready");
      preview.show(new Uint8Array(await blob.arrayBuffer()));
      await ready;
      const valid = { state: frame.dataset.previewState, hidden: image.hidden, width: image.naturalWidth, objectUrl: image.src.startsWith("blob:") };
      const failed = waitForState("error");
      preview.show(new Uint8Array([1, 2, 3]));
      await failed;
      return { initial, valid, failed: { state: frame.dataset.previewState, hidden: image.hidden, message: error.textContent, emptyHidden: empty.hidden } };
    }, `${base}/visual-preview.js`);
    assert.deepEqual(previewStates.initial, { state: "empty", hidden: true, emptyVisible: true });
    assert.equal(previewStates.valid.state, "ready");
    assert.equal(previewStates.valid.hidden, false);
    assert.equal(previewStates.valid.width, 8);
    assert.equal(previewStates.valid.objectUrl, true);
    assert.equal(previewStates.failed.state, "error");
    assert.equal(previewStates.failed.hidden, true);
    assert.equal(previewStates.failed.emptyHidden, true);
    assert.match(previewStates.failed.message, /could not be loaded/);
    console.log("PASS panel UI: no-frame empty state, real WebP blob preview, explicit failed-preview state; no clipping/overflow at 360, 320, or 280px");
    const damagedQr = new QRCodeWriter().encode("damaged-upload-private-payload", BarcodeFormat.QR_CODE, 180, 180, new Map());
    const originalImageB64 = await form.evaluate(async (bits) => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 240;
      const context = canvas.getContext("2d");
      context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "black"; context.font = "bold 24px Arial";
      context.fillText("Aadhaar: 9999 4105 7058", 15, 45);
      context.fillText("Email: upload-private@example.test", 15, 95);
      bits.forEach((row, y) => row.forEach((bit, x) => { if (bit) context.fillRect(x+450, y+20, 1, 1); }));
      // Break the encoded data while leaving the three finder patterns intact.
      context.fillStyle = "white"; context.fillRect(522, 92, 70, 70);
      return canvas.toDataURL("image/png").split(",")[1];
    }, Array.from({length:180}, (_, y) => Array.from({length:180}, (_, x) => damagedQr.get(x, y))));
    const file = provider === "google"
      ? { name: "proof.png", mimeType: "image/png", buffer: Buffer.from(originalImageB64, "base64") }
      : { name: "proof.pdf", mimeType: "application/pdf", buffer: pdfFixture() };
    const originalFileB64 = file.buffer.toString("base64");
    await panel.evaluate(() => {
      window.promptEvents = [];
      window.fileReviewCount = 0;
      const show = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () {
        if (this.id === "ask") window.promptEvents.push(document.querySelector("#ask-text").textContent);
        if (this.id === "file-upload") window.promptEvents.push(document.querySelector("#file-upload-text").textContent);
        if (this.id === "file-review") window.fileReviewCount++;
        return show.call(this);
      };
    });
    assert.equal(await panel.locator('section textarea, section input[type="file"]').count(), 0, "task and file input must be dialog-only");
    await panel.click("#start-task");
    await panel.fill("#task", "Fill this form. Date: wrong, Email: private@example.test, City: Example City, Contact preference: Email");
    await panel.click("#run");
    await panel.waitForSelector("#preflight[open]");
    const questions = await panel.locator("#preflight-fields").innerText();
    assert.match(questions, /Name/i);
    assert.match(questions, /Date/i);
    assert.match(questions, /Email/i);
    assert.match(questions, /Profile Photo|PDF Document/i);
    assert.doesNotMatch(questions, /private@example\.test|Test Person/i);
    assert.equal(packets.length, 0, "local self-check must finish before any page packet is sent");
    if (provider === "google") {
      await panel.click('#preflight button[value="cancel"]');
      await panel.waitForFunction(() => !document.querySelector("#run").disabled);
      assert.equal(packets.length, 0, "cancelled preflight must not contact the planner");
      assert.equal(await form.locator("#name").inputValue(), "");
      await panel.click("#start-task");
      await panel.click("#run");
      await panel.waitForSelector("#preflight[open]");
    }
    await panel.click("#preflight-continue");
    await panel.waitForSelector("#ask[open]");
    assert.match(await panel.locator("#ask-text").innerText(), /Name/);
    // A re-render while answering must re-ground and reuse the answer, not ask twice.
    await form.evaluate(() => {
      const old = document.querySelector("#name");
      old.replaceWith(old.cloneNode(true));
    });
    await panel.fill("#ask-input", "Test Person");
    await panel.click("#ask-ok");
    await panel.waitForFunction(() => document.querySelector('#ask[open] #ask-text')?.textContent?.includes('DD/MM/YYYY'), undefined, { timeout: 15000 });
    assert.equal(await form.locator("#email").inputValue(), "", "must not advance beyond invalid date");
    await panel.fill("#ask-input", "25/12/2000");
    await panel.click("#ask-ok");
    await panel.waitForSelector("#file-upload[open]", { timeout: 25000 });
    assert.match(await panel.locator("#file-upload-text").innerText(), /Profile Photo|PDF Document/);
    assert.equal(await form.locator("#proof").evaluate((node) => node.files?.length), 0, "file attachment must wait for a dialog answer");
    assert.equal(await form.locator("#city").inputValue(), "", "later text questions must wait for the preceding upload");
    await panel.locator("#file-upload-input").setInputFiles({ name: "wrong.txt", mimeType: "text/plain", buffer: Buffer.from("wrong file type") });
    await panel.click("#file-upload-attach");
    assert.match(await panel.locator("#file-upload-error").innerText(), /not accepted/);
    assert.equal(await panel.locator("#file-upload[open]").count(), 1, "invalid file choices stay within one popup");
    await panel.locator("#file-upload-input").setInputFiles(file);
    assert.equal(await panel.locator("#file-upload-page-row").isVisible(), provider === "microsoft", "PDF page selection belongs in the dialog");
    await panel.click("#file-upload-attach");
    await panel.waitForSelector("#file-review[open]", { timeout: 30000 });
    await panel.waitForFunction(() => !document.querySelector("#file-review-approve").disabled);
    assert.equal(await form.locator("#proof").evaluate((node) => node.files?.length), 0, "nothing may be attached before post-preview approval");
    assert.equal(await form.locator("#city").inputValue(), "", "the form sequence must wait for file review");
    const approvedHash = JSON.parse(await panel.locator("#file-review-json").textContent()).website_upload.sha256;
    if (provider === "google") {
      const audit = JSON.parse(await panel.locator("#file-review-json").textContent()).local_audit;
      assert.ok(audit.barcode_regions >= 1, "an unreadable QR must still be located and blacked out");
      assert.ok(audit.redactions_by_class.QR_BARCODE >= 1);
    }
    if (provider === "microsoft") {
      const audit = JSON.parse(await panel.locator("#file-review-json").textContent()).local_audit;
      assert.equal(audit.barcode_regions, 1, "QR detection must run on the rendered PDF page");
      assert.ok(audit.redactions_by_class.QR_BARCODE >= 1);
      assert.ok(audit.redactions_by_class.AADHAAR >= 1);
    }
    assert.equal(JSON.parse(await panel.locator("#media-report").textContent()).website_upload.state, "awaiting_approval");
    // Re-render the upload trigger during review. Retry must use the exact
    // approved artifact, without a second file-selection or approval popup.
    await form.evaluate(() => { const button = document.querySelector("#upload"); button.replaceWith(button.cloneNode(true)); });
    await panel.click("#file-review-approve");
    await panel.waitForFunction(() => document.querySelector('#ask[open] #ask-text')?.textContent?.includes('Country'), undefined, { timeout: 15000 });
    await panel.fill("#ask-input", "India");
    await panel.click("#ask-ok");
    await panel.waitForSelector("#confirm[open]", { timeout: 25000 });
    assert.equal(await panel.locator("#media-sanitized").isVisible(), true, "the dialog-selected file must produce a sanitized sidebar image");
    assert.equal(await panel.locator("#media-original").isVisible(), true, "the original must be available for local comparison");
    const filePreview = JSON.parse(await panel.locator("#media-report").innerText());
    assert.equal(filePreview.transmission, "local_preview_not_sent");
    assert.equal(filePreview.sanitized_packet.visual.present, true);
    assert.ok(!JSON.stringify(filePreview).includes(file.name), "the JSON preview must omit the original filename");
    assert.equal(filePreview.website_upload.state, "attached");
    assert.equal(filePreview.website_upload.sha256, approvedHash);
    assert.equal(await panel.evaluate(() => window.fileReviewCount), 1, "a stale target retry must not repeat file approval");
    const prompts = await panel.evaluate(() => window.promptEvents);
    assert.equal(prompts.length, 4, `questions must be asked once: ${JSON.stringify(prompts)}`);
    assert.match(prompts[0], /Name/);
    assert.match(prompts[1], /DD\/MM\/YYYY/);
    assert.match(prompts[2], /Profile Photo|PDF Document/);
    assert.match(prompts[3], /Country/);
    // Retry the same task with re-rendered/cleared fields: remembered text,
    // corrected dates and public choice labels must survive without new prompts.
    await panel.click('#confirm button[value="cancel"]');
    await panel.waitForFunction(() => !document.querySelector("#run").disabled);
    await form.evaluate(() => {
      document.querySelector("#name").value = "";
      document.querySelector("#date").value = "";
      document.querySelector("#date").setAttribute("aria-invalid", "false");
      const country = document.querySelector("#country");
      if (country.tagName === "SELECT") country.value = "";
      else { country.setAttribute("aria-valuetext", ""); for (const child of country.children) child.setAttribute("aria-selected", String(child.getAttribute("data-value") === "")); }
    });
    await panel.click("#start-task");
    await panel.click("#run");
    await panel.waitForSelector("#preflight[open]");
    await panel.click("#preflight-continue");
    await panel.waitForSelector("#confirm[open]", { timeout: 25000 });
    assert.equal(await panel.evaluate(() => window.promptEvents.length), 4, "retry must reuse all answered questions");
    assert.equal(await form.locator("#date").inputValue(), "25/12/2000", "a correction must take precedence over the original task value");
    assert.equal(await form.locator("#proof").evaluate((node) => node.files?.length), 1);
    assert.equal(await form.locator("#proof").evaluate((node) => node.files?.[0]?.name), provider === "google" ? "sanitized-image.png" : "sanitized-document.pdf");
    assert.equal(await form.locator("#optional-file").evaluate((node) => node.files?.length), 0, "optional file fields must be skipped");
    assert.equal(await form.locator("#name").inputValue(), "Test Person");
    assert.equal(await form.locator("#email").inputValue(), "private@example.test");
    assert.equal(await form.locator("#city").inputValue(), "Example City");
    assert.equal(provider === "google" ? await form.locator("#country").getAttribute("aria-valuetext") : await form.locator("#country").inputValue(), provider === "google" ? "India" : "in");
    assert.equal(await form.locator('[role=radio][aria-checked=true]').textContent(), "Email");
    assert.equal(await form.evaluate(() => window.submissions), 0, "submission requires consent");
    const wire = JSON.stringify(packets);
    for (const secret of ["private@example.test", "Example City", file.name, originalFileB64, "pdf-qr-private-8753", "9999 4105 7058"]) assert.ok(!wire.includes(secret), `sensitive value or file data found on wire: ${secret}`);
    assert.ok(packets.some((packet) => packet.elements.some((element) => element.label === "Name" && element.value?.kind === "filled" && element.value.text === "Test Person")), "Shield may pass a medium-risk name in its matching field");
    assert.ok(packets.some((packet) => packet.elements.some((element) => element.label === "Date" && element.value?.kind === "filled" && element.value.text === "25/12/2000")), "an ordinary form date may pass when it is not identified as a birth date");
    assert.ok(packets.every((packet) => !packet.task.intent.includes("Test Person")), "task text must still be stripped of supplied values");
    assert.ok(packets.length >= 5);
    await panel.click('#confirm button[value="ok"]');
    await form.waitForFunction(() => window.submissions === 1, undefined, { timeout: 5000 });
    const submittedFile = await form.locator("#proof").evaluate(async (node, redactions) => {
      const file = node.files?.[0];
      if (!file) return null;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      let blackedOut = null;
      if (file.type === "image/png") {
        const bitmap = await createImageBitmap(file);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        blackedOut = redactions.length > 0;
        for (const {box} of redactions) {
          for (let y = Math.max(0, Math.floor(box[1])); y < Math.min(canvas.height, Math.ceil(box[1]+box[3])); y++) {
            for (let x = Math.max(0, Math.floor(box[0])); x < Math.min(canvas.width, Math.ceil(box[0]+box[2])); x++) {
              const i = (y * canvas.width + x) * 4;
              if (Math.abs(pixels[i]-16)>2 || Math.abs(pixels[i+1]-18)>2 || Math.abs(pixels[i+2]-22)>2 || pixels[i+3] !== 255) blackedOut = false;
            }
          }
        }
        bitmap.close();
      }
      return { name: file.name, type: file.type, size: file.size, data_b64: btoa(binary), sha256, blackedOut };
    }, filePreview.local_audit.redaction_regions);
    assert.equal(submittedFile.sha256, approvedHash, "the form must ingest exactly the approved sanitized bytes");
    assert.equal(submittedFile.type, file.mimeType);
    assert.notEqual(submittedFile.data_b64, originalFileB64, "the original file must not be submitted");
    if (provider === "google") assert.equal(submittedFile.blackedOut, true, "the uploaded image must contain the blacked-out pixels");
    else {
      assert.ok(Buffer.from(submittedFile.data_b64, "base64").toString().startsWith("%PDF-1.7"));
      const pdfCheck = await panel.evaluate(async (base64) => {
        const { inspectLocalMedia } = await import("/media-pipeline.js");
        const media = await inspectLocalMedia(new File([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], "sanitized-document.pdf", { type: "application/pdf" }));
        const bitmap = await createImageBitmap(media.original);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let blackedOut = true;
        for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i]-16)>2 || Math.abs(pixels[i+1]-18)>2 || Math.abs(pixels[i+2]-22)>2 || pixels[i+3] !== 255) blackedOut = false;
        bitmap.close();
        return { blackedOut, textRegions: media.report.text_regions, barcodeRegions: media.report.barcode_regions };
      }, submittedFile.data_b64);
      assert.equal(pdfCheck.blackedOut, true, "the new PDF must render the reviewed blacked-out page");
      assert.equal(pdfCheck.textRegions, 0, "the new PDF must not retain original document text");
      assert.equal(pdfCheck.barcodeRegions, 0, "the uploaded sanitized PDF must contain no decodable QR code");
    }
    // Rejected popup answers stop instead of opening another question dialog.
    await panel.waitForFunction(() => !document.querySelector("#run").disabled);
    await form.evaluate(() => { const name = document.querySelector("#name"); name.value = ""; name.setCustomValidity("This answer was rejected by the form."); });
    await panel.click("#start-task");
    await panel.fill("#task", "Fill this form with a new answer");
    await panel.click("#run");
    await panel.waitForSelector("#preflight[open]");
    await panel.click("#preflight-continue");
    await panel.waitForSelector("#ask[open]");
    await panel.fill("#ask-input", "Test Person");
    await panel.click("#ask-ok");
    await panel.waitForFunction(() => !document.querySelector("#run").disabled);
    assert.match(await panel.locator("#log").textContent(), /Stopped instead of asking again/);
    assert.equal(await panel.locator("#ask[open]").count(), 0);
    await form.evaluate(() => document.querySelector("#name").setCustomValidity(""));
    // Reinjection must leave only one message executor; old snapshots must fail.
    const old = await form.evaluate(() => new Promise((resolve) => window.listener({type:"perceive"}, {}, resolve)));
    await form.addScriptTag({ path: dist + "content.js" });
    const stale = await form.evaluate((snapshotId) => new Promise((resolve) => window.listener({type:"execute",snapshotId,step:{action:"click",targetId:"e1"}}, {}, resolve)), old.snapshotId);
    assert.equal(stale.error, "stale_snapshot");
    // Stop while a prompt is open must cancel the pending answer, never type it.
    await form.locator("#name").fill("");
    await panel.waitForFunction(() => !document.querySelector('#run').disabled);
    await panel.click("#start-task");
    await panel.fill("#task", "Help fill this form");
    await panel.click("#run");
    await panel.waitForSelector("#preflight[open]");
    await panel.click("#preflight-continue");
    await panel.waitForSelector("#ask[open]");
    await panel.evaluate(() => document.querySelector('#stop').click());
    await panel.waitForFunction(() => !document.querySelector('#run').disabled);
    assert.equal(await form.locator("#name").inputValue(), "");
    // Rejection after review leaves the upload empty and does not repeat the
    // same approval if the user retries this task.
    await form.locator("#name").fill("Test Person");
    await form.locator("#proof").setInputFiles([]);
    await panel.click("#start-task");
    await panel.fill("#task", "Review the file before uploading it");
    await panel.click("#run");
    await panel.waitForSelector("#preflight[open]");
    await panel.click("#preflight-continue");
    await panel.waitForSelector("#file-upload[open]");
    await panel.locator("#file-upload-input").setInputFiles(file);
    await panel.click("#file-upload-attach");
    await panel.waitForSelector("#file-review[open]", { timeout: 30000 });
    await panel.click('#file-review button[value="cancel"]');
    await panel.waitForFunction(() => !document.querySelector("#run").disabled);
    assert.equal(await form.locator("#proof").evaluate((node) => node.files?.length), 0);
    assert.equal(JSON.parse(await panel.locator("#media-report").textContent()).website_upload.state, "rejected");
    const reviewsAfterReject = await panel.evaluate(() => window.fileReviewCount);
    await panel.click("#start-task"); await panel.click("#run");
    await panel.waitForSelector("#preflight[open]"); await panel.click("#preflight-continue");
    await panel.waitForFunction(() => !document.querySelector("#run").disabled);
    assert.equal(await panel.evaluate(() => window.fileReviewCount), reviewsAfterReject);
    assert.equal(await form.locator("#proof").evaluate((node) => node.files?.length), 0);
    // A field that changes its accepted type after review must report a failed
    // upload, never fall back to the original or claim successful ingestion.
    await panel.click("#start-task");
    await panel.fill("#task", "Check the upload acceptance boundary");
    await panel.click("#run");
    await panel.waitForSelector("#preflight[open]"); await panel.click("#preflight-continue");
    await panel.waitForSelector("#file-upload[open]");
    await panel.locator("#file-upload-input").setInputFiles(file);
    await panel.click("#file-upload-attach");
    await panel.waitForSelector("#file-review[open]", { timeout: 30000 });
    await panel.waitForFunction(() => !document.querySelector("#file-review-approve").disabled);
    await form.locator("#proof").evaluate((input) => { input.accept = "text/plain"; });
    await panel.click("#file-review-approve");
    await panel.waitForFunction(() => !document.querySelector("#run").disabled);
    assert.equal(await form.locator("#proof").evaluate((node) => node.files?.length), 0);
    assert.equal(JSON.parse(await panel.locator("#media-report").textContent()).website_upload.state, "failed");
    assert.equal(JSON.parse(await panel.locator("#media-report").textContent()).website_upload.failure_reason, "file_type_not_accepted");
    await form.locator("#proof").evaluate((input, accept) => { input.accept = accept; }, file.mimeType);
    // Stop during async file encoding must prevent the subsequent attachment.
    await form.locator("#name").fill("Test Person");
    await form.locator("#proof").setInputFiles([]);
    await panel.click("#start-task");
    await panel.fill("#task", "Continue this form with the required upload");
    await panel.click("#run");
    await panel.waitForSelector("#preflight[open]");
    await panel.click("#preflight-continue");
    await panel.waitForSelector("#file-upload[open]");
    await panel.locator("#file-upload-input").setInputFiles(file);
    await panel.evaluate(() => {
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return read.call(this);
      };
    });
    await panel.click("#file-upload-attach");
    await panel.evaluate(() => document.querySelector("#stop").click());
    await panel.waitForFunction(() => !document.querySelector("#run").disabled);
    assert.equal(await form.locator("#proof").evaluate((node) => node.files?.length), 0, "Stop must prevent an attachment still being encoded");
    console.log(`PASS ${provider}: once-only post-preview approval, rejection blocks upload, exact approved sanitized ${file.mimeType} ingested, sequential answers and stale-target reuse (${packets.length} packets)`);
    await context.close();
  }
  // A cloud-style picker creates its file input inside an iframe, removes it
  // after dispatch, and later replaces the question with an uploaded-file chip.
  const pickerContext = await browser.newContext();
  const pickerPackets = [];
  await pickerContext.route("http://127.0.0.1:8787/**", async (route) => {
    const body = route.request().postData();
    if (!body) {
      await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ ok: true, planner: "heuristic", provider: "local", model_configured: false, mode: "heuristic", form_flow: "local-sequential-guarded" }) });
      return;
    }
    pickerPackets.push(JSON.parse(body));
    const response = await fetch(plannerUrl + "/plan", { method: "POST", headers: { "content-type": "application/json" }, body });
    await route.fulfill({ status: response.status, body: await response.text(), headers: { "access-control-allow-origin": "*", "content-type": "application/json" } });
  });
  const pickerForm = await pickerContext.newPage();
  await pickerForm.goto(base + "/picker-form");
  await pickerForm.setContent('<form><section role="listitem" id="upload-question"><div role="heading">Photo *</div><p>Upload 1 supported file. Max 10 MB.</p><button type="button" id="upload-button">Add file</button><span id="upload-chip" hidden></span></section><button type="submit">Submit</button></form>');
  await pickerForm.evaluate(() => {
    window.uploadCount = 0;
    window.pickerDelay = 0;
    window.pickerAccept = "image/png";
    window.dispatchCount = 0;
    window.insertCount = 0;
    window.insertDelay = 1100;
    window.acceptSanitizedUpload = async (file) => {
      window.uploadCount++;
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      window.uploadHash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      document.querySelector("#upload-button").remove();
      const picker = document.querySelector(".picker-dialog");
      picker.querySelector("dialog").close();
      picker.querySelector("iframe").contentDocument.body.innerHTML = "";
      setTimeout(() => {
        const chip = document.querySelector("#upload-chip");
        chip.dataset.fileName = file.name; chip.textContent = file.name; chip.hidden = false;
      }, 1200);
    };
    window.openUploadPicker = () => {
      let picker = document.querySelector(".picker-dialog");
      if (!picker) {
        picker = document.createElement("div"); picker.className = "picker-dialog";
        const dialog = document.createElement("dialog"); dialog.append(document.createElement("iframe"));
        picker.append(dialog); document.body.append(picker);
      }
      const dialog = picker.querySelector("dialog");
      const frame = picker.querySelector("iframe");
      frame.srcdoc = `<script>setTimeout(() => {
        document.body.innerHTML = '<input id="picker-file" type="file"><button id="insert-button" disabled>Insert (1)</button>';
        document.querySelector("input").accept = parent.pickerAccept;
        document.querySelector("input").onchange = function () {
          const file = this.files[0]; parent.dispatchCount++;
          const progress = document.createElement("progress"); document.body.append(progress);
          const insert = document.querySelector("button");
          insert.onclick = () => { parent.insertCount++; parent.acceptSanitizedUpload(file); };
          setTimeout(() => { progress.remove(); insert.disabled = false; }, parent.insertDelay);
        };
      }, parent.pickerDelay);<\/script>`;
      dialog.showModal();
    };
    document.querySelector("#upload-button").onclick = window.openUploadPicker;
    document.querySelector("form").onsubmit = (event) => event.preventDefault();
    window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.listener = fn; }, removeListener: () => {} } } };
  });
  await pickerForm.addScriptTag({ path: dist + "content.js" });
  const pickerPanel = await pickerContext.newPage();
  activePanel = pickerPanel;
  let injectedStales = 0;
  await pickerPanel.exposeFunction("sendToForm", async (message) => {
    if (message.type === "attach-file" && injectedStales < 2) {
      injectedStales++;
      await pickerForm.evaluate(() => new Promise((resolve) => window.listener({ type: "perceive" }, {}, resolve)));
    }
    return pickerForm.evaluate((msg) => new Promise((resolve) => window.listener(msg, {}, resolve)), message);
  });
  await pickerPanel.addInitScript(({ url }) => {
    const event = () => ({ addListener: () => {} });
    window.chrome = { runtime: {}, tabs: { query: async () => [{ id: 1, url }], sendMessage: (_id, msg, _options, cb) => window.sendToForm(msg).then(cb), onRemoved: event(), onActivated: event(), onUpdated: event() } };
  }, { url: base + "/picker-form" });
  await pickerPanel.goto(base + "/panel.html");
  await pickerPanel.click("#start-task"); await pickerPanel.fill("#task", "Complete the photo upload"); await pickerPanel.click("#run");
  await pickerPanel.waitForSelector("#preflight[open]"); await pickerPanel.click("#preflight-continue");
  await pickerPanel.waitForSelector("#file-upload[open]");
  const pickerImage = await pickerForm.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 100;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 640, 100);
    ctx.fillStyle = "black"; ctx.font = "bold 24px Arial"; ctx.fillText("Aadhaar: 9999 4105 7058", 15, 60);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await pickerPanel.locator("#file-upload-input").setInputFiles({ name: "private-picker-image.png", mimeType: "image/png", buffer: Buffer.from(pickerImage, "base64") });
  await pickerPanel.click("#file-upload-attach");
  await pickerPanel.waitForSelector("#file-review[open]", { timeout: 30000 });
  await pickerPanel.waitForFunction(() => !document.querySelector("#file-review-approve").disabled);
  const pickerHash = JSON.parse(await pickerPanel.locator("#file-review-json").textContent()).website_upload.sha256;
  await pickerPanel.click("#file-review-approve");
  await pickerPanel.waitForSelector("#confirm[open]", { timeout: 20000 });
  assert.equal(await pickerForm.evaluate(() => window.uploadCount), 1, "input removal after dispatch must not replay the upload");
  assert.equal(await pickerForm.evaluate(() => window.dispatchCount), 1, "a delayed Insert must not cause file re-dispatch");
  assert.equal(await pickerForm.evaluate(() => window.insertCount), 1, "Insert must be clicked once after the picker enables it");
  assert.equal(await pickerForm.evaluate(() => window.uploadHash), pickerHash, "the iframe picker must ingest only the approved sanitized bytes");
  assert.equal(pickerPackets.length, 2, "stale upload retries must stay local instead of calling the planner again");
  const pickerLog = await pickerPanel.locator("#log").textContent();
  assert.match(pickerLog, /upload\.retry:.*reason=stale_snapshot/);
  assert.match(pickerLog, /upload\.confirmed:/);
  assert.ok(!pickerLog.includes("private-picker-image.png") && !pickerLog.includes("9999 4105 7058"), "upload diagnostics must omit original filenames and values");
  assert.equal(JSON.parse(await pickerPanel.locator("#media-report").textContent()).website_upload.state, "attached");
  await pickerPanel.click('#confirm button[value="cancel"]');
  console.log("PASS cloud-style picker: delayed iframe Insert (1) completed once, one file dispatch, fresh snapshots and verified upload acknowledgement");
  await pickerPanel.waitForFunction(() => !document.querySelector("#run").disabled);
  await pickerForm.evaluate(() => {
    window.uploadCount = 0; window.dispatchCount = 0; window.insertCount = 0; window.pickerAccept = "application/pdf";
    const chip = document.querySelector("#upload-chip"); chip.hidden = true; chip.textContent = ""; delete chip.dataset.fileName;
    const button = document.createElement("button"); button.id = "upload-button"; button.type = "button"; button.textContent = "Add file"; button.onclick = window.openUploadPicker;
    document.querySelector("#upload-question").append(button);
  });
  await pickerPanel.click("#start-task"); await pickerPanel.fill("#task", "Complete the PDF document upload"); await pickerPanel.click("#run");
  await pickerPanel.waitForSelector("#preflight[open]"); await pickerPanel.click("#preflight-continue");
  await pickerPanel.waitForSelector("#file-upload[open]");
  await pickerPanel.locator("#file-upload-input").setInputFiles({ name: "private-qr-document.pdf", mimeType: "application/pdf", buffer: pdfFixture() });
  await pickerPanel.click("#file-upload-attach");
  await pickerPanel.waitForSelector("#file-review[open]", { timeout: 30000 });
  await pickerPanel.waitForFunction(() => !document.querySelector("#file-review-approve").disabled);
  const pdfReview = JSON.parse(await pickerPanel.locator("#file-review-json").textContent());
  assert.equal(pdfReview.local_audit.barcode_regions, 1);
  assert.equal(pdfReview.website_upload.mime_type, "application/pdf");
  assert.equal(await pickerForm.evaluate(() => window.uploadCount), 0, "PDF upload must wait for review approval");
  await pickerPanel.click("#file-review-approve");
  await pickerPanel.waitForSelector("#confirm[open]", { timeout: 20000 });
  assert.equal(await pickerForm.evaluate(() => window.uploadCount), 1);
  assert.equal(await pickerForm.evaluate(() => window.dispatchCount), 1);
  assert.equal(await pickerForm.evaluate(() => window.insertCount), 1);
  assert.equal(await pickerForm.evaluate(() => window.uploadHash), pdfReview.website_upload.sha256);
  assert.equal(JSON.parse(await pickerPanel.locator("#media-report").textContent()).website_upload.state, "attached");
  assert.equal(await pickerForm.locator("#upload-chip").textContent(), "sanitized-document.pdf");
  await pickerPanel.click('#confirm button[value="cancel"]');
  console.log("PASS reused cloud-style PDF picker: closed picker reopened, PDF QR detected, one approval, exact sanitized PDF ingested automatically");
  await pickerPanel.waitForFunction(() => !document.querySelector("#run").disabled);
  await pickerForm.evaluate(() => {
    window.uploadCount = 0; window.pickerDelay = 1500; window.pickerAccept = "image/png";
    const chip = document.querySelector("#upload-chip"); chip.hidden = true; chip.textContent = ""; delete chip.dataset.fileName;
    const button = document.createElement("button"); button.id = "upload-button"; button.type = "button"; button.textContent = "Add file"; button.onclick = window.openUploadPicker;
    document.querySelector("#upload-question").append(button);
  });
  await pickerPanel.click("#start-task"); await pickerPanel.fill("#task", "Cancel a pending picker upload"); await pickerPanel.click("#run");
  await pickerPanel.waitForSelector("#preflight[open]"); await pickerPanel.click("#preflight-continue");
  await pickerPanel.waitForSelector("#file-upload[open]");
  await pickerPanel.locator("#file-upload-input").setInputFiles({ name: "cancelled-picker-image.png", mimeType: "image/png", buffer: Buffer.from(pickerImage, "base64") });
  await pickerPanel.click("#file-upload-attach");
  await pickerPanel.waitForSelector("#file-review[open]", { timeout: 30000 });
  await pickerPanel.waitForFunction(() => !document.querySelector("#file-review-approve").disabled);
  await pickerPanel.click("#file-review-approve");
  await pickerForm.waitForSelector(".picker-dialog dialog[open]");
  await pickerPanel.click("#stop");
  await pickerPanel.waitForFunction(() => !document.querySelector("#run").disabled);
  await pickerForm.waitForTimeout(1800);
  assert.equal(await pickerForm.evaluate(() => window.uploadCount), 0, "Stop must prevent dispatch when a picker input appears later");
  console.log("PASS pending picker cancellation: Stop aborts file dispatch before a delayed iframe input appears");
  await pickerContext.close();
  // Native HTML dates silently discard locale-formatted strings. Verify that
  // the executor reports rejection rather than claiming a successful type.
  const page = await browser.newPage();
  await page.goto(base + "/native");
  await page.setContent('<label for="date">Date</label><input id="date" type="date" required>');
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.listener = fn; }, removeListener: () => {} } } };
  });
  await page.addScriptTag({ path: dist + "content.js" });
  const native = await page.evaluate(async () => {
    const message = (msg) => new Promise((resolve) => window.listener(msg, {}, resolve));
    const snapshot = await message({type:"perceive"});
    const field = snapshot.regions.find((r) => r.control);
    const request = {type:"execute",snapshotId:snapshot.snapshotId,grounding:{id:field.id,role:field.role,label:field.label,box:field.box},step:{action:"type",targetId:field.id,text:"31/31/2000"}};
    const rejected = await message(request);
    request.step.text = "2000-12-25";
    const accepted = await message(request);
    return { rejected, accepted, value:document.querySelector('input').value };
  });
  assert.equal(native.rejected.error, "validation_failed");
  assert.ok(native.rejected.detail.includes("YYYY-MM-DD"));
  assert.equal(native.accepted.ok, true);
  assert.equal(native.value, "2000-12-25");
  console.log("PASS native date: rejected format stays rejected; ISO date is accepted and retained");
} catch (error) {
  if (activePanel && !activePanel.isClosed()) console.error(await activePanel.locator("#log").textContent());
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => planner.close(resolve));
  await new Promise((resolve) => assets.close(resolve));
}
