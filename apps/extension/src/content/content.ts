import type { ContentRequest, ContentResponse } from "../shared/messages.js";
import { executeStep, reground } from "./execute.js";
import { perceive, type Snapshot } from "./perceive.js";

/**
 * Content script entry: the eyes (perceive) and the hands (execute), with
 * the re-grounding check between plan and action. Raw values never leave
 * the browser from here; they go only to the extension's own side panel.
 */

let current: Snapshot | null = null;
let snapshotId = 0;

const TARGETED = new Set(["click", "type", "clear", "select", "focus"]);

chrome.runtime.onMessage.addListener(
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
  },
);
