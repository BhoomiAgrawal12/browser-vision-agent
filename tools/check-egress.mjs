#!/usr/bin/env node
/**
 * The single-door rule, enforced: fetch, XMLHttpRequest and WebSocket may
 * appear only in the allowlisted transport modules. Anywhere else in
 * packages/ or apps/ fails the build.
 *
 * Run: node tools/check-egress.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const ALLOWLIST = new Set([
  "apps/extension/src/transport.ts",
  "apps/server/src/planner/ollama.ts",
]);

const BANNED = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bnew\s+WebSocket\b/,
  /\bnavigator\.sendBeacon\b/,
];

const SCAN_DIRS = ["packages", "apps"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if ([...EXTENSIONS].some((e) => name.endsWith(e))) yield full;
  }
}

const violations = [];
for (const dir of SCAN_DIRS) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  for (const file of walk(base)) {
    const rel = relative(ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    if (rel.endsWith(".test.ts")) continue;
    // Strip comments: documenting the banned APIs is not calling them.
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const pattern of BANNED) {
      const m = pattern.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split("\n").length;
        violations.push(`${rel}:${line} uses ${m[0].trim()} outside the egress allowlist`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Egress rule violations:\n" + violations.map((v) => "  " + v).join("\n"));
  console.error("\nOnly the allowlisted transport modules may touch the network.");
  process.exit(1);
}
console.log("egress check passed: no network calls outside the allowlist");
