# Changes

This file records concise summaries of project work. Add new entries at the top of the log.

## 2026-09-30

### Sequential Questions, File Prompts And Local Detection

- Fixed delayed picker completion: wait for upload progress and enabled Insert/Select controls (including selection counts), inspect accessible nested picker frames, complete the owned picker once, and allow up to 30 seconds for form acknowledgement without re-dispatching file bytes.
- Verified delayed iframe Insert completion for image/PDF uploads and retained Stop cancellation. The browser regression completed successfully in isolated Chrome after a Brave D-Bus process crash interrupted an earlier run.
- Replaced decode-dependent QR masking with finder-geometry localization, harder/inverted scans and repeated-code searches. Dense/damaged codes are masked even if their payload cannot be decoded; unresolved finder evidence fails closed.
- Added QR localization to page captures and an identity-upload field hint: if an Aadhaar/identity upload has no located code, withhold the entire image. The media audit now exposes its pipeline version and identity hint.
- Restored a local original-versus-sanitized comparison, added explicit `website_upload.failure_reason`, respected original image MIME when picker formats are unknown, and bound approval to the sanitized-preview hash.
- Fixed reused-picker visibility checks and duplicate nested uploaded-file rows. Tests verify reopening the picker for the next upload, failure reasons, comparison clearing and identity fallback.
- Added PDF-with-QR browser fixtures: detect QR in vector/scanned PDF pages, verify blacked-out output and typed QR descriptors, upload the exact approved sanitized PDF through a cloud-style iframe picker, and re-open the uploaded PDF to verify no original text or decodable QR remains.
- Fixed post-approval stale upload handling: refresh the reviewed field locally, retry stale snapshots without planner calls, and distinguish dispatched bytes from website acceptance so a removed input does not replay the upload.
- Added owned same-origin dialog/iframe picker handling and uploaded-file-chip perception. Inaccessible pickers fail explicitly instead of entering a stale loop.
- Propagated Stop/navigation cancellation to pending page-side uploads; a delayed picker input cannot receive a file after the task has been cancelled. The iframe browser fixture verifies this boundary.
- Added payload-free `dravika.upload` browser events and Activity export for refresh/retry/dispatch/confirmation failures. New browser coverage injects stale snapshots and checks one approved-file dispatch through a delayed iframe picker.
- Added one post-preview approval before file attachment. The website receives the approved sanitized artifact, never the original; the sidebar records its hash and approval/attachment state. New raster-only PDF uploads contain only the reviewed sanitized page.
- Browser fixtures verify no attachment before approval, rejection leaving the field empty, approval reuse after target re-rendering, and exact approved image/PDF bytes ingested by the form.
- Moved task entry and file/PDF-page selection into dialogs. The sidebar is preview-focused, with automatic sanitized image/JSON output and collapsed diagnostics; removed standalone media upload/send controls and the original-image preview.
- Restored per-question image/PDF/file selection, with inline type/size validation and explicit attachment to the website.
- Kept text, choice and upload questions in page order, one action per plan; upload buttons cannot become the primary submission action.
- Preserved answer memory on same-task retries, remembered public choice labels separately, and kept corrections ahead of original task values.
- Prevented repeated question prompts after re-rendering or rejected answers, and removed shared generic prompt keys that could mix different answers.
- Used CPU/WASM face inference to avoid unavailable GPU-adapter errors. Handled expected barcode decode misses quietly while retaining real failure reporting.
- Expanded QR masks beyond finder centres to cover the entire code; an Aadhaar-plus-QR browser fixture verifies both are blacked out and their values stay off the planner wire.
- Restored the offline planner, increased the client request timeout to 45 seconds, and added connection-recovery messages.

### Verification

- All 251 workspace tests, typechecks and the egress check pass.
- Built-panel Google/Microsoft-style form fixtures verify sequential questions, once-only prompts, image/PDF attachment, re-render/retry reuse and submission consent.
- Browser media checks verify full QR masking, WASM inference without adapter errors, quiet barcode misses, metadata removal and packet-size handling.
- Chrome and Firefox extension bundles rebuilt.
- Latest upload recovery checks: 35 extension tests, extension typecheck, egress check and native/cloud-style picker browser fixtures pass.
- Latest QR/comparison checks: 37 extension tests, typecheck, egress checks, form/iframe picker fixtures and difficult-QR/identity/PDF media fixtures pass; both extension builds regenerated.

## 2026-09-26

### Manual Form Progress And Validation

- Added client-only process memory for user answers across same-origin multi-page form steps, with wipe boundaries for tab, origin, extension, and explicit stop.
- Made re-grounding reuse the same accessible-label resolver as perception so native form inputs do not falsely fail execution.
- Added local native/ARIA validation detection and field-specific corrective prompts without sending browser validation text to the planner.
- Prevented planner actions from overwriting valid filled fields, added no-progress protection, and added local completion counts for filled, required-empty, invalid, and optional fields.
- Added safe action summaries to `plan_sent` logs for manual debugging without logging labels or values.

## 2026-09-25

### Provider-Neutral Planner Runtime

- Replaced the provider-specific planner wiring with a generic configured endpoint contract and strict JSON `ActionPlan` parsing.
- Kept deterministic heuristic planning as the default, with explicit `heuristic`, `auto`, and `model` modes and safe fallback logging.
- Added `npm run dev`, ignored `.env`/`.env.local` loading, and a provider-neutral `.env.example` without committing credentials.
- Added `planner_used` to safe `plan_sent` logs so configured end-to-end runs can be inspected without identifying the backend.
- Updated startup status output to report only generic planner mode, never endpoint or provider details.
- Configured planner responses that fail the action guard now fall back to the deterministic plan instead of stalling the task.
- Included the sanitized packet identifier in configured planner requests so returned plans can pass packet binding.

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
- Defined the recommended Phase 0 demonstration around the Jan Seva form and Dravika side panel rather than a fabricated dashboard.
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
