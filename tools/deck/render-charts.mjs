import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CHROME = process.env.DRAVIKA_BROWSER ?? ["/usr/bin/google-chrome", "/opt/brave.com/brave-origin/brave", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
if (!CHROME) throw new Error("Set DRAVIKA_BROWSER to a Chrome/Brave executable.");
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run",
  "--remote-debugging-port=9423","--user-data-dir="+join(HERE,".chrome-charts"),"about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let browser; for(let i=0;i<40&&!browser;i++){try{browser=await puppeteer.connect({browserURL:"http://127.0.0.1:9423"});}catch{await sleep(500);}}
const page = await browser.newPage();
await page.setViewport({width:1400,height:2200,deviceScaleFactor:2});
const ROOT = join(HERE, "..", "..");
const latencyMd = readFileSync(join(ROOT, "bench/LATENCY.md"), "utf8");
const resultsMd = readFileSync(join(ROOT, "bench/RESULTS.md"), "utf8");
const latencyRows = [...latencyMd.matchAll(/^\| (.+?) \|\s*([\d.]+) \|\s*([\d.]+) \|\s*(\d+) \|$/gm)]
  .map((m) => ({ name: m[1], p50: Number(m[2]), p95: Number(m[3]) }));
const shield = resultsMd.split("## Mode: shield")[1]?.split("## Mode: fortress")[0] ?? "";
const recallRows = [...shield.matchAll(/^\| ([A-Z_]+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| ([\d.]+)% \| ([\d.]+)% \| ([\d.]+)% \|$/gm)]
  .map((m) => ({ name: m[1], support: Number(m[2]), recall: Number(m[7]) }));
if (latencyRows.length === 0 || recallRows.length === 0) throw new Error("Could not parse bench/LATENCY.md and bench/RESULTS.md");
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const latencyHeader = escape(latencyMd.split("\n")[2] ?? "Measured local stages");
const latencySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="760" viewBox="0 0 1400 760" style="font-family:Arial,sans-serif;background:white">
  <text x="24" y="42" font-size="27" font-weight="bold" fill="#16181d">Local pipeline latency by stage</text>
  <text x="24" y="70" font-size="15" fill="#5a6470">${latencyHeader}</text>
  <rect x="1060" y="91" width="16" height="16" fill="#1f4e79"/><text x="1082" y="105" font-size="14" fill="#16181d">p50</text>
  <rect x="1150" y="91" width="16" height="16" fill="#9fb4cb"/><text x="1172" y="105" font-size="14" fill="#16181d">p95</text>
  ${latencyRows.map((r, i) => {
    const y = 140 + i * 79;
    const x = 465;
    const scale = 10;
    return `<text x="440" y="${y + 18}" text-anchor="end" font-size="16" fill="#16181d">${escape(r.name)}</text>
      <rect x="${x}" y="${y}" width="${r.p50 * scale}" height="22" rx="3" fill="#1f4e79"/>
      <rect x="${x}" y="${y + 27}" width="${r.p95 * scale}" height="15" rx="3" fill="#9fb4cb"/>
      <text x="${x + r.p95 * scale + 8}" y="${y + 20}" font-size="13" fill="#16181d">${r.p50.toFixed(2)} / ${r.p95.toFixed(2)} ms</text>`;
  }).join("")}
  <text x="465" y="720" font-size="14" fill="#5a6470">Each stage shows p50 (top) and p95 (bottom); single-thread WASM measurement.</text>
</svg>`;
const recallSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="${Math.max(1180, 145 + recallRows.length * 54)}" viewBox="0 0 1400 ${Math.max(1180, 145 + recallRows.length * 54)}" style="font-family:Arial,sans-serif;background:white">
  <text x="24" y="42" font-size="27" font-weight="bold" fill="#16181d">Shield detection recall by PII class</text>
  <text x="24" y="70" font-size="15" fill="#5a6470">RedactBench-Web · 18 synthetic captures · 55 annotated positives</text>
  ${[0, 25, 50, 75, 100].map((tick) => `<line x1="${430 + tick * 7.6}" y1="100" x2="${430 + tick * 7.6}" y2="${110 + recallRows.length * 54}" stroke="#e3e6ea"/><text x="${430 + tick * 7.6}" y="96" text-anchor="middle" font-size="13" fill="#5a6470">${tick}%</text>`).join("")}
  ${recallRows.map((r, i) => {
    const y = 113 + i * 54;
    const color = r.recall >= 95 ? "#3d5a3d" : r.recall >= 75 ? "#b48628" : "#7b2d26";
    return `<text x="405" y="${y + 22}" text-anchor="end" font-size="16" fill="#16181d">${escape(r.name)}</text>
      <rect x="430" y="${y}" width="${r.recall * 7.6}" height="28" rx="3" fill="${color}"/>
      <text x="1205" y="${y + 21}" font-size="15" fill="#16181d">${r.recall.toFixed(1)}% · n=${r.support}</text>`;
  }).join("")}
  <text x="24" y="${Math.max(1180, 145 + recallRows.length * 54) - 18}" font-size="14" fill="#5a6470">Misses are published: free-text address, obfuscated email, and context-dependent DOB.</text>
</svg>`;
await page.setContent(`<!doctype html><html><body style="margin:0;background:white"><div id="latency">${latencySvg}</div><div id="recall">${recallSvg}</div></body></html>`, { waitUntil: "load" });
await page.evaluate(() => document.body.setAttribute("data-ready", "1"));
await page.waitForSelector('body[data-ready="1"]');
await sleep(300);
for (const id of ["latency","recall"]) {
  const el = await page.$(`#${id}`);
  await el.screenshot({path: join(HERE,"assets",`chart-${id}.png`)});
  console.log(`chart-${id}.png`);
}
await browser.disconnect(); proc.kill();
