// r421 guest checkout + in-app browser + 18+-up-front, end to end.
// Real index.html + js/* in Chromium; real functions code (createPaymentIntent,
// stripeWebhook, claimGuestOrder, markOrderShipped and the order email
// triggers) against Firestore/Auth EMULATORS. Stripe (server + browser) and
// Resend are local recording fakes; every other outbound request is blocked.
// Run: functions/test/e2e/run-guest-e2e.sh (needs Java).
const path = require("path");
const fs = require("fs");
const Module = require("module");
for (const k of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) if (!process.env[k]) throw new Error(k + " unset — refusing");
const PROJECT = "demo-teebox-guest";
process.env.GCLOUD_PROJECT = PROJECT;
for (const k of ["OPS_ALERT_WEBHOOK", "POSTHOG_API_KEY", "META_CAPI_TOKEN"]) delete process.env[k];
process.env.STRIPE_SECRET_KEY = "sk_test_stub_never_sent";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_stub";
process.env.SHIPPO_API_KEY = "shippo_test_stub_never_sent";
process.env.RESEND_API_KEY = "re_stub_never_sent";
process.env.UNSUBSCRIBE_SECRET = "unsub_stub";

const REPO = path.join(__dirname, "..", "..", "..");
const FN = path.join(REPO, "functions");
const OUT = process.env.GUEST_E2E_OUT || fs.mkdtempSync(path.join(require("os").tmpdir(), "guest-e2e-"));
fs.mkdirSync(OUT, {recursive: true});
const PORT = 8787;

// ── Fake Stripe (server) ──
const S = {pis: new Map(), calls: [], n: 0};
const fakeStripe = () => ({
  paymentIntents: {
    create: async (p, o) => {
      if (o && o.idempotencyKey && S.pis.has("idem:" + o.idempotencyKey)) return S.pis.get(S.pis.get("idem:" + o.idempotencyKey));
      const id = "pi_stub_" + (++S.n);
      const pi = {id, object: "payment_intent", client_secret: id + "_secret_stub", status: "requires_payment_method", livemode: false, ...JSON.parse(JSON.stringify(p))};
      S.pis.set(id, pi); if (o && o.idempotencyKey) S.pis.set("idem:" + o.idempotencyKey, id);
      S.calls.push({op: "pi.create", id, p}); return pi;
    },
    update: async (id, p) => { const pi = S.pis.get(id); Object.assign(pi, p); return pi; },
    retrieve: async (id) => S.pis.get(id),
    cancel: async (id) => { const pi = S.pis.get(id); pi.status = "canceled"; return pi; },
  },
  charges: {retrieve: async (id) => ({id, transfer: "tr_stub", payment_method_details: {card: {fingerprint: "fp_guest"}}})},
  webhooks: {constructEvent: (raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw)},
});
const stub = (name, exp) => { const p = fs.realpathSync(require.resolve(name, {paths: [FN]})); const m = new Module(p); m.exports = exp; m.loaded = true; m.filename = p; require.cache[p] = m; };
stub("stripe", fakeStripe);
// ── Fake Resend: records every email ──
const MAIL = [];
class FakeResend { constructor() { this.emails = {send: async (msg) => { MAIL.push(msg); return {data: {id: "em_stub_" + MAIL.length}}; }}; } }
stub("resend", {Resend: FakeResend});

const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const url = new URL(typeof u === "string" ? u : u.url);
  if (["127.0.0.1", "localhost"].includes(url.hostname)) return realFetch(u, o);
  if (url.hostname === "api.goshippo.com" && url.pathname === "/shipments/") {
    return new Response(JSON.stringify({rates: [{object_id: "r1", amount: "14.20", provider: "USPS",
      servicelevel: {name: "Ground Advantage", token: "usps_ground_advantage"}}]}), {status: 200, headers: {"Content-Type": "application/json"}});
  }
  throw new Error("harness: blocked " + url.hostname);
};

