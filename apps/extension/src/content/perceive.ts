import type { RawRegion } from "@kavach/core/policy";
import type { ElementRole, OriginClass, PiiClass } from "@kavach/core/schema";
import type { PageMeta } from "../shared/messages.js";

/**
 * Tier 0 perception: walk the DOM (including open shadow roots), keep the
 * meaningful nodes, and describe each as a RawRegion. Raw values stay in
 * this process; the policy engine in the panel decides what survives.
 */

const MAX_REGIONS = 300;
const MAX_TEXT_BLOCKS = 60;

export interface Snapshot {
  regions: RawRegion[];
  meta: PageMeta;
  /** id -> live element, for execution and re-grounding. */
  elements: Map<string, Element>;
}

/* Structural PII classes from DOM hints: the highest-precision channel. */

const AUTOCOMPLETE_CLASS: Record<string, PiiClass> = {
  "cc-number": "CARD_NUMBER",
  "cc-csc": "OTP",
  "cc-exp": "DOB",
  "one-time-code": "OTP",
  "current-password": "PASSWORD",
  "new-password": "PASSWORD",
  email: "EMAIL",
  tel: "PHONE_IN",
  "tel-national": "PHONE_IN",
  "postal-code": "PIN_CODE",
  name: "PERSON_NAME",
  "given-name": "PERSON_NAME",
  "family-name": "PERSON_NAME",
  "street-address": "ADDRESS",
  "address-line1": "ADDRESS",
  "address-line2": "ADDRESS",
  bday: "DOB",
  username: "USERNAME",
};

const NAME_HINTS: [RegExp, PiiClass][] = [
  [/aadha?ar|uidai|\buid\b/i, "AADHAAR"],
  [/\bpan\b|permanent.?account/i, "PAN"],
  [/gstin|\bgst\b/i, "GSTIN"],
  [/ifsc/i, "IFSC"],
  [/\bupi\b|vpa/i, "UPI_VPA"],
  [/passw|pwd/i, "PASSWORD"],
  [/\botp\b|one.?time/i, "OTP"],
  [/account.?(no|num)|acc(oun)?t.?number|a\/c/i, "BANK_ACCOUNT"],
  [/card.?(no|num)/i, "CARD_NUMBER"],
  [/mobile|phone|contact.?num/i, "PHONE_IN"],
  [/pin.?code|postal|zip/i, "PIN_CODE"],
  [/email|e-mail/i, "EMAIL"],
  [/date.?of.?birth|\bdob\b|birth/i, "DOB"],
  [/address/i, "ADDRESS"],
];

function structuralClass(el: Element, label: string | null): PiiClass | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return "PASSWORD";
    if (el.type === "email") return "EMAIL";
    if (el.type === "tel") return "PHONE_IN";
    const ac = el.autocomplete?.toLowerCase();
    if (ac && AUTOCOMPLETE_CLASS[ac]) return AUTOCOMPLETE_CLASS[ac];
  }
  const haystack = [
    el.getAttribute("name"),
    el.id,
    el.getAttribute("aria-label"),
    label,
    el instanceof HTMLInputElement ? el.placeholder : null,
  ]
    .filter(Boolean)
    .join(" ");
  if (haystack) {
    for (const [re, cls] of NAME_HINTS) {
      if (re.test(haystack)) return cls;
    }
  }
  return undefined;
}

/* Role mapping. */

export function roleOf(el: Element): ElementRole {
  const aria = el.getAttribute("role");
  const tag = el.tagName.toLowerCase();
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case "password":
        return "password";
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "range":
        return "slider";
      case "submit":
      case "button":
      case "image":
        return "button";
      default:
        return "textbox";
    }
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "img") return "image";
  if (tag === "canvas") return "canvas";
  if (tag === "video") return "video";
  if (tag === "iframe" || tag === "embed" || tag === "object") return "iframe";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "label") return "label";
  if (tag === "form") return "form";
  if (tag === "table") return "table";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  if (tag === "dialog") return "dialog";
  if (tag === "progress") return "progressbar";
  switch (aria) {
    case "button":
      return "button";
    case "link":
      return "link";
    case "textbox":
    case "searchbox":
      return "textbox";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "combobox":
      return "combobox";
    case "listbox":
      return "listbox";
    case "option":
      return "option";
    case "tab":
      return "tab";
    case "menuitem":
      return "menuitem";
    case "dialog":
    case "alertdialog":
      return "dialog";
    case "alert":
      return "alert";
    case "switch":
      return "switch";
    case "slider":
      return "slider";
    case "heading":
      return "heading";
    case "img":
      return "image";
  }
  return "unknown";
}

