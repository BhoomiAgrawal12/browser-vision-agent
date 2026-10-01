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

/** Find the native file input owned by this field or its upload trigger. */
export function fileInputFor(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === "file") return el;
  const roots: Element[] = [];
  const label = el.closest("label");
  const question = questionOf(el);
  if (label) roots.push(label);
  if (question && question !== label) roots.push(question);
  for (const root of [...new Set(roots)]) {
    const inputs = [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    if (inputs.length === 1) return inputs[0]!;
  }
  return null;
}

export function isFileUploadPrompt(el: Element): boolean {
  const text = (questionOf(el)?.textContent ?? el.parentElement?.textContent ?? "").replace(/\s+/g, " ");
  return /\bupload\s+\d+\s+(?:supported\s+)?files?\b|\b(?:file|photo|image)\s+(?:upload|attachment)\b/i.test(text);
}

export function isFileUploadAction(el: Element): boolean {
  const role = el.getAttribute("role");
  if (!(el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || role === "button" || role === "link")) return false;
  const action = [el.getAttribute("aria-label"), el.textContent].filter(Boolean).join(" ").replace(/\s+/g, " ");
  return /\b(?:add|upload|choose|select|browse|attach)(?:\s+(?:a|an|your))?(?:\s+(?:file|files|photo|image|document))?\b/i.test(action);
}

export function fileUploadHelp(el: Element): string | undefined {
  const text = (questionOf(el)?.textContent ?? el.parentElement?.textContent ?? "").replace(/\s+/g, " ");
  const count = text.match(/\bupload\s+\d+\s+(?:supported\s+)?files?\b/i)?.[0];
  const max = text.match(/\bmax(?:imum)?(?:\s+file\s+size)?\s*[:\-]?\s*\d+(?:\.\d+)?\s*(?:bytes?|kb|mb|gb|kib|mib|gib)\b/i)?.[0];
  const help = [count, max].filter(Boolean).join(". ");
  return help || undefined;
}

export function fileUploadValue(el: Element): string {
  const input = fileInputFor(el);
  if (input?.files?.length) return "file selected";
  const question = questionOf(el);
  const status = question?.querySelector('[aria-label*="Remove file" i], [aria-label*="Delete file" i], [data-file-name], [data-testid*="file"]');
  if (status && isDisplayed(status)) return "file selected";
  const text = (question?.textContent ?? "").replace(/\s+/g, " ");
  return /\b(?:file uploaded|uploaded file|file attached|attached file|sanitized-image\.(?:png|jpe?g|webp)|sanitized-document\.pdf)\b/i.test(text) ? "file selected" : "";
}

/** Only inspect a newly opened, owned picker; never choose unrelated page inputs. */
const ownedFilePickers = new WeakMap<Element, Element>();
export function isFilePickerVisible(root: Element): boolean {
  const view = root.ownerDocument.defaultView!;
  return [root, ...root.querySelectorAll('iframe, dialog, [role="dialog"]')].some((node) => {
    const rect = node.getBoundingClientRect();
    return isDisplayed(node) && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
  });
}

export async function openFilePickerInput(el: Element, signal?: AbortSignal): Promise<{ input: HTMLInputElement | null; picker: Element | null }> {
  if (signal?.aborted) return { input: null, picker: null };
  const doc = el.ownerDocument;
  const selector = 'dialog, [role="dialog"], .picker-dialog';
  const previous = new Set([...doc.querySelectorAll(selector)].filter(isFilePickerVisible));
  const inputs = (root: ParentNode): HTMLInputElement[] => {
    const found = [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter((input) => !input.disabled);
    for (const frame of root.querySelectorAll<HTMLIFrameElement>("iframe")) {
      try { if (frame.contentDocument) found.push(...inputs(frame.contentDocument)); } catch { /* Cross-origin pickers are not accessible from this helper. */ }
    }
    return found;
  };
  const existing = ownedFilePickers.get(el);
  if (existing?.isConnected && isFilePickerVisible(existing)) {
    const found = inputs(existing);
    if (found.length === 1) return { input: found[0]!, picker: existing };
  }
  const direct = fileInputFor(el);
  if (direct) return { input: direct, picker: null };
  (el as HTMLElement).click();
  const activated = new Set<Element>();
  for (let tick = 0; tick < 30; tick++) {
    if (signal?.aborted) return { input: null, picker: null };
    const owned = [...doc.querySelectorAll(selector)].filter((dialog) => !previous.has(dialog) && isFilePickerVisible(dialog));
    const found = [...new Map(owned.flatMap((picker) => inputs(picker).map((input) => [input, { input, picker }] as const))).values()];
    if (found.length === 1) { ownedFilePickers.set(el, found[0]!.picker); return found[0]!; }
    if (found.length > 1) return { input: null, picker: null };
    for (const picker of owned) {
      if (activated.has(picker)) continue;
      const uploadTab = [...picker.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => /^upload$/i.test((tab.getAttribute("aria-label") ?? tab.textContent ?? "").trim()));
      if (uploadTab) { uploadTab.click(); activated.add(picker); }
    }
    const appeared = fileInputFor(el);
    if (appeared) return { input: appeared, picker: null };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { input: null, picker: null };
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
  if (el instanceof HTMLInputElement && el.type === "file") return el.files?.length ? "file selected" : "";
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
