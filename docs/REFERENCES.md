# References

Citation list for the Kavach SIH 2026 deck: every external model, runtime, algorithm, prior-art project, security paper, and tool the project uses or is directly built on.

## A. On-device model and weights

- [UltraFace version-RFB-320 (onnx/models, validated)](https://github.com/onnx/models/tree/main/validated/vision/body_analysis/ultraface) - used for: the vendored 1.2 MB face-detection ONNX model, pinned by SHA-256 in `packages/perception/models/`.
- [Ultra-Light-Fast-Generic-Face-Detector-1MB (Linzaer)](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) - used for: upstream project and MIT licence of the UltraFace weights.

## B. Inference and browser runtimes

- [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) - used for: running UltraFace in the browser (WebGPU with WASM fallback) via the `onnxruntime-web` package.
- [W3C WebGPU specification](https://www.w3.org/TR/webgpu/) - used for: the GPU compute API targeted by the primary inference path.
- [WebGPU implementation status (gpuweb wiki)](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) - used for: tracking which browsers can take the GPU path today.
- [chrome.sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) - used for: hosting the agent UI beside the page in Chrome MV3.
- [chrome.tabs.captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab) - used for: capturing the visible tab as pixels for local perception.
- [chrome.offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) - used for: off-DOM documents where MV3 service workers cannot run canvas/inference work.
- [Offscreen Documents in Manifest V3 (Chrome blog)](https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3) - used for: the design rationale behind the offscreen capture/redaction pipeline.
- [MDN WebExtensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) - used for: the cross-browser extension API surface that lets one codebase target Chrome and Firefox.

## C. Algorithms and standards implemented

- [Verhoeff algorithm](https://en.wikipedia.org/wiki/Verhoeff_algorithm) - used for: hand-implemented dihedral-group checksum that validates Aadhaar numbers in `packages/core/src/detectors/checksums.ts`.
- [Luhn algorithm](https://en.wikipedia.org/wiki/Luhn_algorithm) - used for: hand-implemented check-digit validation for payment card numbers.
- [Goods and Services Tax (India) — GSTIN format](https://en.wikipedia.org/wiki/Goods_and_Services_Tax_(India)) - used for: the GSTIN structure whose mod-36 check character is implemented in `gstinCheckChar`.
- [UIDAI (Unique Identification Authority of India)](https://uidai.gov.in/) - used for: authoritative context on the Aadhaar numbering scheme the Verhoeff detector targets.
- [MDN accessibility tree glossary](https://developer.mozilla.org/en-US/docs/Glossary/Accessibility_tree) - used for: the DOM-side semantic signal fused with vision output.
- [MDN autocomplete attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete) - used for: field-purpose hints that mark inputs as sensitive before pixels leave the device.
- [WCAG 2.1 Technique H98 (autocomplete)](https://www.w3.org/WAI/WCAG21/Techniques/html/H98) - used for: the standardised input-purpose taxonomy behind the DOM PII heuristics.

## D. Prior art studied (not shipped)

- [Microsoft OmniParser](https://github.com/microsoft/OmniParser) - used for: studying screenshot-to-structure GUI parsing; rejected for licence and size.
- [OmniParser V2 model card](https://huggingface.co/microsoft/OmniParser-v2.0) - used for: the concrete model and licence terms evaluated.
- [Microsoft Presidio image redactor](https://microsoft.github.io/presidio/image-redactor/) - used for: the reference architecture for detect-then-mask image redaction.
- [browser-use](https://github.com/browser-use/browser-use) - used for: studying the dominant DOM-first browser-agent design and its privacy gaps.
- [Nanobrowser](https://github.com/nanobrowser/nanobrowser) - used for: studying an open-source in-extension multi-agent browser automation design.
- [ScreenSpot-Pro benchmark](https://github.com/likaixin2000/ScreenSpot-Pro-GUI-Grounding) - used for: the GUI-grounding benchmark framing our vision-accuracy expectations.
- [UI-TARS paper](https://arxiv.org/pdf/2501.12326) - used for: the state of the art in end-to-end GUI agent models we deliberately do not compete with.
- [privacy-focused-browser-agent](https://github.com/Rohinth-S/privacy-focused-browser-agent) - used for: the nearest prior art to this exact problem statement.

## E. Security research informing the design

- [SnapGuard](https://arxiv.org/pdf/2604.25562) - used for: prompt-injection detection patterns for screenshot-based web agents.
- [Prismata](https://arxiv.org/pdf/2607.08147) - used for: confining cross-site prompt injection, informing the planner output guard.
- [AgentSecBench](https://arxiv.org/abs/2605.26269) - used for: the threat taxonomy our egress gate and re-scan defend against.
- [Observable channels: privacy leakage in LLM agent pipelines](https://arxiv.org/pdf/2603.22751) - used for: the leakage-channel analysis behind the single-egress-gate design.
- [Agents that know too much (privacy survey)](https://arxiv.org/pdf/2606.26627) - used for: the data-centric view of agent privacy that shaped the Sanitized Context Packet.
- [Indirect prompt injection in the wild](https://arxiv.org/pdf/2604.27202) - used for: real-world injection evidence motivating server-side output guarding.

## F. Development tooling

- [zod](https://zod.dev/) - used for: runtime validation of the Sanitized Context Packet wire schemas in core and server.
- [TypeScript](https://www.typescriptlang.org/) - used for: the language of every workspace, strict mode throughout.
- [Vitest](https://vitest.dev/) - used for: the unit and property test runner across all packages.
- [esbuild](https://esbuild.github.io/) - used for: bundling the extension for Chrome MV3 and Firefox from one codebase.
- [tsx](https://tsx.is/) - used for: running the TypeScript planner server and bench harness directly under Node.
- [PptxGenJS](https://github.com/gitbrent/PptxGenJS) - used for: generating the SIH pitch deck programmatically in `tools/deck`.
- [Mermaid](https://mermaid.js.org/) - used for: rendering the architecture flowcharts embedded in the report and deck.
- [puppeteer-core](https://pptr.dev/) - used for: headless Chrome rendering of Mermaid diagrams and the report PDF.
- [marked](https://marked.js.org/) - used for: Markdown-to-HTML conversion in the report PDF build.
