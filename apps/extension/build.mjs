#!/usr/bin/env node
/**
 * Build both browser targets from one codebase:
 *   dist/chrome   Manifest V3, service worker background, side panel
 *   dist/firefox  Manifest V2, background page, sidebar action
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "dist");

const common = {
  name: "Kavach",
  version: "0.1.0",
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
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
};

const HOSTS = ["http://127.0.0.1:8787/*", "http://localhost:8787/*"];

const chromeManifest = {
  manifest_version: 3,
  ...common,
  host_permissions: HOSTS,
  background: { service_worker: "background.js" },
  action: { default_title: "Kavach" },
  side_panel: { default_path: "panel.html" },
  permissions: [...common.permissions, "sidePanel"],
};

const firefoxManifest = {
  manifest_version: 2,
  ...common,
  // MV2 takes the CSP as a plain string.
  content_security_policy: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  permissions: [...common.permissions, ...HOSTS],
  background: { scripts: ["background.js"] },
  browser_action: { default_title: "Kavach" },
  sidebar_action: { default_title: "Kavach", default_panel: "panel.html" },
  browser_specific_settings: {
    gecko: { id: "kavach@sih2026", strict_min_version: "115.0" },
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

  cpSync(join(HERE, "src/panel/panel.html"), join(out, "panel.html"));
  cpSync(join(HERE, "src/panel/panel.css"), join(out, "panel.css"));

  // On-device inference runtime and vendored models.
  const ortDist = join(HERE, "../../node_modules/onnxruntime-web/dist");
  mkdirSync(join(out, "ort"), { recursive: true });
  cpSync(join(ortDist, "ort.min.js"), join(out, "ort", "ort.min.js"));
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
