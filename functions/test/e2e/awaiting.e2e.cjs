// r422 "list now, publish after payouts" + payout-setup reminders, end to end.
// Real index.html + js/* in Chromium; real functions code (countListingCreate,
// onListingLive, payoutSetupReminders, stripeWebhook account.updated,
// createPaymentIntent, metaFeed) and real firestore.rules against
// Firestore/Auth EMULATORS. Stripe, Resend and FCM are local recording fakes;
// every other outbound request is blocked.
// Run: functions/test/e2e/run-awaiting-e2e.sh (needs Java).
const path = require("path");
const fs = require("fs");
const Module = require("module");
for (const k of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) if (!process.env[k]) throw new Error(k + " unset — refusing");
const PROJECT = "demo-teebox-await";
process.env.GCLOUD_PROJECT = PROJECT;
for (const k of ["OPS_ALERT_WEBHOOK", "POSTHOG_API_KEY", "META_CAPI_TOKEN"]) delete process.env[k];
process.env.STRIPE_SECRET_KEY = "sk_test_stub_never_sent";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_stub";
process.env.SHIPPO_API_KEY = "shippo_test_stub_never_sent";
process.env.RESEND_API_KEY = "re_stub_never_sent";
process.env.UNSUBSCRIBE_SECRET = "unsub_stub";
process.env.META_FEED_TOKEN = "feedtok_stub";
process.env.TIKTOK_FEED_TOKEN = "feedtok_stub";

const REPO = path.join(__dirname, "..", "..", "..");
const FN = path.join(REPO, "functions");
const OUT = process.env.AWAIT_E2E_OUT || fs.mkdtempSync(path.join(require("os").tmpdir(), "await-e2e-"));
fs.mkdirSync(OUT, {recursive: true});
const PORT = 8788;

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
  accounts: {retrieve: async (id) => ({id, charges_enabled: !!S.ready[id], payouts_enabled: !!S.ready[id], details_submitted: !!S.ready[id], requirements: {currently_due: []}})},
});
S.ready = {};
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
// ── Fake FCM: records every multicast; tokens starting "dead" fail ──
const PUSH = [];
const __msg = admin.messaging();
__msg.sendEachForMulticast = async (m) => {
  m.__uid = TOKOWNER.get(m.tokens[0]);
  PUSH.push(m);
  const responses = m.tokens.map((t) => /^dead/.test(t) ? {success: false, error: {code: "messaging/registration-token-not-registered"}} : {success: true});
  return {successCount: responses.filter((r) => r.success).length, failureCount: responses.filter((r) => !r.success).length, responses};
};
const TOKOWNER = new Map();
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
let ONBOARD_DELAY_MS = 0; let ONBOARD_CALLS = 0;
app.post(`/${PROJECT}/us-central1/createStripeOnboardingLink`, async (req, res) => {
  ONBOARD_CALLS++;
  await new Promise((r) => setTimeout(r, ONBOARD_DELAY_MS));
  res.json({result: {url: `http://127.0.0.1:${PORT}/__stub/stripe-onboarding`}});
});
app.get("/__stub/stripe-onboarding", (_q, res) => res.type("text/html").send("<!doctype html><title>Stripe stub</title><h1>Stripe onboarding (stub)</h1>"));
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

