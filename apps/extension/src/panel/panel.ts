import { defaultRegistry } from "@kavach/core/detectors";
import { EgressBlocked, EgressGate, type PrivacyReceipt } from "@kavach/core/gate";
import { PolicyEngine } from "@kavach/core/policy";
import {
  SCP_SCHEMA_ID,
  isInvariantClass,
  parseToken,
  type ActionPlan,
  type PlanStep,
  type PrivacyMode,
  type SanitizedContextPacket,
  type TaskHistoryStep,
} from "@kavach/core/schema";
import { Vault } from "@kavach/core/vault";
import type { RawRegion } from "@kavach/core/policy";
import { cssToImage, type CoordinateSpace } from "@kavach/core/fusion";
import {
  SelfCheckFailed,
  buildSanitizedVisual,
  captureVisibleTab,
  type CaptureFrame,
  type SanitizedVisual,
} from "@kavach/perception/browser";
import { diffTiles, hashTiles, type RedactionRect } from "@kavach/perception";
import { detectFaces, type FaceModel } from "@kavach/perception/vision";
import { createOrtFaceModel, type OrtNamespace } from "@kavach/perception/vision/ort";
import {
  sendToTab,
  type ExecuteResponse,
  type Grounding,
  type PerceiveResponse,
  type ResolvedStep,
} from "../shared/messages.js";
import { DEFAULT_SERVER_URL, makeTransport } from "../transport.js";

/**
 * The orchestrator. It lives in the side panel (a real, long-lived page)
 * so the in-memory vault survives; MV3 service workers do not. The loop:
 * perceive, sanitize, gate, plan, resolve, re-ground, execute, repeat.
 */

const POLICY_VERSION = "2026.09.1";
const MAX_ITERATIONS = 6;

/* UI plumbing */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const logEl = $("log");
const packetView = $("packet-view");
const receiptsEl = $("receipts");
const runBtn = $<HTMLButtonElement>("run");
const stopBtn = $<HTMLButtonElement>("stop");

function log(text: string, kind: "ok" | "err" | "dim" | "" = ""): void {
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = text;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Full receipt history for audit export. Tokens and hashes only. */
const receiptHistory: PrivacyReceipt[] = [];

function exportReceipts(): void {
  const payload = {
    exported_at: new Date().toISOString(),
    policy_version: POLICY_VERSION,
    receipts: receiptHistory,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kavach-receipts-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const stats = { redacted: 0, sent: 0, bytes: 0 };
function renderStats(): void {
  $("stat-blocked").textContent = String(stats.redacted);
  $("stat-sent").textContent = String(stats.sent);
  $("stat-bytes").textContent = stats.bytes.toLocaleString();
  $("stat-leaks").textContent = "0";
}

function renderReceipt(r: PrivacyReceipt): void {
  const div = document.createElement("div");
  div.className = "receipt" + (r.outcome === "blocked" ? " blocked" : "");
  const classes = Object.entries(r.redactions.by_legend_class)
    .map(([k, v]) => `${k.replace("PII:", "")}×${v}`)
    .join(" ");
  div.innerHTML = "";
  const head = document.createElement("div");
  head.className = "head";
  head.textContent = `${r.outcome.toUpperCase()} · ${r.mode} · ${r.sent.bytes} B`;
  const body = document.createElement("div");
  body.textContent =
    r.outcome === "blocked"
      ? (r.blocked_reasons ?? []).join("; ")
      : `${r.redactions.total} redactions ${classes ? "(" + classes + ")" : ""} · sha256 ${r.sent.payload_sha256.slice(0, 12)}…`;
  div.append(head, body);
  receiptsEl.prepend(div);
}

function ask(promptText: string): Promise<string | null> {
  const dialog = $<HTMLDialogElement>("ask");
  $("ask-text").textContent = promptText;
  const input = $<HTMLInputElement>("ask-input");
  input.value = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "ok" ? input.value : null),
      { once: true },
    );
  });
}

function confirmAction(text: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("confirm");
  $("confirm-text").textContent = text;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), {
      once: true,
    });
  });
}

/* Session state */

const vault = new Vault();
const registry = defaultRegistry();
const policy = new PolicyEngine(registry, vault, POLICY_VERSION);
let lastHostname: string | null = null;
let stopRequested = false;