const INTERACTIVE: ReadonlySet<ElementRole> = new Set([
  "textbox", "password", "button", "link", "checkbox", "radio", "combobox",
  "listbox", "option", "slider", "switch", "tab", "menuitem",
]);

/* Label derivation: accessibility name, roughly in spec priority order. */

function labelOf(el: Element): string | null {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.labels && el.labels.length > 0) {
      const text = el.labels[0]!.textContent?.trim();
      if (text) return text;
    }
    if ("placeholder" in el && el.placeholder.trim()) return el.placeholder.trim();
  }

  if (el instanceof HTMLImageElement && el.alt.trim()) return el.alt.trim();

  const role = roleOf(el);
  if (role === "button" || role === "link" || role === "heading" || role === "menuitem" || role === "tab" || role === "option") {
    const text = el.textContent?.trim().replace(/\s+/g, " ");
    if (text) return text.slice(0, 300);
  }
  if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) {
    if (el.value.trim()) return el.value.trim();
  }
  return null;
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
  let ancestor: Element | null = el;
  while (ancestor) {
    if (ancestor.getAttribute("aria-hidden") === "true") return false;
    const root = ancestor.getRootNode();
    if ("host" in root && root.host instanceof Element) ancestor = root.host;
    else ancestor = ancestor.parentElement;
  }
  const style = getComputedStyle(el);
  const opacity = Number.parseFloat(style.opacity);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    (!Number.isFinite(opacity) || opacity > 0.05)
  );
}

const RISK_LABEL = /submit|pay|transfer|confirm|delete|remove|apply|proceed|place order|buy|send/i;

function riskOf(el: Element, role: ElementRole, label: string | null): RawRegion["risk"] | undefined {
  if (role !== "button") return undefined;
  if (el instanceof HTMLInputElement && el.type === "submit") return "state_changing";
  if (el instanceof HTMLButtonElement && el.type === "submit") return "state_changing";
  if (/delete|remove/i.test(label ?? "")) return "destructive";
  if (RISK_LABEL.test(label ?? "")) return "state_changing";
  return undefined;
}

/* Origin classification: the class crosses the wire, the hostname never. */

const ORIGIN_RULES: [RegExp, OriginClass][] = [
  [/\.gov\.in$|\.nic\.in$|\.gov$/, "government"],
  [/bank|hdfc|icici|sbi|axis|kotak|pnb|barod/i, "banking"],
  [/pay|upi|razorpay|billdesk|paytm|phonepe/i, "payments"],
  [/hospital|health|clinic|pharma|medic/i, "healthcare"],
  [/mail|outlook|proton/i, "mail"],
  [/facebook|instagram|twitter|x\.com|linkedin|reddit|social/i, "social"],
  [/amazon|flipkart|myntra|shop|store|cart/i, "commerce"],
  [/jira|salesforce|zoho|workday|sap|crm/i, "enterprise"],
  [/edu|university|college|school|nptel/i, "education"],
  [/news|times|hindu|ndtv|media|youtube/i, "media"],
  [/github|gitlab|stackoverflow|localhost|127\.0\.0\.1/i, "developer"],
];

export function classifyOrigin(hostname: string): OriginClass {
  for (const [re, cls] of ORIGIN_RULES) {
    if (re.test(hostname)) return cls;
  }
  return "other";
}

function pageKind(doc: Document): string {
  const forms = doc.forms.length;
  const inputs = doc.querySelectorAll("input, select, textarea").length;
  if (inputs >= 8) return "form_multi_step";
  if (forms > 0 || inputs > 0) return "form";
  if (doc.querySelectorAll("article, main p").length > 5) return "article";
  return "other";
}

/* The walk. */

