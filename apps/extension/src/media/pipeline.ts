import { createWorker, OEM } from "tesseract.js";
import { getDocument, GlobalWorkerOptions, Util } from "pdfjs-dist";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import { defaultRegistry } from "@kavach/core/detectors";
import { PolicyEngine, type RawRegion } from "@kavach/core/policy";
import { SCP_SCHEMA_ID, type SanitizedContextPacket } from "@kavach/core/schema";
import { sha256Hex } from "@kavach/core/gate";
import { Vault } from "@kavach/core/vault";
import { inspectImageMetadata, verifyRasterArtifact } from "@kavach/perception/media-metadata";
import { composeSanitized, verifyRedactedRegions, FILL_COLOR } from "@kavach/perception";
import { assetUrl, verifiedMediaAssets } from "./assets.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 6_000_000;
export interface MediaPage {
  page: number;
  original: Blob;
  sanitized: Blob;
  packet: SanitizedContextPacket;
  report: { metadata_removed: string[]; pdf_features_discarded: string[]; text_regions: number; barcode_regions: number; identity_document_detected: boolean; redactions_by_class: Record<string, number>; ocr_detected_classes: string[]; ocr_text_sent: false; ocr_ms: number; treatment: string; elapsed_ms: number };
}

function checkDimensions(w: number, h: number): void {
  if (!Number.isFinite(w * h) || w < 1 || h < 1 || w * h > MAX_PIXELS) throw new Error("Media exceeds the six-megapixel processing limit");
}

/** No original pixels, OCR strings, file names or metadata values cross this boundary.
 * The first release uses a fully masked raster plus typed region descriptors.
 * Unknown documents/signatures stay withheld instead of claiming recognition.
 */
