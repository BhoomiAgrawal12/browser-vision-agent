import type { ExecuteResponse, Grounding, ResolvedStep } from "../shared/messages.js";
import { labelOf, roleOf } from "./perceive.js";
import { choiceLabel, choiceNodes, controlValue, editableTarget, formFeedback, isDisplayed, isFilePickerVisible, openFilePickerInput, selected } from "./form-controls.js";

/**
 * The hands, with the re-grounding check in front of them. Between capture
 * and plan, roughly a second passes; modals open, layouts reflow, buttons
 * disable. Before touching an element we verify it is still the element
 * we described. If not, abort and let the panel re-perceive. Never guess.
 */

const GEOMETRY_TOLERANCE_PX = 48;

export function reground(el: Element | undefined, grounding: Grounding): string | null {
  if (!el || !el.isConnected) return "element no longer in the document";
  if (roleOf(el) !== grounding.role) return "element role changed since capture";
  const rect = el.getBoundingClientRect();
  const [gx, gy] = [grounding.box[0], grounding.box[1]];
  const moved = Math.hypot(rect.x - gx, rect.y - gy);
  if (moved > GEOMETRY_TOLERANCE_PX) {
    return `element moved ${Math.round(moved)}px since capture`;
  }
  if (
    Math.abs(rect.width - grounding.box[2]) > GEOMETRY_TOLERANCE_PX ||
    Math.abs(rect.height - grounding.box[3]) > GEOMETRY_TOLERANCE_PX
  ) {
    return "element size changed since capture";
  }
  if (grounding.label) {
    const current = labelOf(el);
    // Labels are compared loosely: dynamic counters ("Inbox (3)") shift.
    if (!current || (!current.includes(grounding.label.slice(0, 40)) && !grounding.label.includes(current.slice(0, 40)))) {
      return "element label changed since capture";
    }
  }
  if (!isDisplayed(el)) {
    return "element is no longer visible";
  }
  const disabled = isDisabled(el);
  if (grounding.disabled !== undefined && disabled !== grounding.disabled) {
    return "element disabled state changed since capture";
  }
  const readonly = isReadonly(el);
  if (grounding.readonly !== undefined && readonly !== grounding.readonly) {
    return "element readonly state changed since capture";
  }
  return null;
}

function isDisabled(el: Element): boolean {
  const nested = el.querySelector('input:not([type="hidden"]), textarea, select');
  return (
    el.getAttribute("aria-disabled") === "true" ||
    (el instanceof HTMLButtonElement && el.disabled) ||
    (el instanceof HTMLInputElement && el.disabled) ||
    (el instanceof HTMLTextAreaElement && el.disabled) ||
    (el instanceof HTMLSelectElement && el.disabled) ||
    (nested instanceof HTMLInputElement && nested.disabled) ||
    (nested instanceof HTMLTextAreaElement && nested.disabled) ||
    (nested instanceof HTMLSelectElement && nested.disabled)
  );
}

function isReadonly(el: Element): boolean {
  const nested = el.querySelector('input:not([type="hidden"]), textarea');
  return (
    (el instanceof HTMLInputElement && el.readOnly) ||
    (el instanceof HTMLTextAreaElement && el.readOnly) ||
    (nested instanceof HTMLInputElement && nested.readOnly) ||
    (nested instanceof HTMLTextAreaElement && nested.readOnly) ||
    el.getAttribute("aria-readonly") === "true"
  );
}

