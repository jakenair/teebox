#!/usr/bin/env node
// Release check: the web revision must be stamped consistently in
//   index.html  <span class="auth-build">rNNN</span>
//   index.html  the three /js/*.js?v=rNNN script tags
//   sw.js       CACHE_VERSION = 'teebox-v1-YYYY-MM-DD-rNNN'
// A mismatch means a fresh page can run against a stale cached script (r353 skew).
import fs from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const html = fs.readFileSync(root + "index.html", "utf8");
const sw = fs.readFileSync(root + "sw.js", "utf8");
const stamp = (html.match(/class="auth-build"[^>]*>(r\d+)</) || [])[1];
const swRev = (sw.match(/CACHE_VERSION = 'teebox-v1-[0-9-]+-(r\d+)'/) || [])[1];
const tags = [...html.matchAll(/<script[^>]+src="\/js\/[a-z-]+\.js(?:\?v=(r\d+))?"/g)].map((m) => m[1] || "(none)");
const bad = !stamp || !swRev || stamp !== swRev || tags.length !== 3 || tags.some((t) => t !== swRev);
console.log(`stamp=${stamp} sw=${swRev} script tags=${tags.join(",")} -> ${bad ? "MISMATCH" : "ok"}`);
process.exit(bad ? 1 : 0);
