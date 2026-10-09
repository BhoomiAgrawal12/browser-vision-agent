import { createWorker, OEM } from "tesseract.js";
import { getDocument, GlobalWorkerOptions, Util } from "pdfjs-dist";
import { defaultRegistry } from "@kavach/core/detectors";
import { PolicyEngine, type RawRegion } from "@kavach/core/policy";
import { PII_SEVERITY, SCP_SCHEMA_ID, type Box, type SanitizedContextPacket } from "@kavach/core/schema";
import { sha256Hex } from "@kavach/core/gate";
import { Vault } from "@kavach/core/vault";
import { inspectImageMetadata, verifyRasterArtifact } from "@kavach/perception/media-metadata";
import { composeSanitized, verifyRedactedRegions, FILL_COLOR, type ImageDataLike, type RedactionRect } from "@kavach/perception";
import { defaultModelHost, ULTRAFACE_MANIFEST } from "@kavach/perception/models";
import { detectFaces, type FaceModel } from "@kavach/perception/vision";
import { createOrtFaceModel, type OrtNamespace } from "@kavach/perception/vision/ort";
import { assetUrl, verifiedMediaAssets } from "./assets.js";
import { detectBarcodeRegions } from "./barcodes.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 6_000_000;
const MAX_PACKET_RASTER_BYTES = 1_000_000;
const MAX_PACKET_RASTER_EDGE = 1600;
export interface MediaPage {
  page: number;
  original: Blob;
  sanitized: Blob;
  packet: SanitizedContextPacket;
  report: { pipeline_version: string; metadata_removed: string[]; pdf_features_discarded: string[]; text_regions: number; barcode_regions: number; face_regions: number; identity_document_detected: boolean; identity_document_hint: boolean; redactions_by_class: Record<string, number>; redaction_regions: { box: RawRegion["box"]; label: string }[]; ocr_detected_classes: string[]; ocr_text_sent: false; ocr_ms: number; face_ms: number; face_backend: "webgpu" | "wasm" | "none"; output_size_bytes: number; resized: boolean; treatment: string; elapsed_ms: number };
}

let faceModelPromise: Promise<FaceModel> | null = null;

function localFaceModel(): Promise<FaceModel> {
  if (!faceModelPromise) {
    faceModelPromise = (async () => {
      const ort = (globalThis as Record<string, unknown>)["ort"] as OrtNamespace | undefined;
      if (!ort) throw new Error("The local vision runtime is unavailable; refusing to release image pixels");
      const bytes = await defaultModelHost().load({
        ...ULTRAFACE_MANIFEST,
        url: assetUrl("models/ultraface-rfb-320.onnx"),
      });
      return createOrtFaceModel(ort, bytes, {
        wasmPaths: assetUrl("ort/"),
        // Avoid probing unavailable GPU adapters for this lightweight local model.
        executionProviders: ["wasm"],
      });
    })();
  }
  return faceModelPromise;
}

function checkDimensions(w: number, h: number): void {
  if (!Number.isFinite(w * h) || w < 1 || h < 1 || w * h > MAX_PIXELS) throw new Error("Media exceeds the six-megapixel processing limit");
}

function verifyEncodedRedactions(image: ImageDataLike, boxes: Box[]): void {
  for (const box of boxes) {
    const x1 = Math.max(0, Math.floor(box[0]));
    const y1 = Math.max(0, Math.floor(box[1]));
    const x2 = Math.min(image.width, Math.ceil(box[0] + box[2]));
    const y2 = Math.min(image.height, Math.ceil(box[1] + box[3]));
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      const i = (y * image.width + x) * 4;
      if (Math.abs(image.data[i]! - FILL_COLOR[0]) > 2 ||
        Math.abs(image.data[i + 1]! - FILL_COLOR[1]) > 2 ||
        Math.abs(image.data[i + 2]! - FILL_COLOR[2]) > 2 || image.data[i + 3] !== 255) {
        throw new Error("Encoded image redaction verification failed");
      }
    }
  }
}