const fns = require(path.join(FN, "index.js"));
const admin = require(path.join(FN, "node_modules/firebase-admin"));
const G = require(path.join(FN, "lib/guestCheckout.js"));
const db = admin.firestore();
const results = [];
const check = (name, ok, detail) => { results.push({name, ok: !!ok}); console.log((ok ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); };

const express = require(path.join(FN, "node_modules/express"));
const app = express();
app.use(`/${PROJECT}/us-central1/stripeWebhook`, express.raw({type: "*/*"}));
app.use(express.json({limit: "2mb"}));
let FAKE_IP = "203.0.113.10";
app.use((req, _res, next) => { req.headers["x-forwarded-for"] = req.headers["x-test-ip"] || FAKE_IP; next(); });
async function deliver(type, obj) {
  const event = {id: "evt_stub_" + (++S.n), object: "event", type, data: {object: obj}, livemode: false, created: Math.floor(Date.now() / 1000)};
  const r = await realFetch(`http://127.0.0.1:${PORT}/${PROJECT}/us-central1/stripeWebhook`, {method: "POST",
    headers: {"stripe-signature": "t=1,v1=stub", "Content-Type": "application/json"}, body: JSON.stringify(event)});
  return r.status;
}
app.post("/__stub/confirm", async (req, res) => {
  const pi = S.pis.get(req.body.pi);
  if (!pi) return res.status(404).json({error: {message: "no pi"}});
  pi.status = "succeeded"; pi.latest_charge = "ch_stub_" + pi.id; pi.shipping = req.body.shipping || pi.shipping;
  const st = await deliver("payment_intent.succeeded", pi);
  res.json({paymentIntent: {id: pi.id, status: "succeeded", amount: pi.amount}, webhook: st});
});
app.all(`/${PROJECT}/us-central1/:name`, async (req, res) => {
  const fn = fns[req.params.name];
  if (!fn) return res.status(404).json({error: "no " + req.params.name});
  if (req.params.name === "stripeWebhook") req.rawBody = req.body;
  if (!fn.run) return fn(req, res);
  const t0 = Date.now(); if (req.params.name === "claimGuestOrder") console.log("SRV claim start", JSON.stringify(req.body).slice(0, 80));
  res.on("finish", () => { if (req.params.name === "claimGuestOrder") console.log("SRV claim end", res.statusCode, Date.now() - t0, "ms"); });
  try {
    let authCtx;
    const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (tok) { const d = await admin.auth().verifyIdToken(tok); authCtx = {uid: d.uid, token: d}; }
    const out = await fn.run({data: (req.body || {}).data, auth: authCtx, rawRequest: req});
    res.json({result: out === undefined ? null : out});
  } catch (e) {
    res.status((e.httpErrorCode && e.httpErrorCode.status) || 500).json({error: {status: (e.httpErrorCode && e.httpErrorCode.canonicalName) || "INTERNAL", message: e.message}});
  }
});
const FS_REST = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const TYPES = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"};
app.get(/.*/, (req, res) => {
  const rel = decodeURIComponent(req.path === "/" ? "/index.html" : req.path);
  const p = path.join(REPO, rel);
  if (!p.startsWith(REPO + "/") || rel.includes("/.") || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.status(404).end();
  let body = fs.readFileSync(p);
  if (rel === "/index.html") {
    body = String(body)
        .replace("https://us-central1-teebox-market.cloudfunctions.net/createPaymentIntent", `http://127.0.0.1:${PORT}/${PROJECT}/us-central1/createPaymentIntent`)
        .split("https://firestore.googleapis.com/v1/projects/teebox-market/databases/(default)/documents").join(FS_REST);
  }
  if (rel === "/js/app-auth.js") {
    const s = String(body).replace('projectId: "teebox-market"', `projectId: "${PROJECT}"`)
        .replace("initializeAppCheck(app, {", "(window.__TB_TEST_EMU ? (() => {}) : initializeAppCheck)(app, {");
    const anchor = "const db = getFirestore(app);";
    if (!s.includes(anchor)) throw new Error("app-auth anchor missing");
    body = s.replace(anchor, anchor + `
  await (async () => { const E = window.__TB_TEST_EMU; if (!E) return;
    const { connectAuthEmulator } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js");
    const { connectFirestoreEmulator } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const { connectFunctionsEmulator } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js");
    connectAuthEmulator(auth, E.auth, { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", E.fsPort);
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", E.port);
  })();`);
  }
  res.type(TYPES[path.extname(p)] || "application/octet-stream").send(body);
});

// Browser Stripe.js stand-in (deferred-intent aware). Link Authentication
// element renders a real <input>; typing fires change like Stripe's.
const STRIPE_JS = `
window.__stripeStub = { elements: [], confirms: [], submits: 0 };
window.Stripe = function () {
  return {
    elements(opts) {
      const els = { opts, created: [], updates: [] };
      window.__stripeStub.elements.push(els);
      return {
        update(o) { els.updates.push(o); Object.assign(els.opts, o); },
        async submit() { window.__stripeStub.submits++; return {}; },
        create(type, o) {
          const handlers = {};
          const fire = (ev, v) => (handlers[ev] || []).forEach((f) => f(v));
          const el = { type, o, mounted: null,
            mount(sel) { el.mounted = sel; const host = document.querySelector(sel);
              if (!host) return;
              if (type === 'linkAuthentication') {
                host.innerHTML = '<input id="stubEmail" type="email" placeholder="you@example.com" style="width:100%;box-sizing:border-box;border:1px solid #d9d9d9;border-radius:10px;padding:12px;font:15px system-ui">';
                host.querySelector('input').addEventListener('input', (e) => { const v = e.target.value; fire('change', { complete: /.+@.+\\..+/.test(v), value: { email: v } }); });
                return;
              }
              host.innerHTML = '<div class="stub-' + type + '" style="border:1px solid #d9d9d9;border-radius:10px;padding:12px;font:14px system-ui;color:#444">' +
                (type === 'payment' ? 'Card  4242 4242 4242 4242   12/30   123   (Stripe test stub)' : 'Pat Buyer<br>2 Elm St<br>Denver, CO 80202') + '</div>';
              if (type === 'address') setTimeout(() => fire('change', { complete: true, value: el.value }), 300); },
            on(ev, f) { (handlers[ev] = handlers[ev] || []).push(f); },
            unmount() { el.mounted = null; },
            value: { name: 'Pat Buyer', address: { line1: '2 Elm St', city: 'Denver', state: 'CO', postal_code: '80202', country: 'US' } },
            async getValue() { return { complete: true, value: el.value }; } };
          els.created.push(el);
          return el;
        } };
    },
    async confirmPayment(args) {
      const secret = args.clientSecret || (window.__stripeStub.elements.map((e) => e.opts.clientSecret).filter(Boolean).pop());
      const pi = String(secret).split('_secret_')[0];
      window.__stripeStub.confirms.push({ pi, params: args.confirmParams, deferred: !!args.clientSecret });
      const r = await fetch('/__stub/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pi, shipping: args.confirmParams && args.confirmParams.shipping }) }).then((x) => x.json());
      if (r.error) return { error: r.error };
      return { paymentIntent: r.paymentIntent };
    } };
};`;

async function mkUser(email, extra, profile, opts) {
  const u = await admin.auth().createUser({email, password: "qa-pass-123456", emailVerified: true, displayName: (profile && profile.displayName) || "QA", ...(opts || {})});
  await db.doc("users/" + u.uid).set({displayName: (profile && profile.displayName) || "QA", ...(extra || {})});
  if (profile) await db.doc("profiles/" + u.uid).set(profile);
  return {uid: u.uid, email};
}
async function mkListing(id, o) {
  await db.doc("listings/" + id).set({status: "active", quantity: 1, quantitySold: 0, condition: "Very Good",
    photos: ["https://firebasestorage.googleapis.com/v0/b/x/o/listings%2F" + id + ".jpg?alt=media"],
    createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - Math.floor(Math.random() * 1e5)), ...o});
}
const CPI = `http://127.0.0.1:${PORT}/${PROJECT}/us-central1/createPaymentIntent`;
async function cpi(body, headers) {
  const r = await realFetch(CPI, {method: "POST", headers: {"Content-Type": "application/json", ...(headers || {})}, body: JSON.stringify(body)});
  let j = {}; try { j = await r.json(); } catch (_e) {}
  return {status: r.status, body: j};
}
const triggerCreated = (fn, params, data) => fn.run({params, data: {data: () => data, id: Object.values(params)[0]}});
const triggerUpdated = (fn, params, before, after) => fn.run({params, data: {before: {data: () => before}, after: {data: () => after}}});

(async () => {
  await new Promise((r) => app.listen(PORT, "127.0.0.1", r));
  const FROM = {name: "Shop", street1: "1 Main St", city: "Austin", state: "TX", zip: "78701", country: "US"};
  const seller = await mkUser("seller-ready@example.test", {stripeAccountId: "acct_stub_s", stripeChargesEnabled: true, shippingFrom: FROM}, {displayName: "Ready Golf", chargesReady: true});
  const unready = await mkUser("seller-unready@example.test", {}, {displayName: "Unready Golf"});
  const existing = await mkUser("existing.buyer@example.test", {}, {displayName: "Existing Buyer"});
  await mkListing("gPolo", {sellerId: seller.uid, title: "QA Peter Millar Polo", brand: "Peter Millar", cat: "apparel", ask: 40});
  await mkListing("gHat", {sellerId: seller.uid, title: "QA Titleist Hat", brand: "Titleist", cat: "apparel", ask: 25});
  await mkListing("gDriver", {sellerId: seller.uid, title: "QA TaylorMade Qi10 Driver", brand: "TaylorMade", cat: "clubs", ask: 300});
  await mkListing("gUnready", {sellerId: unready.uid, title: "QA Shirt (seller not set up)", brand: "FootJoy", cat: "apparel", ask: 30});
  await mkListing("gSigned", {sellerId: seller.uid, title: "QA Glove", brand: "FootJoy", cat: "accessories", ask: 20});
  await mkListing("gSigned2", {sellerId: seller.uid, title: "QA Towel", brand: "Titleist", cat: "accessories", ask: 18});

  // ── Server-only money gates (BEFORE the browser) ──
  {
    let r = await cpi({guest: true, quoteOnly: false, listingId: "gUnready", email: "g1@example.test", age18: true, shippingAware: true}, {"x-test-ip": "198.51.100.1"});
    check("gate: guest on non-charges-ready seller → 409", r.status === 409, r);
    const lu = (await db.doc("listings/gUnready").get()).data();
    check("gate: 409 leaves no hold", lu.status === "active" && !lu.pendingBuyer && !(lu.quantityReserved > 0), lu);
    r = await cpi({guest: true, listingId: "gHat", email: "g1@example.test", age18: true, shippingAware: true, quantity: 5}, {"x-test-ip": "198.51.100.1"});
    check("gate: qty clamp (5 of 1) → 409", r.status === 409 && /Only 1 available/.test(r.body.error), r);
    r = await cpi({guest: true, listingId: "gHat", email: "Seller-Ready+alt@Example.test", age18: true, shippingAware: true}, {"x-test-ip": "198.51.100.1"});
    check("gate: self-purchase by seller email (+tag, case) → 400", r.status === 400 && /own listing/.test(r.body.error), r);
    r = await cpi({guest: true, listingId: "gHat", email: "g2@example.test", shippingAware: true}, {"x-test-ip": "198.51.100.1"});
    check("gate: guest without 18+ → 412 age-required", r.status === 412 && r.body.error === "age-required", r);
    r = await cpi({guest: true, listingId: "gHat", email: "not-an-email", age18: true}, {"x-test-ip": "198.51.100.1"});
    check("gate: invalid email → 400", r.status === 400, r);
    r = await cpi({listingId: "gHat"}, {"x-test-ip": "198.51.100.1"});
    check("gate: no auth and not guest → 401 (signed-in path unchanged)", r.status === 401, r);
    r = await cpi({guest: true, listingId: "gHat", offerId: "o1", email: "g3@example.test", age18: true}, {"x-test-ip": "198.51.100.1"});
    check("gate: guests can't pay offers → 400", r.status === 400, r);
    r = await cpi({guest: true, quoteOnly: true, listingId: "gHat", shippingAware: true}, {"x-test-ip": "198.51.100.1"});
    check("quote: no email needed, no hold, no PI", r.status === 200 && r.body.quoteOnly && r.body.itemCents === 2500 && S.calls.filter((c) => c.op === "pi.create").length === 0, r.body);
    const lh = (await db.doc("listings/gHat").get()).data();
    check("quote: listing untouched", lh.status === "active" && !lh.pendingBuyer, {status: lh.status});
    // Rate limit: 5 creates / 10 min per IP. Use an isolated IP and real holds on gDriver-like items would interfere, so use distinct listings.
    for (let i = 0; i < 5; i++) await mkListing("gRl" + i, {sellerId: seller.uid, title: "QA RL " + i, brand: "x", cat: "apparel", ask: 10});
    const st = [];
    for (let i = 0; i < 5; i++) st.push((await cpi({guest: true, listingId: "gRl" + i, email: `rl${i}@example.test`, age18: true, shippingAware: true}, {"x-test-ip": "192.0.2.77"})).status);
    await mkListing("gRl5", {sellerId: seller.uid, title: "QA RL 5", brand: "x", cat: "apparel", ask: 10});
    const sixth = await cpi({guest: true, listingId: "gRl5", email: "rl5@example.test", age18: true, shippingAware: true}, {"x-test-ip": "192.0.2.77"});
    check("abuse: 5 guest checkouts per IP per 10 min, 6th → 429", st.every((s) => s === 200) && sixth.status === 429, {st, sixth: sixth.status});
    const otherIp = await cpi({guest: true, listingId: "gRl5", email: "rl5@example.test", age18: true, shippingAware: true}, {"x-test-ip": "192.0.2.78"});
    check("abuse: other IP unaffected", otherIp.status === 200, otherIp.status);
    const emailSt = [];
    for (let i = 0; i < 6; i++) { await mkListing("gEm" + i, {sellerId: seller.uid, title: "QA EM " + i, brand: "x", cat: "apparel", ask: 10});
      emailSt.push((await cpi({guest: true, listingId: "gEm" + i, email: "same.email@example.test", age18: true, shippingAware: true}, {"x-test-ip": "192.0.2." + (100 + i)})).status); }
    check("abuse: 5 per email per hour across IPs, 6th → 429", emailSt.slice(0, 5).every((s) => s === 200) && emailSt[5] === 429, emailSt);
    const guestPis = S.calls.filter((c) => c.op === "pi.create" && c.p.metadata && c.p.metadata.guest === "1");
    const one = guestPis[0] && guestPis[0].p;
    check("guest PI: card+link types, receipt to guest email, destination charge kept",
        one && JSON.stringify(one.payment_method_types) === '["card","link"]' && !one.automatic_payment_methods &&
        one.receipt_email === "rl0@example.test" && one.transfer_data.destination === "acct_stub_s" && one.on_behalf_of === "acct_stub_s", one && {types: one.payment_method_types, r: one.receipt_email});
    check("guest PI metadata: guest buyer id, no uid", one && G.isGuestBuyerId(one.metadata.buyerId) && one.metadata.buyerEmail === "rl0@example.test", one && one.metadata);
  }

  // ── Browser ──
  const {chromium} = require(path.join(REPO, "node_modules/playwright"));
  const sharp = require(path.join(FN, "node_modules/sharp"));
  const jpg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#0f3d2e"/><text x="300" y="310" font-family="Helvetica" font-size="40" font-weight="700" fill="#F3ECDB" text-anchor="middle">TeeBox QA</text></svg>`)).jpeg().toBuffer();
  const browser = await chromium.launch();
  async function newCtx(o) {
    const ctx = await browser.newContext({bypassCSP: true, ...(o || {})});
    await ctx.addInitScript(({port, auth, fsPort}) => { window.__TB_TEST_EMU = {port, auth, fsPort}; try { localStorage.setItem("tb_dnsps", "1"); } catch (_e) {} },
        {port: PORT, auth: "http://" + process.env.FIREBASE_AUTH_EMULATOR_HOST, fsPort: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":")[1])});
    const nav = [];
    await ctx.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return route.continue();
      if (u.hostname === "js.stripe.com") return route.fulfill({status: 200, contentType: "text/javascript", body: STRIPE_JS});
      if (u.hostname === "firebasestorage.googleapis.com") return route.fulfill({status: 200, contentType: "image/jpeg", body: jpg});
      if (["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(u.hostname)) return route.continue();
      nav.push(route.request().url());
      return route.abort();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    return {ctx, page, errors, nav};
  }
  const M = {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2};
  const boot = async (page, q) => {
    await page.goto(`http://127.0.0.1:${PORT}/${q || ""}`);
    await page.click('[data-action="welcome-skip"]', {timeout: 6000}).catch(() => {});
    await page.waitForFunction(() => window.__actions && window.__actions["guest-pay"] && window.PRODUCTS && window.PRODUCTS.length > 0, null, {timeout: 30000});
  };
  const shot = (page, n) => page.screenshot({path: path.join(OUT, n + ".png")});

  // 1. Guest on mobile web: Buy → guest sheet, no sign-up wall, no hold
  const A = await newCtx(M);
  await boot(A.page, "?listing=gPolo&utm_source=facebook&utm_campaign=catalog");
  await A.page.waitForSelector("#detailBuyNowBtn", {state: "visible", timeout: 15000});
  const piBefore = S.calls.filter((c) => c.op === "pi.create").length;
  await A.page.click("#detailBuyNowBtn");
  await A.page.waitForFunction(() => window.__guestCheckoutState && window.__guestCheckoutState() && window.__guestCheckoutState().mounted, null, {timeout: 15000});
  const authOpen = await A.page.evaluate(() => document.getElementById("authSheetBackdrop").classList.contains("open"));
  check("guest: Buy opens checkout, not the sign-up sheet", !authOpen && await A.page.evaluate(() => document.getElementById("checkoutBackdrop").classList.contains("open")));
  check("guest: email + age rows shown", await A.page.evaluate(() => !document.getElementById("guestCoRows").hidden && document.getElementById("checkoutAgeRow").style.display !== "none"));
  check("guest: opening the sheet creates no PaymentIntent", S.calls.filter((c) => c.op === "pi.create").length === piBefore);
  const lp = (await db.doc("listings/gPolo").get()).data();
  check("guest: opening the sheet holds nothing", lp.status === "active" && !lp.pendingBuyer, {status: lp.status});
  const deferred = await A.page.evaluate(() => { const e = window.__stripeStub.elements.slice(-1)[0]; return e && e.opts; });
  check("guest: deferred Elements (mode payment, card+link, $50 = 40 + 10 apparel ship)", deferred && deferred.mode === "payment" && !deferred.clientSecret && JSON.stringify(deferred.paymentMethodTypes) === '["card","link"]' && deferred.amount === 5000, deferred && {mode: deferred.mode, amount: deferred.amount});
  await A.page.waitForTimeout(500);
  check("guest: Pay waits for email", /Enter your email/.test(await A.page.textContent("#payBtn")));
  await shot(A.page, "F-guest-sheet-390-empty");
  await A.page.fill("#stubEmail", "new.guest@example.test");
  await A.page.waitForTimeout(150);
  check("guest: then waits for 18+", /18\+/.test(await A.page.textContent("#payBtn")));
  await A.page.check("#checkoutAge18Checkbox");
  await A.page.waitForTimeout(150);
  const payLabel = await A.page.textContent("#payBtn");
  check("guest: Pay enabled with server total", payLabel.trim() === "Pay $50.00" && !(await A.page.isDisabled("#payBtn")), payLabel);
  await shot(A.page, "F-guest-sheet-390-ready");
  await A.page.click("#payBtn");
  await A.page.waitForFunction(() => document.getElementById("orderConfirmBackdrop") && document.getElementById("orderConfirmBackdrop").classList.contains("open"), null, {timeout: 15000});
  await A.page.waitForTimeout(900);
  await shot(A.page, "F-guest-success-390");
  const gp = S.calls.filter((c) => c.op === "pi.create").slice(-1)[0];
  check("guest pay: PI created at Pay with hold", gp && gp.p.metadata.listingId === "gPolo" && gp.p.amount === 5000, gp && {amount: gp.p.amount});
  const confirm = await A.page.evaluate(() => window.__stripeStub.confirms.slice(-1)[0]);
  check("guest pay: confirmed with the new clientSecret (deferred)", confirm && confirm.deferred && confirm.pi === gp.id, confirm);
  const orderId = gp.id;
  let order = (await db.doc("orders/" + orderId).get()).data();
  check("order: written with buyer email, guest flag, guest buyer id", order && order.buyerEmail === "new.guest@example.test" && order.guestCheckout === true && G.isGuestBuyerId(order.buyerId) && order.status === "paid",
      order && {buyerEmail: order.buyerEmail, buyerId: order.buyerId});
  check("listing: sold after guest payment", (await db.doc("listings/gPolo").get()).data().status === "sold");
  const successNote = await A.page.textContent("#orderConfirmBody");
  check("success sheet: tells guest to use the email link, no View Order button", /new\.guest@example\.test/.test(successNote) && !(await A.page.$('#orderConfirmBody [data-action="view-my-orders"]')), successNote.slice(0, 200));

  // 2. Emails reach the guest (confirmation with claim link, shipped, delivered, dispute)
  MAIL.length = 0;
  await triggerCreated(fns.onOrderCreatedEmail, {orderId}, order);
  const conf = MAIL.find((m) => m.to === "new.guest@example.test" || (Array.isArray(m.to) && m.to.includes("new.guest@example.test")));
  const html = conf && (conf.html || "");
  const claimM = /https:\/\/teeboxmarket\.com\/\?claim=([A-Za-z0-9_-]+)/.exec(html || "");
  check("email: confirmation sent to the guest", !!conf, MAIL.map((m) => ({to: m.to, s: m.subject})));
  check("email: confirmation carries the one-time claim link", !!claimM);
  check("email: seller still gets their order email", MAIL.some((m) => [].concat(m.to).includes("seller-ready@example.test")));
  fs.writeFileSync(path.join(OUT, "F-email-confirmation.html"), html || "");
  const sellerTok = await (async () => { const t = await admin.auth().createCustomToken(seller.uid); const r = await realFetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token: t, returnSecureToken: true})}); return (await r.json()).idToken; })();
  MAIL.length = 0;
  const shipRes = await realFetch(`http://127.0.0.1:${PORT}/${PROJECT}/us-central1/markOrderShipped`, {method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer " + sellerTok},
    body: JSON.stringify({data: {orderId, carrier: "USPS", trackingNumber: "9400100000000000000000"}})});
  check("email: shipped → guest", shipRes.status === 200 && MAIL.some((m) => [].concat(m.to).includes("new.guest@example.test")), {status: shipRes.status, mail: MAIL.map((m) => m.to)});
  order = (await db.doc("orders/" + orderId).get()).data();
  MAIL.length = 0;
  await triggerUpdated(fns.onOrderShippingStatusEmail, {orderId}, order, {...order, shippingStatus: "out_for_delivery"});
  check("email: out for delivery → guest (the buyer's delivery-stage email; prod has no buyer 'delivered' email, neutered r118)", MAIL.some((m) => [].concat(m.to).includes("new.guest@example.test")), MAIL.map((m) => m.to));
  MAIL.length = 0;
  await triggerCreated(fns.onDisputeOpenedEmail, {disputeId: "dsp_1"}, {orderId, reason: "not_as_described"});
  check("email: dispute → guest", MAIL.some((m) => [].concat(m.to).includes("new.guest@example.test")), MAIL.map((m) => m.to));

  // 3. Claim (new email): one tap → account created, order attached, signed in
  const B = await newCtx(M);
  const bLog = [];
  B.page.on("console", (m) => bLog.push(m.type() + ": " + m.text().slice(0, 300)));
  await B.page.addInitScript(() => { const orig = history.replaceState.bind(history);
    history.replaceState = function (s, ti, u) { if (location.search.includes("claim=")) console.warn("[strip] " + u + " :: " + new Error().stack.split("\n").slice(2, 5).join(" | ")); return orig(s, ti, u); };
    window.addEventListener("error", (e) => console.warn("[winerr] " + e.message)); window.addEventListener("unhandledrejection", (e) => console.warn("[rej] " + (e.reason && e.reason.message))); });
  B.page.on("requestfailed", (r) => bLog.push("FAILED " + r.method() + " " + r.url().slice(0, 120) + " :: " + (r.failure() && r.failure().errorText)));
  B.page.on("response", (r) => { if (/claim/i.test(r.url())) bLog.push("RESP " + r.status() + " " + r.url().slice(0, 100)); });
  B.page.on("request", (r) => { if (/claim/i.test(r.url())) bLog.push("REQ " + r.method() + " " + r.url().slice(0, 150)); });
  await B.page.goto(`http://127.0.0.1:${PORT}/?claim=${claimM ? claimM[1] : "x"}`);
  await B.page.waitForFunction(() => window.CURRENT_USER && window.CURRENT_USER.email, null, {timeout: 20000}).catch(() => {});
  const signedAs = await B.page.evaluate(() => window.CURRENT_USER && window.CURRENT_USER.email);
  await B.page.waitForTimeout(2600);
  await shot(B.page, "F-claim-new-390");
  console.log("B console:", JSON.stringify(bLog.filter((l) => /claim|error|Error|toast|warn|FAILED|RESP/i.test(l)).slice(0, 10)));
  console.log("B aborted:", JSON.stringify(B.nav.slice(0, 8)));
  console.log("B toast:", await B.page.evaluate(() => { const t = document.querySelector(".toast, #toast, .tb-toast"); return t ? t.textContent : null; }));
  const newUser = await admin.auth().getUserByEmail("new.guest@example.test").catch(() => null);
  order = (await db.doc("orders/" + orderId).get()).data();
  check("claim (new): account created, email verified, name from shipping", newUser && newUser.emailVerified && newUser.displayName === "Pat Buyer", newUser && {v: newUser.emailVerified, n: newUser.displayName});
  check("claim (new): browser signed in as that account", signedAs === "new.guest@example.test", signedAs);
  check("claim (new): order moved to the account", newUser && order.buyerId === newUser.uid && order.claimedFromGuestId, {buyerId: order.buyerId});
  check("claim (new): url param stripped", !(await B.page.evaluate(() => location.search.includes("claim="))));
  const reuse = await realFetch(`http://127.0.0.1:${PORT}/${PROJECT}/us-central1/claimGuestOrder`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({data: {token: claimM[1]}})});
  check("claim: link is single-use", reuse.status === 400, reuse.status);

  // 4. Claim (existing account): order NOT attached on trust; attached after tap
  const r4 = await cpi({guest: true, listingId: "gDriver", email: "Existing.Buyer@example.test", age18: true, shippingAware: true,
    shipTo: {name: "Existing Buyer", address: {line1: "9 Oak Ave", city: "Denver", state: "CO", postal_code: "80202", country: "US"}}}, {"x-test-ip": "198.51.100.44"});
  check("live-rate guest: priced from address at create (300 + 14.20)", r4.status === 200 && r4.body.amountCents === 31420 && !r4.body.shippingPending, r4.body);
  await realFetch(`http://127.0.0.1:${PORT}/__stub/confirm`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({pi: r4.body.paymentIntentId})});
  const o4 = (await db.doc("orders/" + r4.body.paymentIntentId).get()).data();
  check("existing email: order stays on the guest id until the tap", o4 && G.isGuestBuyerId(o4.buyerId) && o4.buyerId !== existing.uid, o4 && o4.buyerId);
  MAIL.length = 0;
  await triggerCreated(fns.onOrderCreatedEmail, {orderId: r4.body.paymentIntentId}, o4);
  const m4 = MAIL.find((m) => [].concat(m.to).includes("existing.buyer@example.test"));
  const t4 = m4 && /\?claim=([A-Za-z0-9_-]+)/.exec(m4.html || "");
  const C = await newCtx(M);
  await C.page.goto(`http://127.0.0.1:${PORT}/?claim=${t4 ? t4[1] : "x"}`);
  await C.page.waitForFunction(() => window.CURRENT_USER && window.CURRENT_USER.email, null, {timeout: 20000}).catch(() => {});
  const signed4 = await C.page.evaluate(() => window.CURRENT_USER && window.CURRENT_USER.uid);
  const o4b = (await db.doc("orders/" + r4.body.paymentIntentId).get()).data();
  check("existing email: after the tap the order is on the existing account, signed in as it", o4b.buyerId === existing.uid && signed4 === existing.uid, {buyerId: o4b.buyerId, signed4});
  const users = (await admin.auth().listUsers(1000)).users.filter((u) => u.email === "existing.buyer@example.test");
  check("existing email: no duplicate account", users.length === 1);

  // 5. Signed-in buyer: unchanged except the 18+ box is up front (no refusal)
  const D = await newCtx(M);
  const signedBuyer = await mkUser("signed.buyer@example.test", {}, {displayName: "Signed Buyer"});
  await boot(D.page, "?listing=gSigned");
  await D.page.evaluate(async () => { for (let i = 0; i < 50 && !window.__emuSignIn; i++) await new Promise((r) => setTimeout(r, 100)); });
  const tokS = await admin.auth().createCustomToken(signedBuyer.uid);
  await D.page.evaluate(async (t) => { await window.signInWithCustomToken(window.__tbAuthForTest || (await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js")).getAuth(), t); }, tokS);
  await D.page.waitForFunction(() => window.CURRENT_USER, null, {timeout: 15000});
  const before412 = S.calls.filter((c) => c.op === "pi.create").length;
  await D.page.evaluate(() => window.openCheckout("gSigned", 1));
  await D.page.waitForTimeout(1500);
  const ageFirst = await D.page.evaluate(() => document.getElementById("checkoutAgeRow").style.display !== "none" && !document.body.classList.contains("guest-checkout"));
  check("signed-in: first purchase shows 18+ box at once, before any server call", ageFirst && S.calls.filter((c) => c.op === "pi.create").length === before412);
  await shot(D.page, "A3-age-first-390");
  await D.page.check("#checkoutAge18Checkbox");
  await D.page.waitForFunction(() => { const b = document.getElementById("payBtn"); return b && /Pay/.test(b.textContent) && !b.disabled; }, null, {timeout: 15000});
  const sp = S.calls.filter((c) => c.op === "pi.create").slice(-1)[0];
  check("signed-in: tick loads payment straight away (one PI, automatic methods, real uid)", sp && sp.p.automatic_payment_methods && sp.p.metadata.buyerId === signedBuyer.uid && !sp.p.metadata.guest, sp && sp.p.metadata);
  await shot(D.page, "A3-age-ticked-loaded-390");
  await D.page.evaluate(() => window.closeCheckoutDirect());
  const nPi = S.calls.filter((c) => c.op === "pi.create").length;
  await D.page.evaluate(() => window.openCheckout("gSigned2", 1));
  await D.page.waitForFunction(() => { const b = document.getElementById("payBtn"); return b && /Pay/.test(b.textContent) && !b.disabled; }, null, {timeout: 15000});
  check("signed-in: second purchase skips the box", S.calls.filter((c) => c.op === "pi.create").length === nPi + 1 &&
    await D.page.evaluate(() => document.getElementById("checkoutAgeRow").style.display === "none"));

  // 6. iOS app (is-native): no guest path, sign-up sheet as today
  const E = await newCtx(M);
  await boot(E.page, "?listing=gHat");
  await E.page.evaluate(() => document.body.classList.add("is-native"));
  check("native: guest checkout not eligible", !(await E.page.evaluate(() => window.tbGuestCheckoutEligible())));
  await E.page.click("#detailBuyNowBtn");
  await E.page.waitForTimeout(800);
  check("native: Buy opens the sign-up sheet (today's flow)", await E.page.evaluate(() => document.getElementById("authSheetBackdrop").classList.contains("open")));

  // 7. In-app browsers: Google hidden, Open in Safari/browser with listing + UTMs
  const UAS = {
    Facebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 [FBAN/FBIOS;FBAV/490.0.0.39.106;FBBV/650000000;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.1;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/0]",
    Instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 Instagram 356.0.0.33.98 (iPhone15,2; iOS 18_1; en_US; en; scale=3.00; 1179x2556; 655093200)",
    Messenger: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 [FBAN/MessengerForiOS;FBAV/482.0.0.53.109;FBBV/640000000;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.1]",
    TikTok: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 musical_ly_37.2.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US",
    FacebookAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/485.0.0.70.77;]",
    Safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    Chrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  };
  const detected = {};
  const F = await newCtx(M);
  await boot(F.page, "");
  for (const [k, ua] of Object.entries(UAS)) detected[k] = await F.page.evaluate((u) => window.tbIabName(u), ua);
  check("IAB detection on real UA strings", detected.Facebook === "Facebook" && detected.Instagram === "Instagram" && detected.Messenger === "Messenger" &&
    detected.TikTok === "TikTok" && detected.FacebookAndroid === "Facebook" && detected.Safari === null && detected.Chrome === null, detected);
  const I = await newCtx({...M, userAgent: UAS.Instagram});
  await boot(I.page, "?listing=gHat&utm_source=instagram&utm_medium=paid&utm_campaign=catalog_nov");
  await I.page.evaluate(() => window.openAuthSheet("signup", "to make an offer"));
  await I.page.waitForTimeout(900);
  const iab = await I.page.evaluate(() => ({google: document.getElementById("authSheetGoogle").hidden, box: !document.getElementById("authSheetIab").hidden,
    label: document.getElementById("authSheetIabBtnLabel").textContent, msg: document.getElementById("authSheetIabMsg").textContent}));
  check("IAB (Instagram): Google hidden, Open in Safari shown", iab.google && iab.box && iab.label === "Open in Safari", iab);
  await shot(I.page, "A2-iab-instagram-signup-390");
  const link = await I.page.evaluate(() => window.tbCurrentDeepLink());
  check("IAB: link carries listing + UTMs", /\?listing=gHat/.test(link) && /utm_source=instagram/.test(link) && /utm_campaign=catalog_nov/.test(link), link);
  I.nav.length = 0;
  const navP = I.page.waitForEvent("request", {predicate: (r) => /^x-safari-https:\/\/teeboxmarket\.com\/\?listing=gHat/.test(r.url()), timeout: 3000}).then((r) => r.url()).catch(() => null);
  await I.page.evaluate(() => window.tbOpenInBrowser());
  const navUrl = await navP || (await I.page.evaluate(() => location.href));
  check("IAB: Open in Safari navigates to x-safari-https://teeboxmarket.com/?listing=…&utm_…", /x-safari-https:\/\/teeboxmarket\.com\/\?listing=gHat/.test(String(navUrl)) || I.nav.some((u) => /x-safari-https/.test(u)), {navUrl, nav: I.nav.slice(0, 3)});
  const IG = await newCtx({...M, userAgent: UAS.Facebook});
  await boot(IG.page, "?listing=gHat&utm_source=facebook");
  await IG.page.click("#detailBuyNowBtn");
  await IG.page.waitForFunction(() => window.__guestCheckoutState && window.__guestCheckoutState() && window.__guestCheckoutState().mounted, null, {timeout: 15000});
  check("IAB (Facebook): Buy goes to guest checkout with an Apple Pay hint", await IG.page.evaluate(() => !document.getElementById("guestIabHint").hidden));
  await shot(IG.page, "F-guest-sheet-facebook-iab-390");
  const W = await newCtx({viewport: {width: 1280, height: 900}});
  await boot(W.page, "?listing=gHat");
  await W.page.click("#detailBuyNowBtn");
  await W.page.waitForFunction(() => window.__guestCheckoutState && window.__guestCheckoutState() && window.__guestCheckoutState().mounted, null, {timeout: 15000});
  await W.page.fill("#stubEmail", "desk@example.test");
  await shot(W.page, "F-guest-sheet-1280");

  const allErr = [A, B, C, D, E, F, I, IG, W].flatMap((x) => x.errors).filter((m) => !/ResizeObserver|Failed to fetch|NetworkError|net::/.test(m));
  check("no page errors", allErr.length === 0, allErr.slice(0, 5));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("E2E CRASH", e); process.exit(2); });
