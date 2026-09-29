# Dravika — Solution Video Script

**Target runtime:** 4:00
**Spoken-word target:** approximately 560–590 words at 140–150 words per minute
**Format:** timed segments with storyboard cues

---

## Segment 1 — The privacy problem (0:00–0:30)

**On screen:** A person fills out an online form. Name, ID, email, phone, and a profile photo highlight in turn.

> Picture this: you are filling out a form online. Your name, ID, email, phone number—and maybe your face—are right there on the page. An AI helper can only assist if it understands what it sees. But send the whole page to a remote server, and private information goes with it. Strip everything away, and the AI goes blind.
>
> Dravika is built to solve that tension: give the agent enough context to act, without handing over the raw screen.

## Segment 2 — What existing approaches miss (0:30–1:00)

**On screen:** Compare a screenshot sent to a cloud model, a DOM-only list of controls, and a blurred page. Each has a limitation highlighted.

> Cloud-first browser agents can be capable, but they often send page content or screenshots to a remote model. Structure-only agents understand buttons and fields, but can miss information visible only in pixels. Standalone redaction tools can hide sensitive areas, but a black box leaves the planner guessing what was removed.
>
> And blur is not a reliable privacy boundary. Dravika removes the value while preserving its meaning: a typed placeholder tells the planner what kind of information is missing, not what it was.

## Segment 3 — Local perception and redaction (1:00–1:55)

**On screen:** A page becomes a DOM/accessibility map. Show a face detector, the Shield/Fortress/Wireframe selector, a placeholder, and a flat-filled visual region.

> Open a page, describe a task, and choose a privacy mode. Dravika reads the DOM and accessibility tree on your device. When pixels are needed, a small face detector can run locally through WebGPU, with a WASM fallback.
>
> Shield protects high-risk information. Fortress applies a stricter policy. Wireframe sends zero pixels—only the structure of the page and its controls. Sensitive values become typed placeholders, such as “PII:EMAIL number one.” Sensitive pixels are flat-filled on a fresh canvas, never blurred. If the system cannot explain a visual region, it masks that region by default.
>
> Values you provide in the task can be matched to fields locally and kept in the session vault. Detection combines field hints, validators, and pattern checks, including checks across text split between nearby page elements.

## Segment 4 — A guarded plan, one step at a time (1:55–2:45)

**On screen:** Show the sanitized packet and redaction legend. A planner returns an element ID; Dravika rechecks the page, fills one field, and perceives again.

> Before anything leaves, Dravika builds a versioned Sanitized Context Packet. It keeps useful structure—roles, safe labels, field states, and redaction evidence—while replacing protected values. The redaction legend tells the planner what each token means.
>
> The planner returns actions that name page elements, not screen coordinates. Before each action, Dravika checks that the target is still the element it described. If the page changes, it perceives again instead of blindly clicking.
>
> Form filling happens one answer at a time, with a fresh check after each input. Microsoft Forms question titles and ARIA text, radio, and choice controls enter the same loop. If a date or other value fails validation, Dravika shows the form’s own error and advice in the side panel, then waits for a correction instead of moving ahead.

## Segment 5 — The proof in the interface (2:45–3:35)

**On screen:** Run a task on a form. Show `server_packet` beside `local_redaction_audit`, then the activity log, privacy receipt, and redacted visual preview.

> Here is Dravika in action. The planner packet shows placeholders where values were removed. Beside it, the local-only audit shows which page elements were redacted, where they were, and whether text is included in the packet—without copying field values into the audit. Only `server_packet` is sent; the audit stays in this browser.
>
> Every outbound packet passes through one gate: schema validation, a fresh sensitive-data scan, and a vault-leak check. A failed check blocks the send. Each successful request leaves a privacy receipt with its outcome and transmission details.
>
> End-to-end tests check that sample raw PII is absent from outbound packets while typed placeholders and their redaction legend remain.

## Segment 6 — The close (3:35–4:00)

**On screen:** Show Wireframe mode completing a form with no image field in the packet. Finish on Dravika’s tagline and Chrome/Firefox icons.

> Dravika gives an AI helper useful context without giving it the raw page. Perception and sensitive values stay local; the planner gets a clear, redaction-aware view; and every action is checked before it runs.
>
> **Dravika: a local eye, a remote planner, and a guarded boundary.**

**End card:** *Dravika — Useful automation. Privacy by design.*