/** @internal Exported for the browser integration check of the packet-size path. */
export async function encodeVerifiedRaster(
  source: ImageDataLike,
  redactions: RedactionRect[],
): Promise<{ blob: Blob; bytes: Uint8Array; image: ImageDataLike; boxes: Box[]; labels: string[]; resized: boolean }> {
  const initial = composeSanitized(source, redactions);
  if (!verifyRedactedRegions(initial.image, initial.appliedRects, { stamp: null }).ok) {
    throw new Error("Media pixel verification failed");
  }
  const base = new OffscreenCanvas(source.width, source.height);
  base.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(initial.image.data), source.width, source.height), 0, 0);

  let scale = Math.min(1, MAX_PACKET_RASTER_EDGE / Math.max(source.width, source.height));
  for (let attempt = 0; attempt < 9; attempt++) {
    const width = Math.max(1, Math.floor(source.width * scale));
    const height = Math.max(1, Math.floor(source.height * scale));
    const scaleX = width / source.width;
    const scaleY = height / source.height;
    let composed = initial;
    if (width !== source.width || height !== source.height) {
      const resized = new OffscreenCanvas(width, height);
      const resizedContext = resized.getContext("2d", { willReadFrequently: true })!;
      resizedContext.imageSmoothingEnabled = true;
      resizedContext.drawImage(base, 0, 0, width, height);
      const pixels = resizedContext.getImageData(0, 0, width, height);
      const scaledMasks = initial.appliedRects.map((box, index) => ({
        box: [box[0] * scaleX, box[1] * scaleY, box[2] * scaleX, box[3] * scaleY] as Box,
        ...(redactions[index]?.label ? { label: redactions[index]!.label } : {}),
      }));
      composed = composeSanitized({ width, height, data: pixels.data }, scaledMasks);
      if (!verifyRedactedRegions(composed.image, composed.appliedRects, { stamp: null }).ok) {
        throw new Error("Resized media pixel verification failed");
      }
    }

    const output = new OffscreenCanvas(width, height);
    output.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(composed.image.data), width, height), 0, 0);
    const blob = await output.convertToBlob({ type: "image/png" });
    if (blob.size > MAX_PACKET_RASTER_BYTES) {
      scale *= 0.75;
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    verifyRasterArtifact(bytes);
    const roundTrip = await createImageBitmap(blob);
    try {
      const check = new OffscreenCanvas(width, height);
      const ctx = check.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(roundTrip, 0, 0);
      verifyEncodedRedactions({ width, height, data: ctx.getImageData(0, 0, width, height).data }, composed.appliedRects);
    } finally { roundTrip.close(); }
    return {
      blob,
      bytes,
      image: composed.image,
      boxes: composed.appliedRects,
      labels: redactions.map((redaction) => redaction.label ?? "UNEXPLAINED"),
      resized: width !== source.width || height !== source.height,
    };
  }
  throw new Error("Could not fit the sanitized image within the planner packet size limit");
}

/** No original container, OCR strings, file names or metadata values cross this boundary.
 * Supported images preserve pixels outside locally detected PII, faces and barcodes;
 * PDFs and ambiguous identity/signature pages retain the conservative full-page mask.
 */
