#!/usr/bin/env node
// Builds the generated parts of the public Seller API docs from the code that
// serves the API, so the docs can't drift from it:
//   developers/openapi.json                      (whole file)
//   developers/index.html  <!-- gen:NAME -->...  (tables)
//
//   node scripts/gen-seller-api-docs.mjs          write
//   node scripts/gen-seller-api-docs.mjs --check  exit 1 if out of date (unit test)
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const FN = path.join(ROOT, "functions");
const core = require(path.join(FN, "lib/sellerApiCore"));
const config = require(path.join(FN, "lib/sellerApiConfig"));
const schema = require(path.join(FN, "lib/listingSchema"));
const lc = require(path.join(FN, "lib/listingCreate"));
const ERRORS = JSON.parse(fs.readFileSync(path.join(ROOT, "developers/errors.json"), "utf8"));

const live = config.resolve("live", {GCLOUD_PROJECT: config.LIVE_PROJECT});
const sandbox = config.resolve("test", {GCLOUD_PROJECT: config.LIVE_PROJECT});
const L = config.LIMITS;
const cats = core.serializeCategories();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── OpenAPI ────────────────────────────────────────────────────────────────
const str = (o) => ({type: "string", ...o});
const nullable = (o) => ({...o, type: [o.type, "null"]});
const int = (o) => ({type: "integer", ...o});
const time = {type: "string", format: "date-time"};
const ref = (n) => ({$ref: `#/components/schemas/${n}`});
const json = (schemaObj) => ({content: {"application/json": {schema: schemaObj}}});
const errorsFor = (...statuses) => Object.fromEntries(statuses.map((s) => [String(s), {
  description: "Codes: " + ERRORS.filter((e) => e.status === s).map((e) => e.code).join(", "), ...json(ref("Error"))}]));
const COMMON = [401, 403, 429, 500];
const idParam = {name: "id", in: "path", required: true, schema: str({})};
const withId = (o) => ({type: "object", properties: {...o, request_id: str({})}});

const listingProps = {
  id: str({}), url: nullable(str({description: "Public page. null in the sandbox."})),
  status: str({enum: core.API_STATUSES}), title: str({}), brand: str({}),
  category: nullable(str({})), browse_category: nullable(str({})), condition: str({enum: cats.conditions}),
  price: {type: "number"}, currency: str({const: "USD"}),
  quantity: int({description: "Total units, including sold ones."}), quantity_sold: int({}),
  quantity_available: int({description: "0 unless status is active."}),
  description: str({}), specs: {type: "object", additionalProperties: str({})},
  photos: {type: "array", items: str({format: "uri"})},
  created_at: {...time, type: ["string", "null"]}, updated_at: time, expires_at: {...time, type: ["string", "null"]},
  sold_at: {...time, type: ["string", "null"]}, ended_at: {...time, type: ["string", "null"]},
  created_via: str({enum: ["api", "csv", "teebox"]}), created_by_you: {type: "boolean"},
};
const inputProps = {
  title: str({maxLength: cats.rules.title_max}), brand: str({maxLength: cats.rules.brand_max}),
  category: str({enum: cats.categories.map((c) => c.id)}),
  browse_category: str({enum: cats.browse_categories, description: "Only for category other."}),
  condition: str({enum: cats.conditions}),
  price: {type: "number", minimum: cats.rules.price_min, description: "US dollars, at most 2 decimals."},
  quantity: int({minimum: 1, maximum: cats.rules.quantity_max}),
  quantity_available: int({minimum: 0, description: "Units still for sale. 0 on its own ends the listing."}),
  description: str({maxLength: cats.rules.description_max}),
  specs: {type: "object", additionalProperties: str({})},
  photo_urls: {type: "array", maxItems: L.photoUrlsMax, items: str({format: "uri"})},
};
const pick = (keys) => Object.fromEntries(keys.map((k) => [k, inputProps[k]]));
const photoErrors = {type: "array", items: {type: "object", properties: {index: int({}), url: {type: ["string", "null"]}, message: str({})}}};
const listingOut = {...withId({listing: ref("Listing"), photo_errors: photoErrors})};