async function selectAriaOption(el: Element, optionLabel: string): Promise<ExecuteResponse> {
  if (el.getAttribute("aria-expanded") === "false" && el instanceof HTMLElement) {
    el.click();
    await new Promise((r) => setTimeout(r, 250));
  }
  const candidates = choiceNodes(el);
  const multiple = roleOf(el) === "listbox" && candidates.some((node) => node.getAttribute("role") === "checkbox" || (node instanceof HTMLInputElement && node.type === "checkbox"));
  const wanted = (multiple ? optionLabel.split(/[,;\n]/) : [optionLabel]).map((s) => s.trim().toLocaleLowerCase()).filter(Boolean);
  const matches = wanted.map((value) => candidates.filter((node) => choiceLabel(node).toLocaleLowerCase() === value));
  if (!wanted.length || matches.some((group) => group.length !== 1)) {
    return { ok: false, error: "validation_failed", detail: "Choose an exact option shown in this question. Multiple selections can be separated by commas." };
  }
  if (matches.some((group) => isDisabled(group[0]!))) return { ok: false, error: "failed", detail: "option is disabled" };
  for (const node of candidates) {
    const wantedNode = matches.some((group) => group[0] === node);
    if ((wantedNode && !selected(node)) || (multiple && !wantedNode && selected(node))) node.click();
  }
  await new Promise((r) => setTimeout(r, 650));
  const feedback = formFeedback(el);
  if (feedback.invalid) return { ok: false, error: "validation_failed", detail: feedback.message };
  if (!matches.every((group) => selected(group[0]!) || controlValue(el).trim().toLocaleLowerCase() === optionLabel.trim().toLocaleLowerCase())) {
    return { ok: false, error: "validation_failed", detail: "The form did not retain the selected option. Please select it on the page." };
  }
  return { ok: true };
}

async function verifyText(el: Element, expected: string): Promise<ExecuteResponse> {
  // React/Forms commonly validate on blur and render the error asynchronously.
  (editableTarget(el) as HTMLElement | null)?.blur();
  await new Promise((r) => setTimeout(r, 650));
  if (!el.isConnected) return { ok: false, error: "stale_snapshot", detail: "field re-rendered; checking the new page" };
  const feedback = formFeedback(el);
  if (feedback.invalid) return { ok: false, error: "validation_failed", detail: [feedback.message, feedback.help].filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).join("\n") };
  if (controlValue(el) !== expected) {
    const target = editableTarget(el);
    const dateHint = target instanceof HTMLInputElement && target.type === "date" ? " Use the date picker or YYYY-MM-DD." : "";
    return { ok: false, error: "validation_failed", detail: `The form did not accept this value.${dateHint} ${feedback.message}`.trim() };
  }
  return { ok: true };
}

