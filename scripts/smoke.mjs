#!/usr/bin/env node
// scripts/smoke.mjs — TeeBox end-to-end smoke walk (Playwright + Firebase Admin).
//
//   node scripts/smoke.mjs                       # production, full walk, Slow 3G first
//   BASE=http://127.0.0.1:8788 node scripts/smoke.mjs
//   MODE=signup node scripts/smoke.mjs           # stop after account creation
//   MODE=guest  node scripts/smoke.mjs           # cold load + browse only (no accounts)
//   MODE=pixel  node scripts/smoke.mjs --pixel   # guest + buyer/checkout legs only (no listing created)
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
const PIXEL = { events: [], blocked: [] };
const TAG = "pw" + Date.now().toString(36); const PW = "PwWalk!" + TAG;
// Smoke accounts live on the RFC-reserved .invalid TLD: nothing can ever deliver to them, and the
// cleanup guard below refuses to delete anything owned by an account outside this domain.
const SMOKE_DOMAIN = "@teeboxtest.invalid";
const SMOKE_TITLE = "PW WALK TEST polo (delete me)";
const SELLER_EMAIL = `${TAG}-seller${SMOKE_DOMAIN}`, BUYER_EMAIL = `${TAG}-buyer${SMOKE_DOMAIN}`, BUYER_UID = `pwbuyer_${TAG}`;
const CREATED_UIDS = new Set();
// Hard guard: a uid may only be touched by cleanup if WE created it this run AND its email is a
// smoke address. Throws loudly otherwise — nothing is deleted on a guard failure.
async function assertSmokeAccount(uid, what) {
  if (!uid || !CREATED_UIDS.has(uid)) throw new Error(`SMOKE GUARD: refusing ${what} — uid not created by this run`);
  let u = null; try { u = await auth.getUser(uid); } catch (_) {}
  const email = (u && u.email) || "";
  if (!email.toLowerCase().endsWith(SMOKE_DOMAIN)) throw new Error(`SMOKE GUARD: refusing ${what} — account email is not a smoke address`);
  return u;
}
// Everything the pixel would send to Meta (browser beacons, the Conversions API Gateway, and the
// client→capiRelay call) is captured for --pixel reporting and ABORTED, so a smoke run never
// reaches ad data. Nothing else is blocked.
const META_BLOCK = [/https:\/\/www\.facebook\.com\/tr(\/|\?|$)/, /https:\/\/www\.facebook\.com\/privacy_sandbox\//, /https:\/\/[^/]*\.on\.aws\//, /https:\/\/[^/]*\.run\.app\/events\?/, /cloudfunctions\.net\/capiRelay/, /\/capiRelay\b/, /capirelay-[a-z0-9]+-uc\.a\.run\.app/i];
// Buy Now / checkout target. NEVER a real seller's listing: by default the smoke listing this run
// creates (its seller is un-onboarded, so the leg verifies the "tap to get notified" slot and no
// PaymentIntent is created). SMOKE_BUYABLE_LISTING may name a listing owned by a *smoke* account
// that has payouts set up; assertSmokeListing() refuses anything else before the tap.
const BUYABLE_LISTING_ENV = process.env.SMOKE_BUYABLE_LISTING || null;
async function assertSmokeListing(listingId, what) {
  const snap = await db.doc(`listings/${listingId}`).get();
  if (!snap.exists) throw new Error(`SMOKE GUARD: ${what} — listing ${listingId} does not exist`);
  const sellerId = snap.data().sellerId;
  let email = ""; try { email = (await auth.getUser(sellerId)).email || ""; } catch (_) {}
  if (!email.toLowerCase().endsWith(SMOKE_DOMAIN)) throw new Error(`SMOKE GUARD: ${what} — listing ${listingId} is NOT owned by a smoke account; refusing to touch a real seller's listing`);
  return snap.data();
}
const SLOW3G = {offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024};
const FAST3G = {offline: false, latency: 562, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024};
let NET = "Slow 3G";
const report = {steps: [], slow: [], frozen: [], consoleErrors: [], pageErrors: [], failedRequests: [], notes: []};
let shot = 0; let sellerUid = null; let testListingId = null; let BUY_TARGET_FOR_CLEANUP = null;
const now = () => Date.now();
async function snap(page, name) { shot++; const f = path.join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`); await page.screenshot({path: f}).catch(() => {}); return path.basename(f); }
function wire(page, label) {
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

// r366/r367: first-visit overlays. The welcome screen covers the nav for a
// fresh guest; Phase 2's provider sheet is the first step of every sign-in
// prompt. Both helpers are no-ops when the surface isn't there.
async function skipWelcome(pg) {
  try {
    const open = await pg.evaluate(() => !!document.getElementById("welcomeScreen")?.classList.contains("open"));
    if (open) { await pg.locator('[data-action="welcome-skip"]').first().click({timeout: 10000}); await pg.waitForTimeout(400); }
    return open;
  } catch (_e) { return false; }
}
async function skipAuthSheet(pg) {
  try {
    const open = await pg.evaluate(() => !!document.getElementById("authSheetBackdrop")?.classList.contains("open"));
    if (open) { await pg.locator('[data-action="sheet-email"]').first().click({timeout: 10000}); await pg.waitForTimeout(400); }
    return open;
  } catch (_e) { return false; }
}
async function newPage(browser, label) {
  const ctx = await browser.newContext({...devices["iPhone 14"], locale: "en-US", timezoneId: "America/Chicago"});
  const page = await ctx.newPage(); wire(page, label);
  await ctx.route((url) => META_BLOCK.some((re) => re.test(url.href)), (route) => { const u = route.request().url(); try { if (/facebook\.com\/tr/.test(u)) { let q = new URL(u).searchParams; if (!q.get("ev")) { const body = route.request().postData() || ""; if (/^--/.test(body)) { q = new URLSearchParams(); const re = /name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n--/g; let m; while ((m = re.exec(body))) q.set(m[1], m[2]); } else { try { q = new URLSearchParams(body); } catch (_) {} } } PIXEL.events.push({ page: label, ev: q.get("ev"), content_ids: q.get("cd[content_ids]"), value: q.get("cd[value]"), currency: q.get("cd[currency]"), eid: q.get("eid") }); } else { PIXEL.blocked.push(u.slice(0, 100)); } } catch (_) {} route.fulfill({ status: 204, body: "" }); });
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
    // ── Preflight: Meta blocker must intercept every pixel/CAPI request ──
    // Loads the site once, opens a listing (PageView + ViewContent), and compares what the page
    // *requested* against what the route *intercepted*. Any Meta request that was not intercepted
    // aborts the run before an account or listing is created.
    {
      const pre = await newPage(browser, "preflight");
      const requested = []; pre.page.on("request", (r) => { const u = r.url(); if (/facebook\.com|on\.aws|run\.app\/events|capiRelay/i.test(u) && !/connect\.facebook\.net/.test(u)) requested.push(u); });
      const seenBefore = PIXEL.events.length + PIXEL.blocked.length;
      await pre.page.goto((process.env.BASE || "https://teeboxmarket.com") + "/?_=pre" + TAG, {waitUntil: "commit", timeout: 120000});
      await pre.page.locator(".product-card").first().waitFor({state: "visible", timeout: 120000});
      await pre.page.waitForTimeout(8000); await pre.page.locator(".product-card").first().click().catch(() => {}); await pre.page.waitForTimeout(8000);
      const intercepted = PIXEL.events.length + PIXEL.blocked.length - seenBefore;
      const leaked = requested.length - intercepted;
      report.preflight = {metaRequests: requested.length, intercepted, leaked: Math.max(0, leaked)};
      await pre.ctx.close();
      if (requested.length === 0) report.notes.push("preflight: no Meta requests observed (pixel off or blocked upstream)");
      if (leaked > 0) throw new Error(`PREFLIGHT FAILED: ${leaked} Meta request(s) were not intercepted — fix META_BLOCK before running; nothing was created`);
      console.log("preflight ok:", JSON.stringify(report.preflight));
    }
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
      // r352: judge the gate by computed style + class at first paint (the earlier isVisible()
      // check missed the r327 optimistic open), and keep a screenshot as evidence.
      const gate = await p.evaluate(() => { const g = document.getElementById("authScreen"); if (!g) return false; const cs = getComputedStyle(g); return g.classList.contains("open") && cs.display !== "none" && cs.visibility !== "hidden"; }).catch(() => false);
      let dismissMs = null;
      if (gate) { const t0 = now(); await p.locator('[data-action="continue-as-guest"]').click(); await p.locator("#authScreen").waitFor({state: "hidden", timeout: 30000}); dismissMs = now() - t0; }
      report.notes.push(gate ? "First-time guest lands on a full-screen sign-in gate; 'Browse the marketplace first' dismisses it." : "no gate");
      return {gateShown: gate, dismissMs};
    });
    // r366: first-visit guests get the welcome (opening) screen. It must be
    // present for a fresh guest and Skip must drop them into the marketplace.
    await step(p, "guest: welcome screen → Skip", async () => {
      const open = await p.evaluate(() => !!document.getElementById("welcomeScreen")?.classList.contains("open"));
      if (open) { await p.locator('[data-action="welcome-skip"]').first().click({timeout: 10000}); await p.waitForTimeout(400); }
      const still = await p.evaluate(() => !!document.getElementById("welcomeScreen")?.classList.contains("open"));
      if (still) throw new Error("welcome did not close after Skip");
      return {welcomeShown: open};
    });
    await step(p, "guest: scroll feed", async () => { await p.mouse.wheel(0, 1200); await p.waitForTimeout(1500); await p.mouse.wheel(0, 1200); await p.waitForTimeout(1500); const n = await p.locator(".product-card").count(); return {cardsRendered: n}; });
    await step(p, "guest: open a listing detail", async () => {
      const r = await clickWatch(p, `.product-card`, "#detailBuyNowBtn", "guest open detail", 60000);
      const buy = await p.locator("#detailBuyNowBtn").textContent().catch(() => "");
      return {openMs: r.outcomeMs, buyLabel: (buy || "").trim()};
    });
    await step(p, "guest: close detail", async () => { await p.keyboard.press("Escape"); await p.waitForTimeout(800); const open = await p.locator("#detailBuyNowBtn").isVisible().catch(() => false); if (open) { await p.locator('[data-action="close-detail"],[data-action="close-detail-direct"],.modal-close').first().click().catch(() => {}); } });

    // r358: the hamburger drawer's links were dead for 4 days (r349→r357) and
    // no smoke step touched the drawer. Tap About from the drawer and REQUIRE
    // the modal to open — a drawer that only closes itself is a failure.
    await step(p, "guest: drawer → About TeeBox opens", async () => {
      await p.locator(".mobile-nav-toggle:visible").first().click({timeout: 10000});
      await p.waitForTimeout(500);
      const drawerOpen = await p.evaluate(() => !!document.getElementById("mobileNavDrawer")?.classList.contains("open"));
      await p.locator('#mobileNavDrawer [data-action="open-about"]').first().click({timeout: 10000});
      await p.waitForTimeout(700);
      const aboutOpen = await p.evaluate(() => !!document.getElementById("aboutBackdrop")?.classList.contains("open"));
      if (!aboutOpen) throw new Error("About modal did not open from the drawer (drawerOpen=" + drawerOpen + ")");
      await p.locator('#aboutBackdrop [data-action="close-info"]').first().click({timeout: 5000}).catch(() => {});
      await p.waitForTimeout(300);
      return {drawerOpen, aboutOpen};
    });

    if (MODE === "guest") { report.notes.push("mode=guest: stopped before sign-up"); throw new Error("__stop__"); }
    if (MODE !== "pixel") {
    // ── Sign up (guest taps Sell → auth screen → Create Account) ──
    await step(p, "signup: tap Sell as guest → join prompt", async () => {
      const install = await p.locator("#installBanner:not([hidden])").isVisible().catch(() => false);
      if (install) report.notes.push("Install TeeBox banner appears over the bottom of the viewport on the first guest session (covers the lower part of modals).");
      // r349: ONE prompt — the Sell tap opens the auth screen directly (Create Account pane).
      // Older builds showed a "Join TeeBox" interstitial first; handle both.
      // r367: the Sell tap opens the provider sheet ("Sign up for TeeBox") first; "Continue with
      // email" reveals the Create Account form underneath.
      const r = await clickWatch(p, '.bottom-nav-item[data-action="handle-sell"]', '#authSheetBackdrop.open, #authScreen #emailInput, [data-action="show-auth-from-prompt-signup"]', "guest Sell → sign-up prompt", 30000);
      const sheet = await skipAuthSheet(p);
      if (sheet) report.notes.push("Sell tap → provider sheet (Apple/Google/email) → Continue with email");
      const interstitial = await p.locator('[data-action="show-auth-from-prompt-signup"]').isVisible().catch(() => false);
      if (interstitial) { report.notes.push("two-step join prompt still present"); await p.locator('[data-action="show-auth-from-prompt-signup"]').click(); await skipAuthSheet(p); await p.locator("#authScreen #emailInput").waitFor({state: "visible", timeout: 30000}); }
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
    await step(p, "signup: submit (attempt 1)", async () => { const o = await submitOnce("create #1"); return {outcome: o, ...(attempts[0] || {})}; });
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
      CREATED_UIDS.add(u.uid);
      await setNet(seller, FAST3G, "Fast 3G");
      await step(p, "signup: Sign In on Fast 3G (same account)", async () => {
        await p.locator('#authScreen [data-emailmode="signin"]').click().catch(() => {}); await p.waitForTimeout(400);
        await p.fill("#emailInput", SELLER_EMAIL); await p.fill("#passwordInput", PW);
        const o = await submitOnce("sign-in fast3g"); if (o !== "signed-in") throw new Error("sign-in failed on Fast 3G: " + JSON.stringify(attempts[attempts.length - 1]));
        return {...attempts[attempts.length - 1]};
      });
    }
    { const u = await auth.getUserByEmail(SELLER_EMAIL); sellerUid = u.uid; CREATED_UIDS.add(sellerUid); const ud = await db.doc(`users/${u.uid}`).get(); const pd = await db.doc(`profiles/${u.uid}`).get(); report.notes.push(`post-signup server state: displayName=${JSON.stringify(u.displayName)} usersDoc=${ud.exists} profilesDoc=${pd.exists}`); console.log("  server state:", {displayName: u.displayName, usersDoc: ud.exists, profilesDoc: pd.exists}); }
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

    } // end MODE !== "pixel"
    // ── Buyer ──
    await auth.createUser({uid: BUYER_UID, email: BUYER_EMAIL, password: PW, emailVerified: true}); CREATED_UIDS.add(BUYER_UID);
    await db.doc(`users/${BUYER_UID}`).set({displayName: "PW Walk Buyer", createdAt: admin.firestore.FieldValue.serverTimestamp()});
    buyer = await newPage(browser, "buyer"); const b = buyer.page;
    await step(b, "buyer: load + sign in", async () => {
      const t0 = now(); await b.goto((process.env.BASE || "https://teeboxmarket.com") + "/?_=b" + TAG, {waitUntil: "domcontentloaded"});
      await b.locator(".product-card").first().waitFor({state: "visible"}); const loaded = now() - t0;
      await skipWelcome(b);
      const gate = await b.locator("#authScreen").isVisible().catch(() => false);
      if (!gate) { await b.locator('.bottom-nav-item[data-action="handle-sell"]').click(); await b.locator('#authScreen #emailInput, [data-action="show-auth-from-prompt-signup"]').first().waitFor({state: "visible", timeout: 30000}); const inter = b.locator('[data-action="show-auth-from-prompt-signup"]'); if (await inter.isVisible().catch(() => false)) await inter.click(); }
      await skipAuthSheet(b); await b.locator("#authScreen #emailInput").waitFor({state: "visible", timeout: 30000});
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
    if (testListingId) await step(b, "buyer: open the test listing (un-onboarded seller)", async () => {
      const r = await clickWatch(b, `.product-card[data-product-id="${testListingId}"]`, "#detailBuyNowBtn", "buyer open test listing", 60000);
      await b.waitForTimeout(6000); // seller profile loads async under 3G
      const label = (await b.locator("#detailBuyNowBtn").textContent()).trim();
      const note = (await b.locator("#detailNotBuyableNote").textContent().catch(() => "")).trim().slice(0, 120);
      const disabled = await b.locator("#detailBuyNowBtn").isDisabled();
      return {openMs: r.outcomeMs, buyLabel: label, disabled, note};
    });
    // r353 fix: the un-filtered selector matched ~30 close buttons and .first() was a
    // HIDDEN info-modal X, so the click waited the full 120 s default timeout before
    // falling back to Escape on every run. Visible-only, short timeout, then Escape.
    await step(b, "buyer: close detail", async () => { await b.locator('.modal-close:visible, [data-action="close-detail"]:visible, [data-action="close-detail-direct"]:visible').first().click({timeout: 5000}).catch(() => b.keyboard.press("Escape")); await b.waitForTimeout(1000); });
    const BUY_TARGET = BUYABLE_LISTING_ENV || testListingId; BUY_TARGET_FOR_CLEANUP = BUY_TARGET;
    if (BUY_TARGET) await step(b, "buyer: Buy Now on the smoke listing → checkout (STOP)", async () => {
      await assertSmokeListing(BUY_TARGET, "Buy Now");
      await clickWatch(b, `.product-card[data-product-id="${BUY_TARGET}"]`, "#detailBuyNowBtn", "buyer open smoke listing", 60000);
      await b.waitForTimeout(5000);
      const label = (await b.locator("#detailBuyNowBtn").textContent()).trim();
      if (/finishing setup/i.test(label)) { report.notes.push("checkout leg: smoke seller is un-onboarded → Buy slot is the notify CTA; no PaymentIntent created (set SMOKE_BUYABLE_LISTING to a payouts-enabled smoke listing to exercise Stripe)"); return {buyLabel: label, checkoutSkipped: true}; }
      const r = await clickWatch(b, "#detailBuyNowBtn", "#checkoutBackdrop.open", "Buy Now → checkout", 90000);
      const t0 = now(); let stripeMs = -1;
      try { await b.locator('#checkoutBackdrop iframe[name^="__privateStripeFrame"], #checkoutBackdrop iframe[src*="stripe"]').first().waitFor({state: "attached", timeout: 120000}); stripeMs = now() - t0; } catch (_) {}
      await b.waitForTimeout(3000);
      const payBtn = await b.locator("#payBtn").evaluate((x) => ({disabled: x.disabled, text: x.textContent.trim()})).catch(() => null);
      const errText = (await b.locator("#checkoutError, .checkout-error").first().textContent().catch(() => "")).trim().slice(0, 120);
      return {buyLabel: label, checkoutOpenMs: r.outcomeMs, stripeElementMs: stripeMs, payBtn, checkoutError: errText, STOPPED_BEFORE_CARD: true};
    });
    // r353 fix: in the default (notify-slot) leg there is no checkout, so this click used
    // to wait 120 s for a button that never existed. Only click when the checkout is open.
    await step(b, "buyer: close checkout", async () => { const open = await b.locator("#checkoutBackdrop.open").count().catch(() => 0); if (open) await b.locator('#checkoutBackdrop [data-action="close-checkout-direct"]:visible').first().click({timeout: 5000}).catch(() => b.keyboard.press("Escape")); else await b.keyboard.press("Escape").catch(() => {}); await b.waitForTimeout(600); return {checkoutWasOpen: !!open}; });
  } catch (e) { if (String(e && e.message) !== "__stop__") { report.fatal = String(e && e.stack || e).slice(0, 600); console.error("FATAL", e); } }
  finally {
    // ── Cleanup (guarded) ──
    const clean = {guard: "ok"};
    try {
      // The UI-created seller (sign-up leg) is ours too: resolve its uid by the smoke email.
      if (!sellerUid) { try { const u = await auth.getUserByEmail(SELLER_EMAIL); sellerUid = u.uid; CREATED_UIDS.add(u.uid); } catch (_) {} }
      // 0. Guard both accounts BEFORE any delete. A failure aborts the whole cleanup loudly.
      const guarded = [];
      for (const uid of [sellerUid, BUYER_UID].filter(Boolean)) { try { await assertSmokeAccount(uid, `cleanup of ${uid.slice(0, 6)}…`); guarded.push(uid); } catch (e) { if (/not created by this run/.test(e.message) && uid === BUYER_UID) continue; throw e; } }
      // 1. Test listing: only docs owned by the guarded seller AND carrying the smoke title.
      if (sellerUid && guarded.includes(sellerUid)) {
        const mine = await db.collection("listings").where("sellerId", "==", sellerUid).get();
        clean.listingsDeleted = [];
        for (const d of mine.docs) {
          if (d.data().title !== SMOKE_TITLE) { clean.skippedUnexpectedListing = (clean.skippedUnexpectedListing || 0) + 1; console.error("SMOKE GUARD: listing", d.id, "owned by the smoke seller does not carry the smoke title — left in place"); continue; }
          const [files] = await admin.storage().bucket().getFiles({prefix: `listings/${sellerUid}/${d.id}/`});
          for (const f of files) await f.delete().catch(() => {});
          await d.ref.delete(); clean.listingsDeleted.push({id: d.id, storageObjects: files.length});
          const hold = await db.collection("listingHolds").doc(d.id).get(); if (hold.exists) { await hold.ref.delete(); clean.holdDeleted = true; }
        }
      }
      // 2. Accounts + their subcollections (guarded uids only).
      for (const uid of guarded) {
        for (const sub of ["rateLimits", "notifications", "fcmTokens"]) { const x = await db.collection(`users/${uid}/${sub}`).get(); for (const d of x.docs) await d.ref.delete().catch(() => {}); }
        await db.doc(`users/${uid}`).delete().catch(() => {}); await db.doc(`profiles/${uid}`).delete().catch(() => {}); await auth.deleteUser(uid).catch(() => {});
      }
      clean.usersDeleted = guarded.length;
      // 3. The checkout reservation the buyer's Buy Now placed on the real listing: cancel the
      //    PaymentIntent (never confirmed) and release the hold — only if it is OUR buyer's.
      const jl = BUY_TARGET_FOR_CLEANUP ? await db.doc(`listings/${BUY_TARGET_FOR_CLEANUP}`).get() : null; const d = (jl && jl.data()) || {};
      clean.buyTargetBefore = jl ? {id: BUY_TARGET_FOR_CLEANUP, status: d.status, quantityReserved: d.quantityReserved || 0, pendingBuyerIsOurs: d.pendingBuyer === BUYER_UID} : "none";
      if (jl && d.pendingBuyer === BUYER_UID) {
        const piId = d.pendingPaymentIntentId || null;
        if (piId) {
          try {
            const {execFileSync} = await import("node:child_process");
            const key = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret", "STRIPE_SECRET_KEY", "--project", "teebox-market"], {encoding: "utf8"}).trim();
            const stripe = requireFns("stripe")(key);
            const pi = await stripe.paymentIntents.cancel(piId, {cancellation_reason: "abandoned"});
            clean.paymentIntentCancelled = {id: pi.id, status: pi.status};
          } catch (e) { clean.paymentIntentCancelError = String(e && e.message || e).slice(0, 160); clean.paymentIntentId = piId; }
        }
        await jl.ref.update({quantityReserved: 0, pendingBuyer: admin.firestore.FieldValue.delete(), pendingUntil: admin.firestore.FieldValue.delete(), pendingPaymentIntentId: admin.firestore.FieldValue.delete(), ...(d.status === "pending" ? {status: "active"} : {})});
        clean.buyTargetReleased = true;
      }
    } catch (e) { clean.guard = "FAILED"; clean.error = String(e && e.message || e); console.error("CLEANUP ABORTED:", clean.error); }
    report.cleanup = clean;
    if (WANT_PIXEL) {
      const seen = (ev) => PIXEL.events.filter((e) => e.ev === ev);
      report.pixel = {};
      for (const ev of ["PageView", "ViewContent", "AddToCart", "InitiateCheckout"]) {
        const hits = seen(ev); const withIds = hits.filter((h) => h.content_ids); const withValue = hits.filter((h) => h.value);
        report.pixel[ev] = { fired: hits.length, withContentIds: withIds.length, withValue: withValue.length, pass: ev === "PageView" ? hits.length > 0 : (hits.length > 0 && withIds.length > 0 && (ev === "ViewContent" || withValue.length > 0)) };
      }
      report.pixel.deliveredToMeta = 0; report.pixel.blockedRequests = PIXEL.blocked.length; report.pixel.blockedSample = PIXEL.blocked.slice(0, 6); report.pixel.rawEvents = PIXEL.events.slice(0, 20);
      console.log("PIXEL", JSON.stringify(report.pixel));
    }
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
    console.log(JSON.stringify({slow: report.slow, frozen: report.frozen, cleanup: clean, consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length, failedRequests: report.failedRequests.length}, null, 1));
    await browser.close().catch(() => {}); process.exit(0);
  }
})();