const gate = new EgressGate({
  transport: makeTransport(DEFAULT_SERVER_URL),
  registry,
  vault,
  receipts: {
    append: (r) => {
      receiptHistory.push(r);
      $<HTMLButtonElement>("export-receipts").disabled = false;
      renderReceipt(r);
      if (r.outcome === "sent") {
        stats.sent += 1;
        stats.bytes += r.sent.bytes;
      }
      renderStats();
    },
  },
});

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab;
}

function buildPacket(
  perception: PerceiveResponse,
  sanitized: ReturnType<PolicyEngine["sanitize"]>,
  mode: PrivacyMode,
  history: TaskHistoryStep[],
  visual: SanitizedVisual | null,
): SanitizedContextPacket {
  return {
    schema: SCP_SCHEMA_ID,
    packet_id: crypto.randomUUID(),
    captured_at_ms: Date.now(),
    policy: { mode, policy_version: POLICY_VERSION, invariant_floor: true },
    device: {
      backend: "none",
      tier: visual ? "T1" : "T0",
      viewport: perception.meta.viewport,
    },
    origin: {
      class: perception.meta.originClass,
      tls: perception.meta.tls,
      page_kind: perception.meta.pageKind,
      lang: perception.meta.lang.slice(0, 16),
    },
    visual: visual
      ? {
          present: true,
          format: "image/webp",
          w: visual.width,
          h: visual.height,
          sha256: visual.sha256,
          redaction_overlay:
            visual.compose.stampPlacements.length > 0 ? "label_stamp" : "flat_fill",
          regions_redacted: sanitized.summary.regionsRedacted,
          data_b64: visual.base64,
        }
      : { present: false, regions_redacted: sanitized.summary.regionsRedacted },
    elements: sanitized.elements,
    redaction_legend: sanitized.legend,
    task: { intent: sanitized.intent.slice(0, 1000), history: history.slice(-50) },
    untrusted_text: sanitized.untrustedText.slice(0, 200),
  };
}

/* On-device face detection: the model loads once, lazily, from the
   extension's own bundled assets. No model, no crash: the pipeline
   degrades to structural perception and fail-closed media masking. */

let faceModelPromise: Promise<FaceModel | null> | null = null;

function faceModel(): Promise<FaceModel | null> {
  if (!faceModelPromise) {
    faceModelPromise = (async () => {
      const ortNs = (globalThis as Record<string, unknown>)["ort"] as
        | OrtNamespace
        | undefined;
      if (!ortNs) {
        log("onnxruntime not loaded; face detection off", "dim");
        return null;
      }
      try {
        const model = await createOrtFaceModel(ortNs, "models/ultraface-rfb-320.onnx", {
          wasmPaths: "ort/",
          executionProviders: ["webgpu", "wasm"],
        });
        log("face detector ready (ultraface-rfb-320, on-device)", "dim");
        return model;
      } catch (e) {
        log(`face detector unavailable: ${(e as Error).message}`, "dim");
        return null;
      }
    })();
  }
  return faceModelPromise;
}

/** Capture once per iteration; null when capture is not possible. */
async function tryCapture(): Promise<CaptureFrame | null> {
  try {
    return await captureVisibleTab();
  } catch (e) {
    log(`  capture unavailable (${(e as Error).message}); structure only`, "dim");
    return null;
  }
}

/**
 * Run the on-device face detector over the captured frame and express
 * each hit as a raw region in CSS space, so the policy engine mints
 * PII:FACE tokens and the composer destroys those pixels like any other
 * redaction. Ids continue after the content script's sequence.
 */
async function detectFaceRegions(
  frame: CaptureFrame,
  perception: PerceiveResponse,
): Promise<RawRegion[]> {
  const model = await faceModel();
  if (!model) return [];
  const started = performance.now();
  const faces = await detectFaces(frame.image, model);
  const elapsed = Math.round(performance.now() - started);
  if (faces.length > 0) {
    log(`  ${faces.length} face(s) detected on-device in ${elapsed} ms`, "ok");
  } else {
    log(`  face pass clean in ${elapsed} ms`, "dim");
  }
  const cssFactor = perception.meta.viewport.dpr * frame.scale;
  return faces.map((face, i) => ({
    id: `e${perception.regions.length + i + 1}`,
    role: "image" as const,
    label: null,
    box: [
      face.box[0] / cssFactor,
      face.box[1] / cssFactor,
      face.box[2] / cssFactor,
      face.box[3] / cssFactor,
    ] as RawRegion["box"],
    source: "vision" as const,
    confidence: face.score,
    evidence: ["visual:face-detector"],
    explained: false,
    visualClass: "FACE" as const,
  }));
}

