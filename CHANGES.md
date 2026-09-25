# Changes

This file records concise summaries of project work. Add new entries at the top of the log.

## 2026-09-25

### Provider-Neutral Planner Runtime

- Replaced the provider-specific planner wiring with a generic configured endpoint contract and strict JSON `ActionPlan` parsing.
- Kept deterministic heuristic planning as the default, with explicit `heuristic`, `auto`, and `model` modes and safe fallback logging.
- Added `npm run dev`, ignored `.env`/`.env.local` loading, and a provider-neutral `.env.example` without committing credentials.
- Added `planner_used` to safe `plan_sent` logs so configured end-to-end runs can be inspected without identifying the backend.
- Updated startup status output to report only generic planner mode, never endpoint or provider details.
- Configured planner responses that fail the action guard now fall back to the deterministic plan instead of stalling the task.

## 2026-09-25

### Reform Phase 0 Scope Update

- Split `Reform.md` Phase 0 into completed safeguards and remaining product tasks.
- Documented the provider-neutral planner contract, deterministic fallback path, external-only credentials, local startup work, and supported-browser validation boundary.

## 2026-09-25

### Sidebar UI Refresh

- Reworked the extension sidebar into a lighter green-and-white layout with more whitespace, calmer copy, readable two-column metrics, and clearer security checks.
- Added a compact local-first brand header, responsive narrow-sidebar behavior, accessible focus states, and softer cards/dialogs without changing panel behavior or element IDs.

## 2026-09-25

### Phase 0 Guardrails And Automated Coverage

- Made Tier 0 media perception fail closed: images, canvases, videos, and iframes are masked until a vision pass explains their pixels; hidden and `aria-hidden` content is excluded.
- Bound placeholder tokens to their owning packet elements and rejected missing, non-recoverable, or cross-field placeholder use.
- Strengthened browser re-grounding with role, label, geometry, visibility, disabled, and readonly checks; targeted actions now require grounding.
- Wiped the in-memory vault and stopped active work when the active tab changes, navigates, or closes.
- Added a security status checklist to the panel and blocked planner responses containing detected or vault-backed raw PII.
- Added payload-free blocked receipts for schema-invalid attempts; server and transport errors no longer echo response bodies or planner messages.
- Bound the planner server to loopback and added automated `happy-dom` coverage for forms, open shadow roots, hidden content, media masking, action re-grounding, and readonly controls.

### Verification

- `npm test` passed: 186 tests across all workspaces.
- `npm run typecheck` passed.
- `npm run build` passed for Chrome and Firefox bundles.
- `npm run check:egress`, `npm run demo:deblur:selftest`, and `npm run bench` passed.
- Real-browser smoke artifacts were removed; repository tests are automated and do not require human interaction.

## 2026-09-25

### Phase 0 Visual Capture Fix

- Reviewed the live Google Form planner logs and found every Shield request falling back to `visual: false`.
- Fixed `captureVisibleTab` to read the `ImageBitmap` dimensions before closing the bitmap, preventing the browser visual path from throwing and silently degrading to structure-only packets.
- Rebuilt the Chrome and Firefox extension bundles.
- Reverified the full test suite, typecheck, egress scan, and deblur self-test.

## 2026-09-25

### Phase 0 Log Collection

- Updated the log collection with structured, payload-free audit events across schema validation, PII tripwire, vault scan, visual hash, size, rate limiting, receipts, network, and planner response stages.
- The extension Activity panel now displays the egress audit stages and safe metrics.
- The server now emits structured JSON logs for packet receipt, rejection, planner fallback, guarded plans, and successful responses without logging raw packet values.
- Rate-limited requests now produce blocked privacy receipts and audit events.
- Packet receipt byte counts now use UTF-8 byte length.
- Added tests covering audit stage ordering, blocked leak logging, rate-limit receipts, response guards, server event collection, and raw-PII exclusion from logs.

### Verification

- `npm run check:egress` passed.
- `npm test` passed: 177 tests across all workspaces.
- `npm run typecheck` passed.
- `npm run build` passed for Chrome and Firefox extension bundles.
- `npm ci` reported 5 dependency audit findings: 3 moderate, 1 high, and 1 critical.

## 2026-09-25

### Documentation And Planning

- Reviewed the repository architecture, runtime flow, and current implementation status.
- Reviewed `Reform.md`, including the Phase 0 stabilization requirements and later image/PDF roadmap.
- Defined the recommended Phase 0 demonstration around the Jan Seva form and Kavach side panel rather than a fabricated dashboard.
- Recorded the current feature description, PPT guidance, architecture context, and system requirements in the local ignored `output.md` file.

### Local Demo

- Started the demo UI at `http://127.0.0.1:8080/` to verify it served correctly.
- Stopped the demo UI after verification.

### Repository Changes

- Added `output.md` to `.gitignore` so local copyable responses are not committed.
- No application source code was changed.

### Current Phase 0 Status

- Phase 0 dependency installation, tests, typechecking, egress check, and extension build are now verified; Chrome and Firefox browser-driven validation remains.
- Known implementation limitations remain documented in the architecture review and `Reform.md`.
