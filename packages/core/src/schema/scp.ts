import { z } from "zod";
import { PiiClass, PlaceholderToken } from "./pii.js";

/**
 * Sanitized Context Packet v1: the only shape allowed to cross the trust
 * boundary. The design rule is that every field here is either derived-safe
 * (roles, geometry, states) or an explicit typed placeholder. Raw values,
 * raw URLs, cookies and vault contents are unrepresentable by construction.
 */

export const SCP_SCHEMA_ID = "kavach.scp/1.0";
export const PLAN_SCHEMA_ID = "kavach.plan/1.0";

export const PrivacyMode = z.enum(["shield", "fortress", "wireframe"]);
export type PrivacyMode = z.infer<typeof PrivacyMode>;

export const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Box = z.infer<typeof Box>;

export const OriginClass = z.enum([
  "government",
  "banking",
  "payments",
  "healthcare",
  "mail",
  "social",
  "commerce",
  "enterprise",
  "education",
  "media",
  "developer",
  "other",
]);
export type OriginClass = z.infer<typeof OriginClass>;

export const ElementRole = z.enum([
  "textbox",
  "password",
  "button",
  "link",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "slider",
  "switch",
  "tab",
  "menuitem",
  "heading",
  "text",
  "label",
  "image",
  "canvas",
  "video",
  "iframe",
  "document",
  "form",
  "table",
  "list",
  "listitem",
  "dialog",
  "alert",
  "progressbar",
  "region",
  "unknown",
]);
export type ElementRole = z.infer<typeof ElementRole>;

/** What the server is allowed to know about a value. Never the value itself. */
export const ElementValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("filled"),
    /** Only for values policy classified as safe to transmit verbatim. */
    text: z.string().max(2000),
  }),
  z.object({
    kind: z.literal("placeholder"),
    token: PlaceholderToken,
    length: z.number().int().nonnegative().optional(),
    length_bucket: z.string().optional(),
    format_valid: z.boolean().optional(),
    magnitude_bucket: z.string().optional(),
    currency: z.string().optional(),
    domain_class: z.string().optional(),
    masked: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("redacted"),
    token: PlaceholderToken.optional(),
  }),
  z.object({
    kind: z.literal("unexplained_masked"),
  }),
]);
export type ElementValue = z.infer<typeof ElementValue>;

export const EvidenceTag = z
  .string()
  .regex(/^(structural|pattern|semantic|visual|fusion):[a-z0-9_\-=.]+$/);

export const ElementState = z
  .object({
    filled: z.boolean().optional(),
    disabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    required: z.boolean().optional(),
    checked: z.boolean().optional(),
    expanded: z.boolean().optional(),
    invalid: z.boolean().optional(),
    readonly: z.boolean().optional(),
    partially_visible: z.boolean().optional(),
  })
  .strict();
export type ElementState = z.infer<typeof ElementState>;

export const SceneElement = z
  .object({
    id: z.string().regex(/^e\d+$/),
    role: ElementRole,
    label: z.string().max(300).nullable(),
    box: Box,
    state: ElementState.optional(),
    value: ElementValue.optional(),
    evidence: z.array(EvidenceTag).max(16),
    confidence: z.number().min(0).max(1),
    source: z.enum(["dom", "vision", "dom+vision"]),
    risk: z.enum(["state_changing", "navigation", "destructive"]).optional(),
    note: z.string().max(300).optional(),
  })
  .strict();
export type SceneElement = z.infer<typeof SceneElement>;

export const RedactionLegendEntry = z
  .object({
    shape: z.string().max(300),
    recoverable_by_client: z.boolean(),
  })
  .strict();

export const TaskHistoryStep = z
  .object({
    step: z.number().int().positive(),
    action: z.string().max(40),
    element_label: z.string().max(300).nullable(),
    result: z.enum(["ok", "failed", "aborted"]),
  })
  .strict();

export const SanitizedContextPacket = z
  .object({
    schema: z.literal(SCP_SCHEMA_ID),
    packet_id: z.string().min(10).max(64),
    captured_at_ms: z.number().int().positive(),
    policy: z
      .object({
        mode: PrivacyMode,
        policy_version: z.string().max(32),
        invariant_floor: z.literal(true),
      })
      .strict(),
    device: z
      .object({
        backend: z.enum(["webgpu", "wasm-simd-threads", "wasm", "none"]),
        tier: z.enum(["T0", "T1", "T2", "T3"]),
        viewport: z
          .object({
            w: z.number().int().positive(),
            h: z.number().int().positive(),
            dpr: z.number().positive(),
          })
          .strict(),
      })
      .strict(),
    origin: z
      .object({
        class: OriginClass,
        tls: z.boolean(),
        page_kind: z.string().max(64),
        lang: z.string().max(16),
      })
      .strict(),
    visual: z
      .object({
        present: z.boolean(),
        format: z.enum(["image/webp", "image/png"]).optional(),
        w: z.number().int().positive().optional(),
        h: z.number().int().positive().optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        redaction_overlay: z.enum(["flat_fill", "label_stamp", "none"]).optional(),
        regions_redacted: z.number().int().nonnegative(),
      })
      .strict(),
    elements: z.array(SceneElement).max(600),
    redaction_legend: z.record(z.string(), RedactionLegendEntry),
    task: z
      .object({
        intent: z.string().max(1000),
        history: z.array(TaskHistoryStep).max(50),
      })
      .strict(),
    untrusted_text: z
      .array(
        z
          .object({
            src: z.string().regex(/^e\d+$/),
            text: z.string().max(4000),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((packet, ctx) => {
    // Wireframe means wireframe: the schema itself rejects any pixel payload.
    if (packet.policy.mode === "wireframe" && packet.visual.present) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visual", "present"],
        message: "wireframe mode forbids any visual payload",
      });
    }
    if (packet.visual.present && (!packet.visual.format || !packet.visual.sha256)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visual"],
        message: "a present visual requires format and sha256",
      });
    }
    // Every placeholder class used by an element must be described in the legend.
    const legendKeys = new Set(Object.keys(packet.redaction_legend));
    for (const [i, el] of packet.elements.entries()) {
      const token =
        el.value && "token" in el.value && el.value.token ? el.value.token : null;
      if (token) {
        const cls = token.split("#")[0]; // "PII:AADHAAR"
        if (cls && !legendKeys.has(cls)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["elements", i, "value"],
            message: `token class ${cls} missing from redaction_legend`,
          });
        }
      }
    }
  });

export type SanitizedContextPacket = z.infer<typeof SanitizedContextPacket>;

/** Convenience: legend key for a class, e.g. "PII:AADHAAR". */
export function legendKey(cls: PiiClass): string {
  return `PII:${cls}`;
}
