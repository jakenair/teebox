#!/usr/bin/env node
// Generate a transparent-background TeeBox logo PNG for use in emails.
// Source: icon.svg minus the rounded-rect background.
// Output: email-logo.png (300x300 retina-quality, transparent).

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const srcSvg = fs.readFileSync(path.join(ROOT, "icon.svg"), "utf8");

// Drop the background rect + border-stroke rect so the mark is transparent.
// Also drop the bottom shadow ellipse since there's no card behind it now.
const transparentSvg = srcSvg
    .replace(/<rect[^/]*width="512"[^/]*\/>\s*/, "")
    .replace(/<rect[^/]*x="20"[^/]*\/>\s*/, "")
    .replace(/<ellipse[^/]*cx="256"[^/]*cy="426"[^/]*\/>\s*/, "");

const outPath = path.join(ROOT, "email-logo.png");
await sharp(Buffer.from(transparentSvg))
    .resize(300, 300, {fit: "contain", background: {r: 0, g: 0, b: 0, alpha: 0}})
    .png()
    .toFile(outPath);

const stat = fs.statSync(outPath);
console.log(`Wrote ${outPath} (${stat.size} bytes)`);