export async function inspectLocalMedia(file: File, pageNumber = 1, options: { identityDocumentHint?: boolean } = {}): Promise<MediaPage> {
  if (!file.size || file.size > MAX_BYTES) throw new Error("Choose a nonempty file no larger than 20 MiB");
  const started = performance.now();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  const metadata: string[] = [];
  const discarded: string[] = [];
  const regions: RawRegion[] = [];
  const detectedRedactions: RedactionRect[] = [];
  let identityDocumentDetected = false;
  const ocrDetectedClasses = new Set<string>();
  const recognizers = defaultRegistry();
  const add = (text: string, box: [number, number, number, number], source: "dom" | "vision") => {
    if (regions.length >= 400) return;
    const spans = recognizers.analyze(text, { threshold: 0.3 });
    for (const span of spans) ocrDetectedClasses.add(span.cls);
    const classes = [...new Set(spans
      .filter((span) => PII_SEVERITY[span.cls] !== "medium" && span.confidence >= 0.5)
      .map((span) => span.cls))];
    if (classes.length > 0) detectedRedactions.push({ box, label: classes.map((cls) => `PII:${cls}`).join(" + ") });
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
    identityDocumentDetected = options.identityDocumentHint === true || regions.some((region) => /aadhaar|aadhar|passport|voter\s*id|driving\s+licen[cs]e|identity\s+card|government\s+id/i.test(region.rawText ?? ""));
    if (identityDocumentDetected && regions.length < 400) {
      regions.push({
        id: `e${regions.length + 1}`, role: "image", label: options.identityDocumentHint ? "Identity document (local upload-field hint)" : "Identity document (local OCR cues)",
        box: [0, 0, canvas!.width, canvas!.height], source: "vision", confidence: 0.75,
        evidence: [options.identityDocumentHint ? "structural:identity-document-upload" : "visual:id-document-ocr"], explained: true, visualClass: "ID_DOCUMENT",
      });
    }
    // On an identity document every OCR line is personal (name, DOB, address,
    // VID), and a single misread digit defeats the Aadhaar checksum, so mask
    // every text line rather than only checksum-validated values.
    if (identityDocumentDetected) {
      const covered = new Set(detectedRedactions.map((redaction) => redaction.box));
      for (const region of regions) {
        if (region.role === "text" && !covered.has(region.box)) detectedRedactions.push({ box: region.box, label: "PII:ID_DOCUMENT" });
      }
    }
    // If OCR never saw a number-like line, the ID number was not located at all.
    const unlocatedIdNumber = identityDocumentDetected &&
      !regions.some((region) => region.role === "text" && (region.rawText ?? "").replace(/\D/g, "").length >= 8);
    const ctx = canvas!.getContext("2d", { willReadFrequently: true })!;
    const image = ctx.getImageData(0, 0, canvas!.width, canvas!.height);
    let faceBackend: "webgpu" | "wasm" | "none" = "none";
    let faceMs = 0;
    let faceRegions = 0;
    if (!isPdf) {
      const faceStarted = performance.now();
      const model = await localFaceModel();
      const faces = await detectFaces({ width: image.width, height: image.height, data: image.data }, model);
      faceMs = Math.round(performance.now() - faceStarted);
      faceBackend = model.backend ?? "none";
      for (const face of faces) {
        const box = face.box as RawRegion["box"];
        faceRegions++;
        regions.push({
          id: `e${regions.length + 1}`, role: "image", label: null, box, source: "vision",
          confidence: face.score, evidence: ["visual:face-detector"], explained: true, visualClass: "FACE",
        });
        detectedRedactions.push({ box, label: "PII:FACE" });
      }
    }
    let barcodes = 0;
    {
      const barcodeBoxes = detectBarcodeRegions({ width: image.width, height: image.height, data: image.data });
      for (const box of barcodeBoxes) {
        barcodes++;
        regions.push({ id: `e${regions.length + 1}`, role: "image", label: null,
          box, source: "vision",
          confidence: 0.9, evidence: ["visual:qr-barcode-geometry"], explained: true, visualClass: "QR_BARCODE" });
        detectedRedactions.push({ box: regions.at(-1)!.box, label: "PII:QR_BARCODE" });
      }
    }
    const signatureCue = regions.some((region) => /\bsignature\b|\bsigned by\b/i.test(region.rawText ?? ""));
    if (signatureCue && regions.length < 400) {
      regions.push({
        id: `e${regions.length + 1}`, role: "image", label: "Signature-related page",
        box: [0, 0, image.width, image.height], source: "vision", confidence: 0.6,
        evidence: ["visual:signature-cue"], explained: true, visualClass: "SIGNATURE",
      });
    } else if (!isPdf && !identityDocumentDetected && detectedRedactions.length === 0 && regions.length < 400) {
      regions.push({
        id: `e${regions.length + 1}`, role: "image", label: "Unclassified image",
        box: [0, 0, image.width, image.height], source: "vision", confidence: 0.2,
        evidence: ["fusion:no-dom-node"], explained: false,
      });
    }
    const hasRecognizedContent = regions.some((region) => region.role === "text") || faceRegions > 0 || barcodes > 0;
    const unresolvedIdentityQr = options.identityDocumentHint === true && barcodes === 0;
    const forceFullMask = isPdf || signatureCue || unresolvedIdentityQr || unlocatedIdNumber || (identityDocumentDetected && detectedRedactions.length === 0) || !hasRecognizedContent;
    const fullPageMask: RedactionRect = {
      box: [0, 0, image.width, image.height],
      label: isPdf ? "PDF_PAGE" : identityDocumentDetected ? "PII:ID_DOCUMENT" : signatureCue ? "PII:SIGNATURE" : "UNEXPLAINED",
    };
    const redactions = forceFullMask ? [fullPageMask] : detectedRedactions;
    const raster = await encodeVerifiedRaster(image, redactions);
    const sanitized = raster.blob;
    const safeBytes = raster.bytes;
    const vault = new Vault();
    try {
      const policy = new PolicyEngine(recognizers, vault, "2026.09.2");
      const protectedPage = policy.sanitize(regions, "shield", "Describe the sanitized document structure; raw text and original media are withheld.");
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
      for (const region of regions) {
        if (region.visualClass && region.visualClass !== "ID_DOCUMENT") {
          redactionsByClass[region.visualClass] = (redactionsByClass[region.visualClass] ?? 0) + 1;
        }
      }
      if (identityDocumentDetected) redactionsByClass.ID_DOCUMENT = (redactionsByClass.ID_DOCUMENT ?? 0) + 1;
      const redactionRegions = raster.boxes.map((box, index) => ({
        box,
        label: raster.labels[index] ?? "UNEXPLAINED",
      }));
      let binary = "";
      for (let i = 0; i < safeBytes.length; i += 32768) binary += String.fromCharCode(...safeBytes.subarray(i, i + 32768));
      const base64 = btoa(binary);
      const packet: SanitizedContextPacket = {
        schema: SCP_SCHEMA_ID, packet_id: crypto.randomUUID(), captured_at_ms: Date.now(),
        policy: { mode: "shield", policy_version: "2026.09.2", invariant_floor: true },
        device: { backend: faceBackend === "none" ? "wasm" : faceBackend, tier: "T1", viewport: { w: raster.image.width, h: raster.image.height, dpr: 1 } },
        origin: { class: "other", tls: false, page_kind: isPdf ? "sanitized_pdf_page" : "sanitized_image", lang: "en" },
        visual: { present: true, format: "image/png", w: raster.image.width, h: raster.image.height, sha256: await sha256Hex(base64), data_b64: base64, redaction_overlay: "flat_fill", regions_redacted: redactionRegions.length },
        elements: protectedPage.elements.map((element) => ({
          ...element,
          box: [
            element.box[0] * raster.image.width / image.width,
            element.box[1] * raster.image.height / image.height,
            element.box[2] * raster.image.width / image.width,
            element.box[3] * raster.image.height / image.height,
          ] as Box,
        })),
        redaction_legend: Object.fromEntries(Object.entries(protectedPage.legend).map(([key, entry]) => [key, { ...entry, recoverable_by_client: false }])),
        task: { intent: protectedPage.intent, history: [] }, untrusted_text: typedOcrTokens,
      };
      return { page: pageNumber, original, sanitized, packet, report: {
        pipeline_version: "2026.09.30-qr-geometry",
        metadata_removed: [...new Set(metadata)], pdf_features_discarded: discarded,
        text_regions: regions.filter((region) => region.role === "text").length, barcode_regions: barcodes, face_regions: faceRegions,
        redaction_regions: redactionRegions,
        ocr_detected_classes: [...ocrDetectedClasses],
        redactions_by_class: redactionsByClass,
        identity_document_detected: identityDocumentDetected,
        identity_document_hint: options.identityDocumentHint === true,
        ocr_text_sent: false,
        ocr_ms: ocrMs,
        face_ms: faceMs,
        face_backend: faceBackend,
        output_size_bytes: safeBytes.length,
        resized: raster.resized,
        treatment: isPdf
          ? "PDF page fully masked after local OCR; original PDF objects, hidden text and metadata were discarded."
          : unresolvedIdentityQr ? "Full identity-upload image masked because its QR/code region could not be located safely."
          : unlocatedIdNumber ? "Full identity-document image masked because its ID number could not be located."
          : forceFullMask
            ? identityDocumentDetected || signatureCue
              ? "Full image masked because an identity-document or signature cue could not be localized safely."
              : "Full image masked because local detectors could not safely identify sensitive regions."
            : identityDocumentDetected ? "Identity document: every text line, face and barcode flat-filled; card layout is preserved for review."
            : "Selective flat-fill of locally detected PII, faces and barcodes; other pixels are preserved for review. OCR and visual detection can miss content.",
        elapsed_ms: Math.round(performance.now() - started),
      } };
    } finally { vault.wipe(); }
  } finally { await cleanup(); }
}
