/** DOM adapters shared by perception, execution and post-input verification. */
export const QUESTION_SELECTOR = '[data-automation-id="questionItem"], [data-automation-id="question"], .freebirdFormviewerComponentsQuestionBaseRoot, [role="listitem"], fieldset';
const ERROR_SELECTOR = '[role="alert"], [aria-live="assertive"], [data-automation-id="errorMessage"], [data-automation-id="questionError"], .freebirdFormviewerComponentsQuestionBaseErrorMessage';

export function questionOf(el: Element): Element | null {
  return el.closest(QUESTION_SELECTOR) ?? el.closest('[role="group"], [role="radiogroup"]');
}

export function isDisplayed(el: Element): boolean {
  for (let node: Element | null = el; node;) {
    const style = getComputedStyle(node);
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true" ||
      style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
      style.opacity === "0") return false;
    const root = node.getRootNode();
    node = node.parentElement ?? ("host" in root ? root.host as Element : null);
  }
  return true;
}

export function linkedText(el: Element, attribute: string): string[] {
  const root = el.getRootNode() as Document | ShadowRoot;
  return (el.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean).flatMap((id) => {
    const node = root.getElementById(id);
    const text = node && isDisplayed(node) ? node.textContent?.trim().replace(/\s+/g, " ") : "";
    return text ? [text] : [];
  });
}

export function questionTitle(el: Element): string | null {
  const q = questionOf(el);
  const title = q?.querySelector('[data-automation-id="questionTitle"], [data-automation-id="questionTitleText"], .freebirdFormviewerComponentsQuestionBaseTitle, legend, [role="heading"]');
  const value = title?.querySelector(".text-format-content")?.textContent ?? title?.textContent;
  return value?.trim().replace(/\s+/g, " ").replace(/^\d+\s*[.)]\s*/, "").replace(/\s*\*\s*$/, "") || null;
}

export function editableTarget(el: Element): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLElement && el.isContentEditable) return el;
  const nodes = [...el.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]')].filter(isDisplayed);
  return nodes.length === 1 ? nodes[0] as HTMLElement : null;
}

export function choiceNodes(el: Element): HTMLElement[] {
  if (el instanceof HTMLSelectElement) return [...el.options];
  const ids = (el.getAttribute("aria-controls") ?? el.getAttribute("aria-owns") ?? "").split(/\s+/).filter(Boolean);
  const roots: Element[] = [el, ...ids.flatMap((id) => {
    const node = el.ownerDocument.getElementById(id);
    return node ? [node] : [];
  })];
  // Some listboxes use a portal without aria-controls. Only use the unique open list.
  if (roots.length === 1 && el.getAttribute("aria-expanded") === "true") {
    const lists = [...el.ownerDocument.querySelectorAll('[role="listbox"]')].filter(isDisplayed);
    if (lists.length === 1 && lists[0] !== el) roots.push(lists[0]!);
  }
  return [...new Set(roots.flatMap((root) => [...root.querySelectorAll<HTMLElement>('[role="option"], [role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]')]))]
    .filter(isDisplayed);
}

export function choiceLabel(el: Element): string {
  return linkedText(el, "aria-labelledby").join(" ") || el.getAttribute("aria-label")?.trim() ||
    (el instanceof HTMLInputElement ? el.labels?.[0]?.textContent?.trim() : "") ||
    (el instanceof HTMLOptionElement ? el.label : el.textContent?.trim()) || "";
}

export function selected(el: Element): boolean {
  if (el.getAttribute("data-value") === "" || el.getAttribute("aria-disabled") === "true") return false;
  return (el instanceof HTMLInputElement && el.checked) ||
    (el instanceof HTMLOptionElement && el.selected && el.value !== "") ||
    el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true";
}

export function controlValue(el: Element): string {
  if (el instanceof HTMLSelectElement) return el.value ? [...el.selectedOptions].map((o) => o.label).join(", ") : "";
  const choices = choiceNodes(el).filter(selected).map(choiceLabel).filter(Boolean);
  if (choices.length) return choices.join(", ");
  const target = editableTarget(el);
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value;
  if (target?.isContentEditable) return target.textContent ?? "";
  const retained = [...el.querySelectorAll<HTMLElement>('[aria-selected="true"], [aria-checked="true"]')].filter(selected);
  return el.getAttribute("aria-valuetext") ?? [...new Set([...choiceNodes(el).filter(selected), ...retained])].map(choiceLabel).join(", ");
}

export function formFeedback(el: Element): { invalid: boolean; message: string; help: string } {
  const target = editableTarget(el) ?? el;
  const native = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ? target : null;
  const q = questionOf(el);
  const inline = q ? [...q.querySelectorAll(ERROR_SELECTOR)].filter(isDisplayed)
    .filter((node) => questionOf(node) === q)
    .map((node) => node.textContent?.trim().replace(/\s+/g, " ") ?? "").filter(Boolean) : [];
  const ariaInvalid = el.getAttribute("aria-invalid") === "true" || target.getAttribute("aria-invalid") === "true";
  const nativeInvalid = Boolean(native && !native.validity.valid && (native.value || native.validity.badInput || native.validity.customError));
  const invalid = ariaInvalid || nativeInvalid || inline.length > 0;
  const help = [...new Set([...linkedText(el, "aria-describedby"), ...linkedText(target, "aria-describedby"),
    ...(target instanceof HTMLInputElement && /date|yyyy|mm\/dd|dd\/mm/i.test(target.placeholder) ? [target.placeholder] : [])])].join("\n");
  const errors = invalid ? [...new Set([...linkedText(el, "aria-errormessage"), ...linkedText(target, "aria-errormessage"), ...inline])] : [];
  const message = errors.join("\n") || (ariaInvalid ? help : "") || (native?.validationMessage ?? "");
  return { invalid, message, help };
}
