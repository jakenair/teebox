#!/usr/bin/env node
// scripts/smoke.mjs — TeeBox end-to-end smoke walk (Playwright + Firebase Admin).
//
//   node scripts/smoke.mjs                       # production, full walk, Slow 3G first
//   BASE=http://127.0.0.1:8788 node scripts/smoke.mjs
//   MODE=signup node scripts/smoke.mjs           # stop after account creation
//   MODE=guest  node scripts/smoke.mjs           # cold load + browse only (no accounts)
//   node scripts/smoke.mjs --pixel               # also assert Meta pixel events (see --help)
//
// What it does (iPhone 14, Chromium, Chrome "Slow 3G" preset via CDP; steps that
// cannot complete on Slow 3G fall back to Fast 3G and say so):
//   guest cold load → browse → open listing → sign up (throwaway) → verify (admin)
//   → create ONE test listing → buyer (throwaway) opens it → Buy Now on a real
//   buyable listing → checkout opens → STOP (never enters card details).
// Every step is screenshotted to ./smoke-out/, timings over 2 s and frozen
// buttons are reported, and ALL test data is deleted in `finally`
// (listing + storage objects, both throwaway accounts, the checkout reservation).
//
// Requirements: node 20+, `npx playwright install chromium`, gcloud ADC with
// Firestore/Auth admin on teebox-market (functions/node_modules provides
// firebase-admin). Read the README section in scripts/SMOKE.md before running
// against production: it creates and deletes real data.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const requireFns = createRequire(path.join(ROOT, "functions", "package.json"));
const requireRoot = createRequire(path.join(ROOT, "package.json"));
const { chromium, devices } = requireRoot("playwright");
const admin = requireFns("firebase-admin");
admin.initializeApp({ projectId: "teebox-market", credential: admin.credential.applicationDefault(), storageBucket: "teebox-market.firebasestorage.app" });
const db = admin.firestore(); const auth = admin.auth();
const MODE = process.env.MODE || "full";
const WANT_PIXEL = process.argv.includes("--pixel");
if (process.argv.includes("--help")) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("import {")[0]); process.exit(0); }
const OUT = path.join(ROOT, "smoke-out"); fs.mkdirSync(OUT, { recursive: true });
const PHOTO = path.join(OUT, "test-photo.jpg");
if (!fs.existsSync(PHOTO)) { // 1200x1200 labelled JPEG via sharp (functions dep)
  const sharp = requireFns("sharp");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="#e8efe6"/><circle cx="600" cy="560" r="300" fill="#2f5d3a"/><text x="600" y="1050" font-size="72" text-anchor="middle" font-family="Helvetica" fill="#333">SMOKE TEST</text></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(PHOTO);
}
const PIXEL = { events: [] };
const JAKE_LISTING = "F1VEK3FxOKXF02BqC61H";
const SLOW3G = {offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024};
const FAST3G = {offline: false, latency: 562, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024};
let NET = "Slow 3G";
const report = {steps: [], slow: [], frozen: [], consoleErrors: [], pageErrors: [], failedRequests: [], notes: []};
let shot = 0; let sellerUid = null; let testListingId = null;
const now = () => Date.now();
async function snap(page, name) { shot++; const f = path.join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`); await page.screenshot({path: f}).catch(() => {}); return path.basename(f); }
function wire(page, label) {
  if (WANT_PIXEL) page.on("request", (r) => { const u = r.url(); if (/facebook\.com\/tr\/?\?/.test(u)) { try { const q = new URL(u).searchParams; PIXEL.events.push({ page: label, ev: q.get("ev"), content_ids: q.get("cd[content_ids]"), value: q.get("cd[value]"), currency: q.get("cd[currency]"), eid: q.get("eid") }); } catch (_) {} } });
  page.on("console", (m) => { if (m.type() === "error") report.consoleErrors.push(`[${label}] ${m.text().slice(0, 160)}`); });
  page.on("pageerror", (e) => report.pageErrors.push(`[${label}] ${String(e.message || e).slice(0, 160)}`));
  page.on("requestfailed", (r) => { const u = r.url(); if (!/google-analytics|facebook|doubleclick|gstatic.*favicon/i.test(u)) report.failedRequests.push(`[${label}] ${r.failure() && r.failure().errorText} ${u.slice(0, 110)}`); });
  page.on("response", (r) => { if (r.status() >= 400 && /teeboxmarket|firestore|cloudfunctions|firebase/.test(r.url())) report.failedRequests.push(`[${label}] HTTP ${r.status()} ${r.url().slice(0, 110)}`); });
}
async function step(page, name, fn) {
  const t0 = now(); let ok = true, err = null, extra = {};
  try { extra = (await fn()) || {}; } catch (e) { ok = false; err = String(e && e.message || e).slice(0, 200); }
  const ms = now() - t0; const file = await snap(page, name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
  report.steps.push({name, ms, ok, err, shot: file, net: NET, ...extra});
  if (ms > 2000) report.slow.push({name, ms});
  console.log(`${ok ? "✓" : "✗"} ${name} ${ms}ms ${err || ""} ${JSON.stringify(extra)}`);
  return ok;
}
// Click a button and watch whether it comes back to life / outcome appears.
async function clickWatch(page, sel, outcomeSel, label, timeout = 90000) {
  const btn = page.locator(sel).first();
  const t0 = now(); await btn.click({timeout: 15000});
  const samples = [];
  for (const at of [3000, 8000, 15000]) {
    const left = at - (now() - t0); if (left > 0) await page.waitForTimeout(left);
    const state = await btn.evaluate((b) => ({disabled: b.disabled, text: (b.textContent || "").trim().slice(0, 40)})).catch(() => ({gone: true}));
    const outcome = outcomeSel ? await page.locator(outcomeSel).first().isVisible().catch(() => false) : null;
    samples.push({at, ...state, outcome});
    if (outcome) break;
  }
  let outcomeMs = null;
  if (outcomeSel) { try { await page.locator(outcomeSel).first().waitFor({state: "visible", timeout}); outcomeMs = now() - t0; } catch (_) { outcomeMs = -1; } }
  const stuck = samples.length && samples[samples.length - 1].disabled && !samples[samples.length - 1].outcome && outcomeMs === -1;
  if (stuck) report.frozen.push({label, samples});
  if (outcomeMs > 2000) report.slow.push({name: label + " → outcome", ms: outcomeMs});
  return {samples, outcomeMs};
}
async function newPage(browser, label) {
  const ctx = await browser.newContext({...devices["iPhone 14"], locale: "en-US", timezoneId: "America/Chicago"});
  const page = await ctx.newPage(); wire(page, label);
  const cdp = await ctx.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", SLOW3G);
  page.setDefaultTimeout(120000);
  await page.addInitScript(() => { window.__lcp = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({type: "largest-contentful-paint", buffered: true}); } catch (_) {} });
  return {ctx, page, cdp};
}
async function setNet(h, profile, label) { await h.cdp.send("Network.emulateNetworkConditions", profile); NET = label; report.notes.push(`network switched to ${label}`); }
(async () => {
  const browser = await chromium.launch();
  let seller, buyer;
  try {
    // ── Guest browse ──
    seller = await newPage(browser, "seller");
    const p = seller.page;
    await step(p, "guest: home first paint (cold, slow 3G)", async () => {
      const t0 = now(); let dcl = -1; p.once("domcontentloaded", () => { dcl = now() - t0; });
      await p.goto((process.env.BASE || "https://teeboxmarket.com") + "/?_=" + TAG, {waitUntil: "commit", timeout: 120000});
      await p.locator(".product-card").first().waitFor({state: "visible"}); const cards = now() - t0;
      const bootPaint = await p.evaluate(() => Math.round(window.__bootPaintedAt || 0)).catch(() => 0);
      if (dcl < 0) { try { await p.waitForLoadState("domcontentloaded", {timeout: 120000}); dcl = now() - t0; } catch (_) {} }
      const lcp = await p.evaluate(() => Math.round(window.__lcp || 0));
      return {domContentLoadedMs: dcl, firstCardMs: cards, bootPaintMs: bootPaint, lcpMs: lcp};
    });
    await step(p, "guest: first-launch sign-in gate", async () => {
      const gate = await p.locator("#authScreen").isVisible().catch(() => false);
      let dismissMs = null;
      if (gate) { const t0 = now(); await p.locator('[data-action="continue-as-guest"]').click(); await p.locator("#authScreen").waitFor({state: "hidden", timeout: 30000}); dismissMs = now() - t0; }
      report.notes.push(gate ? "First-time guest lands on a full-screen sign-in gate; 'Browse the marketplace first' dismisses it." : "no gate");
      return {gateShown: gate, dismissMs};
    });
    await step(p, "guest: scroll feed", async () => { await p.mouse.wheel(0, 1200); await p.waitForTimeout(1500); await p.mouse.wheel(0, 1200); await p.waitForTimeout(1500); const n = await p.locator(".product-card").count(); return {cardsRendered: n}; });
    await step(p, "guest: open a listing detail", async () => {
      const r = await clickWatch(p, `.product-card[data-product-id="${JAKE_LISTING}"]`, "#detailBuyNowBtn", "guest open detail", 60000);
      const buy = await p.locator("#detailBuyNowBtn").textContent().catch(() => "");
      return {openMs: r.outcomeMs, buyLabel: (buy || "").trim()};
    });
    await step(p, "guest: close detail", async () => { await p.keyboard.press("Escape"); await p.waitForTimeout(800); const open = await p.locator("#detailBuyNowBtn").isVisible().catch(() => false); if (open) { await p.locator('[data-action="close-detail"],[data-action="close-detail-direct"],.modal-close').first().click().catch(() => {}); } });

    if (MODE === "guest") { report.notes.push("mode=guest: stopped before sign-up"); throw new Error("__stop__"); }
    // ── Sign up (guest taps Sell → auth screen → Create Account) ──
    await step(p, "signup: tap Sell as guest → join prompt", async () => {
      const install = await p.locator("#installBanner:not([hidden])").isVisible().catch(() => false);
      if (install) report.notes.push("Install TeeBox banner appears over the bottom of the viewport on the first guest session (covers the lower part of modals).");
      // r349: ONE prompt — the Sell tap opens the auth screen directly (Create Account pane).
      // Older builds showed a "Join TeeBox" interstitial first; handle both.
      const r = await clickWatch(p, '.bottom-nav-item[data-action="handle-sell"]', '#authScreen #emailInput, [data-action="show-auth-from-prompt-signup"]', "guest Sell → sign-up prompt", 30000);
      const interstitial = await p.locator('[data-action="show-auth-from-prompt-signup"]').isVisible().catch(() => false);
      if (interstitial) { report.notes.push("two-step join prompt still present"); await p.locator('[data-action="show-auth-from-prompt-signup"]').click(); await p.locator("#authScreen #emailInput").waitFor({state: "visible", timeout: 30000}); }
      const mode = await p.locator('#authScreen .auth-mode-btn.active').textContent().catch(() => "");
      return {promptMs: r.outcomeMs, twoStep: interstitial, modePreselected: (mode || "").trim(), installBannerShown: install};
    });
    await step(p, "signup: Create Account form", async () => {
      const active = (await p.locator('#authScreen .auth-mode-btn.active').textContent().catch(() => "")).trim();
      if (!/create/i.test(active)) { await p.locator('#authScreen [data-emailmode="signup"]').click(); await p.waitForTimeout(400); }
      await p.fill("#nameSignupInput", "PW Walk Seller"); await p.fill("#emailInput", SELLER_EMAIL); await p.fill("#passwordInput", PW);
    });
    const attempts = [];
    const submitOnce = async (label) => {
      const t0 = now(); await p.locator("#emailSubmitBtn").click();
      const outcome = await Promise.race([
        p.locator("#authScreen").waitFor({state: "hidden", timeout: 120000}).then(() => "signed-in"),
        p.waitForFunction(() => { const e = document.getElementById("authErrorEmail"); return e && e.textContent.trim().length > 0; }, null, {timeout: 120000}).then(() => "error"),
      ]).catch(() => "timeout");
      const ms = now() - t0;
      const err = outcome === "error" ? (await p.locator("#authErrorEmail").textContent()).trim().slice(0, 90) : "";
      const btn = await p.locator("#emailSubmitBtn").evaluate((b) => ({disabled: b.disabled, text: b.textContent.trim()})).catch(() => null);
      let serverHasAccount = false; try { await auth.getUserByEmail(SELLER_EMAIL); serverHasAccount = true; } catch (_) {}
      attempts.push({label, outcome, ms, err, btn, serverHasAccount});
      console.log("  attempt", JSON.stringify(attempts[attempts.length - 1]));
      return outcome;
    };
    await step(p, "signup: submit (attempt 1)", async () => { const o = await submitOnce("create #1"); return {outcome: o, ...attempts[0]}; });
    if (attempts[0].outcome !== "signed-in") {
      await step(p, "signup: submit (attempt 2, same form)", async () => { const o = await submitOnce("create #2"); return {outcome: o, ...attempts[1]}; });
    }
    if (attempts[attempts.length - 1].outcome !== "signed-in") {
      await step(p, "signup: fall back to Sign In with the account attempt 1 created", async () => {
        await p.locator('#authScreen [data-emailmode="signin"]').click(); await p.waitForTimeout(400);
        await p.fill("#emailInput", SELLER_EMAIL); await p.fill("#passwordInput", PW);
        const o = await submitOnce("sign-in"); return {outcome: o, ...attempts[attempts.length - 1]};
      });
    }
    if (attempts[attempts.length - 1].outcome !== "signed-in") {
      report.notes.push("Slow 3G: account creation never completes client-side (30 s SDK timeout) — remaining seller steps ran on Fast 3G.");
      let u = null; try { u = await auth.getUserByEmail(SELLER_EMAIL); } catch (_) {}
      if (!u) u = await auth.createUser({email: SELLER_EMAIL, password: PW, displayName: "PW Walk Seller"});
      await setNet(seller, FAST3G, "Fast 3G");
      await step(p, "signup: Sign In on Fast 3G (same account)", async () => {
        await p.locator('#authScreen [data-emailmode="signin"]').click().catch(() => {}); await p.waitForTimeout(400);
        await p.fill("#emailInput", SELLER_EMAIL); await p.fill("#passwordInput", PW);
        const o = await submitOnce("sign-in fast3g"); if (o !== "signed-in") throw new Error("sign-in failed on Fast 3G: " + JSON.stringify(attempts[attempts.length - 1]));
        return {...attempts[attempts.length - 1]};
      });
    }
    { const u = await auth.getUserByEmail(SELLER_EMAIL); sellerUid = u.uid; const ud = await db.doc(`users/${u.uid}`).get(); const pd = await db.doc(`profiles/${u.uid}`).get(); report.notes.push(`post-signup server state: displayName=${JSON.stringify(u.displayName)} usersDoc=${ud.exists} profilesDoc=${pd.exists}`); console.log("  server state:", {displayName: u.displayName, usersDoc: ud.exists, profilesDoc: pd.exists}); }
    await step(p, "signup: signed-in state", async () => { await p.waitForTimeout(3000); const banner = await p.locator("text=/verify/i").first().textContent({timeout: 5000}).catch(() => ""); return {verifyCopy: (banner || "").trim().slice(0, 100), attempts: attempts.length}; });
    if (MODE === "signup") { report.notes.push("mode=signup: stopped after sign-up"); throw new Error("__stop__"); }
    // Simulate the seller clicking the verification link (admin flip) — the app's "I've verified" path re-checks.
    await auth.updateUser(sellerUid, {emailVerified: true});
    await step(p, "signup: after email verified (I've verified / reload)", async () => {
      const sellOpen = await p.locator("#sellModalBackdrop.open").isVisible().catch(() => false);
      if (!sellOpen) await p.locator('.bottom-nav-item[data-action="handle-sell"]').click();
      await p.locator("#sellModalBackdrop.open").waitFor({state: "visible", timeout: 60000});
      const vp = p.locator("#sellVerifyPrompt");
      if (await vp.isVisible().catch(() => false)) { await p.locator('[data-action="recheck-email-verify"]').click(); await p.waitForTimeout(4000); }
      const headsUp = await p.locator("#sellPayoutHeadsUp").isVisible().catch(() => false);
      const headsText = headsUp ? (await p.locator("#sellPayoutHeadsUp").textContent()).trim().slice(0, 80) : "";
      return {sellModalOpen: true, listFirstHeadsUp: headsUp, headsText};
    });

    // ── Create listing ──
    await step(p, "list: add photo", async () => {
      const t0 = now(); await p.setInputFiles("#photoInput", PHOTO);
      await p.locator("#uploadPreviews img, #uploadPreviews .photo-tile, #uploadPreviews > *").first().waitFor({state: "visible", timeout: 60000});
      return {previewMs: now() - t0};
    });
    await step(p, "list: pick category + fill details", async () => {
      await p.locator('#sellSpecCatPills button[data-speccat="apparel"]').waitFor({state: "visible", timeout: 30000});
      await p.locator('#sellSpecCatPills button[data-speccat="apparel"]').click();
      await p.locator("#sellTitle").waitFor({state: "visible", timeout: 15000});
      try { await p.selectOption("#spec_apparelType", "Polo"); await p.selectOption("#spec_size", "L"); } catch (_e) {}
      await p.fill("#sellTitle", "PW WALK TEST polo (delete me)"); await p.fill("#sellBrand", "Unbranded");
      await p.fill("#sellPrice", "25"); await p.fill("#sellDesc", "Automated QA walk listing — will be deleted within minutes.");
      const catVal = await p.locator("#sellCat").inputValue().catch(() => "");
      const terms = p.locator("#sellTermsRow");
      let termsShown = false; if (await terms.isVisible().catch(() => false)) { termsShown = true; await p.locator("#sellTermsCheckbox").check(); }
      const specErr = await p.locator("#sellSpecFields .field-invalid").count();
      return {cat: catVal, termsShown, specInvalid: specErr};
    });
    await step(p, "list: Post it", async () => {
      const r = await clickWatch(p, "#submitListingBtn", "#stripeRequiredBackdrop.open", "Post it", 180000);
      const errs = await p.locator(".field-error-msg").allTextContents().catch(() => []);
      const dlgTitle = await p.locator("#stripeRequiredTitle").textContent().catch(() => "");
      return {publishMs: r.outcomeMs, btnSamples: r.samples, fieldErrors: errs, dialog: (dlgTitle || "").trim()};
    });
    const mine = await db.collection("listings").where("sellerId", "==", sellerUid).get();
    testListingId = mine.docs[0] && mine.docs[0].id; report.notes.push(`test listing ${testListingId} (${mine.size} created)`);
    await step(p, "list: dismiss payouts dialog", async () => { const b = p.locator('#stripeRequiredBackdrop [data-action="close-stripe-required"]').last(); if (await b.isVisible().catch(() => false)) await b.click(); await p.waitForTimeout(1500); const top = await p.locator(".product-card").first().getAttribute("data-product-id"); return {feedTopIsTestListing: top === testListingId}; });

    // ── Buyer ──
    await auth.createUser({uid: BUYER_UID, email: BUYER_EMAIL, password: PW, emailVerified: true});
    await db.doc(`users/${BUYER_UID}`).set({displayName: "PW Walk Buyer", createdAt: admin.firestore.FieldValue.serverTimestamp()});
    buyer = await newPage(browser, "buyer"); const b = buyer.page;
    await step(b, "buyer: load + sign in", async () => {
      const t0 = now(); await b.goto((process.env.BASE || "https://teeboxmarket.com") + "/?_=b" + TAG, {waitUntil: "domcontentloaded"});
      await b.locator(".product-card").first().waitFor({state: "visible"}); const loaded = now() - t0;
      const gate = await b.locator("#authScreen").isVisible().catch(() => false);
      if (!gate) { await b.locator('.bottom-nav-item[data-action="handle-sell"]').click(); await b.locator('#authScreen #emailInput, [data-action="show-auth-from-prompt-signup"]').first().waitFor({state: "visible", timeout: 30000}); const inter = b.locator('[data-action="show-auth-from-prompt-signup"]'); if (await inter.isVisible().catch(() => false)) await inter.click(); }
      await b.locator("#authScreen #emailInput").waitFor({state: "visible", timeout: 30000});
      const act = (await b.locator('#authScreen .auth-mode-btn.active').textContent().catch(() => "")).trim();
      if (!/sign in/i.test(act)) { await b.locator('#authScreen [data-emailmode="signin"]').click(); await b.waitForTimeout(400); }
      await b.fill("#emailInput", BUYER_EMAIL); await b.fill("#passwordInput", PW);
      const t1 = now(); await b.locator("#emailSubmitBtn").click();
      const o = await Promise.race([
        b.locator("#authScreen").waitFor({state: "hidden", timeout: 120000}).then(() => "signed-in"),
        b.waitForFunction(() => { const e = document.getElementById("authErrorEmail"); return e && e.textContent.trim().length > 0; }, null, {timeout: 120000}).then(() => "error"),
      ]).catch(() => "timeout");
      const r = {outcomeMs: now() - t1, outcome: o, err: o === "error" ? (await b.locator("#authErrorEmail").textContent()).trim().slice(0, 90) : ""};
      if (o !== "signed-in") {
        report.notes.push(`buyer sign-in on Slow 3G: ${o} after ${r.outcomeMs} ms ${r.err}`);
        await setNet(buyer, FAST3G, "Fast 3G");
        const t2 = now(); await b.locator("#emailSubmitBtn").click();
        const o2 = await Promise.race([
          b.locator("#authScreen").waitFor({state: "hidden", timeout: 120000}).then(() => "signed-in"),
          b.waitForFunction(() => { const e = document.getElementById("authErrorEmail"); return e && e.textContent.trim().length > 0 && !/Network error/.test(e.textContent); }, null, {timeout: 120000}).then(() => "error"),
        ]).catch(() => "timeout");
        r.retryFast3g = {outcome: o2, ms: now() - t2};
        if (o2 !== "signed-in") throw new Error("buyer sign-in failed on Fast 3G too: " + JSON.stringify(r));
      }
      await b.waitForTimeout(2000);
      const sm = await b.locator("#sellModalBackdrop.open").isVisible().catch(() => false);
      if (sm) { await b.locator('#sellModalBackdrop [data-action="close-sell-direct"]').first().click().catch(() => {}); await b.waitForTimeout(800); }
      return {loadMs: loaded, signInMs: r.outcomeMs, signInOutcome: r.outcome};
    });
    await step(b, "buyer: open the test listing (un-onboarded seller)", async () => {
      const r = await clickWatch(b, `.product-card[data-product-id="${testListingId}"]`, "#detailBuyNowBtn", "buyer open test listing", 60000);
      await b.waitForTimeout(6000); // seller profile loads async under 3G
      const label = (await b.locator("#detailBuyNowBtn").textContent()).trim();
      const note = (await b.locator("#detailNotBuyableNote").textContent().catch(() => "")).trim().slice(0, 120);
      const disabled = await b.locator("#detailBuyNowBtn").isDisabled();
      return {openMs: r.outcomeMs, buyLabel: label, disabled, note};
    });
    await step(b, "buyer: close detail", async () => { await b.locator('.modal-close, [data-action="close-detail"], [data-action="close-detail-direct"]').first().click().catch(() => b.keyboard.press("Escape")); await b.waitForTimeout(1000); });
    await step(b, "buyer: open a buyable listing → Buy Now → checkout (STOP)", async () => {
      await clickWatch(b, `.product-card[data-product-id="${JAKE_LISTING}"]`, "#detailBuyNowBtn", "buyer open buyable", 60000);
      await b.waitForTimeout(5000);
      const label = (await b.locator("#detailBuyNowBtn").textContent()).trim();
      const r = await clickWatch(b, "#detailBuyNowBtn", "#checkoutBackdrop.open", "Buy Now → checkout", 90000);
      const t0 = now(); let stripeMs = -1;
      try { await b.locator('#checkoutBackdrop iframe[name^="__privateStripeFrame"], #checkoutBackdrop iframe[src*="stripe"]').first().waitFor({state: "attached", timeout: 120000}); stripeMs = now() - t0; } catch (_) {}
      await b.waitForTimeout(3000);
      const payBtn = await b.locator("#payBtn").evaluate((x) => ({disabled: x.disabled, text: x.textContent.trim()})).catch(() => null);
      const errText = (await b.locator("#checkoutError, .checkout-error").first().textContent().catch(() => "")).trim().slice(0, 120);
      return {buyLabel: label, checkoutOpenMs: r.outcomeMs, stripeElementMs: stripeMs, payBtn, checkoutError: errText, STOPPED_BEFORE_CARD: true};
    });
    await step(b, "buyer: close checkout", async () => { await b.locator('#checkoutBackdrop [data-action="close-checkout-direct"]').first().click().catch(() => {}); await b.waitForTimeout(1000); });
  } catch (e) { if (String(e && e.message) !== "__stop__") { report.fatal = String(e && e.stack || e).slice(0, 600); console.error("FATAL", e); } }
  finally {
    // ── Cleanup ──
    const clean = {};
    try {
      if (testListingId) {
        await db.doc(`listings/${testListingId}`).delete(); clean.listingDeleted = testListingId;
        const [files] = await admin.storage().bucket().getFiles({prefix: `listings/${testListingId}/`}); for (const f of files) await f.delete().catch(() => {}); clean.storageObjectsDeleted = files.length;
        const holds = await db.collection("listingHolds").doc(testListingId).get(); if (holds.exists) { await holds.ref.delete(); clean.holdDeleted = true; }
      }
      if (sellerUid) { const u = await db.collection("listings").where("sellerId", "==", sellerUid).get(); for (const d of u.docs) await d.ref.delete(); }
      for (const uid of [sellerUid, BUYER_UID].filter(Boolean)) {
        for (const sub of ["rateLimits", "notifications", "fcmTokens"]) { const s = await db.collection(`users/${uid}/${sub}`).get(); for (const d of s.docs) await d.ref.delete().catch(() => {}); }
        await db.doc(`users/${uid}`).delete().catch(() => {}); await db.doc(`profiles/${uid}`).delete().catch(() => {}); await auth.deleteUser(uid).catch(() => {});
      }
      if (!sellerUid) { try { const u = await auth.getUserByEmail(SELLER_EMAIL); await db.doc(`users/${u.uid}`).delete().catch(() => {}); await auth.deleteUser(u.uid); clean.orphanSellerDeleted = true; } catch (_) {} }
      clean.usersDeleted = [sellerUid, BUYER_UID].filter(Boolean).length;
      // release the checkout reservation the Buy Now tap placed on Jake's listing
      const jl = await db.doc(`listings/${JAKE_LISTING}`).get(); const d = jl.data() || {};
      clean.jakeListingBefore = {status: d.status, quantityReserved: d.quantityReserved || 0, pendingBuyer: d.pendingBuyer ? "set" : null};
      if (d.pendingBuyer === BUYER_UID || (d.quantityReserved || 0) > 0) {
        await jl.ref.update({quantityReserved: 0, pendingBuyer: admin.firestore.FieldValue.delete(), pendingUntil: admin.firestore.FieldValue.delete(), pendingPaymentIntentId: admin.firestore.FieldValue.delete(), ...(d.status === "pending" ? {status: "active"} : {})});
        clean.jakeListingReleased = true;
      }
    } catch (e) { clean.error = String(e && e.message || e); }
    report.cleanup = clean;
    if (WANT_PIXEL) {
      const seen = (ev) => PIXEL.events.filter((e) => e.ev === ev);
      report.pixel = {};
      for (const ev of ["PageView", "ViewContent", "AddToCart", "InitiateCheckout"]) {
        const hits = seen(ev); const withIds = hits.filter((h) => h.content_ids); const withValue = hits.filter((h) => h.value);
        report.pixel[ev] = { fired: hits.length, withContentIds: withIds.length, withValue: withValue.length, pass: ev === "PageView" ? hits.length > 0 : (hits.length > 0 && withIds.length > 0 && (ev === "ViewContent" || withValue.length > 0)) };
      }
      console.log("PIXEL", JSON.stringify(report.pixel));
    }
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
    console.log(JSON.stringify({slow: report.slow, frozen: report.frozen, cleanup: clean, consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length, failedRequests: report.failedRequests.length}, null, 1));
    await browser.close().catch(() => {}); process.exit(0);
  }
})();
