// Founder hard rule (2026-11-17): Seller Integrations (CSV bulk upload, seller
// API) must NEVER touch payments, payouts, refunds, transfers or Stripe, and
// never write orders. This scans every integration source file. Add new
// integration files to FILES.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync, existsSync} = require("node:fs");
const path = require("node:path");

const FN = path.join(__dirname, "..", "..");
const FILES = [
  "bulkListings.js",
  "lib/bulkUploadCore.js",
  "lib/listingCreate.js",
  "lib/listingSchema.js",
  "lib/photoFetch.js",
  "sellerApi.js", // Phase 2a (checked once it exists)
  "lib/sellerApiCore.js",
  "lib/sellerApiKeys.js",
  "lib/sellerApiConfig.js",
  "lib/sellerApiSandbox.js",
  "lib/sandboxDb.js",
];
const FORBIDDEN = [
  [/require\(\s*["']stripe["']\s*\)/, "requires the Stripe SDK"],
  [/\bstripe(Client|Secret)?\b(?!\s*anywhere)/i, "mentions Stripe"],
  [/paymentIntents?|payment_intent/i, "touches PaymentIntents"],
  [/\btransfers?\.(create|createReversal)|reverse_transfer/i, "touches transfers"],
  [/\brefunds?\.create|refundOrder|refundCartItem/i, "creates refunds"],
  [/\bpayouts?\.(create|update)/i, "touches payouts"],
  [/collection\(\s*["']orders["']\s*\)\s*\.doc\([^)]*\)\s*\.(set|update|delete)|doc\(\s*[`"']orders\//, "writes orders"],
  [/application_fee/i, "touches application fees"],
];

for (const f of FILES) {
  const p = path.join(FN, f);
  test(`no money code in ${f}`, {skip: !existsSync(p) && "not built yet"}, () => {
    // Comments may NAME the rule ("NO payments ... Stripe"), code may not use it.
    const code = readFileSync(p, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const [re, why] of FORBIDDEN) assert.ok(!re.test(code), `${f} ${why} (${re})`);
  });
}
