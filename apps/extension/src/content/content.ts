import type { ContentRequest, ContentResponse } from "../shared/messages.js";
import { attachSelectedFile, executeStep, reground } from "./execute.js";
import { perceive, type Snapshot } from "./perceive.js";

/**
 * Content script entry: the eyes (perceive) and the hands (execute), with
 * the re-grounding check between plan and action. Raw values never leave
 * the browser from here; they go only to the extension's own side panel.
 */

let current: Snapshot | null = null;
let snapshotId = 0;

const TARGETED = new Set(["click", "type", "clear", "select", "focus"]);

// Reinjection must not install a second executor for the same document.
const host = globalThis as typeof globalThis & { __dravikaListener?: Parameters<typeof chrome.runtime.onMessage.addListener>[0]; __dravikaUploads?: Map<string, AbortController> };
if (host.__dravikaListener) chrome.runtime.onMessage.removeListener(host.__dravikaListener);
for (const controller of host.__dravikaUploads?.values() ?? []) controller.abort();
const pendingUploads = new Map<string, AbortController>();
host.__dravikaUploads = pendingUploads;
const cancelledUploads = new Set<string>();
const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] =
  (message: ContentRequest, _sender, sendResponse: (r: ContentResponse) => void) => {
    void (async () => {
      try {
        switch (message.type) {
          case "perceive": {
            current = perceive(document);
            snapshotId += 1;
            sendResponse({
              ok: true,
              snapshotId,
              regions: current.regions,
              meta: current.meta,
            });
            return;
          }

          case "execute": {
            if (!current || message.snapshotId !== snapshotId) {
              sendResponse({ ok: false, error: "stale_snapshot" });
              return;
            }
            const el = message.step.targetId
              ? current.elements.get(message.step.targetId)
              : undefined;
            if (TARGETED.has(message.step.action) && !message.grounding) {
              sendResponse({
                ok: false,
                error: "unsupported",
                detail: "target grounding is required",
              });
              return;
            }
            if (message.grounding) {
              const problem = reground(el, message.grounding);
              if (problem) {
                sendResponse({ ok: false, error: "regrounding_failed", detail: problem });
                return;
              }
            } else if (message.step.targetId && !el) {
              sendResponse({ ok: false, error: "not_found" });
              return;
            }
            if (TARGETED.has(message.step.action) && !message.step.targetId) {
              sendResponse({ ok: false, error: "unsupported", detail: "missing target" });
              return;
            }
            sendResponse(await executeStep(el, message.step));
            return;
          }

          case "attach-file": {
            if (message.uploadId && cancelledUploads.has(message.uploadId)) {
              sendResponse({ ok: false, error: "failed", detail: "upload cancelled" }); return;
            }
            if (!current || message.snapshotId !== snapshotId) {
              sendResponse({ ok: false, error: "stale_snapshot" });
              return;
            }
            const el = current.elements.get(message.targetId);
            const problem = reground(el, message.grounding);
            if (problem) {
              sendResponse({ ok: false, error: "regrounding_failed", detail: problem });
              return;
            }
            const controller = new AbortController();
            if (message.uploadId) {
              if (pendingUploads.has(message.uploadId)) { sendResponse({ ok: false, error: "failed", detail: "upload already in progress" }); return; }
              pendingUploads.set(message.uploadId, controller);
            }
            try { sendResponse(await attachSelectedFile(el, message.file, controller.signal)); }
            finally { if (message.uploadId) pendingUploads.delete(message.uploadId); }
            return;
          }

          case "cancel-upload": {
            cancelledUploads.add(message.uploadId);
            if (cancelledUploads.size > 256) cancelledUploads.delete(cancelledUploads.values().next().value!);
            pendingUploads.get(message.uploadId)?.abort();
            sendResponse({ ok: true });
            return;
          }

          case "highlight": {
            for (const id of message.ids) {
              const el = current?.elements.get(id);
              if (el instanceof HTMLElement) {
                const previous = el.style.outline;
                el.style.outline = "3px solid #1f4e79";
                setTimeout(() => {
                  el.style.outline = previous;
                }, 1500);
              }
            }
            sendResponse({ ok: true });
            return;
          }
        }
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message });
      }
    })();
    return true; // async sendResponse
  };
host.__dravikaListener = listener;
chrome.runtime.onMessage.addListener(listener);