const openapi = {
  openapi: "3.1.0",
  info: {title: "TeeBox Seller API", version: "1.0.0",
    description: "List, update and end a seller's items on TeeBox. Neither environment is open yet. No payment, payout, refund or order endpoints exist."},
  servers: [{url: sandbox.baseUrl.replace(/\/v1$/, ""), description: "Sandbox (open; test keys on request)"},
    {url: live.baseUrl.replace(/\/v1$/, ""), description: "Live (not open yet)"}],
  security: [{partnerKey: [], connectionKey: []}],
  paths: {
    "/v1/me": {get: {operationId: "me", summary: "Who this connection is", responses: {200: {description: "OK",
      ...json(withId({environment: str({enum: ["live", "sandbox"]}),
        partner: {type: "object", properties: {id: str({}), name: str({})}},
        seller: {type: "object", properties: {display_name: {type: ["string", "null"]}, can_list: {type: "boolean"},
          cannot_list_reason: {type: ["object", "null"], properties: {code: str({}), message: str({})}},
          payouts_ready: {type: "boolean"}, daily_listing_limit: int({}), listings_created_today: int({}),
          daily_limit_resets_at: {...time, type: ["string", "null"]}}}}))}, ...errorsFor(...COMMON)}}},
    "/v1/categories": {get: {operationId: "categories", summary: "Categories, spec fields and listing rules",
      responses: {200: {description: "OK", ...json(withId({conditions: {type: "array", items: str({})},
        browse_categories: {type: "array", items: str({})},
        categories: {type: "array", items: {type: "object", properties: {id: str({}), label: str({}),
          browse_category: {type: ["string", "null"]}, requires_browse_category: {type: "boolean"},
          fields: {type: "array", items: {type: "object", properties: {key: str({}), label: str({}),
            type: str({enum: ["select", "text"]}), required: {type: "boolean"}, options: {type: "array", items: str({})}}}}}}},
        rules: {type: "object"}}))}, ...errorsFor(...COMMON)}}},
    "/v1/listings": {
      get: {operationId: "list", summary: "List the seller's listings, oldest change first", parameters: [
        {name: "updated_since", in: "query", schema: time},
        {name: "status", in: "query", description: "Comma-separated: " + core.API_STATUSES.join(", "), schema: str({})},
        {name: "limit", in: "query", schema: int({minimum: 1, maximum: L.listPageMax, default: L.listPageDefault})},
        {name: "cursor", in: "query", schema: str({})}],
      responses: {200: {description: "OK", ...json(withId({data: {type: "array", items: ref("Listing")},
        has_more: {type: "boolean"}, next_cursor: {type: ["string", "null"]}}))}, ...errorsFor(400, ...COMMON)}},
      post: {operationId: "create", summary: "Create a listing", parameters: [
        {name: "Idempotency-Key", in: "header", schema: str({maxLength: 255})}],
      requestBody: {required: true, ...json(ref("ListingCreate"))},
      responses: {201: {description: "Created", ...json(listingOut)}, ...errorsFor(400, 409, 422, ...COMMON)}},
    },
    "/v1/listings/{id}": {
      parameters: [idParam],
      get: {operationId: "get", summary: "Get one listing", responses: {200: {description: "OK", ...json(withId({listing: ref("Listing")}))}, ...errorsFor(404, ...COMMON)}},
      patch: {operationId: "patch", summary: "Edit a listing or sync its quantity", requestBody: {required: true, ...json(ref("ListingUpdate"))},
        responses: {200: {description: "OK", ...json(listingOut)}, ...errorsFor(400, 404, 409, 422, ...COMMON)}},
    },
    "/v1/listings/{id}/end": {parameters: [idParam], post: {operationId: "end", summary: "End a listing",
      responses: {200: {description: "OK", ...json(withId({listing: ref("Listing"), already_ended: {type: "boolean"}}))}, ...errorsFor(404, 409, ...COMMON)}}},
    "/v1/sandbox/listings/{id}/sell": {parameters: [idParam], post: {operationId: "sandbox_sell", summary: "Sandbox only: mark units sold",
      requestBody: {required: false, ...json({type: "object", additionalProperties: false, properties: {quantity: int({minimum: 1, default: 1})}})},
      responses: {200: {description: "OK", ...json(withId({listing: ref("Listing")}))}, ...errorsFor(400, 404, 409, 422, ...COMMON)}}},
  },
  components: {
    securitySchemes: {
      partnerKey: {type: "apiKey", in: "header", name: "X-TeeBox-Partner-Key"},
      connectionKey: {type: "http", scheme: "bearer", description: "The seller's connection key."},
    },
    schemas: {
      Listing: {type: "object", properties: listingProps},
      ListingCreate: {type: "object", additionalProperties: false, properties: pick(core.CREATE_FIELDS),
        required: ["title", "brand", "category", "condition", "price", "photo_urls"]},
      ListingUpdate: {type: "object", additionalProperties: false, minProperties: 1, properties: pick(core.PATCH_FIELDS)},
      Error: {type: "object", properties: {error: {type: "object", required: ["code", "message"], properties: {
        code: str({enum: ERRORS.map((e) => e.code)}), message: str({}),
        errors: {type: "array", items: {type: "object", properties: {field: str({}), message: str({})}}}}}, request_id: str({})}},
    },
  },
};

