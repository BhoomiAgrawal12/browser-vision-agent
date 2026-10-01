import {
  PII_LEGEND,
  PII_SEVERITY,
  isInvariantClass,
  type PiiClass,
} from "../schema/pii.js";
import {
  legendKey,
  type Box,
  type ElementRole,
  type ElementState,
  type ElementValue,
  type PrivacyMode,
  type SceneElement,
} from "../schema/scp.js";
import type { RecognizerRegistry } from "../detectors/recognizers.js";
import { Vault, VaultFullError } from "../vault/index.js";

/**
 * The policy engine: takes raw regions (which still contain real values)
 * and a privacy mode, and produces sanitized scene elements, the redaction
 * legend and a summary. The inversion that matters: we do not ask "is this
 * PII?", we ask "can this region be positively explained as safe?" and
 * mask when the answer is no.
 */

export interface RawRegion {
  id: string;
  role: ElementRole;
  label: string | null;
  box: Box;
  state?: ElementState;
  source: "dom" | "vision" | "dom+vision";
  confidence: number;
  evidence: string[];
  /** Fusion says a DOM node accounts for these pixels. */
  explained: boolean;
  /** Current value of a form control, if any. Real, unsanitized. */
  rawValue?: string;
  /** Visible text content of a non-control region. Real, unsanitized. */
  rawText?: string;
  /** Class asserted by DOM structure: type=password, autocomplete=cc-number. */
  structuralClass?: PiiClass;
  /** Class asserted by vision: FACE, QR_BARCODE, ID_DOCUMENT, SIGNATURE. */
  visualClass?: PiiClass;
  /** Browser-local validation feedback; never copied into a sanitized packet. */
  validationMessage?: string;
  /** Browser-only control metadata. Never serialized by the policy engine. */
  control?: {
    kind: "text" | "select" | "radio" | "checkboxes";
    inputType?: string;
    fileInputAvailable?: boolean;
    accept?: string;
    triggerLabel?: string;
    help?: string;
    options?: string[];
  };
  risk?: "state_changing" | "navigation" | "destructive";
}

export interface SanitizeResult {
  elements: SceneElement[];
  legend: Record<string, { shape: string; recoverable_by_client: boolean }>;
  untrustedText: { src: string; text: string }[];
  summary: {
    regionsRedacted: number;
    redactedByClass: Partial<Record<PiiClass, number>>;
    unexplainedMasked: number;
    vaultOverflows: number;
  };
}

/** Analyzer thresholds per mode: stricter modes look harder. */
const MODE_THRESHOLD: Record<PrivacyMode, number> = {
  shield: 0.5,
  fortress: 0.3,
  wireframe: 0.3,
};

/** Does this mode redact this severity? The invariant floor ignores modes. */
function modeRedacts(mode: PrivacyMode, cls: PiiClass): boolean {
  const severity = PII_SEVERITY[cls];
  if (severity === "invariant") return true;
  if (mode === "shield") return severity === "high";
  return true; // fortress and wireframe redact medium too
}

