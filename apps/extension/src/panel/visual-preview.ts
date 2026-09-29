export interface VisualPreviewElements {
  frame: HTMLElement;
  image: HTMLImageElement;
  empty: HTMLElement;
  error: HTMLElement;
}

export interface ObjectUrlProvider {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

/** Owns the preview URL and exposes loading, empty, ready, and error states. */
export function createVisualPreview(
  elements: VisualPreviewElements,
  urls: ObjectUrlProvider = URL,
) {
  let currentUrl: string | null = null;

  function releaseImage(): void {
    elements.image.onload = null;
    elements.image.onerror = null;
    elements.image.removeAttribute("src");
    elements.image.hidden = true;
    if (currentUrl) urls.revokeObjectURL(currentUrl);
    currentUrl = null;
  }

  function showError(message: string, url?: string): void {
    if (url && url !== currentUrl) return;
    releaseImage();
    elements.frame.dataset.previewState = "error";
    elements.empty.hidden = true;
    elements.error.textContent = message;
    elements.error.hidden = false;
  }

  function clear(message = "No redacted frame is available yet."): void {
    releaseImage();
    elements.frame.dataset.previewState = "empty";
    elements.error.textContent = "";
    elements.error.hidden = true;
    elements.empty.textContent = message;
    elements.empty.hidden = false;
  }

  function show(bytes: Uint8Array): void {
    releaseImage();
    if (bytes.length === 0) {
      showError("The redacted preview is empty. No image was attached.");
      return;
    }

    elements.frame.dataset.previewState = "loading";
    elements.error.textContent = "";
    elements.error.hidden = true;
    elements.empty.textContent = "Loading verified redacted preview…";
    elements.empty.hidden = false;

    const blob = new Blob([bytes.slice() as BlobPart], { type: "image/webp" });
    const url = urls.createObjectURL(blob);
    currentUrl = url;
    elements.image.onload = () => {
      if (currentUrl !== url) return;
      if (elements.image.naturalWidth < 1 || elements.image.naturalHeight < 1) {
        showError("The redacted preview could not be decoded. The packet remains available below.", url);
        return;
      }
      elements.frame.dataset.previewState = "ready";
      elements.image.hidden = false;
      elements.empty.hidden = true;
      elements.error.hidden = true;
    };
    elements.image.onerror = () => {
      showError("The redacted preview could not be loaded. The packet remains available below.", url);
    };
    elements.image.src = url;
  }

  clear();
  return { show, clear, showError };
}
