import { defaultRegistry } from "@kavach/core/detectors";
import {
  EgressBlocked,
  EgressGate,
  type EgressAuditEvent,
  type PrivacyReceipt,
} from "@kavach/core/gate";
import { extractPromptAnswers, type PromptAnswer, type PromptField } from "@kavach/core/prompt";
import { PolicyEngine, type RawRegion } from "@kavach/core/policy";
import {
  SCP_SCHEMA_ID,
  PLAN_SCHEMA_ID,
  isInvariantClass,
  parseToken,
  type ActionPlan,
  type PlanStep,
  type PrivacyMode,
  type SanitizedContextPacket,
  type TaskHistoryStep,
} from "@kavach/core/schema";
import { Vault } from "@kavach/core/vault";
import { cssToImage, type CoordinateSpace } from "@kavach/core/fusion";
import {
  SelfCheckFailed,
  buildSanitizedVisual,
  captureVisibleTab,
  type CaptureFrame,
  type SanitizedVisual,
} from "@kavach/perception/browser";
import { type RedactionRect } from "@kavach/perception";
import { detectFaces, type FaceModel } from "@kavach/perception/vision";
import { createOrtFaceModel, type OrtNamespace } from "@kavach/perception/vision/ort";
import { defaultModelHost, ULTRAFACE_MANIFEST } from "@kavach/perception/models";
import {
  sendToTab,
  type ExecuteResponse,
  type Grounding,
  type PerceiveResponse,
  type ResolvedStep,
} from "../shared/messages.js";
import { promptAnswerForField, promptMemoryKeys, rememberPromptAnswers } from "./prompt-memory.js";
import { buildLocalRedactionAudit } from "./redaction-audit.js";
import { createVisualPreview } from "./visual-preview.js";
import { DEFAULT_SERVER_URL, makeTransport } from "../transport.js";

/**
 * The orchestrator. It lives in the side panel (a real, long-lived page)
 * so the in-memory vault survives; MV3 service workers do not. The loop:
 * perceive, sanitize, gate, plan, resolve, re-ground, execute, repeat.
 */

const POLICY_VERSION = "2026.09.1";
const MAX_ITERATIONS = 30;

/* UI plumbing */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const logEl = $("log");
const packetView = $("packet-view");
const receiptsEl = $("receipts");
const runBtn = $<HTMLButtonElement>("run");
const stopBtn = $<HTMLButtonElement>("stop");
const visualPreview = createVisualPreview({
  frame: $("visual-preview-state"),
  image: $<HTMLImageElement>("visual-preview"),
  empty: $("visual-preview-empty"),
  error: $("visual-preview-error"),
});
let packetPreview: Record<string, unknown> | null = null;
let previewPacketId: string | null = null;

