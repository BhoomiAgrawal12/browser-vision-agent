import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CHROME = process.env.DRAVIKA_BROWSER ?? ['/usr/bin/google-chrome', '/opt/brave.com/brave-origin/brave', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!CHROME) throw new Error('Set DRAVIKA_BROWSER to a Chrome/Brave executable.');
const htmlPath = resolve(process.argv[2]);
const outPath = resolve(process.argv[3]);
const PORT = 9333;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${resolve(HERE, 'chrome-profile-print')}`,
  'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let browser;
for (let i = 0; i < 40; i++) {
  try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, protocolTimeout: 300000 }); break; }
  catch { await sleep(500); }
}
if (!browser) { chrome.kill(); throw new Error('could not connect to Chrome'); }

const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 300000 });
console.log('loaded, waiting for mermaid...');
await page.waitForSelector('body[data-ready="1"]', { timeout: 300000 });

const stats = await page.evaluate(() => {
  const d = [...document.querySelectorAll('.diagram')];
  return { total: d.length, wide: d.filter(x => x.classList.contains('wide')).length,
           withSvg: d.filter(x => x.querySelector('svg')).length };
});
console.log('diagrams:', JSON.stringify(stats));

await page.emulateMediaType('print');
await sleep(1500);

const footer = `
<div style="width:100%;font-size:7pt;color:#8a9099;font-family:-apple-system,Helvetica,Arial,sans-serif;
            padding:0 14mm;display:flex;justify-content:space-between;">
  <span>Dravika &middot; Product and Technical Report</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;

const pdf = await page.pdf({
  path: outPath,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: footer,
  margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
  timeout: 300000,
});
console.log('pdf bytes:', pdf.length);

await page.close();
await browser.disconnect();
chrome.kill();
process.exit(0);
