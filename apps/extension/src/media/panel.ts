import { inspectLocalMedia, type MediaPage } from "./pipeline.js";
import { EgressGate } from "@kavach/core/gate";
import { defaultRegistry } from "@kavach/core/detectors";
import { Vault } from "@kavach/core/vault";
import { makeTransport } from "../transport.js";

const input = document.getElementById("media-file") as HTMLInputElement;
const inspect = document.getElementById("media-inspect") as HTMLButtonElement;
const send = document.getElementById("media-send") as HTMLButtonElement;
const output = document.getElementById("media-report")!;
const status = document.getElementById("media-status")!;
const fileName = document.getElementById("media-file-name")!;
const fileType = document.getElementById("media-file-type")!;
const pageInput = document.getElementById("media-page") as HTMLInputElement;
const pageRow = document.getElementById("media-page-row");
let page: MediaPage | null = null;
let urls: string[] = [];
let generation = 0;
function clear(): void {
  generation++;
  page = null;
  send.disabled = true;
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
  for (const id of ["media-original", "media-sanitized"]) {
    const img = document.getElementById(id) as HTMLImageElement;
    img.removeAttribute("src"); img.hidden = true;
  }
  output.textContent = "";
}
input.addEventListener("change", () => {
  clear();
  const file = input.files?.[0];
  pageInput.value = "1";
  fileName.textContent = file?.name ?? "No file selected";
  fileName.title = file?.name ?? "";
  const isPdf = Boolean(file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name)));
  fileType.textContent = file ? (isPdf ? "PDF" : "IMAGE") : "";
  fileType.hidden = !file;
  fileType.classList.toggle("pdf", isPdf);
  if (pageRow) pageRow.hidden = !isPdf;
  if (file) void inspectSelectedMedia();
  else status.textContent = "No media selected.";
});
document.getElementById("media-clear")!.addEventListener("click", () => {
  clear();
  input.value = "";
  input.disabled = false;
  pageInput.value = "1";
  if (pageRow) pageRow.hidden = true;
  fileName.textContent = "No file selected";
  fileName.title = "";
  fileType.textContent = "";
  fileType.hidden = true;
  fileType.classList.remove("pdf");
  status.textContent = "Local media cleared.";
});
pageInput.addEventListener("change", () => {
  if (input.files?.[0] && !pageInput.disabled) void inspectSelectedMedia();
});
inspect.addEventListener("click", () => void inspectSelectedMedia());

async function inspectSelectedMedia(): Promise<void> {
  clear();
  const ticket = generation;
  const file = input.files?.[0];
  if (!file) { status.textContent = "Choose an image or PDF first."; return; }
  inspect.disabled = true;
  input.disabled = true;
  pageInput.disabled = true;
  const isLikelyPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  status.textContent = `Inspecting ${isLikelyPdf ? "PDF page" : "image"} locally: checking file contents, OCR, faces, barcodes and redactions…`;
  try {
    const result = await inspectLocalMedia(file, Number(pageInput.value));
    if (generation !== ticket) return;
    page = result;
    const isPdf = result.packet.origin.page_kind === "sanitized_pdf_page";
    fileType.textContent = isPdf ? "PDF" : "IMAGE";
    fileType.hidden = false;
    fileType.classList.toggle("pdf", isPdf);
    if (pageRow) pageRow.hidden = !isPdf;
    for (const [id, blob] of [["media-original", result.original], ["media-sanitized", result.sanitized]] as const) {
      const url = URL.createObjectURL(blob); urls.push(url);
      const img = document.getElementById(id) as HTMLImageElement; img.src = url; img.hidden = false;
    }
    output.textContent = JSON.stringify({ local_audit: result.report, server_packet: { ...result.packet, visual: { ...result.packet.visual, data_b64: "<verified PNG pixels>" } } }, null, 2);
    send.disabled = false;
    status.textContent = result.report.redaction_regions.length > 0
      ? `Verified locally. ${result.report.redaction_regions.length} region(s) were flat-filled. Review the image before sending; local detectors can miss content.`
      : "Verified locally. No sensitive region was detected; review the metadata-free image before sending.";
  } catch {
    status.textContent = "BLOCKED: local media processing or integrity verification failed. No media was sent. Try a smaller PNG/JPEG or an unencrypted PDF page.";
  } finally {
    inspect.disabled = false;
    input.disabled = false;
    pageInput.disabled = false;
  }
}
send.addEventListener("click", async () => {
  if (!page || send.disabled) return;
  const ticket = generation;
  send.disabled = true;
  const receipts: unknown[] = [];
  const gate = new EgressGate({ transport: makeTransport(), registry: defaultRegistry(), vault: new Vault(), receipts: { append: (r) => { receipts.push(r); } } });
  try {
    await gate.send(page.packet);
    if (ticket === generation) status.textContent = "Processed image sent. No original file bytes, OCR text, filename, or metadata values were included.";
  } catch {
    if (ticket === generation) status.textContent = "Media request blocked or planner unavailable. Check the receipt below for whether transmission occurred.";
  }
  if (ticket === generation) output.textContent += `\n\n${JSON.stringify({ receipts }, null, 2)}`;
});
