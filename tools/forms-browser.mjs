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
  const filename = req.url === "/panel.html" ? "panel.html" : req.url === "/panel.js" ? "panel.js" : req.url === "/panel.css" ? "panel.css" : null;
  if (filename) { res.setHeader("content-type", filename.endsWith("js") ? "text/javascript" : filename.endsWith("css") ? "text/css" : "text/html"); res.end(readFileSync(dist + filename)); }
  else if (req.url === "/visual-preview.js") { res.setHeader("content-type", "text/javascript"); res.end(previewBundle.outputFiles[0].text); }
  else { res.setHeader("content-type", "text/html"); res.end("<!doctype html><body></body>"); }
});
await new Promise((resolve) => assets.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${assets.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
let activePanel;
try {
  for (const provider of ["google", "microsoft"]) {
    const context = await browser.newContext();
    const packets = [];
    await context.route("http://127.0.0.1:8787/**", async (route) => {
      const body = route.request().postData();
      if (!body) { await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } }); return; }
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
      <div style="height:1100px"></div>
      <section ${attr}><div ${title}>City *</div><input id="city" required></section>
      <section ${attr}><div ${title}>Country *</div>${provider === "google" ? '<div id="country" role="listbox" tabindex="0" aria-expanded="false" aria-required="true" aria-valuetext=""><div role="option" data-value="" aria-selected="true">Choose</div><div role="option" data-value="in" aria-selected="false" hidden>India</div></div>' : '<select id="country" required><option value="">Choose</option><option value="in">India</option></select>'}</section>
      <section ${attr}><div ${title}>Contact preference *</div><div role="radiogroup" id="contact" aria-required="true"><div role="radio" aria-checked="false">Phone</div><div role="radio" aria-checked="false">Email</div></div></section>
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
    await panel.locator("#media-file-name").evaluate((node) => { node.textContent = "very-long-selected-document-name-with-private-but-synthetic-test-content-2026-09.pdf"; });
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
          filePicker: rect(".media-file-picker"),
          pageInput: rect("#media-page"),
          buttons: ["#media-inspect", "#media-send", "#media-clear"].map((selector) => {
            const button = document.querySelector(selector);
            const box = button.getBoundingClientRect();
            return { left: box.left, right: box.right, width: button.clientWidth, scrollWidth: button.scrollWidth, whiteSpace: getComputedStyle(button).whiteSpace };
          }),
          preview: { hidden: previewImage.hidden, display: getComputedStyle(previewImage).display, emptyVisible: getComputedStyle(previewEmpty).display !== "none" },
          fileName: rect("#media-file-name"),
          packet: { maxHeight: getComputedStyle(packet).maxHeight, overflowY: getComputedStyle(packet).overflowY, whiteSpace: getComputedStyle(packet).whiteSpace, width: packet.clientWidth, scrollWidth: packet.scrollWidth, scrollHeight: packet.scrollHeight, clientHeight: packet.clientHeight },
        };
      });
      assert.ok(layout.documentWidth <= width, `panel overflows at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.filePicker.left >= 0 && layout.filePicker.right <= width, `file picker is clipped at ${width}px`);
      assert.ok(layout.fileName.left >= 0 && layout.fileName.right <= width, `long file name is clipped at ${width}px`);
      assert.ok(layout.pageInput.width >= 64 && layout.pageInput.right <= width, `PDF page field is clipped at ${width}px`);
      for (const button of layout.buttons) {
        assert.ok(button.left >= 0 && button.right <= width, `media action is clipped at ${width}px: ${JSON.stringify(button)}`);
        assert.equal(button.whiteSpace, "nowrap", `media action label wraps at ${width}px`);
        assert.ok(button.scrollWidth <= button.width + 1, `media action label collides at ${width}px`);
      }
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
    await panel.selectOption("#mode", "wireframe");
    await panel.fill("#task", "Fill this form. Name: Test Person, Date: wrong, Email: private@example.test, City: Example City, Country: India, Contact preference: Email");
    await panel.click("#run");
    await panel.waitForFunction(() => document.querySelector('#ask[open] #ask-text')?.textContent?.includes('DD/MM/YYYY'), undefined, { timeout: 15000 });
    assert.equal(await form.locator("#email").inputValue(), "", "must not advance beyond invalid date");
    await panel.fill("#ask-input", "25/12/2000");
    await panel.click("#ask-ok");
    await panel.waitForSelector("#confirm[open]", { timeout: 25000 });
    assert.equal(await form.locator("#name").inputValue(), "Test Person");
    assert.equal(await form.locator("#email").inputValue(), "private@example.test");
    assert.equal(await form.locator("#city").inputValue(), "Example City");
    assert.equal(provider === "google" ? await form.locator("#country").getAttribute("aria-valuetext") : await form.locator("#country").inputValue(), provider === "google" ? "India" : "in");
    assert.equal(await form.locator('[role=radio][aria-checked=true]').textContent(), "Email");
    assert.equal(await form.evaluate(() => window.submissions), 0, "submission requires consent");
    await panel.click('#confirm button[value="reject"], #confirm button[value="cancel"]', { timeout: 1000 }).catch(async () => panel.evaluate(() => document.querySelector('#confirm').close('cancel')));
    const wire = JSON.stringify(packets);
    for (const secret of ["Test Person", "private@example.test", "Example City", "25/12/2000"]) assert.ok(!wire.includes(secret), `raw value found on wire: ${secret}`);
    assert.ok(packets.length >= 5);
    // Reinjection must leave only one message executor; old snapshots must fail.
    const old = await form.evaluate(() => new Promise((resolve) => window.listener({type:"perceive"}, {}, resolve)));
    await form.addScriptTag({ path: dist + "content.js" });
    const stale = await form.evaluate((snapshotId) => new Promise((resolve) => window.listener({type:"execute",snapshotId,step:{action:"click",targetId:"e1"}}, {}, resolve)), old.snapshotId);
    assert.equal(stale.error, "stale_snapshot");
    // Stop while a prompt is open must cancel the pending answer, never type it.
    await form.locator("#name").fill("");
    await panel.waitForFunction(() => !document.querySelector('#run').disabled);
    await panel.fill("#task", "Help fill this form");
    await panel.click("#run");
    await panel.waitForSelector("#ask[open]");
    await panel.evaluate(() => document.querySelector('#stop').click());
    await panel.waitForFunction(() => !document.querySelector('#run').disabled);
    assert.equal(await form.locator("#name").inputValue(), "");
    console.log(`PASS ${provider}: full built-panel loop, offscreen fields, delayed validation/correction, selects, radios, consent, outbound redaction (${packets.length} packets)`);
    await context.close();
  }
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
  if (activePanel && !activePanel.isClosed()) console.error(await activePanel.locator("#log").innerText());
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => planner.close(resolve));
  await new Promise((resolve) => assets.close(resolve));
}
