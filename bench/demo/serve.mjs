#!/usr/bin/env node
/** Serve the demo page: node bench/demo/serve.mjs [port] */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)));
const port = Number(process.argv[2] ?? 8080);

createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(port, () => {
  console.log(`demo form at http://127.0.0.1:${port}/`);
});
