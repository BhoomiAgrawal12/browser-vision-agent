import { defaultRegistry } from "@kavach/core/detectors";
import {
  EgressBlocked,
  EgressGate,
  type EgressAuditEvent,
  type PrivacyReceipt,
} from "@kavach/core/gate";
import { PolicyEngine, type RawRegion } from "@kavach/core/policy";
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
import { cssToImage, type CoordinateSpace } from "@kavach/core/fusion";
import {
  SelfCheckFailed,
  buildSanitizedVisual,
  captureVisibleTab,
  type SanitizedVisual,
} from "@kavach/perception/browser";
import { diffTiles, hashTiles, type RedactionRect } from "@kavach/perception";
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

function renderAuditEvent(event: EgressAuditEvent): void {
  const metrics = event.metrics
    ? ` (${Object.entries(event.metrics)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ")})`
    : "";
  const kind = event.outcome === "blocked" || event.outcome === "error" ? "err" : "dim";
  log(`  gate.${event.stage}: ${event.outcome} - ${event.detail ?? "check complete"}${metrics}`, kind);
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

function promptMemoryKeys(
  packet: SanitizedContextPacket,
  element: PacketElement,
  promptText?: string,
): string[] {
  const label = (element.label ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  const hint = element.evidence.find((item) => item.startsWith("structural:hint=")) ?? "";
  const peers = packet.elements.filter((candidate) => {
    return candidate.role === element.role && candidate.label === element.label;
  });
  const ordinal = Math.max(0, peers.findIndex((candidate) => candidate.id === element.id));
  const keys = [`field|${element.role}|${hint}|${label}|${ordinal}`];
  if (promptText?.trim()) {
    const prompt = promptText.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
    keys.push(`prompt|${element.role}|${prompt}`);
  }
  return keys;
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

/* The visual pipeline: capture, dirty-tile reuse, compose, self-check. */

let lastTiles: Uint32Array | null = null;
let lastVisual: SanitizedVisual | null = null;

async function buildVisual(
  perception: PerceiveResponse,
  sanitized: ReturnType<PolicyEngine["sanitize"]>,
): Promise<SanitizedVisual | null> {
  try {
    const frame = await captureVisibleTab();
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
    log(`  capture unavailable (${(e as Error).message}); structure only`, "dim");
    return null;
  }
}

async function resolveStep(
  step: PlanStep,
  packet: SanitizedContextPacket,
  element: PacketElement | undefined,
  rawElement: RawRegion | undefined,
): Promise<ResolvedStep | "cancelled"> {
  const resolved: ResolvedStep = { action: step.action };
  if (step.target_element_id) resolved.targetId = step.target_element_id;
  if (step.scroll) resolved.scroll = step.scroll;
  if (step.wait_ms) resolved.waitMs = step.wait_ms;

  if (step.value) {
    switch (step.value.kind) {
      case "user_prompt": {
        const memoryKeys = element ? promptMemoryKeys(packet, element, step.value.prompt_text) : [];
        const remembered = element?.state?.invalid
          ? undefined
          : memoryKeys.map((key) => vault.recall(key)).find((value) => value !== undefined);
        if (remembered !== undefined) {
          log("  reusing the remembered answer for this form field", "dim");
          resolved.text = remembered;
          break;
        }
        const label = element?.label?.trim() || `the ${element?.role ?? "form"} field`;
        const validation = rawElement?.validationMessage?.trim();
        const promptText = validation
          ? `${validation} Please enter a valid value for ${label}.`
          : element?.state?.invalid
            ? `The form rejected the previous value. Please enter a valid value for ${label}.`
            : element
              ? `Please provide a value for ${label}.`
              : step.value.prompt_text;
        const answer = await ask(promptText);
        if (answer === null) return "cancelled";
        for (const key of memoryKeys) vault.remember(key, answer);
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
  let awaitingFieldProgress = false;
  let filledBeforeLastPlan = 0;

  try {
    const tab = await activeTab();
    taskTabId = tab.id!;
    const hostname = tab.url ? new URL(tab.url).hostname : "";
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
      log(`  ${perception.regions.length} regions from structure`);

      const sanitized = policy.sanitize(perception.regions, mode, intent);
      stats.redacted += sanitized.summary.regionsRedacted;
      renderStats();
      const filledCount = sanitized.elements.filter((element) => {
        return (
          element.state?.filled === true ||
          element.value?.kind === "placeholder" ||
          element.value?.kind === "filled"
        );
      }).length;
      if (awaitingFieldProgress) {
        if (filledCount <= filledBeforeLastPlan) {
          log("form input did not persist; stopping before repeating the prompt", "err");
          return;
        }
        awaitingFieldProgress = false;
      }
      filledBeforeLastPlan = filledCount;
      if (filledCount > 0) {
        log(`  resume: ${filledCount} existing field(s) will be left unchanged`, "dim");
      }
      log(
        `  sanitized: ${sanitized.summary.regionsRedacted} redactions, ` +
          `${sanitized.summary.unexplainedMasked} unexplained masked`,
      );

      const visual = mode === "wireframe" ? null : await buildVisual(perception, sanitized);
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
      let pageChanged = false;
      let stateChangingActionExecuted = false;
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
        const el = packet.elements.find((x) => x.id === step.target_element_id);
        const rawEl = perception.regions.find((x) => x.id === step.target_element_id);
        const resolved = await resolveStep(step, packet, el, rawEl);
        if (resolved === "cancelled") {
          log("  step cancelled by user", "dim");
          continue;
        }
        let grounding: Grounding | undefined;
        if (el) {
          grounding = {
            id: el.id,
            role: el.role,
            label: el.label,
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
          if (step.action === "type") awaitingFieldProgress = true;
          if (step.action === "click" && step.requires_confirmation) {
            stateChangingActionExecuted = true;
          }
          log(`  ✓ ${step.action} ${el?.label ?? step.target_element_id ?? ""}`, "ok");
        } else if (result.error === "regrounding_failed" || result.error === "stale_snapshot") {
          log(`  page changed (${result.detail ?? result.error}); re-perceiving`, "dim");
          pageChanged = true;
          break; // next iteration re-perceives
        } else {
          log(`  ✗ ${step.action}: ${result.detail ?? result.error}`, "err");
        }
        await new Promise((r) => setTimeout(r, 350));
      }

      if (pageChanged) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      if (!plan.needs_more_context) {
        if (!executedSomething) {
          log("nothing left to execute", "dim");
          return;
        }
        if (stateChangingActionExecuted) {
          log("✓ plan complete", "ok");
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
stopBtn.addEventListener("click", () => {
  stopRequested = true;
  vault.wipe();
  activeTaskIntent = null;
  resumeAfterSameOriginNavigation = false;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== lastTabId) return;
  vault.wipe();
  stopRequested = true;
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
    nextHostname = new URL(changeInfo.url).hostname;
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
});
renderStats();
log("ready. open a page, describe a task, press Run.", "dim");
