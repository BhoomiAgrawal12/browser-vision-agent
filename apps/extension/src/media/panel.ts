import { inspectLocalMedia, type MediaPage } from "./pipeline.js";

export interface MediaPreview {
  inspect(file: File, pageNumber?: number, options?: { identityDocumentHint?: boolean }): Promise<MediaPage | null>;
  showUpload(file: File, sha256: string, state: "awaiting_approval" | "approved" | "uploading" | "rejected" | "attached" | "failed", reason?: string): void;
  clear(): void;
}

/** Read-only sidebar output; file selection is owned by the question dialog. */
export function createMediaPreview(): MediaPreview {
  const output = document.getElementById("media-report")!;
  const status = document.getElementById("media-status")!;
  const image = document.getElementById("media-sanitized") as HTMLImageElement;
  const original = document.getElementById("media-original") as HTMLImageElement;
  let generation = 0;
  let url: string | null = null;
  let originalUrl: string | null = null;
  let selected: File | null = null;
  let selectedPage = 1;
  let selectedHint = false;
  let pending: Promise<MediaPage | null> | null = null;
  let resultPage: MediaPage | null = null;
  let displayedUpload: File | null = null;
  let view: Record<string, unknown> | null = null;

  function clear(): void {
    generation++;
    selected = null;
    pending = null;
    resultPage = null;
    displayedUpload = null;
    view = null;
    if (url) URL.revokeObjectURL(url);
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    url = null;
    originalUrl = null;
    image.removeAttribute("src");
    image.hidden = true;
    original.removeAttribute("src"); original.hidden = true;
    output.textContent = "";
    status.textContent = "No file preview yet.";
  }

  return {
    clear,
    showUpload(file, sha256, state, reason) {
      if (!resultPage || !view) return;
      if (displayedUpload !== file) {
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(file.type === "application/pdf" ? resultPage.sanitized : file);
        image.src = url;
        displayedUpload = file;
      }
      view.website_upload = { content: "sanitized_file_only", mime_type: file.type, bytes: file.size, sha256, state, ...(state === "failed" && reason ? { failure_reason: reason } : {}) };
      output.textContent = JSON.stringify(view, null, 2);
      status.textContent = state === "awaiting_approval" ? "Blacked-out file ready for review. Nothing has been uploaded to the form."
        : state === "rejected" ? "Upload rejected. No file was attached to the form."
        : state === "attached" ? "The approved blacked-out file was attached to the form."
        : state === "failed" ? `Upload failed: ${reason ?? "website_did_not_confirm_upload"}. See the JSON or Activity for details.`
        : state === "uploading" ? "Uploading the approved blacked-out file; refreshing the field and waiting for the form to accept it…"
        : "Blacked-out file approved; preparing the form attachment.";
    },
    inspect(file, pageNumber = 1, options = {}) {
      if (selected === file && selectedPage === pageNumber && selectedHint === (options.identityDocumentHint === true) && pending) return pending;
      clear();
      selected = file;
      selectedPage = pageNumber;
      selectedHint = options.identityDocumentHint === true;
      const ticket = generation;
      status.textContent = "Preparing the blacked-out preview locally: OCR, faces, QR codes and metadata checks…";
      pending = (async () => {
        try {
          const result = await inspectLocalMedia(file, pageNumber, options);
          if (generation !== ticket) return null;
          url = URL.createObjectURL(result.sanitized);
          resultPage = result;
          originalUrl = URL.createObjectURL(result.original);
          original.src = originalUrl; original.hidden = false;
          image.src = url;
          image.hidden = false;
          view = {
            transmission: "local_preview_not_sent",
            local_audit: result.report,
            sanitized_packet: { ...result.packet, visual: { ...result.packet.visual, data_b64: "<verified sanitized PNG pixels shown above>" } },
          };
          output.textContent = JSON.stringify(view, null, 2);
          const kind = result.packet.origin.page_kind === "sanitized_pdf_page" ? `PDF page ${result.page}` : "Image";
          status.textContent = `${kind} verified locally. ${result.report.redaction_regions.length} region(s) blacked out. This preview contains only sanitized content.`;
          return result;
        } catch {
          if (generation === ticket) {
            status.textContent = "Preview blocked: local processing or verification failed. Use a supported JPEG, PNG, WebP or unencrypted PDF.";
            pending = null;
          }
          return null;
        }
      })();
      return pending;
    },
  };
}