function magnitudeBucket(raw: string): string | undefined {
  const digits = raw.replace(/[^\d.]/g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const exp = Math.floor(Math.log10(n));
  return `1e${exp}_to_1e${exp + 1}`;
}

const MAX_UNTRUSTED_TEXT = 4000;
const MAX_FILLED_TEXT = 2000;

export class PolicyEngine {
  constructor(
    private readonly registry: RecognizerRegistry,
    private readonly vault: Vault,
    readonly policyVersion: string,
  ) {}

  /**
   * Replace every detected PII span in a free-text string with its vault
   * token. Used for labels, untrusted text and the user's task intent,
   * which can all carry PII.
   */
  sanitizeText(
    text: string,
    mode: PrivacyMode,
    used: Set<PiiClass>,
    counters: { overflows: number },
  ): string {
    const spans = this.registry.analyze(text, { threshold: MODE_THRESHOLD[mode] });
    if (spans.length === 0) return text;
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      if (!modeRedacts(mode, span.cls)) continue;
      out += text.slice(cursor, span.start);
      try {
        const token = this.vault.mint(span.cls, span.normalized ?? span.text);
        used.add(span.cls);
        out += token;
      } catch (e) {
        if (e instanceof VaultFullError) {
          counters.overflows += 1;
          used.add(span.cls);
          out += `PII:${span.cls}#?`;
        } else {
          throw e;
        }
      }
      cursor = span.end;
    }
    out += text.slice(cursor);
    return out;
  }

  /**
   * Cross-region line scan: PII split across adjacent DOM nodes on one
   * visual line ("9999 4105" in one span, "7058" in the next) defeats
   * per-region analysis. Reconstruct lines by y-band, analyze the joined
   * text, and force-redact every region a crossing span touches.
   */
  private crossRegionScan(
    regions: RawRegion[],
    mode: PrivacyMode,
  ): Map<string, { cls: PiiClass; normalized: string }> {
    const forced = new Map<string, { cls: PiiClass; normalized: string }>();
    const textual = regions
      .filter((r) => (r.rawText ?? r.rawValue ?? "").trim().length > 0)
      .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);

    // Group into visual lines: same y-band within half the region height.
    const lines: RawRegion[][] = [];
    for (const r of textual) {
      const line = lines.find((l) => {
        const ref = l[0]!;
        const tolerance = Math.max(8, Math.min(ref.box[3], r.box[3]) / 2);
        return Math.abs(ref.box[1] - r.box[1]) <= tolerance;
      });
      if (line) line.push(r);
      else lines.push([r]);
    }

    for (const line of lines) {
      if (line.length < 2) continue;
      line.sort((a, b) => a.box[0] - b.box[0]);
      const parts = line.map((r) => (r.rawText ?? r.rawValue ?? "").trim());
      const joined = parts.join(" ");
      const bounds: number[] = [];
      let cursor = 0;
      for (const p of parts) {
        cursor += p.length;
        bounds.push(cursor);
        cursor += 1; // the joining space
      }
      for (const span of this.registry.analyze(joined, {
        threshold: MODE_THRESHOLD[mode],
      })) {
        if (!modeRedacts(mode, span.cls)) continue;
        // Which parts does this span touch? Crossing a boundary means the
        // value was split across regions and each one must be redacted.
        const touched: number[] = [];
        let start = 0;
        for (const [i, p] of parts.entries()) {
          const end = start + p.length;
          if (span.start < end && start < span.end) touched.push(i);
          start = end + 1;
        }
        if (touched.length >= 2) {
          for (const i of touched) {
            forced.set(line[i]!.id, {
              cls: span.cls,
              normalized: span.normalized ?? span.text,
            });
          }
        }
      }
    }
    return forced;
  }

  sanitize(regions: RawRegion[], mode: PrivacyMode, taskIntent: string): SanitizeResult & { intent: string } {
    const used = new Set<PiiClass>();
    const recoverable = new Set<PiiClass>();
    const redactedByClass: Partial<Record<PiiClass, number>> = {};
    const untrustedText: { src: string; text: string }[] = [];
    const counters = { overflows: 0 };
    let unexplainedMasked = 0;
    const forced = this.crossRegionScan(regions, mode);

    const note = (cls: PiiClass) => {
      used.add(cls);
      redactedByClass[cls] = (redactedByClass[cls] ?? 0) + 1;
    };

    const elements: SceneElement[] = regions.map((r) => {
      const evidence = [...r.evidence];
      let value: ElementValue | undefined;
      let label = r.label;

      // 0. Cross-region hits: this region carries part of a value that was
      //    split across nodes. The whole region is redacted; the token is
      //    minted from the reassembled value so it stays stable.
      const crossHit = forced.get(r.id);
      if (crossHit) {
        note(crossHit.cls);
        evidence.push("pattern:cross-region");
        value = this.mintValue(crossHit.cls, crossHit.normalized, counters, recoverable);
        const el: SceneElement = {
          id: r.id,
          role: r.role,
          label: label ? this.sanitizeText(label, mode, used, counters).slice(0, 300) : null,
          box: r.box,
          evidence: evidence.slice(0, 16),
          confidence: r.confidence,
          source: r.source,
        };
        if (r.state) el.state = r.state;
        if (value) el.value = value;
        if (r.risk) el.risk = r.risk;
        return el;
      }
      // 1. Fail closed: pixels no DOM node explains are masked, always.
      if (!r.explained && r.source === "vision" && !r.visualClass) {
        value = { kind: "unexplained_masked" };
        unexplainedMasked += 1;
        if (!evidence.includes("fusion:no-dom-node")) evidence.push("fusion:no-dom-node");
      }
      // 2. Visual PII classes: faces, QR codes, documents, signatures.
      else if (r.visualClass) {
        const cls = r.visualClass;
        // Visual classes are invariant or high; every mode redacts them.
        note(cls);
        value = this.mintVisual(cls, r.id, counters);
      }
      // 3. Structural certainty: the DOM says what this field is.
      else if (r.structuralClass && r.rawValue !== undefined && r.rawValue !== "") {
        const cls = r.structuralClass;
        if (modeRedacts(mode, cls)) {
          note(cls);
          value = this.mintValue(cls, r.rawValue, counters, recoverable);
        } else {
          value = { kind: "filled", text: r.rawValue.slice(0, MAX_FILLED_TEXT) };
        }
      }
      // 4. Filled control without a structural class: analyze the value with
      //    the field's label prepended as context, so "PIN code" next to six
      //    digits boosts exactly like inline context words do.
      else if (r.rawValue !== undefined && r.rawValue !== "") {
        const prefix = r.label ? `${r.label}: ` : "";
        const spans = this.registry
          .analyze(prefix + r.rawValue, { threshold: MODE_THRESHOLD[mode] })
          .filter((s) => s.start >= prefix.length);
        const strongest = spans.filter((s) => modeRedacts(mode, s.cls))[0];
        if (strongest) {
          note(strongest.cls);
          evidence.push(...strongest.evidence.slice(0, 3));
          value = this.mintValue(
            strongest.cls,
            strongest.normalized ?? strongest.text,
            counters,
            recoverable,
            r.rawValue,
          );
        } else if (mode === "fortress" || mode === "wireframe") {
          // Strict modes do not transmit unclassified values at all.
          value = { kind: "redacted" };
        } else {
          value = { kind: "filled", text: r.rawValue.slice(0, MAX_FILLED_TEXT) };
        }
      }
      // 5. Empty control.
      else if (this.isControl(r.role) || r.control?.inputType === "file") {
        value = { kind: "empty" };
      }

      // 6. Free text regions: quarantined into untrusted_text, sanitized.
      if (r.rawText && r.rawText.trim().length > 0) {
        const clean = this.sanitizeText(r.rawText, mode, used, counters);
        for (const cls of used) {
          if (clean.includes(`PII:${cls}#`)) {
            redactedByClass[cls] = redactedByClass[cls] ?? 0;
          }
        }
        untrustedText.push({ src: r.id, text: clean.slice(0, MAX_UNTRUSTED_TEXT) });
      }

      // 7. Labels are page text too.
      if (label) label = this.sanitizeText(label, mode, used, counters).slice(0, 300);

      const el: SceneElement = {
        id: r.id,
        role: r.role,
        label,
        box: r.box,
        evidence: evidence.slice(0, 16),
        confidence: r.confidence,
        source: r.source,
      };
      if (r.state) el.state = r.state;
      if (value) el.value = value;
      if (r.risk) el.risk = r.risk;
      return el;
    });

    const intent = this.sanitizeText(taskIntent, mode, used, counters);
    const legend: SanitizeResult["legend"] = {};
    for (const cls of used) {
      legend[legendKey(cls)] = {
        shape: PII_LEGEND[cls],
        recoverable_by_client: recoverable.has(cls),
      };
    }

    const regionsRedacted = Object.values(redactedByClass).reduce(
      (a, b) => a + (b ?? 0),
      unexplainedMasked,
    );

    return {
      elements,
      legend,
      untrustedText,
      intent,
      summary: {
        regionsRedacted,
        redactedByClass,
        unexplainedMasked,
        vaultOverflows: counters.overflows,
      },
    };
  }

  private isControl(role: ElementRole): boolean {
    return (
      role === "textbox" ||
      role === "password" ||
      role === "combobox" ||
      role === "listbox" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "slider" ||
      role === "switch"
    );
  }

  private mintValue(
    cls: PiiClass,
    normalized: string,
    counters: { overflows: number },
    recoverable: Set<PiiClass>,
    original?: string,
  ): ElementValue {
    try {
      const token = this.vault.mint(cls, normalized);
      recoverable.add(cls);
      const v: ElementValue = {
        kind: "placeholder",
        token,
        length: (original ?? normalized).length,
        masked: isInvariantClass(cls),
      };
      if (cls === "AMOUNT") {
        const bucket = magnitudeBucket(normalized);
        if (bucket) {
          v.magnitude_bucket = bucket;
          v.currency = "INR";
          delete v.length; // exact length of an amount is itself a leak
        }
      }
      if (PII_SEVERITY[cls] === "invariant") {
        // For invariant classes even the exact length is withheld.
        delete v.length;
        v.length_bucket = this.lengthBucket((original ?? normalized).length);
      }
      return v;
    } catch (e) {
      if (e instanceof VaultFullError) {
        counters.overflows += 1;
        return { kind: "redacted" };
      }
      throw e;
    }
  }

  private mintVisual(cls: PiiClass, regionId: string, counters: { overflows: number }): ElementValue {
    try {
      // Visual regions have no text value; the region id anchors the ordinal.
      const token = this.vault.mint(cls, `region:${regionId}`);
      return { kind: "redacted", token };
    } catch (e) {
      if (e instanceof VaultFullError) {
        counters.overflows += 1;
        return { kind: "redacted" };
      }
      throw e;
    }
  }

  private lengthBucket(n: number): string {
    if (n <= 8) return "1_to_8";
    if (n <= 16) return "8_to_16";
    if (n <= 32) return "16_to_32";
    return "over_32";
  }
}
