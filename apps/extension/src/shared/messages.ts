import type { RawRegion } from "@kavach/core/policy";
import type { ElementRole, OriginClass, PlanStep } from "@kavach/core/schema";

/**
 * The typed message protocol between the side panel (orchestrator) and the
 * content script (eyes and hands). Everything here stays inside the
 * browser: raw values may cross THIS boundary, never the network one.
 */

export interface PageMeta {
  originClass: OriginClass;
  tls: boolean;
  lang: string;
  pageKind: string;
  viewport: { w: number; h: number; dpr: number };
  truncated?: boolean;
}

export interface PerceiveResponse {
  ok: true;
  snapshotId: number;
  regions: RawRegion[];
  meta: PageMeta;
}

/** What the executor verifies before touching an element. */
export interface Grounding {
  id: string;
  role: ElementRole;
  label: string | null;
  box: [number, number, number, number];
  disabled?: boolean;
  readonly?: boolean;
}

/** A plan step with any placeholder or prompt already resolved to text. */
export interface ResolvedStep {
  action: PlanStep["action"];
  targetId?: string;
  text?: string;
  optionLabel?: string;
  scroll?: { direction: "up" | "down"; amount: "page" | "half" | "to_element" };
  waitMs?: number;
}

export interface ExecuteRequest {
  type: "execute";
  snapshotId: number;
  step: ResolvedStep;
  grounding?: Grounding;
}

/** A user-approved local file transfer to a page file input. */
export interface AttachFileRequest {
  type: "attach-file";
  uploadId?: string;
  snapshotId: number;
  targetId: string;
  grounding: Grounding;
  file: { name: string; mimeType: string; data_b64: string; maxBytes?: number; sha256?: string };
}

export interface ExecuteResponse {
  ok: boolean;
  error?: "stale_snapshot" | "not_found" | "regrounding_failed" | "unsupported" | "failed" | "validation_failed";
  detail?: string;
  /** File bytes were handed to the page; never replay this upload on a re-render. */
  fileDispatched?: boolean;
  fileSha256?: string;
  pickerCompletion?: "closed" | "completed" | "pending" | "unavailable" | "cancelled";
  uploadReason?: "file_type_not_accepted" | "file_size_limit" | "different_existing_file";
}

export type ContentRequest =
  | { type: "perceive" }
  | AttachFileRequest
  | { type: "cancel-upload"; uploadId: string }
  | ExecuteRequest
  | { type: "highlight"; ids: string[] };

export type ContentResponse =
  | PerceiveResponse
  | ExecuteResponse
  | { ok: true }
  | { ok: false; error: string };

function sendMessage<T extends ContentResponse>(
  tabId: number,
  message: ContentRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!response || typeof response.ok !== "boolean") reject(new Error("The page helper did not return a valid response. Reload the extension and page."));
      else resolve(response as T);
    });
  });
}

function isMissingReceiver(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not establish connection|receiving end does not exist/i.test(message);
}

/** Send to the page helper, injecting our bundled helper once if the tab lacks it. */
export async function sendToTab<T extends ContentResponse>(
  tabId: number,
  message: ContentRequest,
): Promise<T> {
  try {
    return await sendMessage<T>(tabId, message);
  } catch (error) {
    if (!isMissingReceiver(error)) throw error;
  }

  // A lost execution response must never cause an action to be replayed.
  if (message.type !== "perceive") throw new Error("Page helper disconnected. Run again to re-perceive before acting.");

  try {
    if (chrome.scripting?.executeScript) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } else if (chrome.tabs.executeScript) {
      await new Promise<void>((resolve, reject) => {
        chrome.tabs.executeScript(tabId, { file: "content.js", allFrames: false }, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error("Page injection unavailable"));
          else resolve();
        });
      });
    } else throw new Error("Page injection unavailable");
    return await sendMessage<T>(tabId, message);
  } catch (error) {
    throw new Error(
      "Dravika couldn't access this tab. Reload Dravika, allow site access, refresh the form, and open its direct URL (not an embedded preview).",
    );
  }
}
