import type { MediaPage } from "../media/pipeline.js";
import { fileChoiceError } from "./file-prompt.js";

async function rasterPdf(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const rgb = new Uint8Array(canvas.width * canvas.height * 3);
    for (let i = 0, j = 0; i < pixels.length; i += 4) {
      rgb[j++] = pixels[i]!; rgb[j++] = pixels[i + 1]!; rgb[j++] = pixels[i + 2]!;
    }
    const compressed = new Uint8Array(await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    const chunks: Uint8Array[] = [encode("%PDF-1.7\n")];
    const offsets = [0];
    let length = chunks[0]!.length;
    const append = (bytes: Uint8Array): void => { chunks.push(bytes); length += bytes.length; };
    const object = (id: number, body: string, stream?: Uint8Array): void => {
      offsets[id] = length;
      append(encode(`${id} 0 obj\n${body}\n`));
      if (stream) { append(encode("stream\n")); append(stream); append(encode("\nendstream\n")); }
      append(encode("endobj\n"));
    };
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${canvas.width} ${canvas.height}] /Resources << /XObject << /Image 4 0 R >> >> /Contents 5 0 R >>`);
    object(4, `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>`, compressed);
    const content = encode(`q ${canvas.width} 0 0 ${canvas.height} 0 0 cm /Image Do Q`);
    object(5, `<< /Length ${content.length} >>`, content);
    const xref = length;
    append(encode(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    // New raster-only document: no original PDF objects, text or metadata.
    return new Blob(chunks as BlobPart[], { type: "application/pdf" });
  } finally { bitmap.close(); }
}

async function encodeImage(blob: Blob, type: string): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type, quality: 1 });
  } finally { bitmap.close(); }
}

/** Upload only a freshly generated artifact derived from verified sanitized pixels. */
export async function prepareSanitizedUpload(media: MediaPage, accept: string, maxBytes: number, preferredType?: string): Promise<{ file: File; sha256: string }> {
  let file: File | null = null;
  if (media.packet.origin.page_kind === "sanitized_pdf_page") {
    file = new File([await rasterPdf(media.sanitized)], "sanitized-document.pdf", { type: "application/pdf" });
  } else {
    const formats: [string, string][] = [
      ["image/png", "png"], ["image/jpeg", "jpg"], ["image/jpeg", "jpeg"], ["image/webp", "webp"],
    ];
    if (!accept.trim() && preferredType) formats.sort(([left], [right]) => Number(right === preferredType) - Number(left === preferredType));
    for (const [type, extension] of formats) {
      const name = `sanitized-image.${extension}`;
      if (fileChoiceError({ name, type, size: 0 }, accept, maxBytes)) continue;
      const blob = type === "image/png" ? media.sanitized : await encodeImage(media.sanitized, type);
      if (blob.type !== type) continue;
      file = new File([blob], name, { type });
      break;
    }
  }
  if (!file) throw new Error("This field does not accept a supported sanitized image format.");
  const error = fileChoiceError(file, accept, maxBytes);
  if (error) throw new Error(error);
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return { file, sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("") };
}

/** Review the exact image artifact (or its lossless PDF page) before upload. */
export function reviewSanitizedUpload(file: File, preview: Blob, label: string): Promise<boolean> {
  const dialog = document.getElementById("file-review") as HTMLDialogElement;
  const image = document.getElementById("file-review-image") as HTMLImageElement;
  const approve = document.getElementById("file-review-approve") as HTMLButtonElement;
  const status = document.getElementById("file-review-status")!;
  document.getElementById("file-review-text")!.textContent = `Review the blacked-out file for “${label}”. Approve to upload this sanitized file to the form.`;
  document.getElementById("file-review-pdf-note")!.hidden = file.type !== "application/pdf";
  document.getElementById("file-review-json")!.textContent = document.getElementById("media-report")!.textContent;
  const url = URL.createObjectURL(file.type === "application/pdf" ? preview : file);
  approve.disabled = true;
  status.textContent = "Loading the reviewed image…";
  image.src = url;
  dialog.returnValue = "cancel";
  dialog.showModal();
  void image.decode().then(() => {
    if (dialog.open && image.src === url) { approve.disabled = false; status.textContent = "Nothing is uploaded until you approve."; }
  }).catch(() => { if (dialog.open && image.src === url) status.textContent = "The preview could not be displayed. Cancel this upload."; });
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const approved = dialog.returnValue === "ok" && !approve.disabled;
      approve.disabled = true;
      image.removeAttribute("src");
      document.getElementById("file-review-json")!.textContent = "";
      URL.revokeObjectURL(url);
      resolve(approved);
    }, { once: true });
  });
}