function* walkNodes(root: ParentNode): Generator<Element> {
  const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(
    root as Node,
    NodeFilter.SHOW_ELEMENT,
  );
  let node = walker.nextNode();
  while (node) {
    const el = node as Element;
    yield el;
    if (el.shadowRoot) yield* walkNodes(el.shadowRoot);
    node = walker.nextNode();
  }
}

const TEXT_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "dt", "dd", "blockquote", "figcaption"]);

export function perceive(doc: Document): Snapshot {
  const regions: RawRegion[] = [];
  const elements = new Map<string, Element>();
  let n = 0;
  let textBlocks = 0;

  const push = (el: Element, region: Omit<RawRegion, "id">): void => {
    if (regions.length >= MAX_REGIONS) return;
    n += 1;
    const id = `e${n}`;
    regions.push({ ...region, id });
    elements.set(id, el);
  };

  for (const el of walkNodes(doc)) {
    if (regions.length >= MAX_REGIONS) break;
    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();
    const interactive = INTERACTIVE.has(role);
    const media = role === "image" || role === "canvas" || role === "video" || role === "iframe";
    const isTextBlock = TEXT_TAGS.has(tag);
    if (!interactive && !media && !isTextBlock) continue;
    if (!isVisible(el)) continue;

    const rect = el.getBoundingClientRect();
    const box: RawRegion["box"] = [rect.x, rect.y, rect.width, rect.height];
    const label = labelOf(el);

    if (interactive) {
      const state: NonNullable<RawRegion["state"]> = {};
      let rawValue: string | undefined;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
          state.checked = el.checked;
        } else {
          rawValue = el.value;
          state.filled = el.value.length > 0;
        }
        state.disabled = el.disabled;
        if ("required" in el) state.required = el.required;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          state.readonly = el.readOnly;
        }
        if (el.matches(":invalid") && el.value.length > 0) state.invalid = true;
      } else if (el instanceof HTMLButtonElement) {
        state.disabled = el.disabled;
      } else if (el.getAttribute("aria-disabled") === "true") {
        state.disabled = true;
      }
      if (doc.activeElement === el) state.focused = true;

      const cls = structuralClass(el, label);
      const risk = riskOf(el, role, label);
      const region: Omit<RawRegion, "id"> = {
        role,
        label,
        box,
        state,
        source: "dom",
        confidence: 0.98,
        evidence: [
          `structural:role=${role}`,
          ...(cls ? [`structural:hint=${cls.toLowerCase()}`] : []),
        ],
        explained: true,
      };
      if (rawValue !== undefined) region.rawValue = rawValue;
      if (cls) region.structuralClass = cls;
      if (risk) region.risk = risk;
      push(el, region);
    } else if (media) {
      // Tier 0 cannot inspect pixels safely. Even same-origin media may carry
      // sensitive content, so every media box is masked until a vision pass
      // positively explains it.
      push(el, {
        role,
        label,
        box,
        source: "vision",
        confidence: 0.5,
        evidence: [`structural:tag=${tag}`],
        explained: false,
      });
    } else if (isTextBlock && textBlocks < MAX_TEXT_BLOCKS) {
      const text = directText(el);
      if (!text) continue;
      textBlocks += 1;
      push(el, {
        role: role === "heading" ? "heading" : "text",
        label: null,
        box,
        source: "dom",
        confidence: 0.95,
        evidence: ["structural:text"],
        explained: true,
        rawText: text.slice(0, 4000),
      });
    }
  }

  const meta: PageMeta = {
    originClass: classifyOrigin(location.hostname),
    tls: location.protocol === "https:",
    lang: doc.documentElement.lang || navigator.language || "en",
    pageKind: pageKind(doc),
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
  };

  return { regions, meta, elements };
}

/** Text directly inside a block, not text of nested blocks (avoids duplication). */
function directText(el: Element): string {
  let out = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? "";
    else if (
      child.nodeType === Node.ELEMENT_NODE &&
      !TEXT_TAGS.has((child as Element).tagName.toLowerCase()) &&
      !INTERACTIVE.has(roleOf(child as Element))
    ) {
      out += child.textContent ?? "";
    }
  }
  return out.trim().replace(/\s+/g, " ");
}
