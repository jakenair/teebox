// The public /developers docs must match the code that serves the API.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const core = require("../../lib/sellerApiCore");
const config = require("../../lib/sellerApiConfig");
const schema = require("../../lib/listingSchema");

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const html = read("developers/index.html");
const spec = JSON.parse(read("developers/openapi.json"));
const errors = JSON.parse(read("developers/errors.json"));
const src = ["sellerApiCore", "sellerApiKeys"].map((f) => read(`functions/lib/${f}.js`)).join("\n");

// The router's own route names, read from its source.
const routerNames = new Set([...src.matchAll(/return \{name: "([a-z_]+)"/g)].map((m) => m[1]).filter((n) => n !== "method_not_allowed"));
const concrete = (p) => p.replace("{id}", "abc123");
const METHODS = ["get", "post", "put", "patch", "delete"];

test("generated parts are up to date", () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts/gen-seller-api-docs.mjs"), "--check"], {stdio: "pipe"});
});

test("every documented route exists in the router, and the other way round (OpenAPI)", () => {
  const documented = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of METHODS) {
      const r = core.route(m.toUpperCase(), concrete(p));
      if (item[m]) {
        assert.ok(r && r.name !== "method_not_allowed", `${m} ${p} is documented but not routed`);
        assert.equal(item[m].operationId, r.name);
        documented.add(r.name);
      } else {
        assert.ok(!r || r.name === "method_not_allowed", `${m} ${p} is routed but not documented`);
      }
    }
  }
  assert.deepEqual([...documented].sort(), [...routerNames].sort());
});

test("every route has a section and a curl example on the page, and no others", () => {
  const heads = [...html.matchAll(/<h3 id="ep-[a-z]+"><span class="verb">([A-Z]+)<\/span> <code>([^<]+)<\/code><\/h3>([\s\S]*?)(?=<h[23])/g)];
  const names = heads.map(([, verb, p, body]) => {
    assert.match(body, /<pre><code>curl /, `${verb} ${p} needs a curl example`);
    const r = core.route(verb, concrete(p));
    assert.ok(r, `${verb} ${p}`);
    return r.name;
  });
  assert.deepEqual(names.sort(), [...routerNames].sort());
});

test("the quickstart uses the sandbox base URL from config", () => {
  assert.ok(html.includes(`export TEEBOX=${config.SANDBOX_BASE_URL}\n`));
  assert.ok(spec.servers[0].url + "/v1" === config.SANDBOX_BASE_URL);
});

test("curl examples use real routes, and their create bodies pass validation", () => {
  const codes = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  let bodies = 0;
  for (const c of codes) {
    const m = c.match(/curl (?:-X ([A-Z]+) )?"\$TEEBOX([^"]*)"/);
    if (!m) continue;
    const r = core.route(m[1] || "GET", "/v1" + m[2].replace("LISTING_ID", "abc123"));
    assert.ok(r && r.name !== "method_not_allowed", c.slice(0, 80));
    const d = c.match(/-d '([\s\S]*)'/);
    if (!d) continue;
    const body = JSON.parse(d[1]);
    const allowed = {create: core.CREATE_FIELDS, patch: core.PATCH_FIELDS, sandbox_sell: ["quantity"]}[r.name];
    for (const k of Object.keys(body)) assert.ok(allowed.includes(k), k);
    if (r.name === "create") {
      const v = schema.validateListingInput({...body, cat: body.browse_category, photoCount: body.photo_urls.length});
      assert.deepEqual(v.errors, []);
      bodies++;
    }
  }
  assert.equal(bodies, 2);
});

test("every error code the API can return is documented with its status, and no others", () => {
  const inCode = new Set([...src.matchAll(/ApiError\((\d{3}), "([a-z_]+)"/g)].map((m) => `${m[1]} ${m[2]}`));
  // thrown only by the signed-in callables, never by the REST API
  for (const c of ["404 partner_not_found", "404 connection_not_found", "400 consent_required"]) assert.ok(inCode.delete(c), c);
  inCode.add("403 live_not_open"); // thrown by sellerApi.js when it picks the environment
  inCode.add("500 internal");
  assert.deepEqual(errors.map((e) => `${e.status} ${e.code}`).sort(), [...inCode].sort());
  for (const e of errors) assert.ok(html.includes(`<code>${e.code}</code>`), e.code);
});

test("listing fields, statuses and input fields match the code", () => {
  const keys = Object.keys(core.serializeListing("x", {}, config.resolve("test", {}), null)).sort();
  assert.deepEqual(Object.keys(spec.components.schemas.Listing.properties).sort(), keys);
  for (const k of keys) assert.ok(html.includes(`<code>${k}</code>`), "field on the page: " + k);
  for (const s of core.API_STATUSES) assert.ok(html.includes(`<td><code>${s}</code></td>`), "status on the page: " + s);
  assert.deepEqual(Object.keys(spec.components.schemas.ListingCreate.properties), core.CREATE_FIELDS);
  assert.deepEqual(Object.keys(spec.components.schemas.ListingUpdate.properties), core.PATCH_FIELDS);
});

test("the page: sandbox open and live marked not open, no emoji, no real-looking keys, no money endpoints", () => {
  assert.match(html, /The sandbox is open/);
  assert.match(html, /The live API is not open yet/);
  assert.equal(config.LIVE_API_ENABLED, false);
  assert.doesNotMatch(html, /(?![©®™])\p{Extended_Pictographic}/u);
  for (const t of [html, JSON.stringify(spec), JSON.stringify(errors)]) assert.doesNotMatch(t, /(pk|sk_conn)_(live|test)_[0-9A-Za-z]{43}/);
  for (const p of Object.keys(spec.paths)) assert.doesNotMatch(p, /order|pay|refund|transfer|stripe|buyer/i);
  assert.match(html, /A listing that returns 404 has been removed from TeeBox\. Delist it on your side\./);
});