/** Set a value the way a user would, so framework listeners fire. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function executeStep(
  el: Element | undefined,
  step: ResolvedStep,
): Promise<ExecuteResponse> {
  switch (step.action) {
    case "done":
    case "abort":
      return { ok: true };

    case "wait":
      await new Promise((r) => setTimeout(r, Math.min(step.waitMs ?? 500, 10_000)));
      return { ok: true };

    case "scroll": {
      if (step.scroll?.amount === "to_element" && el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        const page = window.innerHeight;
        const amount = step.scroll?.amount === "half" ? page / 2 : page;
        window.scrollBy({
          top: step.scroll?.direction === "up" ? -amount : amount,
          behavior: "smooth",
        });
      }
      return { ok: true };
    }

    case "click": {
      if (!el) return { ok: false, error: "not_found" };
      if (isDisabled(el)) return { ok: false, error: "failed", detail: "target is disabled" };
      (el as HTMLElement).scrollIntoView({ block: "center" });
      (el as HTMLElement).click();
      return { ok: true };
    }

    case "focus": {
      if (!el) return { ok: false, error: "not_found" };
      if (isDisabled(el)) return { ok: false, error: "failed", detail: "target is disabled" };
      (el as HTMLElement).focus();
      return { ok: true };
    }

    case "type": {
      if (!el) return { ok: false, error: "not_found" };
      if (isDisabled(el) || isReadonly(el)) {
        return { ok: false, error: "failed", detail: "target cannot accept text" };
      }
      const target = editableTarget(el);
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (target instanceof HTMLInputElement && ["file", "hidden", "checkbox", "radio", "submit", "button"].includes(target.type)) return { ok: false, error: "unsupported", detail: "not a text input" };
        target.scrollIntoView({ block: "center" });
        target.focus();
        setNativeValue(target, step.text ?? "");
        return verifyText(el, step.text ?? "");
      }
      if (target instanceof HTMLElement && target.isContentEditable) {
        target.focus();
        target.textContent = step.text ?? "";
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return verifyText(el, step.text ?? "");
      }
      return { ok: false, error: "unsupported", detail: "target is not a text field" };
    }

    case "clear": {
      if (!el) return { ok: false, error: "not_found" };
      if (isDisabled(el) || isReadonly(el)) {
        return { ok: false, error: "failed", detail: "target cannot be cleared" };
      }
      const target = editableTarget(el);
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.focus();
        setNativeValue(target, "");
        return { ok: true };
      }
      if (target instanceof HTMLElement && target.isContentEditable) {
        target.focus();
        target.textContent = "";
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      return { ok: false, error: "unsupported" };
    }

    case "select": {
      if (!el) return { ok: false, error: "not_found" };
      if (isDisabled(el)) return { ok: false, error: "failed", detail: "target is disabled" };
      if (el instanceof HTMLSelectElement) {
        const wanted = (step.optionLabel ?? "").trim().toLowerCase();
        const option = [...el.options].find(
          (o) => o.label.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted,
        );
        if (!option) return { ok: false, error: "failed", detail: "option not found" };
        el.value = option.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
        await new Promise((r) => setTimeout(r, 650));
        const feedback = formFeedback(el);
        return feedback.invalid || el.value !== option.value
          ? { ok: false, error: "validation_failed", detail: feedback.message || "The form did not retain this option." }
          : { ok: true };
      }
      if (["combobox", "listbox"].includes(roleOf(el)) && el instanceof HTMLElement) {
        return selectAriaOption(el, step.optionLabel ?? "");
      }
      return { ok: false, error: "unsupported" };
    }

    default:
      return { ok: false, error: "unsupported" };
  }
}

function acceptedFile(input: HTMLInputElement, file: Pick<File, "name" | "type">): boolean {
  const tokens = input.accept.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return tokens.some((token) => token.startsWith(".")
    ? name.endsWith(token)
    : token.endsWith("/*")
      ? mime.startsWith(token.slice(0, -1))
      : mime === token);
}

async function completeFilePicker(picker: Element, signal?: AbortSignal): Promise<NonNullable<ExecuteResponse["pickerCompletion"]>> {
  let sawFinish = false;
  let clickedUpload = false;
  const roots = (): ParentNode[] => {
    const found: ParentNode[] = [picker];
    const visit = (root: ParentNode): void => {
      for (const frame of root.querySelectorAll<HTMLIFrameElement>("iframe")) {
        try {
          const doc = frame.contentDocument;
          if (doc && !found.includes(doc)) { found.push(doc); visit(doc); }
        } catch { /* Inaccessible picker frames cannot be completed by this helper. */ }
      }
    };
    visit(picker);
    return found;
  };
  for (let poll = 0; poll < 150; poll++) {
    if (signal?.aborted) return "cancelled";
    if (!picker.isConnected || !isFilePickerVisible(picker)) return "closed";
    const scope = roots();
    const buttons = [...new Set(scope.flatMap((root) => [...root.querySelectorAll<HTMLElement>('button, [role="button"]')]))].filter(isDisplayed);
    const label = (button: HTMLElement) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
    const finalAction = /^(?:insert|select|done)(?:\s*\(?\d+\)?(?:\s+files?)?)?$/i;
    const uploadAction = /^upload(?:\s+\d+(?:\s+files?)?)?$/i;
    const candidates = buttons.filter((button) => finalAction.test(label(button)) || uploadAction.test(label(button)));
    sawFinish ||= candidates.length > 0;
    const busy = scope.some((root) => [...root.querySelectorAll('[aria-busy="true"], [role="progressbar"], progress')].some(isDisplayed));
    const enabled = candidates.filter((button) => !button.hasAttribute("disabled") && !isDisabled(button) && (!clickedUpload || finalAction.test(label(button))));
    const final = enabled.filter((button) => finalAction.test(label(button)));
    const ready = final.length ? final : enabled;
    if (poll > 0 && !busy && ready.length === 1) {
      const isFinal = finalAction.test(label(ready[0]!));
      ready[0]!.click();
      if (isFinal) return "completed";
      clickedUpload = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return sawFinish ? "pending" : "unavailable";
}

/** Attach a file only after an explicit user choice in the extension panel. */
export async function attachSelectedFile(
  el: Element | undefined,
  payload: { name: string; mimeType: string; data_b64: string; maxBytes?: number; sha256?: string },
  signal?: AbortSignal,
): Promise<ExecuteResponse> {
  if (signal?.aborted) return { ok: false, error: "failed", detail: "upload cancelled" };
  if (!el?.isConnected) return { ok: false, error: "regrounding_failed", detail: "upload control changed before attachment" };
  const { input: target, picker } = await openFilePickerInput(el, signal);
  if (signal?.aborted) return { ok: false, error: "failed", detail: "upload cancelled" };
  if (!target || target.type !== "file") {
    return { ok: false, error: "unsupported", detail: "The page's upload picker has no uniquely accessible file input. Cross-origin or account-specific picker support is required." };
  }
  if (target.disabled) return { ok: false, error: "failed", detail: "file input is disabled" };
  if (!acceptedFile(target, { name: payload.name, type: payload.mimeType })) {
    return { ok: false, error: "validation_failed", uploadReason: "file_type_not_accepted", detail: "The selected file type is not accepted by this field." };
  }

  try {
    const binary = atob(payload.data_b64);
    if (payload.maxBytes !== undefined && binary.length > payload.maxBytes) {
      return { ok: false, error: "validation_failed", uploadReason: "file_size_limit", detail: "The selected file exceeds this upload field's size limit." };
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (signal?.aborted) return { ok: false, error: "failed", detail: "upload cancelled" };
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (payload.sha256 && sha256 !== payload.sha256) return { ok: false, error: "failed", detail: "sanitized upload hash changed" };
    if (!target.isConnected || !el.isConnected) return { ok: false, error: "regrounding_failed", detail: "upload control changed before file dispatch" };
    if (target.files?.length) {
      const current = target.files[0]!;
      if (target.files.length !== 1 || current.size !== bytes.length || current.type !== payload.mimeType) {
        return { ok: false, error: "failed", uploadReason: "different_existing_file", detail: "The field already contains a different file; it was not replaced." };
      }
      const currentDigest = await crypto.subtle.digest("SHA-256", await current.arrayBuffer());
      const currentHash = [...new Uint8Array(currentDigest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (currentHash !== sha256) return { ok: false, error: "failed", uploadReason: "different_existing_file", detail: "The field already contains a different file; it was not replaced." };
      const pickerCompletion = picker ? await completeFilePicker(picker, signal) : undefined;
      return { ok: true, fileDispatched: true, fileSha256: sha256, ...(pickerCompletion ? { pickerCompletion } : {}) };
    }
    const safeName = payload.name.split(/[\\/]/).pop() || "attachment";
    const realm = target.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    const file = new (realm?.File ?? File)([bytes], safeName, { type: payload.mimeType || "application/octet-stream" });
    const transfer = new (realm?.DataTransfer ?? DataTransfer)();
    transfer.items.add(file);
    if (signal?.aborted) return { ok: false, error: "failed", detail: "upload cancelled" };
    target.files = transfer.files;
    const retained = target.files?.length === 1 && target.files[0]?.size === bytes.length;
    if (!retained) return { ok: false, error: "failed", detail: "The page did not retain the selected file." };
    target.dispatchEvent(new (realm?.Event ?? Event)("input", { bubbles: true }));
    target.dispatchEvent(new (realm?.Event ?? Event)("change", { bubbles: true }));
    const pickerCompletion = picker ? await completeFilePicker(picker, signal) : undefined;
    const completion = pickerCompletion ? { pickerCompletion } : {};
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (!target.isConnected || !el.isConnected) return { ok: true, fileDispatched: true, fileSha256: sha256, ...completion, detail: "File handed to the page; verify the re-rendered upload field." };
    const feedback = formFeedback(el!);
    if (feedback.invalid) return { ok: false, error: "validation_failed", fileDispatched: true, fileSha256: sha256, detail: feedback.message || "The page rejected the selected file." };
    return { ok: true, fileDispatched: true, fileSha256: sha256, ...completion };
  } catch {
    return { ok: false, error: "failed", detail: "The selected file could not be attached to this field." };
  }
}
