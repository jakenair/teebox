#!/usr/bin/env node
/**
 * scripts/sync-bingo-select.mjs
 *
 * /bingo-select.mjs is the ONE authored implementation of the Logo Bingo
 * board algorithm. The web client and the iOS bundle import it directly as
 * ESM. The Cloud Functions codebase is CommonJS and calls it synchronously
 * (bingoSync, bingoCrossPlatformMonitor), so it cannot `await import()` it.
 *
 * Rather than let someone hand-maintain a second copy — which is exactly how
 * the 2026-10-01 divergence survived, with the parity test comparing the
 * server against its own third copy — this script MECHANICALLY generates the
 * CommonJS build at functions/lib/bingoSelect.js and stamps it with a hash of
 * the source. scripts/check-bingo-single-source.mjs fails the build if the
 * stamp doesn't match, so the generated file can never silently fall behind.
 *
 * Run it after editing bingo-select.mjs:
 *     node scripts/sync-bingo-select.mjs
 * It also runs as part of `npm run build:web`.
 */

import {createHash} from "node:crypto";
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "bingo-select.mjs");
const OUT = resolve(ROOT, "functions/lib/bingoSelect.js");

export function sourceHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function toCommonJS(src) {
  const names = [];
  const body = src
      .split("\n")
      .map((line) => {
        let m = line.match(/^export const ([A-Za-z0-9_$]+)/);
        if (m) {
          names.push(m[1]);
          return line.replace(/^export /, "");
        }
        m = line.match(/^export function ([A-Za-z0-9_$]+)/);
        if (m) {
          names.push(m[1]);
          return line.replace(/^export /, "");
        }
        if (/^export\s/.test(line)) {
          throw new Error(
              `unsupported export form, teach this script about it: ${line}`);
        }
        return line;
      })
      .join("\n");

  if (!names.length) throw new Error("no exports found in bingo-select.mjs");

  const header =
    "// GENERATED FILE - DO NOT EDIT.\n" +
    "// Built from /bingo-select.mjs by scripts/sync-bingo-select.mjs.\n" +
    "// Edit the source, then re-run that script (or `npm run build:web`).\n" +
    `// source-sha256: ${sourceHash(src)}\n\n`;

  const footer =
    "\nmodule.exports = {\n" +
    names.map((n) => `  ${n},`).join("\n") +
    "\n};\n";

  return header + body + footer;
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`[bingo-select] missing source: ${SRC}`);
    process.exit(2);
  }
  const src = readFileSync(SRC, "utf8");
  const out = toCommonJS(src);
  mkdirSync(dirname(OUT), {recursive: true});
  const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (prev === out) {
    console.log(`[bingo-select] functions/lib/bingoSelect.js already current ` +
      `(source ${sourceHash(src)})`);
    return;
  }
  writeFileSync(OUT, out);
  console.log(`[bingo-select] wrote functions/lib/bingoSelect.js ` +
    `(source ${sourceHash(src)})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
