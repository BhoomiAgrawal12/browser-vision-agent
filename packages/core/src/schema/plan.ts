import { z } from "zod";
import { PLAN_SCHEMA_ID, SanitizedContextPacket } from "./scp.js";
import { PlaceholderToken } from "./pii.js";

export { PLAN_SCHEMA_ID };

/**
 * Action Plan v1: what the server is allowed to say back. The verb list is
 * closed, targets are element IDs from the packet (never coordinates), and
 * the only way to reference a private value is a placeholder token or a
 * request that the client ask the user.
 */

export const ACTION_VERBS = [
  "click",
  "type",
  "clear",
  "select",
  "focus",
  "scroll",
  "wait",
  "done",
  "abort",
] as const;
export const ActionVerb = z.enum(ACTION_VERBS);
export type ActionVerb = z.infer<typeof ActionVerb>;

/** Verbs that require a target element. */
const TARGETED: ReadonlySet<string> = new Set(["click", "type", "clear", "select", "focus"]);

export const StepValue = z.discriminatedUnion("kind", [
  /** Ask the human. The prompt names the field, never the value. */
  z.object({
    kind: z.literal("user_prompt"),
    prompt_text: z.string().max(300),
  }),
  /** Reuse a value the client already holds, by token. Client policy decides consent. */
  z.object({
    kind: z.literal("placeholder"),
    token: PlaceholderToken,
  }),
  /** Non-sensitive literal the server composed, e.g. a search query. */
  z.object({
    kind: z.literal("literal"),
    text: z.string().max(2000),
  }),
  /** For select: choose an option by its visible label. */
  z.object({
    kind: z.literal("option_label"),
    label: z.string().max(300),
  }),
]);
export type StepValue = z.infer<typeof StepValue>;

export const PlanStep = z
  .object({
    action: ActionVerb,
    target_element_id: z.string().regex(/^e\d+$/).optional(),
    value: StepValue.optional(),
    scroll: z
      .object({
        direction: z.enum(["up", "down"]),
        amount: z.enum(["page", "half", "to_element"]),
      })
      .strict()
      .optional(),
    wait_ms: z.number().int().positive().max(10000).optional(),
    requires_confirmation: z.boolean(),
    confirmation_reason: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (TARGETED.has(step.action) && !step.target_element_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_element_id"],
        message: `action "${step.action}" requires a target element id`,
      });
    }
    if ((step.action === "type" || step.action === "select") && !step.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: 'action "type" requires a value',
      });
    }
    if (step.action === "scroll" && !step.scroll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scroll"],
        message: 'action "scroll" requires scroll parameters',
      });
    }
  });
export type PlanStep = z.infer<typeof PlanStep>;

export const ActionPlan = z
  .object({
    schema: z.literal(PLAN_SCHEMA_ID),
    packet_id: z.string().min(10).max(64),
    reasoning_summary: z.string().max(2000),
    steps: z.array(PlanStep).max(20),
    needs_more_context: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ActionPlan = z.infer<typeof ActionPlan>;

export type PlanGuardIssue = { step: number; problem: string };

/**
 * The output guard, shared by client and server. A plan that fails any of
 * these checks is discarded whole; there is no partial execution of a
 * suspect plan.
 */
export function guardPlanAgainstPacket(
  plan: ActionPlan,
  packet: SanitizedContextPacket,
): PlanGuardIssue[] {
  const issues: PlanGuardIssue[] = [];

  if (plan.packet_id !== packet.packet_id) {
    issues.push({ step: -1, problem: "plan answers a different packet" });
  }

  const ids = new Map(packet.elements.map((e) => [e.id, e]));
  const placeholderOwners = new Map<string, string>();
  const unavailableTokens = new Set<string>();
  const promptedTargets = new Set<string>();
  for (const element of packet.elements) {
    const value = element.value;
    if (value?.kind === "placeholder") {
      placeholderOwners.set(value.token, element.id);
    } else if (value?.kind === "redacted" && value.token) {
      unavailableTokens.add(value.token);
    }
  }

  for (const [i, step] of plan.steps.entries()) {
    if (step.target_element_id) {
      const el = ids.get(step.target_element_id);
      if (!el) {
        issues.push({
          step: i,
          problem: `element ${step.target_element_id} does not exist in the packet`,
        });
        continue;
      }
      // State-changing elements must arrive flagged for confirmation.
      if (el.risk && !step.requires_confirmation) {
        issues.push({
          step: i,
          problem: `element ${step.target_element_id} is ${el.risk} but the step does not require confirmation`,
        });
      }
      if (step.action === "type" && el.role !== "textbox" && el.role !== "password" && el.role !== "combobox") {
        issues.push({
          step: i,
          problem: `cannot type into role "${el.role}"`,
        });
      }
      if (step.action === "select" && el.role !== "combobox" && el.role !== "listbox") {
        issues.push({ step: i, problem: `cannot select into role "${el.role}"` });
      }
      if (TARGETED.has(step.action) && (el.state?.disabled === true || (["type", "select", "clear"].includes(step.action) && el.state?.readonly === true))) {
        issues.push({ step: i, problem: "target is disabled or readonly" });
      }
      if (
        step.action === "type" &&
        el.state?.invalid !== true &&
        (el.state?.filled === true || el.value?.kind === "placeholder" || el.value?.kind === "filled")
      ) {
        issues.push({
          step: i,
          problem: `element ${step.target_element_id} already contains a value`,
        });
      }
      if (step.action === "type" && el.state?.invalid === true && step.value?.kind !== "user_prompt") {
        issues.push({
          step: i,
          problem: `element ${step.target_element_id} is invalid and requires fresh user input`,
        });
      }
      if (step.action === "type" && step.value?.kind === "user_prompt") {
        if (promptedTargets.has(step.target_element_id)) {
          issues.push({
            step: i,
            problem: `element ${step.target_element_id} was already prompted in this plan`,
          });
        }
        promptedTargets.add(step.target_element_id);
      }
    }
    // The server may never ask the client to reveal a value: placeholder
    // steps are fills, and only into fields, which the check above enforces.
    if (step.value?.kind === "placeholder" && step.action !== "type") {
      issues.push({
        step: i,
        problem: "placeholder values may only be used with the type action",
      });
    }
    if (step.value?.kind === "placeholder") {
      const owner = placeholderOwners.get(step.value.token);
      if (!owner) {
        issues.push({
          step: i,
          problem: unavailableTokens.has(step.value.token)
            ? `placeholder ${step.value.token} is not recoverable`
            : `placeholder ${step.value.token} is not present in the packet`,
        });
      } else if (step.target_element_id !== owner) {
        issues.push({
          step: i,
          problem: `placeholder ${step.value.token} belongs to element ${owner}`,
        });
      }
    }
  }
  return issues;
}