// ── HTML tables ────────────────────────────────────────────────────────────
const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>\n` +
  rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n") + "\n</tbody></table></div>";
const code = (s) => `<code>${esc(s)}</code>`;
const blocks = {
  categories: table(["Category", "Required specs", "Optional specs"], cats.categories.map((c) => [
    `${code(c.id)}<br>${esc(c.label)}`,
    c.fields.filter((f) => f.required).map((f) => code(f.key)).join(" ") || (c.requires_browse_category ? `none, but send ${code("browse_category")}` : "none"),
    c.fields.filter((f) => !f.required).map((f) => code(f.key)).join(" ") || "none"])),
  errors: table(["HTTP", "Code", "What to do"], ERRORS.map((e) => [e.status, code(e.code), esc(e.fix)])),
  limits: table(["Limit", "Value"], [
    ["Requests per minute, per seller connection", L.requestsPerMinute],
    ["Requests per minute, per partner key (all sellers together)", L.partnerRequestsPerMinute.toLocaleString("en-US")],
    ["New listings per seller in a rolling 24 hours (shared with CSV upload)", `${lc.CAP_STANDARD}, or ${lc.CAP_HIGH} for sellers TeeBox approves`],
    ["Listings per page", `${L.listPageDefault} by default, ${L.listPageMax} at most`],
    ["Photo URLs per listing", L.photoUrlsMax],
    ["Idempotency keys kept", `${L.idempotencyHours} hours`]]),
  rules: table(["Rule", "Value"], [
    ["Price", `$${cats.rules.price_min} or more, US dollars, at most 2 decimals`],
    ["Photos", `${cats.rules.photos_min} to ${cats.rules.photos_max}; at least ${cats.rules.high_value_photos_min} when the price is $${cats.rules.high_value_price} or more`],
    ["Quantity", `1 to ${cats.rules.quantity_max}`],
    ["Title, brand, description", `${cats.rules.title_max}, ${cats.rules.brand_max} and ${cats.rules.description_max.toLocaleString("en-US")} characters at most`],
    ["Condition", cats.conditions.map(code).join(" ")],
    ["Browse category (only for category other)", cats.browse_categories.map(code).join(" ")]]),
  urls: table(["Environment", "Base URL", "Keys", "Status"], [
    ["Sandbox", code(sandbox.baseUrl), `${code(sandbox.partnerPrefix + "...")} ${code(sandbox.connectionPrefix + "...")}`, "Open, keys on request"],
    ["Live", code(live.baseUrl), `${code(live.partnerPrefix + "...")} ${code(live.connectionPrefix + "...")}`, "Not open yet"]]),
};

const check = process.argv.includes("--check");
const htmlPath = path.join(ROOT, "developers/index.html");
const apiPath = path.join(ROOT, "developers/openapi.json");
const html = fs.readFileSync(htmlPath, "utf8");
let out = html;
for (const [name, body] of Object.entries(blocks)) {
  const re = new RegExp(`(<!-- gen:${name} -->)[\\s\\S]*?(<!-- /gen:${name} -->)`);
  if (!re.test(out)) { console.error(`missing marker gen:${name}`); process.exit(1); }
  out = out.replace(re, (_m, a, b) => `${a}\n${body}\n${b}`);
}
const apiText = JSON.stringify(openapi, null, 2) + "\n";
if (check) {
  const bad = [];
  if (out !== html) bad.push("developers/index.html");
  if (!fs.existsSync(apiPath) || fs.readFileSync(apiPath, "utf8") !== apiText) bad.push("developers/openapi.json");
  if (bad.length) { console.error("out of date: " + bad.join(", ") + " (run node scripts/gen-seller-api-docs.mjs)"); process.exit(1); }
} else {
  fs.writeFileSync(htmlPath, out);
  fs.writeFileSync(apiPath, apiText);
  console.log("wrote developers/index.html, developers/openapi.json");
}
