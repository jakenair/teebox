#!/usr/bin/env node
/**
 * scripts/sync-sunday-nine.mjs
 *
 * sunday-nine/categories.js + sunday-nine/engine.js are the ONE authored
 * copy of the Sunday Nine rules (same single-source pattern as
 * bingo-select.mjs). The browser imports them as ES modules; the Cloud
 * Functions codebase is CommonJS, so this script mechanically generates
 * functions/lib/sundayNineCore.js and stamps it with a hash of the sources.
 * The unit test (functions/test/unit/sundayNine.test.js) fails if the stamp
 * is stale, so the server can never score with an older copy of the rules.
 *
 *     node scripts/sync-sunday-nine.mjs          # write
 *     node scripts/sync-sunday-nine.mjs --check  # exit 1 if stale
 * Runs as part of `npm run build:web`.
 */

import {createHash} from "node:crypto";
import {readFileSync, writeFileSync, existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SOURCES = ["sunday-nine/categories.js", "sunday-nine/engine.js"];
const OUT = resolve(ROOT, "functions/lib/sundayNineCore.js");
// The rule schedule the server scores with: a byte copy of the one the
// clients fetch, so the server always scores with the rules it tells them.
const RULES_SRC = resolve(ROOT, "sunday-nine/rules.json");
const RULES_OUT = resolve(ROOT, "functions/data/sunday-nine-rules.json");

export function sourcesHash(texts) {
  const h = createHash("sha256");
  for (const t of texts) h.update(t, "utf8");
  return h.digest("hex").slice(0, 16);
}

export function build() {
  const texts = SOURCES.map((f) => readFileSync(resolve(ROOT, f), "utf8"));
  const names = [];
  const bodies = texts.map((src, i) => src.split("\n").map((line) => {
    if (/^import\s/.test(line)) {
      // Only sibling imports are allowed: both files land in one CommonJS file.
      if (!/from "\.\/categories\.js";$/.test(line)) {
        throw new Error(`${SOURCES[i]}: unsupported import ${line}`);
      }
      return "";
    }
    const m = line.match(/^export (const|function) ([A-Za-z0-9_$]+)/);
    if (m) {
      names.push(m[2]);
      return line.replace(/^export /, "");
    }
    if (/^export\s/.test(line)) throw new Error(`${SOURCES[i]}: unsupported export ${line}`);
    return line;
  }).join("\n"));
  const hash = sourcesHash(texts);
  return "// GENERATED FILE - DO NOT EDIT.\n" +
    "// Built from sunday-nine/categories.js + sunday-nine/engine.js by\n" +
    "// scripts/sync-sunday-nine.mjs. Edit the sources, then re-run it.\n" +
    `// source-sha256: ${hash}\n/* eslint-disable */\n"use strict";\n\n` +
    bodies.join("\n") +
    "\nmodule.exports = {\n" + names.map((n) => `  ${n},`).join("\n") + "\n};\n";
}

function main() {
  const out = build();
  const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const rules = readFileSync(RULES_SRC, "utf8");
  JSON.parse(rules); // fail loudly on a broken rules.json
  const prevRules = existsSync(RULES_OUT) ? readFileSync(RULES_OUT, "utf8") : "";
  if (process.argv.includes("--check")) {
    if (prev !== out) {
      console.error("[sunday-nine] functions/lib/sundayNineCore.js is stale — run node scripts/sync-sunday-nine.mjs");
      process.exit(1);
    }
    if (prevRules !== rules) {
      console.error("[sunday-nine] functions/data/sunday-nine-rules.json differs from sunday-nine/rules.json — run node scripts/sync-sunday-nine.mjs");
      process.exit(1);
    }
    console.log("[sunday-nine] server core and rules current");
    return;
  }
  if (prevRules !== rules) {
    writeFileSync(RULES_OUT, rules);
    console.log("[sunday-nine] wrote functions/data/sunday-nine-rules.json");
  }
  if (prev === out) {
    console.log("[sunday-nine] functions/lib/sundayNineCore.js already current");
    return;
  }
  writeFileSync(OUT, out);
  console.log("[sunday-nine] wrote functions/lib/sundayNineCore.js");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
