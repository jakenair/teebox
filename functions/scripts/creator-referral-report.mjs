#!/usr/bin/env node
/**
 * functions/scripts/creator-referral-report.mjs
 *
 * The payout ledger for the creator SELLER-BOUNTY pilot.
 *
 * Joins: creator codes (.internal-docs/creator-codes.json)
 *      → referralClaims/{uid}   (first-touch, create-once, see firestore.rules)
 *      → that account's listings
 * and reports who has cleared the activation bar and what is owed.
 *
 * WHY A SCRIPT AND NOT A DASHBOARD
 * Five creators and a monthly manual payout do not justify a web surface, an
 * admin auth path and a new callable. A script that prints a ledger is the
 * whole product until the pilot proves itself — and it is the thing you would
 * have had to write anyway to verify a dashboard was telling the truth.
 *
 * ATTRIBUTION RULES IMPLEMENTED HERE, NOT IN FIRESTORE RULES
 * An unknown code pays nobody. A self-referral is flagged, never paid
 * (Dylan's fraud rule, §7). Both are report-time decisions on purpose: rules
 * cannot know who a creator is, and baking a code allow-list into rules would
 * mean a rules deploy every time a creator is onboarded.
 *
 * PRIVACY: aggregates and counts only. No email, display name or uid is
 * printed, and nothing is written to disk. Seller identity is shown as a
 * truncated uid purely so a disputed bounty can be chased.
 *
 * Usage:
 *   node functions/scripts/creator-referral-report.mjs
 *   node functions/scripts/creator-referral-report.mjs --json
 */

import admin from "firebase-admin";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const AS_JSON = process.argv.includes("--json");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODES = path.join(ROOT, ".internal-docs", "creator-codes.json");

admin.initializeApp({projectId: "teebox-market"});
const db = admin.firestore();

const usd = (n) => "$" + Number(n).toFixed(2);

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CODES, "utf8"));
  const pilot = cfg.pilot || {};
  const THRESH = Number(pilot.activationThreshold) || 5;
  const BOUNTY = Number(pilot.bountyUsd) || 20;
  const BONUS = Number(pilot.volumeBonusUsd) || 250;
  const BONUS_AT = Number(pilot.volumeBonusListings) || 100;
  const CAP = Number(pilot.exposureCapUsd) || 2500;
  const MIN = Number(pilot.payoutMinimumUsd) || 50;

  // code (upper) -> creator
  const byCode = new Map();
  for (const c of cfg.creators || []) {
    if (!c.code) continue;
    byCode.set(String(c.code).toUpperCase(), c);
  }

  const claimSnap = await db.collection("referralClaims").get();
  const listSnap = await db.collection("listings").get();

  // uid -> listing count
  const listings = new Map();
  listSnap.forEach((d) => {
    const o = d.data() || {};
    const uid = o.sellerId || o.userId;
    if (!uid) return;
    listings.set(uid, (listings.get(uid) || 0) + 1);
  });

  const perCreator = new Map();
  let unmatched = 0, unmatchedListings = 0;

  claimSnap.forEach((d) => {
    const uid = d.id;
    const code = String((d.data() || {}).code || "").toUpperCase();
    const n = listings.get(uid) || 0;
    const creator = byCode.get(code);
    if (!creator) {                       // unknown code — pays nobody
      unmatched++; unmatchedListings += n;
      return;
    }
    const key = creator.code.toUpperCase();
    if (!perCreator.has(key)) {
      perCreator.set(key, {creator, referred: 0, activated: 0, listings: 0, selfFlags: [], rows: []});
    }
    const e = perCreator.get(key);
    const isSelf = (creator.selfUids || []).includes(uid);
    e.referred += 1;
    e.listings += n;
    if (isSelf) e.selfFlags.push({uid: uid.slice(0, 6), listings: n});
    else if (n >= THRESH) e.activated += 1;
    e.rows.push({uid: uid.slice(0, 6), listings: n, activated: !isSelf && n >= THRESH, self: isSelf});
  });

  let owedTotal = 0;
  const out = [];
  for (const [, e] of perCreator) {
    const bounties = e.activated * BOUNTY;
    const bonus = e.listings >= BONUS_AT ? BONUS : 0;
    const owed = bounties + bonus;
    owedTotal += owed;
    out.push({
      creator: e.creator.name || e.creator.code,
      code: e.creator.code,
      referredSignups: e.referred,
      activatedSellers: e.activated,
      listings: e.listings,
      bountiesUsd: bounties,
      volumeBonusUsd: bonus,
      owedUsd: owed,
      payableNow: owed >= MIN,
      w9OnFile: !!e.creator.w9OnFile,
      selfReferralFlags: e.selfFlags,
      rows: e.rows,
    });
  }
  out.sort((a, b) => b.owedUsd - a.owedUsd);

  if (AS_JSON) { console.log(JSON.stringify({pilot, creators: out, unmatched, owedTotal}, null, 2)); return; }

  console.log("\n  CREATOR SELLER-BOUNTY LEDGER");
  console.log("  " + new Date().toISOString().slice(0, 19) + "Z");
  console.log(`  bar: ${THRESH}+ listings = activated · ${usd(BOUNTY)}/activation · ` +
              `${usd(BONUS)} at ${BONUS_AT} listings · cap ${usd(CAP)} · payout min ${usd(MIN)}\n`);

  if (!byCode.size) {
    console.log("  No creators configured yet — add them to .internal-docs/creator-codes.json.");
  } else if (!out.length) {
    console.log("  Codes are live but nobody has signed up through one yet.");
  }

  for (const c of out) {
    console.log(`  ${c.creator}  [${c.code}]`);
    console.log(`     referred signups : ${c.referredSignups}`);
    console.log(`     activated sellers: ${c.activatedSellers}   (${THRESH}+ listings)`);
    console.log(`     listings brought : ${c.listings}`);
    console.log(`     owed             : ${usd(c.owedUsd)}  ` +
                `(${usd(c.bountiesUsd)} bounties${c.volumeBonusUsd ? " + " + usd(c.volumeBonusUsd) + " volume bonus" : ""})`);
    if (!c.payableNow && c.owedUsd > 0) console.log(`     ⏸  below the ${usd(MIN)} minimum — rolls to next month`);
    if (c.owedUsd > 0 && !c.w9OnFile) console.log(`     ⛔ W-9 NOT ON FILE — must not pay (spec §7)`);
    for (const f of c.selfReferralFlags) console.log(`     ⚠️  SELF-REFERRAL ${f.uid}… (${f.listings} listings) — excluded, review`);
    const near = c.rows.filter((r) => !r.activated && !r.self && r.listings > 0 && r.listings < THRESH);
    if (near.length) console.log(`     ${near.length} referred seller(s) partway: ${near.map((r) => r.listings).join(", ")} listings`);
    console.log("");
  }

  console.log("  ── totals ─────────────────────────────");
  console.log(`  owed across all creators : ${usd(owedTotal)}`);
  console.log(`  remaining under the cap  : ${usd(Math.max(0, CAP - owedTotal))}`);
  if (owedTotal > CAP) console.log(`  🚨 EXPOSURE CAP BREACHED by ${usd(owedTotal - CAP)} — pause the pilot`);
  if (unmatched) {
    console.log(`  claims with an unknown code: ${unmatched} (${unmatchedListings} listings) — pays nobody.`);
    console.log("     Expected if a creator was onboarded before their code was added to the file.");
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[referral-report] FAILED:", e && e.message);
  process.exit(1);
});
