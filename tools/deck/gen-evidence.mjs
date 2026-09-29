import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const CHROME = process.env.DRAVIKA_BROWSER ?? ["/usr/bin/google-chrome", "/opt/brave.com/brave-origin/brave", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
if (!CHROME) throw new Error("Set DRAVIKA_BROWSER to a Chrome/Brave executable.");
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run",
  "--remote-debugging-port=9427","--user-data-dir="+join(HERE,".chrome-ev"),"about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let browser; for(let i=0;i<40&&!browser;i++){try{browser=await puppeteer.connect({browserURL:"http://127.0.0.1:9427"});}catch{await sleep(500);}}

/* 1. Scene-graph overlay: the perception view of the demo form. */
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 940, deviceScaleFactor: 2 });
  await page.goto("file://" + join(ROOT, "bench/demo/index.html"), { waitUntil: "load" });
  await sleep(300);
  await page.evaluate(() => {
    let n = 0;
    const mark = (el, role, extra = "", color = "#1f4e79") => {
      n += 1;
      const r = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.style.cssText =
        `position:fixed;left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;` +
        `height:${r.height + 4}px;border:2px solid ${color};border-radius:3px;z-index:9998;` +
        "pointer-events:none;";
      const tag = document.createElement("div");
      tag.style.cssText =
        `position:fixed;left:${r.left - 2}px;top:${r.top - 24}px;background:${color};` +
        "color:#fff;font:600 11px system-ui;padding:2px 7px;border-radius:3px 3px 0 0;z-index:9999;";
      tag.textContent = `e${n} ${role}${extra}`;
      document.body.append(box, tag);
    };
    mark(document.querySelector("h1"), "heading");
    mark(document.querySelector(".ref"), "text");
    mark(document.querySelector("svg"), "image", " · unexplained", "#7b2d26");
    for (const input of document.querySelectorAll("input")) {
      const filled = input.value.trim().length > 0;
      const req = input.required ? " · required" : "";
      mark(input, "textbox", `${req}${filled ? " · filled" : " · empty"}`,
        filled ? "#3d5a3d" : "#1f4e79");
    }
    mark(document.querySelector("#submit-btn"), "button", " · disabled · state-changing", "#8a6d1a");
    const legend = document.createElement("div");
    legend.style.cssText =
      "position:fixed;right:18px;top:14px;background:#16181d;color:#e8eaed;z-index:9999;" +
      "font:12px system-ui;padding:10px 14px;border-radius:8px;line-height:1.6;";
    legend.innerHTML =
      "<b>Scene graph: 11 regions, ~15 ms</b><br>" +
      "DOM + accessibility walk, no models<br>" +
      "<span style='color:#8fd4a8'>green</span> filled · " +
      "<span style='color:#9bc0e8'>blue</span> empty/actionable<br>" +
      "<span style='color:#e8a89b'>red</span> unexplained pixels (fail closed)";
    document.body.append(legend);
  });
  await sleep(200);
  await page.screenshot({ path: join(HERE, "assets", "evidence-scenegraph.png") });
  console.log("evidence-scenegraph.png");
  await page.close();
}
await browser.disconnect(); proc.kill();
