import {
  PLAN_SCHEMA_ID,
  type ActionPlan,
  type PlanStep,
  type SanitizedContextPacket,
  type SceneElement,
} from "@kavach/core/schema";

/**
 * The deterministic Tier 0 planner. No model, no network, works air-gapped.
 * It reads the element graph the way the report describes the server
 * reasoning: entirely in terms of roles, states and placeholders.
 *
 * Strategy, in order:
 *  1. Required, empty form fields -> ask the user for each (the server can
 *     never know these values; user_prompt is the only channel).
 *  2. Everything required is filled -> find the primary action button and
 *     click it, honouring the risk flag with a confirmation requirement.
 *  3. Otherwise -> report done or ask for more context.
 */

const SUBMIT_LABEL = /submit|proceed|continue|next|save|verify|confirm|pay|apply|login|sign in|search|start now/i;

function isFillableRole(el: SceneElement): boolean {
  return ["textbox", "password", "combobox", "listbox"].includes(el.role) ||
    el.evidence.includes("structural:input_type=file");
}

function isFileUpload(el: SceneElement): boolean {
  return el.evidence.includes("structural:input_type=file");
}

function isEmptyRequired(el: SceneElement): boolean {
  return (
    isFillableRole(el) &&
    (el.state?.required === true || el.evidence.includes("structural:provided-locally")) &&
    el.state?.disabled !== true &&
    el.state?.readonly !== true &&
    el.value?.kind === "empty"
  );
}

function isInvalidField(el: SceneElement): boolean {
  return isFillableRole(el) && el.state?.invalid === true && el.state?.disabled !== true && el.state?.readonly !== true;
}

function isActionButton(el: SceneElement): boolean {
  return (
    el.role === "button" &&
    !isFileUpload(el) &&
    el.state?.disabled !== true &&
    el.label !== null &&
    SUBMIT_LABEL.test(el.label)
  );
}

export function heuristicPlan(packet: SanitizedContextPacket): ActionPlan {
  const steps: PlanStep[] = [];
  // Pick the first pending question in page order, including uploads and
  // locally supplied optional answers. Never batch later fields or submission.
  const el = packet.elements.find((element) => isInvalidField(element) || isEmptyRequired(element));
  if (el) {
    const invalid = isInvalidField(el);
    steps.push({
      action: isFileUpload(el) ? "click" : el.role === "combobox" || el.role === "listbox" ? "select" : "type",
      target_element_id: el.id,
      ...(isFileUpload(el) ? {} : { value: { kind: "user_prompt" as const, prompt_text: `Please ${invalid ? "correct" : "provide"}: ${el.label ?? "the highlighted field"}` } }),
      requires_confirmation: el.risk !== undefined,
    });
    return {
      schema: PLAN_SCHEMA_ID,
      packet_id: packet.packet_id,
      reasoning_summary: `The next question (${el.label ?? el.id}) ${invalid ? "needs correction" : "needs an answer"}. Later questions will be checked after this one.`,
      steps,
      needs_more_context: false,
      confidence: invalid ? 0.8 : 0.75,
    };
  }

  const button = packet.elements.find(isActionButton);
  if (button) {
    const step: PlanStep = {
      action: "click",
      target_element_id: button.id,
      requires_confirmation: button.risk !== undefined,
    };
    if (button.risk) {
      step.confirmation_reason = `"${button.label}" is a ${button.risk.replace("_", " ")} action.`;
    }
    steps.push(step);
    return {
      schema: PLAN_SCHEMA_ID,
      packet_id: packet.packet_id,
      reasoning_summary: `All required fields are filled; "${button.label}" is the primary action.`,
      steps,
      needs_more_context: false,
      confidence: 0.7,
    };
  }

  const disabledButton = packet.elements.find(
    (el) => el.role === "button" && el.state?.disabled === true,
  );
  if (disabledButton) {
    return {
      schema: PLAN_SCHEMA_ID,
      packet_id: packet.packet_id,
      reasoning_summary:
        `The action button "${disabledButton.label ?? disabledButton.id}" is disabled` +
        " and no required field is empty. The page may need a scroll or has" +
        " validation errors not visible in the packet.",
      steps: [
        {
          action: "scroll",
          scroll: { direction: "down", amount: "half" },
          requires_confirmation: false,
        },
      ],
      needs_more_context: true,
      confidence: 0.4,
    };
  }

  return {
    schema: PLAN_SCHEMA_ID,
    packet_id: packet.packet_id,
    reasoning_summary: "No empty required fields and no actionable button found.",
    steps: [{ action: "done", requires_confirmation: false }],
    needs_more_context: false,
    confidence: 0.5,
  };
}
