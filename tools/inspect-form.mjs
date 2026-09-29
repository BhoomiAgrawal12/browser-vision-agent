#!/usr/bin/env node
// Read-only diagnostic using the built content script in an isolated browser.
// Reports control metadata only, never current field values. Does not submit.
import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) throw new Error("Usage: node tools/inspect-form.mjs <form-url>");
const executablePath = process.env.DRAVIKA_BROWSER ?? ["/opt/brave.com/brave-origin/brave", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(2500);
  const start = page.getByRole("button", { name: "Start now", exact: true });
  if (await start.isVisible()) { await start.click(); await page.waitForTimeout(2500); }
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.listener = fn; }, removeListener: () => {} } } };
  });
  // CDP evaluation avoids page script-tag Trusted Types restrictions, just as
  // the extension's isolated-world content script does.
  await page.evaluate(readFileSync(fileURLToPath(new URL("../apps/extension/dist/chrome/content.js", import.meta.url)), "utf8"));
  const metadata = await page.evaluate(async () => {
    const result = await new Promise((resolve) => window.listener({ type: "perceive" }, {}, resolve));
    if (!result.ok) throw new Error(result.error);
    return result.regions.filter((r) => r.control).map((r) => ({ id: r.id, role: r.role, label: r.label, required: r.state.required, invalid: r.state.invalid, kind: r.control.kind, inputType: r.control.inputType }));
  });
  console.log(JSON.stringify(metadata, null, 2));
} finally {
  await browser.close();
}
