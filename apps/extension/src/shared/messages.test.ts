import { afterEach, describe, expect, it, vi } from "vitest";
import { sendToTab, type ContentRequest, type ContentResponse } from "./messages.js";

describe("page messaging recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never reinjects or replays an action after losing its receiver", async () => {
    const executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { lastError: { message: "Receiving end does not exist" } },
      tabs: { sendMessage: (_id: number, _msg: unknown, _options: unknown, cb: (value: unknown) => void) => cb(undefined) },
      scripting: { executeScript },
    });
    await expect(sendToTab(17, { type: "execute", snapshotId: 1, step: { action: "click", targetId: "e1" } })).rejects.toThrow("re-perceive");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("injects the bundled content script and retries when a tab has no receiver", async () => {
    const runtime: { lastError: { message: string } | undefined } = { lastError: undefined };
    const replies: { error?: string; response?: ContentResponse }[] = [
      { error: "Could not establish connection. Receiving end does not exist." },
      { response: { ok: true } },
    ];
    const sendMessage = vi.fn(
      (_tabId: number, _message: ContentRequest, _options: unknown, callback: (response: ContentResponse) => void) => {
        const reply = replies.shift()!;
        runtime.lastError = reply.error ? { message: reply.error } : undefined;
        callback(reply.response!);
        runtime.lastError = undefined;
      },
    );
    const executeScript = vi.fn(async () => []);
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      runtime,
      scripting: { executeScript },
    });

    await expect(sendToTab(17, { type: "perceive" })).resolves.toEqual({ ok: true });

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 17 },
      files: ["content.js"],
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("explains when Chrome blocks injection into the current tab", async () => {
    const runtime: { lastError: { message: string } | undefined } = { lastError: undefined };
    const sendMessage = vi.fn(
      (_tabId: number, _message: ContentRequest, _options: unknown, callback: (response: ContentResponse) => void) => {
        runtime.lastError = {
          message: "Could not establish connection. Receiving end does not exist.",
        };
        callback(undefined as unknown as ContentResponse);
        runtime.lastError = undefined;
      },
    );
    const executeScript = vi.fn(async () => {
      throw new Error("Cannot access contents of url chrome://extensions/");
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      runtime,
      scripting: { executeScript },
    });

    await expect(sendToTab(17, { type: "perceive" })).rejects.toThrow(
      "Reload Dravika, allow site access",
    );
  });
});
