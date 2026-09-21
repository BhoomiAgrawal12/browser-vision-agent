import type { RawRegion } from "@kavach/core/policy";
import type { OriginClass, PlanStep } from "@kavach/core/schema";

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
  role: string;
  label: string | null;
  box: [number, number, number, number];
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

export interface ExecuteResponse {
  ok: boolean;
  error?: "stale_snapshot" | "not_found" | "regrounding_failed" | "unsupported" | "failed";
  detail?: string;
}

export type ContentRequest =
  | { type: "perceive" }
  | ExecuteRequest
  | { type: "highlight"; ids: string[] };

export type ContentResponse =
  | PerceiveResponse
  | ExecuteResponse
  | { ok: true }
  | { ok: false; error: string };

/** Promise wrapper over chrome.tabs.sendMessage. */
export function sendToTab<T extends ContentResponse>(
  tabId: number,
  message: ContentRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response as T);
    });
  });
}
