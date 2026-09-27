import type { ExecuteResponse, Grounding, ResolvedStep } from "../shared/messages.js";
import { labelOf, roleOf } from "./perceive.js";

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
  const style = getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    el.getAttribute("aria-hidden") === "true"
  ) {
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
  return (
    el.getAttribute("aria-disabled") === "true" ||
    (el instanceof HTMLButtonElement && el.disabled) ||
    (el instanceof HTMLInputElement && el.disabled) ||
    (el instanceof HTMLTextAreaElement && el.disabled) ||
    (el instanceof HTMLSelectElement && el.disabled)
  );
}

function isReadonly(el: Element): boolean {
  return (
    (el instanceof HTMLInputElement && el.readOnly) ||
    (el instanceof HTMLTextAreaElement && el.readOnly) ||
    el.getAttribute("aria-readonly") === "true"
  );
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
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        setNativeValue(el, step.text ?? "");
        return { ok: true };
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        el.focus();
        el.textContent = step.text ?? "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true };
      }
      return { ok: false, error: "unsupported", detail: "target is not a text field" };
    }

    case "clear": {
      if (!el) return { ok: false, error: "not_found" };
      if (isDisabled(el) || isReadonly(el)) {
        return { ok: false, error: "failed", detail: "target cannot be cleared" };
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        setNativeValue(el, "");
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
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      return { ok: false, error: "unsupported" };
    }

    default:
      return { ok: false, error: "unsupported" };
  }
}