export async function inspectLocalMedia(file: File, pageNumber = 1): Promise<MediaPage> {
  if (!file.size || file.size > MAX_BYTES) throw new Error("Choose a nonempty file no larger than 20 MiB");
  const started = performance.now();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  const metadata: string[] = [];
  const discarded: string[] = [];
  const regions: RawRegion[] = [];
  let identityDocumentDetected = false;
  const ocrDetectedClasses = new Set<string>();
  const recognizers = defaultRegistry();
  const add = (text: string, box: [number, number, number, number], source: "dom" | "vision") => {
    if (regions.length >= 400) return;
    for (const span of recognizers.analyze(text, { threshold: 0.3 })) ocrDetectedClasses.add(span.cls);
    regions.push({ id: `e${regions.length + 1}`, role: "text", label: null, box, source, confidence: 1, evidence: [source === "dom" ? "structural:pdf-text" : "visual:ocr"], explained: true, rawText: text });
  };
  let canvas: OffscreenCanvas;
  let cleanup = async () => {};
  await verifiedMediaAssets();
  GlobalWorkerOptions.workerSrc = assetUrl("media/pdf.worker.min.mjs");
  if (isPdf) {
    const loading = getDocument({ data: bytes, enableXfa: false, useSystemFonts: true, disableFontFace: true, stopAtErrors: true });
    cleanup = () => loading.destroy();
    try {
      const doc = await loading.promise;
      if (doc.numPages > 50 || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) throw new Error("PDF page is unavailable or document exceeds 50 pages");
      const info = await doc.getMetadata();
      metadata.push(...Object.keys(info.info).filter((key) => !["PDFFormatVersion", "IsLinearized"].includes(key)));
      if (info.metadata) metadata.push("XMP");
      if (await doc.getJSActions()) discarded.push("JavaScript/actions");
      if (await doc.getAttachments()) discarded.push("attachments");
      // Rasterisation discards optional-content state, hidden layers and all
      // original PDF objects; none of them are copied into the new PNG.
      const page = await doc.getPage(pageNumber);
      if ((await page.getAnnotations()).length) discarded.push("annotations/form values");
      discarded.push("original PDF structure, revisions, thumbnails and hidden/off-page content");
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1600 / base.width) });
      checkDimensions(viewport.width, viewport.height);
      canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, annotationMode: 0 }).promise;
      // PDF text may include invisible/off-page instructions. Read it only for
      // local PII classification; the packet builder below keeps typed PII
      // tokens and discards every non-token string.
      discarded.push("raw native text values (only detected PII tokens may leave)");
      const text = await page.getTextContent();
      for (const item of text.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const transform = Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(transform[2]!, transform[3]!);
        const box: [number, number, number, number] = [transform[4]!, transform[5]! - height, item.width * viewport.scale, height];
        if (box[0] < 0 || box[1] < 0 || box[0] + box[2] > canvas.width || box[1] + box[3] > canvas.height) continue;
        add(item.str, box, "dom");
      }
    } catch (error) { await cleanup(); throw error; }
  } else {
    const inspected = inspectImageMetadata(bytes);
    metadata.push(...inspected.removed);
    if (!inspected.width || !inspected.height) throw new Error("Image dimensions are unavailable; refusing to decode unknown-size media");
    checkDimensions(inspected.width, inspected.height);
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    try {
      if (bitmap.width !== inspected.width || bitmap.height !== inspected.height) throw new Error("Decoded image dimensions do not match the container header");
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    } finally { bitmap.close(); }
  }
  try {
    const original = await canvas!.convertToBlob({ type: "image/png" });
    const ocrStarted = performance.now();
    const worker = await createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: assetUrl("media/worker.min.js"), corePath: assetUrl("media/tesseract-core-lstm.wasm.js"),
      langPath: assetUrl("media").replace(/\/$/, ""), workerBlobURL: false, cacheMethod: "none", gzip: true,
    });
    try {
      const result = await worker.recognize(canvas!, {}, { blocks: true, text: true });
      for (const block of result.data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
        if (!line.text.trim()) continue;
        const b = line.bbox;
        add(line.text, [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0], "vision");
      }
    } finally { await worker.terminate(); }
    const ocrMs = Math.round(performance.now() - ocrStarted);
    identityDocumentDetected = regions.some((region) => /aadhaar|aadhar|passport|voter\s*id|driving\s+licen[cs]e|identity\s+card|government\s+id/i.test(region.rawText ?? ""));
    if (identityDocumentDetected && regions.length < 400) {
      regions.push({
        id: `e${regions.length + 1}`, role: "image", label: "Identity document (local OCR cues)",
        box: [0, 0, canvas!.width, canvas!.height], source: "vision", confidence: 0.75,
        evidence: ["visual:id-document-ocr"], explained: true, visualClass: "ID_DOCUMENT",
      });
    }
    const ctx = canvas!.getContext("2d", { willReadFrequently: true })!;
    const image = ctx.getImageData(0, 0, canvas!.width, canvas!.height);
    let barcodes = 0;
    try {
      const gray = new Uint8ClampedArray(image.width * image.height);
      for (let i = 0; i < gray.length; i++) gray[i] = (image.data[i * 4]! + image.data[i * 4 + 1]! * 2 + image.data[i * 4 + 2]!) / 4;
      const reader = new MultiFormatReader();
      reader.setHints(new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX, BarcodeFormat.PDF_417, BarcodeFormat.AZTEC, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]] ]));
      const result = reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray, image.width, image.height))));
      if (result) {
        barcodes = 1; // Decoded barcode contents are intentionally discarded.
        const points = result.getResultPoints();
        const xs = points.map((p) => p.getX());
        const ys = points.map((p) => p.getY());
        const left = xs.length ? Math.max(0, Math.min(...xs) - 4) : 0;
        const top = ys.length ? Math.max(0, Math.min(...ys) - 4) : 0;
        const right = xs.length ? Math.min(image.width, Math.max(...xs) + 4) : image.width;
        const bottom = ys.length ? Math.min(image.height, Math.max(...ys) + 4) : image.height;
        regions.push({ id: `e${regions.length + 1}`, role: "image", label: null,
          box: [left, top, Math.max(1, right - left), Math.max(1, bottom - top)], source: "vision",
          confidence: 0.9, evidence: ["visual:qr-barcode"], explained: true, visualClass: "QR_BARCODE" });
      }
    } catch { /* No supported code detected; the whole page still stays masked. */ }
    const mask = { box: [0, 0, image.width, image.height] as [number, number, number, number] };
    const composed = composeSanitized(image, [mask]);
    if (!verifyRedactedRegions(composed.image, composed.appliedRects, { stamp: null }).ok) throw new Error("Media pixel verification failed");
    const output = new OffscreenCanvas(image.width, image.height);
    output.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(composed.image.data), image.width, image.height), 0, 0);
    const sanitized = await output.convertToBlob({ type: "image/png" });
    const safeBytes = new Uint8Array(await sanitized.arrayBuffer());
    verifyRasterArtifact(safeBytes);
    const roundTrip = await createImageBitmap(sanitized);
    try {
      output.getContext("2d")!.drawImage(roundTrip, 0, 0);
      const decoded = output.getContext("2d")!.getImageData(0, 0, image.width, image.height);
      // PNG decode colour management may shift 18 to 19; a tolerance of two
      // still proves every pixel is near the same flat fill, not source data.
      for (let i = 0; i < decoded.data.length; i += 4) {
        if (Math.abs(decoded.data[i]! - FILL_COLOR[0]) > 2 ||
          Math.abs(decoded.data[i + 1]! - FILL_COLOR[1]) > 2 ||
          Math.abs(decoded.data[i + 2]! - FILL_COLOR[2]) > 2 || decoded.data[i + 3] !== 255) {
          throw new Error("Encoded image pixel verification failed");
        }
      }
    } finally { roundTrip.close(); }
    const vault = new Vault();
    try {
      const policy = new PolicyEngine(recognizers, vault, "2026.09.2");
      const protectedPage = policy.sanitize(regions, "fortress", "Describe the sanitized document structure; raw text and original media are withheld.");
      const typedOcrTokens = protectedPage.untrustedText.flatMap((entry) => {
        const tokens = [...new Set(entry.text.match(/\bPII:[A-Z0-9_]+#\d+\b/g) ?? [])];
        return tokens.length ? [{ src: entry.src, text: tokens.join(" ") }] : [];
      });
      const redactionsByClass: Record<string, number> = {};
      for (const entry of typedOcrTokens) {
        for (const match of entry.text.matchAll(/\bPII:([A-Z0-9_]+)#\d+\b/g)) {
          redactionsByClass[match[1]!] = (redactionsByClass[match[1]!] ?? 0) + 1;
        }
      }
      if (identityDocumentDetected) redactionsByClass.ID_DOCUMENT = (redactionsByClass.ID_DOCUMENT ?? 0) + 1;
      let binary = "";
      for (let i = 0; i < safeBytes.length; i += 32768) binary += String.fromCharCode(...safeBytes.subarray(i, i + 32768));
      const base64 = btoa(binary);
      const packet: SanitizedContextPacket = {
        schema: SCP_SCHEMA_ID, packet_id: crypto.randomUUID(), captured_at_ms: Date.now(),
        policy: { mode: "fortress", policy_version: "2026.09.2", invariant_floor: true },
        device: { backend: "wasm", tier: "T1", viewport: { w: image.width, h: image.height, dpr: 1 } },
        origin: { class: "other", tls: false, page_kind: isPdf ? "sanitized_pdf_page" : "sanitized_image", lang: "en" },
        visual: { present: true, format: "image/png", w: image.width, h: image.height, sha256: await sha256Hex(base64), data_b64: base64, redaction_overlay: "flat_fill", regions_redacted: 1 },
        elements: protectedPage.elements,
        redaction_legend: Object.fromEntries(Object.entries(protectedPage.legend).map(([key, entry]) => [key, { ...entry, recoverable_by_client: false }])),
        task: { intent: protectedPage.intent, history: [] }, untrusted_text: typedOcrTokens,
      };
      return { page: pageNumber, original, sanitized, packet, report: {
        metadata_removed: [...new Set(metadata)], pdf_features_discarded: discarded,
        text_regions: regions.length, barcode_regions: barcodes,
        ocr_detected_classes: [...ocrDetectedClasses],
      redactions_by_class: redactionsByClass,
      identity_document_detected: identityDocumentDetected,
        ocr_text_sent: false,
        ocr_ms: ocrMs,
        treatment: "Fully masked page image. OCR/PDF text classified locally; original pixels, hidden text and metadata discarded. Document/signature regions remain unexplained and withheld.",
        elapsed_ms: Math.round(performance.now() - started),
      } };
    } finally { vault.wipe(); }
  } finally { await cleanup(); }
}
