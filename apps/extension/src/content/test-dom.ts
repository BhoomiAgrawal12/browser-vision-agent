import { Window } from "happy-dom";

type TestRect = { x: number; y: number; width: number; height: number };

const rects = new WeakMap<Element, TestRect>();

function expose(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

export function installDom(url = "https://forms.example.test/viewform"): Window {
  const win = new Window({ url });
  Object.defineProperty(win, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(win, "innerHeight", { configurable: true, value: 900 });
  Object.defineProperty(win, "devicePixelRatio", { configurable: true, value: 1 });

  for (const name of [
    "window",
    "document",
    "navigator",
    "location",
    "Node",
    "NodeFilter",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "HTMLOptionElement",
    "HTMLImageElement",
    "HTMLCanvasElement",
    "HTMLIFrameElement",
    "Event",
  ]) {
    expose(name, (win as unknown as Record<string, unknown>)[name]);
  }
  expose("getComputedStyle", win.getComputedStyle.bind(win));

  Object.defineProperty(win.Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element): DOMRect {
      const rect = rects.get(this) ?? { x: 0, y: 0, width: 120, height: 24 };
      return {
        ...rect,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        left: rect.x,
        toJSON: () => rect,
      } as DOMRect;
    },
  });
  return win;
}

export function setRect(
  element: unknown,
  rect: TestRect = { x: 0, y: 0, width: 120, height: 24 },
): void {
  rects.set(element as Element, rect);
}