function log(text: string, kind: "ok" | "err" | "dim" | "" = ""): void {
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = text;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderAuditEvent(event: EgressAuditEvent): void {
  const check = document.getElementById(`check-${event.stage}`);
  if (check) {
    check.className = `check ${event.outcome === "blocked" || event.outcome === "error" ? "bad" : "ok"}`;
    check.textContent = `${event.stage.toUpperCase()}: ${event.outcome.toUpperCase()}`;
  }
  const metrics = event.metrics
    ? ` (${Object.entries(event.metrics)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ")})`
    : "";
  const kind = event.outcome === "blocked" || event.outcome === "error" ? "err" : "dim";
  log(`  gate.${event.stage}: ${event.outcome} - ${event.detail ?? "check complete"}${metrics}`, kind);
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
  a.download = `dravika-receipts-${Date.now()}.json`;
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

function ask(promptText: string, inputType = "text"): Promise<string | null> {
  const dialog = $<HTMLDialogElement>("ask");
  $("ask-text").textContent = promptText;
  const input = $<HTMLInputElement>("ask-input");
  input.type = ["date", "time", "month", "number", "email", "tel", "password"].includes(inputType) ? inputType : "text";
  dialog.returnValue = "cancel";
  input.value = "";
  dialog.showModal();
  input.focus();
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
  dialog.returnValue = "cancel";
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
let lastTabId: number | null = null;
let stopRequested = false;
let activeTaskIntent: string | null = null;
let resumeAfterSameOriginNavigation = false;

const gate = new EgressGate({
  transport: makeTransport(DEFAULT_SERVER_URL),
  registry,
  vault,
  audit: { append: renderAuditEvent },
  receipts: {
    append: (r) => {
      if (packetPreview && previewPacketId === r.packet_id) {
        packetPreview.transmission = r.outcome;
        packetView.textContent = JSON.stringify(packetPreview, null, 2);
      }
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

async function verifyFormState(tabId: number): Promise<void> {
  try {
    const perception = await sendToTab<PerceiveResponse>(tabId, { type: "perceive" });
    if (!perception.ok) {
      log("local verification unavailable", "err");
      return;
    }
    const fillable = new Set(["textbox", "password", "combobox"]);
    const fields = perception.regions.filter((region) => fillable.has(region.role));
    const filled = fields.filter((field) => field.state?.filled === true).length;
    const requiredEmpty = fields.filter((field) => {
      return field.state?.required === true && field.state?.filled !== true && field.state?.disabled !== true;
    }).length;
    const invalid = fields.filter((field) => field.state?.invalid === true).length;
    const optionalEmpty = fields.filter((field) => {
      return field.state?.required !== true && field.state?.filled !== true && field.state?.disabled !== true;
    }).length;
    log(
      `✓ local verification: ${filled}/${fields.length} fillable fields filled; ` +
        `${requiredEmpty} required empty; ${invalid} invalid; ${optionalEmpty} optional empty`,
      requiredEmpty === 0 && invalid === 0 ? "ok" : "err",
    );
  } catch {
    log("local verification unavailable", "err");
  }
}

type PacketElement = SanitizedContextPacket["elements"][number];

function filledElementCount(elements: PacketElement[]): number {
  return elements.filter((element) => {
    return (
      element.state?.filled === true ||
      element.value?.kind === "placeholder" ||
      element.value?.kind === "filled"
    );
  }).length;
}

const PROMPT_FIELD_ROLES = new Set(["textbox", "password", "combobox", "listbox"]);

function promptFields(regions: RawRegion[]): PromptField[] {
  return regions
    .filter((region) => PROMPT_FIELD_ROLES.has(region.role))
    .map((region) => ({
      id: region.id,
      label: region.label,
      ...(region.structuralClass ? { structuralClass: region.structuralClass } : {}),
    }));
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
      backend: visual ? visionBackend : "none",
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
let visionBackend: "none" | "webgpu" | "wasm" = "none";

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
        const bytes = await defaultModelHost().load({ ...ULTRAFACE_MANIFEST, url: chrome.runtime.getURL("models/ultraface-rfb-320.onnx") });
        const model = await createOrtFaceModel(ortNs, bytes, {
          wasmPaths: "ort/",
          executionProviders: ["webgpu", "wasm"],
        });
        visionBackend = model.backend ?? "none";
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
  visionBackend = model.backend ?? "none";
  const elapsed = Math.round(performance.now() - started);
  if (faces.length > 0) {
    log(`  ${faces.length} face(s) detected on-device in ${elapsed} ms`, "ok");
  } else {
    log(`  face pass clean in ${elapsed} ms`, "dim");
  }
  const cssFactor = perception.meta.viewport.dpr * frame.scale;
  return faces.map((face, i) => ({
    id: `e${Math.max(0, ...perception.regions.map((r) => Number(r.id.slice(1)))) + i + 1}`,
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

async function buildVisual(
  frame: CaptureFrame,
  perception: PerceiveResponse,
  sanitized: ReturnType<PolicyEngine["sanitize"]>,
): Promise<SanitizedVisual | null> {
  try {
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
    log(
      `  visual: ${redactions.length} region(s) destroyed, ` +
        `self-check ${visual.selfCheck.pixelsChecked.toLocaleString()} px, ` +
        `${visual.bytes.length.toLocaleString()} B webp`,
    );
    return visual;
  } catch (e) {
    if (e instanceof SelfCheckFailed) {
      // Fail closed: a frame that flunks its own verification never leaves.
      log(`  ${e.message} Sending structure only.`, "err");
      return null;
    }
    log(`  visual pipeline failed (${(e as Error).message}); structure only`, "dim");
    return null;
  }
}

async function resolveStep(
  step: PlanStep,
  packet: SanitizedContextPacket,
  element: PacketElement | undefined,
  rawElement: RawRegion | undefined,
  promptAnswers: PromptAnswer[],
  correction?: string,
): Promise<ResolvedStep | "cancelled"> {
  if (rawElement?.control?.inputType === "file") {
    log("This question requires a file upload. Choose the file on the page, then run Dravika again.", "err");
    return "cancelled";
  }
  const resolved: ResolvedStep = { action: step.action };
  if (step.target_element_id) resolved.targetId = step.target_element_id;
  if (step.scroll) resolved.scroll = step.scroll;
  if (step.wait_ms) resolved.waitMs = step.wait_ms;

  if (step.value) {
    switch (step.value.kind) {
      case "user_prompt": {
        const memoryKeys = element ? promptMemoryKeys(packet, element, step.value.prompt_text) : [];
        const supplied = !correction && element
          ? promptAnswerForField(promptAnswers, element.id, element.state)
          : undefined;
        if (supplied !== undefined) {
          log("  using the locally supplied task value for this field", "dim");
          if (step.action === "select") resolved.optionLabel = supplied;
          else resolved.text = supplied;
          break;
        }
        const rejectedFilledValue = Boolean(correction) || element?.state?.invalid === true;
        const remembered = rejectedFilledValue
          ? undefined
          : memoryKeys.map((key) => vault.recall(key)).find((value) => value !== undefined);
        if (remembered !== undefined) {
          log("  reusing the remembered answer for this form field", "dim");
          if (step.action === "select") resolved.optionLabel = remembered;
          else resolved.text = remembered;
          break;
        }
        const label = element?.label?.trim() || `the ${element?.role ?? "form"} field`;
        const validation = correction || (rawElement?.state?.invalid ? rawElement.validationMessage?.trim() : "");
        const promptText = validation
          ? `${validation} Please enter a valid value for ${label}.`
          : element?.state?.invalid
            ? `The form rejected the previous value. Please enter a valid value for ${label}.`
            : element
              ? `Please provide a value for ${label}.`
              : step.value.prompt_text;
        const help = rawElement?.control?.help;
        const options = rawElement?.control?.options ?? [];
        const answer = await ask(
          [promptText, help, options.length ? `Options: ${options.join(", ")}` : ""].filter(Boolean).join("\n\n"),
          step.action === "select" ? "text" : rawElement?.control?.inputType,
        );
        if (answer === null) return "cancelled";
        if (stopRequested) return "cancelled";
        if (step.action !== "select") for (const key of memoryKeys) vault.remember(key, answer);
        if (step.action === "select") resolved.optionLabel = answer;
        else resolved.text = answer;
        break;
      }
      case "placeholder": {
        const token = step.value.token;
        const real = vault.resolve(token);
        if (real === undefined) {
          log(`vault has no value for ${token}; asking user`, "dim");
          const answer = await ask(`The plan needs the value behind ${token}. Provide it:`);
          if (answer === null) return "cancelled";
          if (element) {
            for (const key of promptMemoryKeys(packet, element)) vault.remember(key, answer);
          }
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
  if (runBtn.disabled) return;
  const intent = $<HTMLTextAreaElement>("task").value.trim();
  const mode = $<HTMLSelectElement>("mode").value as PrivacyMode;
  if (!intent) {
    log("type a task first", "err");
    return;
  }

  if (activeTaskIntent !== intent || !resumeAfterSameOriginNavigation) {
    vault.wipe();
  }
  activeTaskIntent = intent;
  resumeAfterSameOriginNavigation = false;

  runBtn.disabled = true;
  stopBtn.disabled = false;
  stopRequested = false;
  const history: TaskHistoryStep[] = [];
  let taskTabId: number | null = null;
  let correction: { id: string; label: string | null; role: string; message: string; attempts: number } | null = null;
  let stalled = 0;
  const clicked = new Set<string>();
  const correctionAttempts = new Map<string, number>();

  try {
    const tab = await activeTab();
    taskTabId = tab.id!;
    const hostname = tab.url ? new URL(tab.url).origin : "";
    if (lastTabId !== null && tab.id !== lastTabId) {
      vault.wipe();
      lastHostname = null;
      log("active tab changed; vault wiped", "dim");
    }
    if (lastHostname !== null && hostname !== lastHostname) {
      vault.wipe();
      log("origin changed; vault wiped", "dim");
    }
    lastTabId = tab.id!;
    lastHostname = hostname;

    for (let i = 1; i <= MAX_ITERATIONS && !stopRequested; i++) {
      log(`● iteration ${i}: perceiving…`, "dim");
      const perception = await sendToTab<PerceiveResponse>(tab.id!, { type: "perceive" });
      if (!perception.ok) throw new Error("perception failed");
      if (perception.meta.truncated) throw new Error("This page exceeds the 300-element capture limit. Open a smaller form section before continuing.");
      log(`  ${perception.regions.length} regions from structure`);

      const promptExtraction = extractPromptAnswers(intent, promptFields(perception.regions), registry);
      if (stopRequested) return;

      // Capture before sanitization so the on-device face pass can add
      // regions the DOM knows nothing about; the same frame then feeds
      // the composer, so what was scanned is exactly what is redacted.
      const frame = mode === "wireframe" ? null : await tryCapture();
      const faceRegions = frame ? await detectFaceRegions(frame, perception) : [];

      const sanitized = policy.sanitize(
        [...perception.regions, ...faceRegions],
        mode,
        perception.meta.pageKind.startsWith("form")
          ? "Help complete the form sequentially. Values and corrections are supplied locally."
          : promptExtraction.sanitizedIntent,
      );
      stats.redacted += sanitized.summary.regionsRedacted;
      renderStats();
      const filledCount = filledElementCount(sanitized.elements);
      if (filledCount > 0) {
        log(`  resume: ${filledCount} existing field(s) will be left unchanged`, "dim");
      }
      log(
        `  sanitized: ${sanitized.summary.regionsRedacted} redactions, ` +
          `${sanitized.summary.unexplainedMasked} unexplained masked`,
      );

      const visual = frame ? await buildVisual(frame, perception, sanitized) : null;
      const packet = buildPacket(perception, sanitized, mode, history, visual);
      rememberPromptAnswers(packet, promptExtraction.answers, vault);
      for (const element of packet.elements) {
        if (promptExtraction.answers.some((answer) => answer.fieldId === element.id)) element.evidence.push("structural:provided-locally");
      }
      if (promptExtraction.answers.length > 0) {
        log(`  local prompt values available for ${promptExtraction.answers.length} field(s)`, "dim");
      }

      if (visual) {
        visualPreview.show(visual.bytes);
      } else {
        visualPreview.clear("No redacted frame was included. This packet contains structure only.");
      }
      previewPacketId = packet.packet_id;
      for (const node of document.querySelectorAll<HTMLElement>(".checks [id^=check-]")) {
        node.className = "check waiting";
        node.textContent = `${node.id.slice(6).toUpperCase()}: WAITING`;
      }
      packetPreview = {
          transmission: correction ? "local_correction_not_sent" : "prepared_not_sent",
          server_packet: {
            ...packet,
            visual: {
              ...packet.visual,
              data_b64: packet.visual.data_b64
                ? `<${packet.visual.data_b64.length} base64 chars, shown above>`
                : undefined,
            },
          },
          local_redaction_audit: buildLocalRedactionAudit(
            packet,
            promptExtraction.answers.map((answer) => answer.fieldId),
          ),
        };
      packetView.textContent = JSON.stringify(packetPreview, null, 2);

      log(correction ? "  correcting locally…" : "  sending through the egress gate…", "dim");
      let plan: ActionPlan;
      try {
        if (correction) {
          const candidates = perception.regions.filter((r) => r.role === correction!.role && r.label === correction!.label);
          const target = perception.regions.find((r) => r.id === correction!.id) ?? (candidates.length === 1 ? candidates[0] : undefined);
          if (!target) { log("The rejected field changed or disappeared. Stopping for review.", "err"); return; }
          correction.id = target.id;
          plan = {
            schema: PLAN_SCHEMA_ID, packet_id: packet.packet_id, reasoning_summary: "Correcting the rejected field locally before continuing.",
            steps: [{ action: target.role === "combobox" || target.role === "listbox" ? "select" : "type", target_element_id: target.id,
              value: { kind: "user_prompt", prompt_text: "Correct this field" }, requires_confirmation: false }],
            needs_more_context: true, confidence: 1,
          };
        } else plan = await gate.send(packet);
        if (stopRequested) return;
      } catch (e) {
        if (e instanceof EgressBlocked) {
          log(`  BLOCKED by gate: ${e.reasons.join("; ")}`, "err");
          return;
        }
        throw e;
      }
      log(`  plan: ${plan.reasoning_summary}`, "ok");

      let executedSomething = false;
      let pageChanged = false;
      let rePerceiveAfterAnswer = false;
      let stateChangingActionExecuted = false;
      for (const step of plan.steps) {
        if (stopRequested) break;
        if (step.action === "done") {
          const pending = perception.regions.some((r) => PROMPT_FIELD_ROLES.has(r.role) && !r.state?.disabled && !r.state?.readonly &&
            (r.state?.invalid || (r.state?.required && !r.state?.filled)));
          log(pending ? "Required or invalid fields remain; stopping for review." : "No further planned action. Check the form's confirmation before treating it as submitted.", pending ? "err" : "dim");
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
            return;
          }
          if (stopRequested) return;
        }
        const el = packet.elements.find((x) => x.id === step.target_element_id);
        const rawEl = perception.regions.find((x) => x.id === step.target_element_id);
        const answerStep =
          step.action === "type" ||
          step.action === "select" ||
          (step.action === "click" &&
            Boolean(el && ["checkbox", "radio", "switch", "option"].includes(el.role)));
        const resolved = await resolveStep(step, packet, el, rawEl, promptExtraction.answers, correction?.message);
        if (resolved === "cancelled") {
          log("  step cancelled by user", "dim");
          return;
        }
        if (stopRequested) return;
        const clickKey = `${el?.id}|${el?.label}|${perception.regions.filter((r) => r.control).map((r) => r.id).join(",")}`;
        if (step.action === "click" && clicked.has(clickKey)) { log("The same button was requested again without a page transition. Stopping for review.", "err"); return; }
        let grounding: Grounding | undefined;
        if (el) {
          grounding = {
            id: el.id,
            role: el.role,
            label: rawEl?.label ?? el.label,
            box: el.box,
            ...(el.state?.disabled !== undefined ? { disabled: el.state.disabled } : {}),
            ...(el.state?.readonly !== undefined ? { readonly: el.state.readonly } : {}),
          };
        }

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
          stalled = 0;
          correction = null;
          if (step.action === "click") clicked.add(clickKey);
          if (answerStep) rePerceiveAfterAnswer = true;
          if (step.action === "click" && step.requires_confirmation && !/^(next|continue|back|previous)\b/i.test(el?.label ?? "")) {
            stateChangingActionExecuted = true;
          }
          log(`  ✓ ${step.action} ${el?.label ?? step.target_element_id ?? ""}`, "ok");
          if (answerStep) break;
          if (step.action === "click") { rePerceiveAfterAnswer = !stateChangingActionExecuted; break; }
        } else if (result.error === "validation_failed" && rawEl) {
          const attempts = (correctionAttempts.get(rawEl.id) ?? 0) + 1;
          correctionAttempts.set(rawEl.id, attempts);
          if (attempts > 3) { log("Three corrections were rejected. Stopping so you can review this field on the page.", "err"); return; }
          correction = { id: rawEl.id, label: rawEl.label, role: rawEl.role, message: result.detail || "The form rejected this value.", attempts };
          log(`Form validation — ${el?.label ?? rawEl.id}: ${correction.message}`, "err");
          rePerceiveAfterAnswer = true;
          break;
        } else if (result.error === "regrounding_failed" || result.error === "stale_snapshot") {
          if (++stalled > 3) { log("The page kept changing; stopped after three retries.", "err"); return; }
          log(`  page changed (${result.detail ?? result.error}); re-perceiving`, "dim");
          pageChanged = true;
          break; // next iteration re-perceives
        } else {
          log(`  ✗ ${step.action}: ${result.detail ?? result.error}`, "err");
          return;
        }
        await new Promise((r) => setTimeout(r, 350));
      }

      if (pageChanged) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      if (rePerceiveAfterAnswer) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      if (!plan.needs_more_context) {
        if (!executedSomething) {
          log("nothing left to execute", "dim");
          return;
        }
        if (stateChangingActionExecuted) {
          log("Submission action executed. Review the page's confirmation.", "dim");
          return;
        }
      }
      if (!executedSomething) {
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
    if (taskTabId !== null && !stopRequested) await verifyFormState(taskTabId);
    runBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

runBtn.addEventListener("click", () => void runTask());
$<HTMLButtonElement>("export-receipts").addEventListener("click", exportReceipts);
function cancelDialogs(): void {
  for (const id of ["ask", "confirm"]) {
    const dialog = $<HTMLDialogElement>(id);
    if (dialog.open) dialog.close("cancel");
  }
}
stopBtn.addEventListener("click", () => {
  stopRequested = true;
  cancelDialogs();
  vault.wipe();
  activeTaskIntent = null;
  resumeAfterSameOriginNavigation = false;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== lastTabId) return;
  vault.wipe();
  stopRequested = true;
  cancelDialogs();
  lastTabId = null;
  lastHostname = null;
  activeTaskIntent = null;
  resumeAfterSameOriginNavigation = false;
  log("active tab closed; vault wiped", "dim");
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (lastTabId === null || tabId === lastTabId) return;
  vault.wipe();
  stopRequested = true;
  cancelDialogs();
  lastTabId = tabId;
  lastHostname = null;
  activeTaskIntent = null;
  resumeAfterSameOriginNavigation = false;
  log("active tab changed; task stopped and vault wiped", "dim");
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== lastTabId || !changeInfo.url) return;
  let nextHostname: string | null = null;
  try {
    nextHostname = new URL(changeInfo.url).origin;
  } catch {
    // Invalid or browser-internal URLs are a security boundary.
  }
  if (!nextHostname || !lastHostname || nextHostname !== lastHostname) {
    vault.wipe();
    activeTaskIntent = null;
    resumeAfterSameOriginNavigation = false;
    lastHostname = null;
    log("origin changed; process memory wiped", "dim");
  } else {
    resumeAfterSameOriginNavigation = true;
    log("same-origin navigation; preserving process memory", "dim");
  }
  stopRequested = true;
  cancelDialogs();
});
renderStats();
log("Dravika v0.2 ready. Open a page, describe a task, press Run.", "dim");
