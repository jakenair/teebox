#!/usr/bin/env node
/**
 * scripts/gen-listing-specs.mjs — copy the Sell form's category spec schema
 * (window.SPEC_SCHEMA in js/app-auth.js) and its condition list (index.html
 * #sellCondition) into functions/data/listing-specs.json, so the server-side
 * listing check (functions/lib/listingSchema.js, used by CSV bulk upload and
 * the seller API) validates exactly what the app's Sell form validates.
 *
 *   node scripts/gen-listing-specs.mjs           # write
 *   node scripts/gen-listing-specs.mjs --check   # exit 1 if the JSON is stale
 *
 * The app's source stays the single source of truth; the JSON is generated.
 * functions/test/unit/listingSchema.test.js runs --check, so the two cannot
 * drift silently.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = resolve(ROOT, "js", "app-auth.js");
const HTML = resolve(ROOT, "index.html");
const OUT = resolve(ROOT, "functions", "data", "listing-specs.json");
// Same JSON, served to the bulk-upload page (template + category guide).
const OUT_WEB = resolve(ROOT, "assets", "listing-specs.json");

export function buildSpecs() {
  const src = readFileSync(APP, "utf8");
  // From the rng helper through the end of the SPEC_SCHEMA object literal.
  const start = src.indexOf("const rng = (a, b, st, unit)");
  const schemaAt = src.indexOf("window.SPEC_SCHEMA = {", start);
  const end = src.indexOf("\n  };", schemaAt);
  if (start < 0 || schemaAt < 0 || end < 0) throw new Error("SPEC_SCHEMA block not found in js/app-auth.js");
  const block = src.slice(start, end + 4);
  const sandbox = {window: {}};
  vm.runInNewContext(block, sandbox, {timeout: 1000});
  const schema = sandbox.window.SPEC_SCHEMA;
  if (!schema || !schema.driver) throw new Error("SPEC_SCHEMA did not evaluate");

  const html = readFileSync(HTML, "utf8");
  const sel = html.match(/<select id="sellCondition"[^>]*>([\s\S]*?)<\/select>/);
  if (!sel) throw new Error("#sellCondition not found in index.html");
  const conditions = [...sel[1].matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1].trim());

  const cat = html.match(/<select id="sellCat"[^>]*>([\s\S]*?)<\/select>/);
  if (!cat) throw new Error("#sellCat not found in index.html");
  const browseCats = [...cat[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);

  const categories = {};
  for (const [k, c] of Object.entries(schema)) {
    categories[k] = {
      label: c.label,
      browse: c.browse || "",
      // The box picker is required in the Sell form only. Files and the API
      // may leave it out; the server then works the box out from the listing
      // (lib/shippingParcels classifyClubBox).
      fields: c.fields.map((f) => f.type === "box" ?
        {k: f.k, label: f.label, type: "select", options: ["single", "partial", "full"], req: false} :
        {k: f.k, label: f.label, type: f.type,
          ...(f.options ? {options: f.options.map(String)} : {}), req: !!f.req}),
    };
  }
  return {
    generatedBy: "scripts/gen-listing-specs.mjs",
    source: ["js/app-auth.js (window.SPEC_SCHEMA)", "index.html (#sellCondition, #sellCat)"],
    conditions, browseCats, categories,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const json = JSON.stringify(buildSpecs(), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    let cur = ""; let curWeb = "";
    try { cur = readFileSync(OUT, "utf8"); curWeb = readFileSync(OUT_WEB, "utf8"); } catch (_e) { /* missing */ }
    if (cur !== json || curWeb !== json) {
      console.error("functions/data/listing-specs.json or assets/listing-specs.json is stale — run: node scripts/gen-listing-specs.mjs");
      process.exit(1);
    }
    console.log("listing-specs.json up to date");
  } else {
    writeFileSync(OUT, json);
    writeFileSync(OUT_WEB, json);
    console.log("wrote", OUT, "and", OUT_WEB);
  }
}