/* The visual pipeline: dirty-tile reuse, compose, self-check. */

let lastTiles: Uint32Array | null = null;
let lastVisual: SanitizedVisual | null = null;

async function buildVisual(
  frame: CaptureFrame,
  perception: PerceiveResponse,
  sanitized: ReturnType<PolicyEngine["sanitize"]>,
): Promise<SanitizedVisual | null> {
  try {
    const tiles = hashTiles(frame.image);
    const diff = diffTiles(lastTiles, tiles);
    lastTiles = tiles;
    if (diff.changedFraction === 0 && lastVisual) {
      log("  frame unchanged; reusing previous sanitized visual", "dim");
      return lastVisual;
    }

    const space: CoordinateSpace = {
      dpr: perception.meta.viewport.dpr,
      scale: frame.scale,
      imageW: frame.image.width,
      imageH: frame.image.height,
    };
    // Every region whose value was withheld gets its pixels destroyed too.
    const redactions: RedactionRect[] = sanitized.elements
      .filter(
        (el) =>
          el.value &&
          (el.value.kind === "placeholder" ||
            el.value.kind === "redacted" ||
            el.value.kind === "unexplained_masked"),
      )
      .map((el) => {
        const token =
          el.value && "token" in el.value && el.value.token ? el.value.token : null;
        const r: RedactionRect = { box: cssToImage(el.box, space) };
        if (token) r.label = token.split("#")[0]!;
        else if (el.value!.kind === "unexplained_masked") r.label = "UNEXPLAINED";
        return r;
      });

    const visual = await buildSanitizedVisual(frame, redactions);
    lastVisual = visual;
    log(
      `  visual: ${redactions.length} region(s) destroyed, ` +
        `self-check ${visual.selfCheck.pixelsChecked.toLocaleString()} px, ` +
        `${visual.bytes.length.toLocaleString()} B webp`,
    );
    return visual;
  } catch (e) {
    lastVisual = null;
    if (e instanceof SelfCheckFailed) {
      // Fail closed: a frame that flunks its own verification never leaves.
      log(`  ${e.message} Sending structure only.`, "err");
      return null;
    }
    log(`  visual pipeline failed (${(e as Error).message}); structure only`, "dim");
    return null;
  }
}

async function resolveStep(step: PlanStep): Promise<ResolvedStep | "cancelled"> {
  const resolved: ResolvedStep = { action: step.action };
  if (step.target_element_id) resolved.targetId = step.target_element_id;
  if (step.scroll) resolved.scroll = step.scroll;
  if (step.wait_ms) resolved.waitMs = step.wait_ms;

  if (step.value) {
    switch (step.value.kind) {
      case "user_prompt": {
        const answer = await ask(step.value.prompt_text);
        if (answer === null) return "cancelled";
        resolved.text = answer;
        break;
      }
      case "placeholder": {
        const token = step.value.token;
        const real = vault.resolve(token);
        if (real === undefined) {
          log(`vault has no value for ${token}; asking user`, "dim");
          const answer = await ask(`The plan needs the value behind ${token}. Provide it:`);
          if (answer === null) return "cancelled";
          resolved.text = answer;
          break;
        }
        const parsed = parseToken(token);
        if (parsed && isInvariantClass(parsed.cls)) {
          const approved = await confirmAction(
            `The plan wants to re-enter your ${parsed.cls} into a field. Allow?`,
          );
          if (!approved) return "cancelled";
        }
        resolved.text = real;
        break;
      }
      case "literal":
        resolved.text = step.value.text;
        break;
      case "option_label":
        resolved.optionLabel = step.value.label;
        break;
    }
  }
  return resolved;
}

