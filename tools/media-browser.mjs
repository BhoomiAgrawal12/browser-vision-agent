#!/usr/bin/env node
/** Browser-based media intake check. The server sees only newly generated PNGs. */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { BarcodeFormat, QRCodeWriter } from "@zxing/library";
import { makeServer } from "../apps/server/src/server.ts";
import { EgressGate } from "@kavach/core/gate";
import { defaultRegistry } from "@kavach/core/detectors";
import { Vault } from "@kavach/core/vault";

const dist = fileURLToPath(new URL("../apps/extension/dist/chrome/", import.meta.url));
const browserPath = process.env.DRAVIKA_BROWSER ?? ["/opt/brave.com/brave-origin/brave", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const server = createServer((req, res) => {
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end('<input type="file" id="file"><pre id="status"></pre>');
    return;
  }
  if (req.url === "/ui") {
    res.setHeader("content-type", "text/html");
    res.end('<input id="media-file" type="file"><span id="media-file-name">No file selected</span><span id="media-file-type" hidden></span><input id="media-page" value="1"><button id="media-inspect">Inspect locally</button><button id="media-send" disabled>Send sanitized page</button><button id="media-clear">Clear</button><span id="media-status"></span><img id="media-original" hidden><img id="media-sanitized" hidden><pre id="media-report"></pre><script type="module" src="/media.js"></script>');
    return;
  }
  const path = req.url?.replace(/^\//, "") ?? "";
  console.log(`asset: ${path}`);
  if (!/^(media\/[^/]+|media\.js|media-pipeline\.js)$/.test(path)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader("content-type", path.endsWith(".mjs") || path.endsWith(".js") ? "text/javascript" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    res.end(readFileSync(join(dist, path)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--disable-gpu"] });
const planner = makeServer({ env: {}, log: () => {} });
await new Promise((resolve) => planner.listen(0, "127.0.0.1", resolve));
const plannerUrl = `http://127.0.0.1:${planner.address().port}/plan`;
async function sendVerified(packet, forbidden) {
  const scannable = JSON.stringify({ ...packet, packet_id: undefined, captured_at_ms: undefined, visual: { ...packet.visual, sha256: undefined, data_b64: undefined } });
  const hits = defaultRegistry().analyze(scannable, { threshold: 0.8 });
  if (hits.length) console.error("tripwire diagnostics (class, offset, field):", hits.map((hit) => [hit.cls, hit.start, scannable.slice(Math.max(0, hit.start - 80), hit.start).match(/"[a-z_]+":/g)?.at(-1)]));
  const receipts = [];
  const gate = new EgressGate({ transport: { post: async (serialized) => {
    for (const secret of forbidden) assert.ok(!serialized.includes(secret));
    const response = await fetch(plannerUrl, { method: "POST", headers: { "content-type": "application/json" }, body: serialized });
    assert.equal(response.status, 200);
    return response.json();
  } }, registry: defaultRegistry(), vault: new Vault(), receipts: { append: (receipt) => receipts.push(receipt) } });
  await gate.send(packet);
  assert.equal(receipts[0].outcome, "sent");
}
function createPdf(jpeg) {
  const content = "q 640 0 0 220 0 0 cm /Im0 Do Q BT 0 Tr /F1 10 Tf 10 20 Td (HIDDEN_ACCESS_CODE_4959 hidden@example.test) Tj ET";
  const attachment = "private attachment payload";
  const parts = [Buffer.from("%PDF-1.4\n")];
  let length = parts[0].length;
  const offsets = [0];
  const add = (id, body) => {
    const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
    offsets[id] = length;
    const prefix = Buffer.from(`${id} 0 obj\n`);
    const suffix = Buffer.from("\nendobj\n");
    parts.push(prefix, content, suffix);
    length += prefix.length + content.length + suffix.length;
  };
  add(1, "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(private.txt) 6 0 R] >> >> /OpenAction 8 0 R >>");
  add(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  add(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 220] /Resources << /XObject << /Im0 10 0 R >> /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [7 0 R] >>");
  add(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  add(6, "<< /Type /Filespec /F (private.txt) /EF << /F 9 0 R >> >>");
  add(7, "<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (private annotation payload) >>");
  add(8, "<< /S /JavaScript /JS (app.alert('private script')) >>");
  add(9, `<< /Type /EmbeddedFile /Length ${attachment.length} >>\nstream\n${attachment}\nendstream`);
  add(10, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 640 /Height 220 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]));
  const xrefOffset = length;
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const pos of offsets.slice(1)) xref += `${String(pos).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info << /Author (Local Secret) >> >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(Buffer.from(xref + trailer));
  return Buffer.concat(parts);
}
function imageWithMetadata(png) {
  const type = Buffer.from("tEXt");
  const data = Buffer.from("Author\0GPS_LOCATION_SECRET");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), chunk.length - 4);
  const firstChunkEnd = 8 + 12 + png.readUInt32BE(8); // IHDR must precede ancillary chunks
  return Buffer.concat([png.subarray(0, firstChunkEnd), chunk, png.subarray(firstChunkEnd)]);
}
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("browser console:", m.text()); });
  await page.goto(url);
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 140;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0,0,300,100);
    ctx.fillStyle = "black"; ctx.font = "bold 25px Arial"; ctx.fillText("Email: private@example.test", 15,50); ctx.fillText("123 Main St", 15,95);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const result = await page.evaluate(async (base64) => {
    const bin = atob(base64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media = await Promise.race([inspectLocalMedia(new File([bytes], "private.png", { type: "image/png" })), new Promise((_, reject) => setTimeout(() => reject(new Error("Media processing timed out after 20s")), 20000))]);
    return { packet: media.packet, report: media.report, original: Array.from(new Uint8Array(await media.original.arrayBuffer())), sanitized: Array.from(new Uint8Array(await media.sanitized.arrayBuffer())) };
  }, image);
  assert.equal(result.packet.visual.present, true);
  assert.equal(result.packet.visual.format, "image/png");
  assert.equal(result.packet.origin.page_kind, "sanitized_image");
  const original = Buffer.from(result.original);
  const masked = Buffer.from(result.sanitized);
  assert.ok(!original.equals(masked), "raster must be newly generated and masked");
  assert.ok(!JSON.stringify(result.packet).includes("private@example.test"), "raw OCR PII must stay local");
  assert.ok(JSON.stringify(result.packet).includes("PII:EMAIL#1"), "packet must preserve typed redaction meaning");
  assert.ok(result.report.ocr_detected_classes.includes("EMAIL"));
  assert.ok(JSON.stringify(result.packet.untrusted_text).includes("PII:EMAIL#"));
  await sendVerified(result.packet, ["private@example.test", "private.png"]);
  console.log(`PASS browser image: local OCR, verified fully masked PNG, no original text in packet (${result.report.elapsed_ms}ms, ${Buffer.byteLength(JSON.stringify(result.packet))} outbound bytes)`);
  const qrMatrix = new QRCodeWriter().encode("qr-private-payload-8753", BarcodeFormat.QR_CODE, 180, 180, new Map());
  const qrImage = await page.evaluate((bits) => {
    const canvas = document.createElement("canvas"); canvas.width = bits[0].length; canvas.height = bits.length;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.fillStyle = "black";
    bits.forEach((row,y)=>row.forEach((bit,x)=>{if(bit)ctx.fillRect(x,y,1,1);}));
    return canvas.toDataURL("image/png").split(",")[1];
  }, Array.from({length:qrMatrix.height},(_,y)=>Array.from({length:qrMatrix.width},(_,x)=>qrMatrix.get(x,y))));
  const qrResult = await page.evaluate(async (base64) => {
    const data = Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media=await inspectLocalMedia(new File([data],"qr.png",{type:"image/png"}));
    return {packet:media.packet,report:media.report};
  }, qrImage);
  assert.equal(qrResult.report.barcode_regions,1);
  assert.ok(!JSON.stringify(qrResult.packet).includes("qr-private-payload-8753"));
  assert.ok(JSON.stringify(qrResult.packet).includes("PII:QR_BARCODE#1"));
  await sendVerified(qrResult.packet,["qr-private-payload-8753"]);
  console.log("PASS browser QR: payload decoded locally, discarded, and absent from the packet");
  const tagged = await page.evaluate(async (data) => {
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media = await inspectLocalMedia(new File([Uint8Array.from(data)], "gps-photo.png", { type: "image/png" }));
    return { report: media.report, packet: media.packet };
  }, [...imageWithMetadata(Buffer.from(image, "base64"))]);
  assert.ok(tagged.report.metadata_removed.includes("tEXt"));
  assert.ok(!JSON.stringify(tagged.packet).includes("GPS_LOCATION_SECRET"));
  await sendVerified(tagged.packet, ["GPS_LOCATION_SECRET", "gps-photo.png"]);
  console.log("PASS browser metadata: embedded PNG author/GPS metadata removed and absent from outbound packet");
  const scannedJpeg = Buffer.from(await page.evaluate(() => {
    const canvas=document.createElement("canvas"); canvas.width=640; canvas.height=220;
    const ctx=canvas.getContext("2d"); ctx.fillStyle="white"; ctx.fillRect(0,0,640,220);
    ctx.fillStyle="black"; ctx.font="bold 18px Arial"; ctx.fillText("Government Identity Card",15,32); ctx.fillText("Aadhaar: 9999 4105 7058",15,69); ctx.fillText("Email: media@example.test",15,106); ctx.fillText("Phone: 9876543210",15,143); ctx.fillText("PAN: ABCPE1234F",15,180);
    return canvas.toDataURL("image/jpeg",1).split(",")[1];
  }), "base64");
  const pdfBytes = createPdf(scannedJpeg);
  const pdf = await page.evaluate(async (data) => {
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media = await Promise.race([inspectLocalMedia(new File([Uint8Array.from(data)], "private.pdf", { type: "application/pdf" })), new Promise((_, reject) => setTimeout(() => reject(new Error("PDF processing timed out")), 20000))]);
    return { packet: media.packet, report: media.report, original: Array.from(new Uint8Array(await media.original.arrayBuffer())), sanitized: Array.from(new Uint8Array(await media.sanitized.arrayBuffer())) };
  }, [...pdfBytes]);
  assert.equal(pdf.packet.origin.page_kind, "sanitized_pdf_page");
  assert.ok(pdf.report.metadata_removed.includes("Author"));
  assert.ok(pdf.report.pdf_features_discarded.some((item) => item.includes("hidden")));
  assert.ok(pdf.report.pdf_features_discarded.includes("JavaScript/actions"));
  assert.ok(pdf.report.pdf_features_discarded.includes("attachments"));
  assert.ok(pdf.report.pdf_features_discarded.includes("annotations/form values"));
  assert.ok(pdf.report.redactions_by_class.EMAIL >= 1);
  assert.ok(pdf.report.redactions_by_class.AADHAAR >= 1);
  assert.ok(pdf.report.redactions_by_class.PHONE_IN >= 1);
  assert.ok(pdf.report.redactions_by_class.PAN >= 1);
  assert.equal(pdf.report.identity_document_detected, true);
  assert.ok(pdf.packet.elements.some((e) => e.value?.kind === "redacted" && e.value.token === "PII:ID_DOCUMENT#1"));
  assert.ok(!JSON.stringify(pdf.packet).includes("media@example.test"));
  assert.ok(!JSON.stringify(pdf.packet).includes("9999 4105 7058"));
  assert.ok(!JSON.stringify(pdf.packet).includes("9876543210"));
  assert.ok(!JSON.stringify(pdf.packet).includes("ABCPE1234F"));
  assert.ok(!JSON.stringify(pdf.packet).includes("Local Secret"));
  assert.ok(!JSON.stringify(pdf.packet).includes("HIDDEN_ACCESS_CODE_4959"));
  assert.ok(!JSON.stringify(pdf.packet).includes("hidden@example.test"));
  assert.ok(JSON.stringify(pdf.packet).includes("PII:EMAIL#"), "visible and hidden PDF email values are represented only as category tokens");
  assert.ok(JSON.stringify(pdf.packet).includes("PII:AADHAAR#"));
  assert.ok(JSON.stringify(pdf.packet).includes("PII:PHONE_IN#"));
  assert.ok(JSON.stringify(pdf.packet).includes("PII:PAN#"));
  assert.ok(!Buffer.from(pdf.original).equals(Buffer.from(pdf.sanitized)));
  await sendVerified(pdf.packet, ["media@example.test", "hidden@example.test", "9999 4105 7058", "9876543210", "ABCPE1234F", "Local Secret", "private.pdf", "private attachment payload", "private annotation payload", "private script"]);
  console.log(`PASS browser PDF: local render/OCR, metadata inspection, fully masked PNG, no original PDF or extracted text in packet (${pdf.report.elapsed_ms}ms, ${Buffer.byteLength(JSON.stringify(pdf.packet))} outbound bytes)`);
   await page.goto(url + "/ui");
   await page.locator("#media-file").setInputFiles({ name: "private.pdf", mimeType: "application/pdf", buffer: pdfBytes });
   assert.equal(await page.locator("#media-file-name").textContent(), "private.pdf");
   assert.equal(await page.locator("#media-file-type").textContent(), "PDF");
   await page.locator("#media-inspect").click();
  await page.waitForFunction(() => document.querySelector("#media-status")?.textContent?.startsWith("Verified locally"), undefined, { timeout: 20000 });
  assert.equal(await page.locator("#media-original").isVisible(), true);
  assert.equal(await page.locator("#media-sanitized").isVisible(), true);
  assert.equal(await page.locator("#media-send").isEnabled(), true);
  assert.ok(!(await page.locator("#media-report").innerText()).includes("HIDDEN_ACCESS_CODE_4959"));
   await page.locator("#media-clear").click();
   assert.equal(await page.locator("#media-send").isDisabled(), true);
   assert.equal(await page.locator("#media-file-name").textContent(), "No file selected");
   assert.equal(await page.locator("#media-file-type").isHidden(), true);
  console.log("PASS browser media UI: local PDF preview, audit, cleared memory and disabled send");
} finally {
  await browser.close();
  await new Promise((resolve) => planner.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
