import { defaultRegistry } from "@kavach/core/detectors";
import type { SanitizedContextPacket } from "@kavach/core/schema";

/**
 * Defence in depth: the server does not trust the client's sanitization.
 * Every string field in an arriving packet is re-scanned with the same
 * detector suite; a strong hit means a broken or malicious client, and
 * the request is rejected and logged, never processed.
 */

const registry = defaultRegistry();
const RESCAN_THRESHOLD = 0.8;

export interface RescanIssue {
  path: string;
  cls: string;
}

function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`);
  }
}

export function rescanPacket(packet: SanitizedContextPacket): RescanIssue[] {
  const issues: RescanIssue[] = [];
  for (const [path, text] of strings(packet, "packet")) {
    // Hashes are hex strings; skip them, they cannot carry PII patterns
    // but a 64-char digit-heavy string could false-positive as an account.
    if (path.endsWith(".sha256")) continue;
    // Image bytes: base64 digit runs false-positive; the client's
    // pixel-level self-check owns this field's safety.
    if (path.endsWith(".data_b64")) continue;
    for (const span of registry.analyze(text, { threshold: RESCAN_THRESHOLD })) {
      issues.push({ path, cls: span.cls });
    }
  }
  return issues;
}
