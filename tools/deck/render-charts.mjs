import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run",
  "--remote-debugging-port=9423","--user-data-dir="+join(HERE,".chrome-charts"),"about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let browser; for(let i=0;i<40&&!browser;i++){try{browser=await puppeteer.connect({browserURL:"http://127.0.0.1:9423"});}catch{await sleep(500);}}
const page = await browser.newPage();
await page.setViewport({width:1400,height:2200,deviceScaleFactor:2});
await page.goto("file://"+join(HERE,"charts.html"),{waitUntil:"load"});
await page.waitForSelector('body[data-ready="1"]');
await sleep(300);
for (const id of ["latency","recall"]) {
  const el = await page.$(`#${id}`);
  await el.screenshot({path: join(HERE,"assets",`chart-${id}.png`)});
  console.log(`chart-${id}.png`);
}
await browser.disconnect(); proc.kill();
