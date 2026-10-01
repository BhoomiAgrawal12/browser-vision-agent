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
import { EgressGate, sha256Hex } from "@kavach/core/gate";
import { defaultRegistry } from "@kavach/core/detectors";
import { Vault } from "@kavach/core/vault";

const dist = fileURLToPath(new URL("../apps/extension/dist/chrome/", import.meta.url));
const browserPath = process.env.DRAVIKA_BROWSER ?? ["/opt/brave.com/brave-origin/brave", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const server = createServer((req, res) => {
  if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end('<input type="file" id="file"><pre id="status"></pre><script src="/ort/ort.min.js"></script>');
    return;
  }
  if (req.url === "/ui") {
    res.setHeader("content-type", "text/html");
    res.end('<span id="media-status"></span><img id="media-original" hidden><img id="media-sanitized" hidden><pre id="media-report"></pre><script src="/ort/ort.min.js"></script><script type="module">import {createMediaPreview} from "/media.js"; window.mediaPreview = createMediaPreview();</script>');
    return;
  }
  const path = req.url?.replace(/^\//, "") ?? "";
  console.log(`asset: ${path}`);
  if (!/^(media\/[^/]+|media\.js|media-pipeline\.js|ort\/(?:ort\.min\.js|ort-wasm-simd-threaded(?:\.jsep)?\.(?:mjs|wasm))|models\/ultraface-rfb-320\.onnx)$/.test(path)) { res.writeHead(404); res.end(); return; }
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
function assertFlatFill(pixel, label) {
  assert.ok(pixel, `${label}: redaction box was not found`);
  assert.ok(pixel.slice(0, 3).every((channel, index) => Math.abs(channel - [16, 18, 22][index]) <= 2) && pixel[3] === 255, `${label}: pixel was not flat-filled`);
}
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => console.error("page error:", e.message));
  const initializerWarnings = [];
  const detectorErrors = [];
  page.on("console", (m) => {
    if (m.text().includes("Initializer ") && m.text().includes("appears in graph inputs")) initializerWarnings.push(m.text());
    if (/No available adapters|MultiFormatReader: non-ReaderException/.test(m.text())) detectorErrors.push(m.text());
    if (m.type() === "error" && !m.text().includes("Initializer ")) console.error("browser console:", m.text());
  });
  await page.goto(url);
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 140;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0,0,640,140);
    ctx.fillStyle = "black"; ctx.font = "bold 25px Arial"; ctx.fillText("Email: private@example.test", 15,50); ctx.fillText("123 Main St", 15,95);
    ctx.fillStyle = "#dcefe0"; ctx.fillRect(520,108,100,20);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const result = await page.evaluate(async (base64) => {
    const bin = atob(base64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media = await Promise.race([inspectLocalMedia(new File([bytes], "private.png", { type: "image/png" })), new Promise((_, reject) => setTimeout(() => reject(new Error("Media processing timed out after 20s")), 20000))]);
    const preview = await createImageBitmap(media.sanitized);
    const check = new OffscreenCanvas(preview.width, preview.height);
    const checkContext = check.getContext("2d", { willReadFrequently: true });
    checkContext.drawImage(preview, 0, 0);
    const safePixel = [...checkContext.getImageData(560, 118, 1, 1).data];
    const emailRegion = media.report.redaction_regions.find((region) => region.label.includes("PII:EMAIL"))?.box;
    const emailPixel = emailRegion
      ? [...checkContext.getImageData(Math.floor(emailRegion[0] + emailRegion[2] / 2), Math.floor(emailRegion[1] + emailRegion[3] / 2), 1, 1).data]
      : null;
    preview.close();
    return { packet: media.packet, report: media.report, safePixel, emailPixel, original: Array.from(new Uint8Array(await media.original.arrayBuffer())), sanitized: Array.from(new Uint8Array(await media.sanitized.arrayBuffer())) };
  }, image);
  assert.equal(result.packet.visual.present, true);
  assert.equal(result.packet.visual.format, "image/png");
  assert.equal(result.packet.origin.page_kind, "sanitized_image");
  assert.match(result.report.treatment, /Selective flat-fill/);
  assert.ok(result.report.redaction_regions.some((region) => region.label.includes("PII:EMAIL")));
  assert.ok(result.safePixel.slice(0, 3).every((channel, index) => Math.abs(channel - [220, 239, 224][index]) <= 3) && result.safePixel[3] === 255, "a safe image region must remain visible");
  assertFlatFill(result.emailPixel, "detected email");
  const original = Buffer.from(result.original);
  const masked = Buffer.from(result.sanitized);
  assert.ok(!original.equals(masked), "raster must be newly generated and masked");
  assert.ok(!JSON.stringify(result.packet).includes("private@example.test"), "raw OCR PII must stay local");
  assert.ok(JSON.stringify(result.packet).includes("PII:EMAIL#1"), "packet must preserve typed redaction meaning");
  assert.ok(result.packet.visual.data_b64.length <= 1_500_000, "raster must fit the Sanitized Context Packet limit");
  assert.ok(result.report.ocr_detected_classes.includes("EMAIL"));
  assert.ok(JSON.stringify(result.packet.untrusted_text).includes("PII:EMAIL#"));
  assert.equal(initializerWarnings.length, 0, "non-fatal ONNX initializer warnings should stay out of extension errors");
  assert.equal(result.report.face_backend, "wasm", "GPU-disabled devices must use the CPU backend");
  await sendVerified(result.packet, ["private@example.test", "private.png"]);
  console.log(`PASS browser image: selective local PII masking preserves safe pixels (${result.report.elapsed_ms}ms, ${Buffer.byteLength(JSON.stringify(result.packet))} outbound bytes)`);
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 220;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#f7fbf7"; ctx.fillRect(0,0,640,220);
    ctx.fillStyle = "black"; ctx.font = "bold 22px Arial";
    ctx.fillText("Name: Demo Person", 18,40);
    ctx.fillText("Aadhaar: 9999 4105 7058", 18,82);
    ctx.fillText("Phone: 9876543210", 18,124);
    ctx.fillText("Account summary", 18,166);
    ctx.fillStyle = "#dcefe0"; ctx.fillRect(520,180,90,25);
    return canvas.toDataURL("image/jpeg",0.95).split(",")[1];
  });
  const jpegResult = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media = await inspectLocalMedia(new File([bytes], "private-photo.jpg", { type: "image/jpeg" }));
    const preview = await createImageBitmap(media.sanitized);
    const check = new OffscreenCanvas(preview.width, preview.height);
    const ctx = check.getContext("2d", { willReadFrequently: true }); ctx.drawImage(preview, 0, 0);
    const safePixel = [...ctx.getImageData(560, 192, 1, 1).data];
    const aadhaarRegion = media.report.redaction_regions.find((region) => region.label.includes("PII:AADHAAR"))?.box;
    const phoneRegion = media.report.redaction_regions.find((region) => region.label.includes("PII:PHONE_IN"))?.box;
    const sampleBox = [12, 10, 350, 38];
    const sourcePreview = await createImageBitmap(media.original);
    const sourceCanvas = new OffscreenCanvas(sourcePreview.width, sourcePreview.height);
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true }); sourceContext.drawImage(sourcePreview, 0, 0);
    const sourceNamePixels = sourceContext.getImageData(...sampleBox);
    const resultNamePixels = ctx.getImageData(...sampleBox);
    let matchingNamePixels = 0;
    for (let i = 0; i < sourceNamePixels.data.length; i++) if (sourceNamePixels.data[i] === resultNamePixels.data[i]) matchingNamePixels++;
    const namePixelMatch = matchingNamePixels / sourceNamePixels.data.length;
    sourcePreview.close();
    preview.close();
    return {
      packet: media.packet, report: media.report, safePixel, namePixelMatch,
      aadhaarPixel: aadhaarRegion ? [...ctx.getImageData(Math.floor(aadhaarRegion[0] + aadhaarRegion[2] / 2), Math.floor(aadhaarRegion[1] + aadhaarRegion[3] / 2), 1, 1).data] : null,
      phonePixel: phoneRegion ? [...ctx.getImageData(Math.floor(phoneRegion[0] + phoneRegion[2] / 2), Math.floor(phoneRegion[1] + phoneRegion[3] / 2), 1, 1).data] : null,
    };
  }, jpeg);
  assert.equal(jpegResult.packet.visual.format, "image/png", "JPEG is decoded locally and freshly encoded as PNG");
  assert.equal(jpegResult.report.redactions_by_class.PERSON_NAME, undefined, "Shield mode may pass names");
  assert.ok(jpegResult.report.redaction_regions.some((region) => region.label.includes("PII:AADHAAR")));
  assert.ok(jpegResult.report.redaction_regions.some((region) => region.label.includes("PII:PHONE_IN")));
  assert.ok(jpegResult.safePixel.slice(0, 3).every((channel, index) => Math.abs(channel - [220, 239, 224][index]) <= 5) && jpegResult.safePixel[3] === 255, "safe JPEG content must survive redaction");
  assertFlatFill(jpegResult.aadhaarPixel, "JPEG Aadhaar");
  assertFlatFill(jpegResult.phonePixel, "JPEG phone");
  assert.ok(jpegResult.namePixelMatch > 0.98, "name pixels should remain visible in Shield mode");
  assert.ok(!JSON.stringify(jpegResult.packet).includes("Demo Person"));
  assert.ok(jpegResult.packet.visual.data_b64.length <= 1_500_000);
  await sendVerified(jpegResult.packet, ["Demo Person", "9999 4105 7058", "9876543210", "private-photo.jpg"]);
   console.log(`PASS browser JPEG: name retained, Aadhaar/phone masked, safe pixels preserved (${jpegResult.report.elapsed_ms}ms)`);
   const identityFallback = await page.evaluate(async (base64) => {
     const { inspectLocalMedia } = await import("/media-pipeline.js");
     const result = await inspectLocalMedia(new File([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], "identity-upload.jpg", { type: "image/jpeg" }), 1, { identityDocumentHint: true });
     const bitmap = await createImageBitmap(result.sanitized);
     const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
     const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0);
     const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
     let allBlack = true;
     for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i]-16)>2 || Math.abs(pixels[i+1]-18)>2 || Math.abs(pixels[i+2]-22)>2 || pixels[i+3]!==255) allBlack = false;
     bitmap.close(); return { report: result.report, allBlack };
   }, jpeg);
   assert.equal(identityFallback.report.barcode_regions, 0);
   assert.equal(identityFallback.report.identity_document_hint, true);
   assert.equal(identityFallback.allBlack, true, "identity uploads with an unresolved QR must not leave unverified pixels visible");
   assert.match(identityFallback.report.treatment, /QR\/code region could not be located/);
   console.log("PASS identity upload fallback: no located QR means the whole identity image is withheld");
  const largeRaster = await page.evaluate(async () => {
    const width = 2100, height = 1600;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = ctx.createImageData(width, height);
    let seed = 0x13579bdf;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = seed >>> 24;
      pixels.data[i] = noise;
      pixels.data[i + 1] = (noise * 3 + 17) & 255;
      pixels.data[i + 2] = (noise * 7 + 31) & 255;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 760, 135);
    ctx.fillStyle = "black"; ctx.font = "bold 38px Arial"; ctx.fillText("Aadhaar: 9999 4105 7058", 22, 86);
    const { encodeVerifiedRaster } = await import("/media-pipeline.js");
    const raster = await encodeVerifiedRaster(ctx.getImageData(0, 0, width, height), [{ box: [18, 45, 780, 62], label: "PII:AADHAAR" }]);
    let binary = "";
    for (let i = 0; i < raster.bytes.length; i += 32768) binary += String.fromCharCode(...raster.bytes.subarray(i, i + 32768));
    return { data_b64: btoa(binary), w: raster.image.width, h: raster.image.height, bytes: raster.bytes.length, resized: raster.resized, boxes: raster.boxes, labels: raster.labels };
  });
  assert.equal(largeRaster.resized, true, "large raster should be downscaled when needed for the wire cap");
  assert.ok(largeRaster.bytes <= 1_000_000);
  assert.ok(largeRaster.data_b64.length <= 1_500_000);
  assert.ok(largeRaster.w < 2100);
  assert.ok(largeRaster.labels.some((label) => label.includes("PII:AADHAAR")));
  const largePacket = structuredClone(jpegResult.packet);
  const packetScaleX = largeRaster.w / largePacket.visual.w;
  const packetScaleY = largeRaster.h / largePacket.visual.h;
  largePacket.device.viewport = { ...largePacket.device.viewport, w: largeRaster.w, h: largeRaster.h };
  largePacket.elements = largePacket.elements.map((element) => ({
    ...element,
    box: [element.box[0] * packetScaleX, element.box[1] * packetScaleY, element.box[2] * packetScaleX, element.box[3] * packetScaleY],
  }));
  largePacket.visual = {
    ...largePacket.visual,
    w: largeRaster.w,
    h: largeRaster.h,
    sha256: await sha256Hex(largeRaster.data_b64),
    data_b64: largeRaster.data_b64,
    regions_redacted: largeRaster.boxes.length,
  };
  await sendVerified(largePacket, ["9999 4105 7058", "large-id-photo.jpg"]);
  console.log("PASS browser large raster: resized below packet cap, redaction verified, actual PNG sent through the gate");
  const qrMatrix = new QRCodeWriter().encode("qr-private-payload-8753", BarcodeFormat.QR_CODE, 180, 180, new Map());
  const qrImage = await page.evaluate((bits) => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 240;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.fillStyle = "black";
    ctx.font = "bold 20px Arial";
    ctx.fillText("Aadhaar: 9999 4105 7058", 18, 50);
    bits.forEach((row,y)=>row.forEach((bit,x)=>{if(bit)ctx.fillRect(x+450,y+30,1,1);}));
    return canvas.toDataURL("image/png").split(",")[1];
  }, Array.from({length:qrMatrix.height},(_,y)=>Array.from({length:qrMatrix.width},(_,x)=>qrMatrix.get(x,y))));
  const qrResult = await page.evaluate(async (base64) => {
    const data = Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media=await inspectLocalMedia(new File([data],"qr.png",{type:"image/png"}));
    const original = await createImageBitmap(media.original);
    const sanitized = await createImageBitmap(media.sanitized);
    const canvas = new OffscreenCanvas(640, 240);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(original, 0, 0); const raw = ctx.getImageData(0, 0, 640, 240).data;
    ctx.drawImage(sanitized, 0, 0); const safe = ctx.getImageData(0, 0, 640, 240).data;
    let fullCodeMasked = true;
    for (let y = 30; y < 210; y++) for (let x = 450; x < 630; x++) {
      const i = (y * 640 + x) * 4;
      if (raw[i] < 40 && !([16,18,22].every((value, channel) => Math.abs(safe[i+channel] - value) <= 2) && safe[i+3] === 255)) fullCodeMasked = false;
    }
    original.close(); sanitized.close();
    return {packet:media.packet,report:media.report,fullCodeMasked};
  }, qrImage);
  assert.equal(qrResult.report.barcode_regions,1);
  assert.ok(qrResult.report.redactions_by_class.AADHAAR >= 1);
  assert.equal(qrResult.fullCodeMasked, true, "every QR module, including outer finder/data modules, must be blacked out");
  assert.ok(!JSON.stringify(qrResult.packet).includes("qr-private-payload-8753"));
  assert.ok(JSON.stringify(qrResult.packet).includes("PII:QR_BARCODE#1"));
  await sendVerified(qrResult.packet,["qr-private-payload-8753", "9999 4105 7058"]);
   console.log("PASS browser Aadhaar + QR: Aadhaar number and entire QR blacked out; decoded payload discarded and absent from the packet");
   const damagedCode = new QRCodeWriter().encode("damaged-private-code-8753", BarcodeFormat.QR_CODE, 180, 180, new Map());
   const denseCode = new QRCodeWriter().encode("secure-synthetic-" + "a1B2c3D4".repeat(150), BarcodeFormat.QR_CODE, 300, 300, new Map());
   const hardQr = await page.evaluate(async ({ damaged, dense }) => {
     const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 430;
     const ctx = canvas.getContext("2d", { willReadFrequently: true });
     ctx.fillStyle = "white"; ctx.fillRect(0, 0, 900, 430);
     ctx.fillStyle = "black"; ctx.font = "bold 22px Arial"; ctx.fillText("Aadhaar: 9999 4105 7058", 18, 38);
     damaged.forEach((row, y) => row.forEach((bit, x) => { if (bit) ctx.fillRect(x+25, y+100, 1, 1); }));
     dense.forEach((row, y) => row.forEach((bit, x) => { if (bit) ctx.fillRect(x+480, y+80, 1, 1); }));
     ctx.fillStyle = "white"; ctx.fillRect(97, 172, 70, 70);
     const source = ctx.getImageData(0, 0, 900, 430).data;
     const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
     const { inspectLocalMedia } = await import("/media-pipeline.js");
     const result = await inspectLocalMedia(new File([blob], "dense-damaged-qr.png", { type: "image/png" }));
     const bitmap = await createImageBitmap(result.sanitized);
     const safeCanvas = new OffscreenCanvas(900, 430);
     const safeCtx = safeCanvas.getContext("2d", { willReadFrequently: true }); safeCtx.drawImage(bitmap, 0, 0);
     const safe = safeCtx.getImageData(0, 0, 900, 430).data;
     let allQrBlack = true;
     for (const [left, top, size] of [[25,100,180], [480,80,300]]) {
       for (let y = top; y < top+size; y++) for (let x = left; x < left+size; x++) {
         const i = (y*900+x)*4;
         if (source[i] < 40 && ![16,18,22].every((value, channel) => Math.abs(safe[i+channel]-value) <= 2)) allQrBlack = false;
       }
     }
     bitmap.close();
     return { allQrBlack, packet: result.packet, report: result.report };
   }, {
     damaged: Array.from({length:180}, (_, y) => Array.from({length:180}, (_, x) => damagedCode.get(x,y))),
     dense: Array.from({length:300}, (_, y) => Array.from({length:300}, (_, x) => denseCode.get(x,y))),
   });
   assert.ok(hardQr.report.barcode_regions >= 1);
   assert.equal(hardQr.allQrBlack, true, "damaged and dense QR pixels must be blacked even without a readable payload");
   await sendVerified(hardQr.packet, ["damaged-private-code-8753", "secure-synthetic-", "9999 4105 7058", "dense-damaged-qr.png"]);
   console.log("PASS difficult QR media: damaged data and dense secure-QR-sized code fully masked in the encoded preview");
  const tagged = await page.evaluate(async (data) => {
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media = await inspectLocalMedia(new File([Uint8Array.from(data)], "gps-photo.png", { type: "image/png" }));
    return { report: media.report, packet: media.packet };
  }, [...imageWithMetadata(Buffer.from(image, "base64"))]);
  assert.ok(tagged.report.metadata_removed.includes("tEXt"));
  assert.ok(!JSON.stringify(tagged.packet).includes("GPS_LOCATION_SECRET"));
  await sendVerified(tagged.packet, ["GPS_LOCATION_SECRET", "gps-photo.png"]);
  console.log("PASS browser metadata: embedded PNG author/GPS metadata removed and absent from outbound packet");
   const scannedJpeg = Buffer.from(await page.evaluate((bits) => {
    const canvas=document.createElement("canvas"); canvas.width=640; canvas.height=220;
    const ctx=canvas.getContext("2d"); ctx.fillStyle="white"; ctx.fillRect(0,0,640,220);
     ctx.fillStyle="black"; ctx.font="bold 24px Arial"; ctx.fillText("Government Identity Card",15,32); ctx.fillText("Aadhaar: 9999 4105 7058",15,69); ctx.fillText("Email: media@example.test",15,106); ctx.fillText("Phone: 9876543210",15,143); ctx.fillText("PAN: ABCPE1234F",15,180);
     bits.forEach((row,y)=>row.forEach((bit,x)=>{if(bit)ctx.fillRect(x+450,y+20,1,1);}));
     return canvas.toDataURL("image/jpeg",1).split(",")[1];
   }, Array.from({length:qrMatrix.height},(_,y)=>Array.from({length:qrMatrix.width},(_,x)=>qrMatrix.get(x,y)))), "base64");
  const pdfBytes = createPdf(scannedJpeg);
  const pdf = await page.evaluate(async (data) => {
    const { inspectLocalMedia } = await import("/media-pipeline.js");
    const media = await Promise.race([inspectLocalMedia(new File([Uint8Array.from(data)], "private.pdf", { type: "application/pdf" })), new Promise((_, reject) => setTimeout(() => reject(new Error("PDF processing timed out")), 20000))]);
    return { packet: media.packet, report: media.report, original: Array.from(new Uint8Array(await media.original.arrayBuffer())), sanitized: Array.from(new Uint8Array(await media.sanitized.arrayBuffer())) };
  }, [...pdfBytes]);
   assert.equal(pdf.packet.origin.page_kind, "sanitized_pdf_page");
   assert.match(pdf.report.treatment, /fully masked/);
   assert.equal(pdf.report.redaction_regions.length, 1);
   assert.equal(pdf.report.redaction_regions[0].box[2], pdf.packet.visual.w);
   assert.equal(pdf.report.redaction_regions[0].box[3], pdf.packet.visual.h);
  assert.ok(pdf.report.metadata_removed.includes("Author"));
  assert.ok(pdf.report.pdf_features_discarded.some((item) => item.includes("hidden")));
  assert.ok(pdf.report.pdf_features_discarded.includes("JavaScript/actions"));
  assert.ok(pdf.report.pdf_features_discarded.includes("attachments"));
  assert.ok(pdf.report.pdf_features_discarded.includes("annotations/form values"));
  assert.ok(pdf.report.redactions_by_class.EMAIL >= 1);
  assert.ok(pdf.report.redactions_by_class.AADHAAR >= 1);
  assert.ok(pdf.report.redactions_by_class.PHONE_IN >= 1);
   assert.ok(pdf.report.redactions_by_class.PAN >= 1);
   assert.equal(pdf.report.barcode_regions, 1, "QR must be detected inside a scanned PDF page");
   assert.ok(pdf.report.redactions_by_class.QR_BARCODE >= 1);
   assert.ok(JSON.stringify(pdf.packet).includes("PII:QR_BARCODE#"));
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
   await sendVerified(pdf.packet, ["media@example.test", "hidden@example.test", "9999 4105 7058", "9876543210", "ABCPE1234F", "Local Secret", "private.pdf", "private attachment payload", "private annotation payload", "private script", "qr-private-payload-8753"]);
   console.log(`PASS browser PDF + QR: QR detected, page fully blacked out, metadata/hidden content discarded, QR payload absent from packet (${pdf.report.elapsed_ms}ms, ${Buffer.byteLength(JSON.stringify(pdf.packet))} outbound bytes)`);
    await page.goto(url + "/ui");
    await page.waitForFunction(() => Boolean(window.mediaPreview));
    const pdfPreview = await page.evaluate(async (bytes) => {
      const result = await window.mediaPreview.inspect(new File([Uint8Array.from(bytes)], "private.pdf", { type: "application/pdf" }));
      return result?.packet.origin.page_kind;
    }, [...pdfBytes]);
   assert.equal(pdfPreview, "sanitized_pdf_page");
   assert.equal(await page.locator('input[type="file"], #media-send').count(), 0, "the sidebar has no file-picker or media-send controls");
   assert.equal(await page.locator("#media-original").isVisible(), true);
   assert.equal(await page.locator("#media-sanitized").isVisible(), true);
   assert.ok(!(await page.locator("#media-report").innerText()).includes("HIDDEN_ACCESS_CODE_4959"));
    assert.equal(JSON.parse(await page.locator("#media-report").innerText()).transmission, "local_preview_not_sent");
    await page.evaluate(() => window.mediaPreview.clear());
    assert.equal(await page.locator("#media-sanitized").isHidden(), true);
    assert.equal(await page.locator("#media-original").isHidden(), true);
    assert.equal(await page.locator("#media-report").innerText(), "");
    console.log("PASS browser media UI: sanitized PDF image and JSON only, cleared preview and released image URL");
    const imagePreview = await page.evaluate(async (bytes) => {
      const result = await window.mediaPreview.inspect(new File([Uint8Array.from(bytes)], "private-photo.jpg", { type: "image/jpeg" }));
      return result?.packet.origin.page_kind;
    }, [...scannedJpeg]);
    assert.equal(imagePreview, "sanitized_image");
    assert.equal(await page.locator("#media-sanitized").isVisible(), true);
    console.log("PASS browser media UI: dialog-selected JPEG receives an automatic sanitized image/JSON preview");
    const cancelledPreview = await page.evaluate(async (bytes) => {
      const pending = window.mediaPreview.inspect(new File([Uint8Array.from(bytes)], "cancelled.pdf", { type: "application/pdf" }));
      window.mediaPreview.clear();
      return await pending;
    }, [...pdfBytes]);
    assert.equal(cancelledPreview, null);
    assert.equal(await page.locator("#media-sanitized").isHidden(), true);
    assert.equal(await page.locator("#media-report").innerText(), "", "a cancelled inspection must not repopulate the sidebar");
    assert.deepEqual(detectorErrors, [], "normal GPU fallback and barcode misses must not produce extension errors");
} finally {
  await browser.close();
  await new Promise((resolve) => planner.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