const PR = require(path.join(FN, "lib/payoutReminders.js"));
const fire = async (fn, listingId) => { const ref = db.doc("listings/" + listingId); const snap = await ref.get();
  return fn.run({params: {listingId}, data: {data: () => snap.data(), id: listingId, ref}}); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pushesTo = (uid) => PUSH.filter((m) => m.__uid === uid);
async function addToken(uid, tok) { TOKOWNER.set(tok, uid); await db.doc(`users/${uid}/fcmTokens/${tok}`).set({platform: "ios", createdAt: new Date()}); }

(async () => {
  app.listen(PORT);
  await sleep(300);
  // ── seed ──
  const unready = await mkUser("unready.seller@example.test",
      {sellerVerified: true, sellerAge18At: new Date(), stripeAccountId: "acct_unready"}, {displayName: "Una Seller"});
  await addToken(unready.uid, "tok_unready_ios");
  const nopush = await mkUser("nopush.seller@example.test", {sellerVerified: true, sellerAge18At: new Date()}, {displayName: "Nopush Seller"});
  const legacy = await mkUser("legacy.seller@example.test", {sellerVerified: true, sellerAge18At: new Date()}, {displayName: "Legacy Seller"});
  await addToken(legacy.uid, "tok_legacy");
  const noage = await mkUser("noage.seller@example.test", {sellerVerified: true}, {displayName: "Noage Seller"});
  const ready = await mkUser("ready.seller@example.test", {sellerVerified: true, sellerAge18At: new Date(), stripeAccountId: "acct_ready", stripeChargesEnabled: true}, {displayName: "Ready Seller"});
  await mkListing("rDriver", {sellerId: ready.uid, title: "Ping G430 Driver", brand: "Ping", cat: "clubs", ask: 260});

  // ── Browser ──
  const {chromium} = require(path.join(REPO, "node_modules/playwright"));
  const sharp = require(path.join(FN, "node_modules/sharp"));
  const jpg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#0f3d2e"/><text x="300" y="310" font-family="Helvetica" font-size="40" font-weight="700" fill="#F3ECDB" text-anchor="middle">TeeBox QA</text></svg>`)).jpeg().toBuffer();
  const photoPath = path.join(OUT, "qa-photo.jpg"); fs.writeFileSync(photoPath, jpg);
  const browser = await chromium.launch();
  async function newCtx(o) {
    const ctx = await browser.newContext({bypassCSP: true, ...(o || {})});
    await ctx.addInitScript(({port, auth, fsPort}) => { window.__TB_TEST_EMU = {port, auth, fsPort}; try { localStorage.setItem("tb_dnsps", "1"); } catch (_e) {} },
        {port: PORT, auth: "http://" + process.env.FIREBASE_AUTH_EMULATOR_HOST, fsPort: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":")[1])});
    await ctx.route("**/*", (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return route.continue();
      if (u.hostname === "firebasestorage.googleapis.com") {
        // Storage stand-in: uploadBytes (POST) + getDownloadURL (metadata GET) + image GET.
        const m = u.pathname.match(/\/v0\/b\/([^/]+)\/o\/?(.*)$/);
        const bucket = m ? m[1] : "b"; const name = u.searchParams.get("name") || decodeURIComponent((m && m[2]) || "x");
        if (req.method() === "GET" && u.searchParams.get("alt") === "media") return route.fulfill({status: 200, contentType: "image/jpeg", body: jpg});
        return route.fulfill({status: 200, contentType: "application/json",
          body: JSON.stringify({name, bucket, contentType: "image/jpeg", size: String(jpg.length), downloadTokens: "tok_stub", generation: "1", metageneration: "1"})});
      }
      if (["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(u.hostname)) return route.continue();
      return route.abort();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (/submitListing|permission|verify|error/i.test(m.text())) fs.appendFileSync(path.join(OUT, "console.log"), m.type() + " " + m.text().slice(0, 400) + "\n"); });
    return {ctx, page, errors};
  }
  const M = {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2};
  const DESK = {viewport: {width: 1280, height: 900}};
  const boot = async (page, q) => {
    await page.goto(`http://127.0.0.1:${PORT}/${q || ""}`);
    await page.click('[data-action="welcome-skip"]', {timeout: 6000}).catch(() => {});
    await page.waitForFunction(() => window.__actions && window.PRODUCTS && window.PRODUCTS.length > 0, null, {timeout: 30000});
  };
  const signIn = async (page, uid) => {
    await page.evaluate(async () => { for (let i = 0; i < 50 && !window.signInWithCustomToken; i++) await new Promise((r) => setTimeout(r, 100)); });
    const t = await admin.auth().createCustomToken(uid);
    await page.evaluate(async (tok) => { await window.signInWithCustomToken(window.__tbAuthForTest || (await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js")).getAuth(), tok); }, t);
    await page.waitForFunction((u) => window.CURRENT_USER && window.CURRENT_USER.uid === u, uid, {timeout: 15000});
    await page.waitForTimeout(1500);
  };
  const shot = (page, n) => page.screenshot({path: path.join(OUT, n + ".png")});
  const toastText = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".toast, #toast, [role=status]")).map((e) => e.textContent.trim()).filter(Boolean).join(" | "));

  // 1. Unready seller lists through the REAL sell form (web r422 client)
  const A = await newCtx(M);
  await boot(A.page);
  await signIn(A.page, unready.uid);
  await A.page.evaluate(() => window.openSellModal());
  await A.page.waitForSelector("#photoInput", {state: "attached"});
  await A.page.setInputFiles("#photoInput", photoPath);
  await A.page.waitForTimeout(800);
  await A.page.evaluate(() => window.setSpecCategory("other"));
  await A.page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input", {bubbles: true})); e.dispatchEvent(new Event("change", {bubbles: true})); };
    set("sellTitle", "Scotty Cameron Newport 2 Putter"); set("sellBrand", "Scotty Cameron"); set("sellCat", "clubs");
    set("sellPrice", "240"); set("sellCondition", "Very Good"); set("sellDesc", "Gamed one season, original grip and headcover.");
  });
  const pre = await A.page.evaluate(() => ({ev: window.CURRENT_USER && window.CURRENT_USER.emailVerified, ver: window.IS_VERIFIED_SELLER, n: (document.querySelectorAll("#previewGrid img, .preview-item, .photo-preview img") || []).length}));
  console.log("pre-submit", JSON.stringify(pre));
  await A.page.evaluate(() => window.submitListing());
  await A.page.waitForFunction(() => !window.__submitListingBusy, null, {timeout: 30000});
  console.log("post-submit", JSON.stringify(await A.page.evaluate(() => ({errs: Array.from(document.querySelectorAll(".field-error-msg")).map((e) => e.textContent),
    toasts: Array.from(document.querySelectorAll(".toast, #toast")).map((e) => e.textContent), cat: document.getElementById("sellCat").value,
    cond: document.getElementById("sellCondition").value, name: (window.CURRENT_USER || {}).displayName}))));
  const mine = (await db.collection("listings").where("sellerId", "==", unready.uid).get()).docs;
  const L = mine[0] ? {id: mine[0].id, ...mine[0].data()} : {};
  check("create (web): unready seller's listing saves as hidden/awaiting_payouts", mine.length === 1 && L.status === "hidden" && L.hiddenReason === "awaiting_payouts", {status: L.status, reason: L.hiddenReason});
  check("create (web): photo attached under the new rule", Array.isArray(L.photos) && L.photos.length === 1, L.photos);
  await A.page.waitForTimeout(1500);
  const t1 = await toastText(A.page);
  check("create (web): toast says saved, finish payout setup", /Finish payout setup to publish/.test(t1), t1);
  await A.page.waitForFunction(() => document.getElementById("stripeRequiredBackdrop").classList.contains("open"), null, {timeout: 8000}).catch(() => {});
  const dlg = await A.page.evaluate(() => { const b = document.getElementById("stripeRequiredBackdrop"); return {open: b.classList.contains("open"), text: b.innerText}; });
  check("create (web): 'Almost live' pop-up with Finish payout setup", dlg.open && /Almost live/.test(dlg.text) && /Finish payout setup/.test(dlg.text), dlg.text.slice(0, 160));
  await shot(A.page, "S1-almost-live-popup-390");
  await A.page.click('#stripeRequiredBackdrop [data-action="close-stripe-required"]').catch(() => {});

  // 2. Rules: the seller can't self-publish it
  const selfPub = await A.page.evaluate(async (id) => {
    const {getFirestore, doc, updateDoc} = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    try { await updateDoc(doc(getFirestore(), "listings", id), {status: "active"}); return "allowed"; } catch (e) { return e.code; }
  }, L.id);
  check("rules: seller cannot flip awaiting → active from the client", selfPub === "permission-denied", selfPub);

  // 3. Buyers can't see it anywhere
  const G1 = await newCtx(M);
  await boot(G1.page);
  const inFeed = await G1.page.evaluate((id) => (window.PRODUCTS || []).some((p) => String(p.id) === id), L.id);
  check("buyer: not in browse/search/category (window.PRODUCTS)", !inFeed);
  const searchHit = await G1.page.evaluate(() => (window.PRODUCTS || []).some((p) => /Newport 2/.test(p.title || "")));
  check("buyer: search for its title finds nothing", !searchHit);
  await G1.page.goto(`http://127.0.0.1:${PORT}/?listing=${L.id}`);
  await G1.page.waitForTimeout(4000);
  const deep = await G1.page.evaluate(() => ({open: document.getElementById("detailBackdrop") && document.getElementById("detailBackdrop").classList.contains("open"),
    toast: Array.from(document.querySelectorAll(".toast, #toast")).map((e) => e.textContent).join("|")}));
  check("buyer: shared/deep link does not open it", !deep.open, deep);
  await shot(G1.page, "S2-buyer-deeplink-390");
  const otherStore = await G1.page.evaluate(async (uid) => {
    if (window.openProfile) await window.openProfile(uid); else if (window.openSellerProfile) await window.openSellerProfile(uid);
    await new Promise((r) => setTimeout(r, 2500));
    return document.body.innerText.includes("Scotty Cameron Newport 2");
  }, unready.uid);
  check("buyer: not on the seller's storefront to other people", !otherStore);
  if (!L.id) throw new Error("no listing created; see console.log in OUT");
  const gate = await cpi({guest: true, quoteOnly: true, listingId: L.id, shippingAware: true});
  check("money gate: createPaymentIntent refuses it (no hold)", gate.status >= 400 && gate.status < 500, gate);
  const lAfterGate = (await db.doc("listings/" + L.id).get()).data();
  check("money gate: listing untouched by the attempt", lAfterGate.status === "hidden" && !lAfterGate.pendingBuyer);
  const feedRes = await (async () => {
    const r = await realFetch(`http://127.0.0.1:${PORT}/${PROJECT}/us-central1/metaFeed?token=feedtok_stub`);
    return {status: r.status, body: await r.text()};
  })();
  check("Meta feed: awaiting listing absent, live listing present", !feedRes.body.includes(L.id) && feedRes.body.includes("rDriver"), {status: feedRes.status, len: feedRes.body.length});

  // 4. Seller-side states (390 + 1280)
  await A.page.evaluate(() => window.openShopDashboard && window.openShopDashboard());
  await A.page.waitForTimeout(3000);
  const dash = await A.page.evaluate(() => { const el = document.getElementById("dashTabActive"); return el ? el.innerText : ""; });
  check("seller: My Shop shows 'Almost live' + Finish payout setup", /Almost live: finish payout setup to publish/.test(dash) && /Finish payout setup/.test(dash), dash.slice(0, 200));
  await A.page.evaluate(() => { const e = document.getElementById("dashTabActive"); if (e) e.scrollIntoView({block: "start"}); });
  await A.page.waitForTimeout(400);
  await shot(A.page, "S3-myshop-almost-live-390");
  await A.page.evaluate((uid) => { if (window.openProfile) return window.openProfile(uid); }, unready.uid);
  await A.page.waitForTimeout(2500);
  const ownStore = await A.page.evaluate(() => document.body.innerText);
  check("seller: own storefront shows it with the Almost live badge + banner", /Almost live: finish payout setup to publish/.test(ownStore) && /Scotty Cameron Newport 2/.test(ownStore));
  await A.page.evaluate(() => { const b = Array.from(document.querySelectorAll(".profile-section .awaiting-payouts-banner")).pop(); if (b) b.scrollIntoView({block: "start"}); });
  await A.page.waitForTimeout(400);
  await shot(A.page, "S4-storefront-own-390");
  const W = await newCtx(DESK);
  await boot(W.page);
  await signIn(W.page, unready.uid);
  await W.page.evaluate(() => window.openShopDashboard && window.openShopDashboard());
  await W.page.waitForTimeout(3000);
  await W.page.evaluate(() => { const e = document.getElementById("dashTabActive"); if (e) e.scrollIntoView({block: "start"}); });
  await W.page.waitForTimeout(400);
  await shot(W.page, "S3-myshop-almost-live-1280");
  await W.page.evaluate((uid) => window.openProfile && window.openProfile(uid), unready.uid);
  await W.page.waitForTimeout(2500);
  await W.page.evaluate(() => { const b = Array.from(document.querySelectorAll(".profile-section .awaiting-payouts-banner")).pop(); if (b) b.scrollIntoView({block: "start"}); });
  await W.page.waitForTimeout(400);
  await shot(W.page, "S4-storefront-own-1280");

  // 5. Reminder 1 right after save (onListingLive), by push
  const p0 = PUSH.length;
  await fire(fns.onListingLive, L.id);
  const r1 = PUSH.slice(p0).find((m) => m.__uid === unready.uid);
  check("reminder 1: push right after save, names the item", r1 && r1.notification.title === "Your Scotty Cameron Newport 2 Putter is almost live" && r1.notification.body === "Finish payout setup to start selling. About 3 minutes.", r1 && r1.notification);
  check("reminder 1: tap → payout setup (teebox://payouts/setup, web /?payouts=setup, no listingId)", r1 && r1.data.url === "teebox://payouts/setup" && r1.data.webUrl === "/?payouts=setup" && !r1.data.listingId, r1 && r1.data);
  check("reminder 1: no 'your listing is live' email for an unready seller", !MAIL.some((m) => /is live/.test(m.subject || "") && (m.to === unready.email || (m.to || []).includes && (m.to || []).includes(unready.email))));
  let log = (await db.doc("payoutReminders/" + unready.uid).get()).data() || {};
  check("log: stage 1 recorded once, channel push", log.count === 1 && log.sent && log.sent[1] && log.sent[1].channel === "push", log);
  const p1 = PUSH.length;
  await fns.payoutSetupReminders.run({});
  await fire(fns.onListingLive, L.id);
  check("idempotent: scheduler + a retried trigger send nothing more", PUSH.slice(p1).filter((m) => m.__uid === unready.uid).length === 0);
  // 24h later → stage 2
  await db.doc("payoutReminders/" + unready.uid).set({anchorMs: Date.now() - 25 * 3600e3, sent: {1: {atMs: Date.now() - 25 * 3600e3}}}, {merge: true});
  await fns.payoutSetupReminders.run({});
  const r2 = PUSH.slice(p1).find((m) => m.__uid === unready.uid);
  check("reminder 2 at 24h: 'isn't live yet'", r2 && /isn't live yet$/.test(r2.notification.title), r2 && r2.notification.title);

  // 6. Email fallback: seller with no push token
  const n0 = MAIL.length;
  await mkListing("nopush1", {sellerId: nopush.uid, title: "FootJoy Pro SL Shoes", brand: "FootJoy", cat: "shoes", ask: 90, status: "hidden", hiddenReason: "awaiting_payouts"});
  await fns.payoutSetupReminders.run({});
  const em = MAIL.slice(n0).find((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(nopush.email));
  check("email fallback: no push token → Resend email, same copy", em && em.subject === "Your FootJoy Pro SL Shoes is almost live", em && em.subject);
  check("email fallback: List-Unsubscribe header (honors opt-out)", em && em.headers && /unsubscribe/i.test(em.headers["List-Unsubscribe"] || ""), em && em.headers);
  fs.writeFileSync(path.join(OUT, "email-fallback.html"), (em && em.html) || "");
  await db.doc("users/" + nopush.uid).set({emailPrefs: {payoutReminders: false}}, {merge: true});
  await db.doc("payoutReminders/" + nopush.uid).set({anchorMs: Date.now() - 25 * 3600e3, sent: {1: {atMs: Date.now() - 25 * 3600e3}}}, {merge: true});
  const n1 = MAIL.length;
  await fns.payoutSetupReminders.run({});
  check("unsubscribed: opted-out seller gets no reminder email", !MAIL.slice(n1).some((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(nopush.email)));

  // 7. Legacy client (installed iOS app) writes status "active" → admitted, then demoted
  const Lg = await newCtx(M);
  await boot(Lg.page);
  await signIn(Lg.page, legacy.uid);
  const legacyId = await Lg.page.evaluate(async (uid) => {
    const {getFirestore, collection, addDoc, serverTimestamp} = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
    const r = await addDoc(collection(getFirestore(), "listings"), {title: "Titleist Tour Bag", brand: "Titleist", cat: "bags", ask: 150, condition: "Good",
      desc: "", badge: "new", specCategory: "other", specs: {}, photos: [], sellerId: uid, status: "active", createdAt: serverTimestamp(),
      expiresAt: new Date(Date.now() + 9e9), quantity: 1, quantitySold: 0, requiresAuth: false, authReviewState: "na"});
    return r.id;
  }, legacy.uid);
  check("legacy: old-build 'active' create by an unready seller is admitted", !!legacyId);
  await fire(fns.countListingCreate, legacyId);
  const lg = (await db.doc("listings/" + legacyId).get()).data();
  check("legacy: countListingCreate demotes it to awaiting_payouts", lg.status === "hidden" && lg.hiddenReason === "awaiting_payouts" && !!lg.awaitingSince, lg.status);
  const readyCreate = await W.page.evaluate(async () => 1);
  void readyCreate;

  // 8. Spinner: age first (no server call), then visible progress, then redirect
  const Sp = await newCtx(M);
  await boot(Sp.page);
  await signIn(Sp.page, noage.uid);
  const calls0 = ONBOARD_CALLS;
  await Sp.page.evaluate(() => window.__actions["stripe-connect"]());
  await Sp.page.waitForTimeout(800);
  const ageDlg = await Sp.page.evaluate(() => { const b = document.getElementById("sellerAgeBackdrop"); return b && b.classList.contains("open"); });
  check("spinner: no-18+ seller gets the age dialog at once, no Stripe call", ageDlg && ONBOARD_CALLS === calls0);
  const A2 = await newCtx(M);
  await boot(A2.page);
  await signIn(A2.page, unready.uid);
  await A2.page.evaluate(() => window.openShopDashboard && window.openShopDashboard());
  await A2.page.waitForSelector('#dashTabActive [data-action="stripe-connect"]', {timeout: 15000});
  ONBOARD_DELAY_MS = 8000;
  const tapAt = Date.now();
  await A2.page.click('#dashTabActive [data-action="stripe-connect"]');
  await A2.page.waitForTimeout(400);
  const s1 = await A2.page.evaluate(() => ({overlay: document.getElementById("stripeConnectingOverlay").classList.contains("open"),
    btn: (document.querySelector('#dashTabActive [data-action="stripe-connect"]') || {}).textContent,
    disabled: (document.querySelector('#dashTabActive [data-action="stripe-connect"]') || {}).disabled}));
  check("spinner: tap → 'Connecting to Stripe…' overlay + button within 400 ms", s1.overlay && /Connecting to Stripe/.test(s1.btn || "") && s1.disabled, s1);
  await shot(A2.page, "S5-connecting-390");
  await A2.page.waitForTimeout(6500);
  const slow = await A2.page.evaluate(() => document.getElementById("stripeConnectingSlow").textContent);
  check("spinner: after 6 s it says it's still connecting", /Still connecting/.test(slow), slow);
  await shot(A2.page, "S5-connecting-slow-390");
  await A2.page.waitForURL(/__stub\/stripe-onboarding/, {timeout: 15000}).catch(() => {});
  check("spinner: lands on Stripe onboarding when the link arrives", /stripe-onboarding/.test(A2.page.url()), {url: A2.page.url(), ms: Date.now() - tapAt});
  ONBOARD_DELAY_MS = 0;

  // 9. Cancel-on-onboard + auto-publish via the account.updated WEBHOOK
  const pBefore = PUSH.length; const mBefore = MAIL.length;
  S.ready.acct_unready = true;
  const wh = await deliver("account.updated", {id: "acct_unready", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: {currently_due: []}});
  check("webhook: account.updated acked", wh === 200, wh);
  const pub = (await db.doc("listings/" + L.id).get()).data();
  check("auto-publish: awaiting listing flipped to active by the webhook", pub.status === "active" && !pub.hiddenReason && !!pub.publishedAt, {status: pub.status});
  log = (await db.doc("payoutReminders/" + unready.uid).get()).data() || {};
  check("cancel-on-onboard: reminder log cancelled", !!log.cancelledAtMs && log.cancelReason === "charges-enabled", log.cancelReason);
  const livePush = PUSH.slice(pBefore).find((m) => m.__uid === unready.uid);
  check("auto-publish: 'Your listing is live' push", livePush && livePush.notification.title === "Your listing is live", livePush && livePush.notification);
  const liveMail = MAIL.slice(mBefore).find((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(unready.email));
  check("auto-publish: 'Your listing is live' email", liveMail && /is live/.test(liveMail.subject), liveMail && liveMail.subject);
  const pAfter = PUSH.length;
  await db.doc("payoutReminders/" + unready.uid).set({anchorMs: Date.now() - 8 * 86400e3}, {merge: true});
  await db.doc("listings/" + L.id).set({status: "hidden", hiddenReason: "awaiting_payouts"}, {merge: true}); // even if something re-hid it
  await db.doc("users/" + unready.uid).set({stripeChargesEnabled: false}, {merge: true});
  await PR.runReminderForSeller(unready.uid, {trigger: "test"});
  check("cancel-on-onboard: no reminder after onboarding, even 8 days on", PUSH.slice(pAfter).filter((m) => m.__uid === unready.uid && /payout/i.test(m.notification.body || "")).length === 0);
  await db.doc("users/" + unready.uid).set({stripeChargesEnabled: true}, {merge: true});
  await db.doc("listings/" + L.id).set({status: "active", hiddenReason: admin.firestore.FieldValue.delete()}, {merge: true});
  const G2 = await newCtx(M);
  await boot(G2.page);
  const nowInFeed = await G2.page.evaluate((id) => (window.PRODUCTS || []).some((p) => String(p.id) === id), L.id);
  check("buyer: published listing now in the feed", nowInFeed);

  // 10. Scheduler self-heal: charges-enabled seller with a leftover awaiting listing gets published
  await db.doc("users/" + legacy.uid).set({stripeChargesEnabled: true}, {merge: true});
  await fns.payoutSetupReminders.run({});
  const lg2 = (await db.doc("listings/" + legacyId).get()).data();
  check("self-heal: scheduler publishes a ready seller's awaiting listing", lg2.status === "active");

  const allErr = [A, A2, G1, W, Lg, Sp, G2].flatMap((x) => x.errors).filter((m) => !/ResizeObserver|Failed to fetch|NetworkError|net::|Load failed/.test(m));
  check("no page errors", allErr.length === 0, allErr.slice(0, 5));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("E2E CRASH", e); process.exit(2); });
