import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const src = readFileSync(join(HERE, "../../docs/diagrams/kavach-flow-corrected.mmd"), "utf8");
const mermaidJs = readFileSync(join(HERE, "mermaid.min.js"), "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

writeFileSync(join(HERE, "flow.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;font-family:-apple-system,Helvetica,Arial,sans-serif}
#d{display:inline-block;padding:20px;background:#fff}</style></head><body>
<div id="d"><pre class="mermaid">${esc(src)}</pre></div>
<script>${mermaidJs}</script>
<script>
mermaid.initialize({startOnLoad:false,theme:"base",securityLevel:"loose",
 flowchart:{useMaxWidth:false,htmlLabels:true,curve:"basis"},
 themeVariables:{fontFamily:"-apple-system,Helvetica Neue,Arial,sans-serif",fontSize:"14px",
  primaryColor:"#eef3f8",primaryTextColor:"#16181d",primaryBorderColor:"#1f4e79",
  lineColor:"#5a6470",clusterBkg:"#f7f8fa",clusterBorder:"#c9ced6"}});
mermaid.run({querySelector:"pre.mermaid"}).then(()=>document.body.setAttribute("data-ready","1"));
</script></body></html>`);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run",
  "--remote-debugging-port=9421","--user-data-dir="+join(HERE,".chrome-flow"),"about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let browser; for(let i=0;i<40&&!browser;i++){try{browser=await puppeteer.connect({browserURL:"http://127.0.0.1:9421"});}catch{await sleep(500);}}
const page = await browser.newPage();
await page.setViewport({width:5200,height:2600,deviceScaleFactor:2});
await page.goto("file://"+join(HERE,"flow.html"),{waitUntil:"load"});
await page.waitForSelector('body[data-ready="1"]',{timeout:120000});
await sleep(500);
const el = await page.$("#d");
await el.screenshot({path: join(HERE,"../../docs/diagrams/kavach-flow-corrected.png")});
await browser.disconnect(); proc.kill();
console.log("rendered docs/diagrams/kavach-flow-corrected.png");