async function runTask(): Promise<void> {
  const intent = $<HTMLTextAreaElement>("task").value.trim();
  const mode = $<HTMLSelectElement>("mode").value as PrivacyMode;
  if (!intent) {
    log("type a task first", "err");
    return;
  }

  runBtn.disabled = true;
  stopBtn.disabled = false;
  stopRequested = false;
  const history: TaskHistoryStep[] = [];

  try {
    const tab = await activeTab();
    const hostname = tab.url ? new URL(tab.url).hostname : "";
    if (lastHostname !== null && hostname !== lastHostname) {
      vault.wipe();
      log("origin changed; vault wiped", "dim");
    }
    lastHostname = hostname;

    for (let i = 1; i <= MAX_ITERATIONS && !stopRequested; i++) {
      log(`● iteration ${i}: perceiving…`, "dim");
      const perception = await sendToTab<PerceiveResponse>(tab.id!, { type: "perceive" });
      if (!perception.ok) throw new Error("perception failed");
      log(`  ${perception.regions.length} regions from structure`);

      // Capture before sanitization so the on-device face pass can add
      // regions the DOM knows nothing about; the same frame then feeds
      // the composer, so what was scanned is exactly what is redacted.
      const frame = mode === "wireframe" ? null : await tryCapture();
      const faceRegions = frame ? await detectFaceRegions(frame, perception) : [];

      const sanitized = policy.sanitize(
        [...perception.regions, ...faceRegions],
        mode,
        intent,
      );
      stats.redacted += sanitized.summary.regionsRedacted;
      renderStats();
      log(
        `  sanitized: ${sanitized.summary.regionsRedacted} redactions, ` +
          `${sanitized.summary.unexplainedMasked} unexplained masked`,
      );

      const visual = frame ? await buildVisual(frame, perception, sanitized) : null;
      const packet = buildPacket(perception, sanitized, mode, history, visual);

      const preview = $<HTMLImageElement>("visual-preview");
      if (visual) {
        preview.src = `data:image/webp;base64,${visual.base64}`;
        preview.hidden = false;
      } else {
        preview.hidden = true;
      }
      packetView.textContent = JSON.stringify(
        { ...packet, visual: { ...packet.visual, data_b64: packet.visual.data_b64 ? `<${packet.visual.data_b64.length} base64 chars, shown above>` : undefined } },
        null,
        2,
      );

      log("  sending through the egress gate…", "dim");
      let plan: ActionPlan;
      try {
        plan = await gate.send(packet);
      } catch (e) {
        if (e instanceof EgressBlocked) {
          log(`  BLOCKED by gate: ${e.reasons.join("; ")}`, "err");
          return;
        }
        throw e;
      }
      log(`  plan: ${plan.reasoning_summary}`, "ok");

      let executedSomething = false;
      for (const step of plan.steps) {
        if (stopRequested) break;
        if (step.action === "done") {
          log("✓ task complete", "ok");
          return;
        }
        if (step.action === "abort") {
          log("plan aborted by server", "err");
          return;
        }
        if (step.requires_confirmation) {
          const approved = await confirmAction(
            step.confirmation_reason ??
              `Approve action "${step.action}" on ${step.target_element_id}?`,
          );
          if (!approved) {
            log(`  step ${step.action} rejected by user`, "dim");
            continue;
          }
        }
        const resolved = await resolveStep(step);
        if (resolved === "cancelled") {
          log("  step cancelled by user", "dim");
          continue;
        }
        let grounding: Grounding | undefined;
        const el = packet.elements.find((x) => x.id === step.target_element_id);
        if (el) grounding = { id: el.id, role: el.role, label: el.label, box: el.box };

        const result = await sendToTab<ExecuteResponse>(tab.id!, {
          type: "execute",
          snapshotId: perception.snapshotId,
          step: resolved,
          ...(grounding ? { grounding } : {}),
        });

        history.push({
          step: history.length + 1,
          action: step.action.slice(0, 40),
          element_label: el?.label ?? null,
          result: result.ok ? "ok" : "failed",
        });

        if (result.ok) {
          executedSomething = true;
          log(`  ✓ ${step.action} ${el?.label ?? step.target_element_id ?? ""}`, "ok");
        } else if (result.error === "regrounding_failed" || result.error === "stale_snapshot") {
          log(`  page changed (${result.detail ?? result.error}); re-perceiving`, "dim");
          break; // next iteration re-perceives
        } else {
          log(`  ✗ ${step.action}: ${result.detail ?? result.error}`, "err");
        }
        await new Promise((r) => setTimeout(r, 350));
      }

      if (!executedSomething && !plan.needs_more_context) {
        log("nothing left to execute", "dim");
        return;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    if (stopRequested) log("stopped by user", "dim");
    else log(`iteration cap (${MAX_ITERATIONS}) reached`, "dim");
  } catch (e) {
    log(`error: ${(e as Error).message}`, "err");
  } finally {
    runBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

runBtn.addEventListener("click", () => void runTask());
$<HTMLButtonElement>("export-receipts").addEventListener("click", exportReceipts);
stopBtn.addEventListener("click", () => {
  stopRequested = true;
});
renderStats();
log("ready. open a page, describe a task, press Run.", "dim");
