import type { SanitizedContextPacket } from "@kavach/core/schema";

type PacketElement = SanitizedContextPacket["elements"][number];

function tokensIn(text: string): string[] {
  return [...new Set(text.match(/\bPII:[A-Z0-9_]+#\d+\b/g) ?? [])];
}

function disposition(element: PacketElement): {
  action: string;
  value_in_packet: boolean;
  token?: string;
  category?: string;
} {
  const value = element.value;
  if (!value) return { action: "no_value", value_in_packet: false };
  switch (value.kind) {
    case "empty":
      return { action: "empty_no_value", value_in_packet: false };
    case "filled":
      return { action: "included_as_filled_text", value_in_packet: true };
    case "placeholder":
      return {
        action: "replaced_with_placeholder",
        value_in_packet: false,
        token: value.token,
        category: value.token.slice(0, value.token.lastIndexOf("#")),
      };
    case "redacted":
      return {
        action: "withheld",
        value_in_packet: false,
        ...(value.token
          ? {
              token: value.token,
              category: value.token.slice(0, value.token.lastIndexOf("#")),
            }
          : {}),
      };
    case "unexplained_masked":
      return { action: "masked_fail_closed", value_in_packet: false };
  }
}

/** Local-only explanation of packet dispositions; never include raw values. */
export function buildLocalRedactionAudit(
  packet: SanitizedContextPacket,
  locallyProvidedTaskFieldIds: string[] = [],
) {
  return {
    scope: "LOCAL ONLY — this audit is not sent to the planner.",
    elements: packet.elements.map((element) => ({
      element_id: element.id,
      label: element.label,
      source: element.source,
      box_css_px: element.box,
      evidence: element.evidence,
      ...disposition(element),
    })),
    task_intent: {
      redaction_tokens: tokensIn(packet.task.intent),
      locally_provided_field_ids: locallyProvidedTaskFieldIds,
    },
    untrusted_text: packet.untrusted_text.flatMap((entry) => {
      const redactionTokens = tokensIn(entry.text);
      return redactionTokens.length > 0 ? [{ source_element_id: entry.src, redaction_tokens: redactionTokens }] : [];
    }),
  };
}
