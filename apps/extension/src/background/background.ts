/**
 * Minimal background: the orchestration loop deliberately lives in the
 * side panel page (a real, long-lived document) rather than here, because
 * MV3 service workers are killed at will and would drop the in-memory
 * vault. The background only wires the toolbar button to the panel.
 */

declare const browser: typeof chrome | undefined;

const isFirefox = typeof browser !== "undefined" && chrome.sidePanel === undefined;

if (!isFirefox && chrome.sidePanel) {
  // Chrome: clicking the toolbar icon opens the side panel.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e: unknown) => console.warn("sidePanel behavior", e));
}
// Firefox declares sidebar_action in the manifest; no wiring needed.
