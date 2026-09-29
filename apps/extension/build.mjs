#!/usr/bin/env node
/**
 * Build both browser targets from one codebase:
 *   dist/chrome   Manifest V3, service worker background, side panel
 *   dist/firefox  Manifest V2, background page, sidebar action
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "dist");

const common = {
  name: "Dravika",
  version: "0.2.0",
  description:
    "Privacy-preserving vision agent: local perception, on-device redaction, placeholder-token planning.",
  icons: {},
  permissions: ["activeTab", "tabs", "storage"],
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["content.js"],
      run_at: "document_idle",
    },
  ],
  // The on-device models run as WebAssembly inside extension pages.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; img-src 'self' blob: data:",
  },
};

const HOSTS = [
  "http://127.0.0.1:8787/*",
  "http://localhost:8787/*",
  "https://forms.cloud.microsoft/*",
  "https://forms.office.com/*",
  "https://forms.office.net/*",
  "https://forms.microsoft.com/*",
  "https://docs.google.com/forms/*",
];

const chromeManifest = {
  manifest_version: 3,
  ...common,
  host_permissions: HOSTS,
  background: { service_worker: "background.js" },
  action: { default_title: "Dravika" },
  side_panel: { default_path: "panel.html" },
  permissions: [...common.permissions, "sidePanel", "scripting"],
};

const firefoxManifest = {
  manifest_version: 2,
  ...common,
  // MV2 takes the CSP as a plain string.
  content_security_policy: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; img-src 'self' blob: data:",
  permissions: [...common.permissions, ...HOSTS],
  background: { scripts: ["background.js"] },
  browser_action: { default_title: "Dravika" },
  sidebar_action: { default_title: "Dravika", default_panel: "panel.html" },
  browser_specific_settings: {
    gecko: { id: "dravika@browser-agent", strict_min_version: "115.0" },
  },
};

rmSync(DIST, { recursive: true, force: true });

for (const [target, manifest] of [
  ["chrome", chromeManifest],
  ["firefox", firefoxManifest],
]) {
  const out = join(DIST, target);
  mkdirSync(out, { recursive: true });

  await build({
    entryPoints: [
      { in: join(HERE, "src/content/content.ts"), out: "content" },
      { in: join(HERE, "src/background/background.ts"), out: "background" },
      { in: join(HERE, "src/panel/panel.ts"), out: "panel" },
    ],
    bundle: true,
    format: "iife",
    target: "es2022",
    outdir: out,
    sourcemap: false,
    minify: false,
    logLevel: "warning",
  });

  await build({ entryPoints: [join(HERE, "src/media/panel.ts")], bundle: true, format: "esm", target: "es2022", outfile: join(out, "media.js"), logLevel: "warning" });
  await build({ entryPoints: [join(HERE, "src/media/pipeline.ts")], bundle: true, format: "esm", target: "es2022", outfile: join(out, "media-pipeline.js"), logLevel: "warning" });
  mkdirSync(join(out, "media"), { recursive: true });
  const mediaAssets = JSON.parse(readFileSync(join(HERE, "media-assets.json"), "utf8"));
  for (const asset of mediaAssets) {
    const source = join(HERE, "../../node_modules", asset.source);
    const bytes = readFileSync(source);
    if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error(`Media asset integrity failed: ${asset.path}`);
    cpSync(source, join(out, asset.path));
  }

  cpSync(join(HERE, "src/panel/panel.html"), join(out, "panel.html"));
  cpSync(join(HERE, "src/panel/panel.css"), join(out, "panel.css"));

  // On-device inference runtime and vendored models.
  const ortDist = join(HERE, "../../node_modules/onnxruntime-web/dist");
  mkdirSync(join(out, "ort"), { recursive: true });
  cpSync(join(ortDist, "ort.webgpu.min.js"), join(out, "ort", "ort.min.js"));
  for (const asset of [
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
  ]) {
    cpSync(join(ortDist, asset), join(out, "ort", asset));
  }
  mkdirSync(join(out, "models"), { recursive: true });
  cpSync(
    join(HERE, "../../packages/perception/models/ultraface-rfb-320.onnx"),
    join(out, "models", "ultraface-rfb-320.onnx"),
  );

  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`built dist/${target}`);
}
