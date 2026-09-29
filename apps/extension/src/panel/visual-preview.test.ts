import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { createVisualPreview, type ObjectUrlProvider } from "./visual-preview.js";

describe("redacted frame preview", () => {
  let dom: Window;
  let urls: ObjectUrlProvider;

  beforeEach(() => {
    dom = new Window();
    dom.document.body.innerHTML = `
      <section id="frame" data-preview-state="empty">
        <img id="image" alt="Verified redacted frame" hidden>
        <p id="empty"></p>
        <p id="error" role="alert" hidden></p>
      </section>`;
    urls = {
      createObjectURL: vi.fn(() => "blob:dravika-preview"),
      revokeObjectURL: vi.fn(),
    };
  });

  afterEach(() => dom.close());

  function makePreview() {
    const get = (id: string) => dom.document.getElementById(id)! as unknown as HTMLElement;
    return createVisualPreview({
      frame: get("frame"),
      image: get("image") as unknown as HTMLImageElement,
      empty: get("empty"),
      error: get("error"),
    }, urls);
  }

  function image(): HTMLImageElement {
    return dom.document.querySelector("#image") as unknown as HTMLImageElement;
  }

  function element(id: string): HTMLElement {
    return dom.document.getElementById(id)! as unknown as HTMLElement;
  }

  function dispatchImageEvent(type: "load" | "error"): void {
    const EventConstructor = (dom as unknown as { Event: new (type: string) => Event }).Event;
    image().dispatchEvent(new EventConstructor(type));
  }

  it("starts in an explicit empty state, not as an image with a missing source", () => {
    makePreview();
    expect(dom.document.querySelector("#frame")?.getAttribute("data-preview-state")).toBe("empty");
    expect(dom.document.querySelector("#empty")?.textContent).toContain("No redacted frame");
    expect(image().hidden).toBe(true);
    expect(image().hasAttribute("src")).toBe(false);
  });

  it("renders verified WebP bytes and releases its object URL on clear", async () => {
    const preview = makePreview();
    const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
    preview.show(bytes);

    const blob = vi.mocked(urls.createObjectURL).mock.calls[0]?.[0];
    expect(blob?.type).toBe("image/webp");
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([...bytes]);
    const previewImage = image();
    expect(previewImage.getAttribute("src")).toBe("blob:dravika-preview");
    Object.defineProperty(previewImage, "naturalWidth", { configurable: true, value: 12 });
    Object.defineProperty(previewImage, "naturalHeight", { configurable: true, value: 8 });
    dispatchImageEvent("load");
    expect(dom.document.querySelector("#frame")?.getAttribute("data-preview-state")).toBe("ready");
    expect(previewImage.hidden).toBe(false);
    expect(element("empty").hidden).toBe(true);

    preview.clear("Structure-only packet; no frame was sent.");
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:dravika-preview");
    expect(previewImage.hidden).toBe(true);
    expect(previewImage.hasAttribute("src")).toBe(false);
    expect(dom.document.querySelector("#empty")?.textContent).toBe("Structure-only packet; no frame was sent.");
  });

  it("shows an error state for a failed image load instead of leaving alt text on a broken icon", () => {
    const preview = makePreview();
    preview.show(new Uint8Array([1, 2, 3]));
    const previewImage = image();
    dispatchImageEvent("error");

    expect(dom.document.querySelector("#frame")?.getAttribute("data-preview-state")).toBe("error");
    expect(element("empty").hidden).toBe(true);
    expect(dom.document.querySelector("#error")?.textContent).toContain("could not be loaded");
    expect(element("error").hidden).toBe(false);
    expect(previewImage.hidden).toBe(true);
    expect(previewImage.hasAttribute("src")).toBe(false);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:dravika-preview");
  });
});
