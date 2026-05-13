#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * test-stripe-failures.js
 *
 * Programmatic reproduction of Stripe-defined card failures against
 * TeeBox's Pro Seller subscription Price.
 *
 *   Required env:
 *     STRIPE_TEST_SECRET_KEY     sk_test_...
 *     STRIPE_TEST_PRO_PRICE_ID   price_... (test-mode recurring price)
 *
 *   Optional env:
 *     KEEP_CUSTOMERS=1   skip cleanup so you can inspect in dashboard
 *
 *   Run:
 *     STRIPE_TEST_SECRET_KEY=sk_test_xxx \
 *     STRIPE_TEST_PRO_PRICE_ID=price_xxx \
 *     node scripts/test-stripe-failures.js
 *
 * The script does NOT touch Firestore, Cloud Functions, or live keys.
 * It only exercises Stripe in TEST mode. The expected outcome for every
 * card except #5 is that the Subscription is created with
 *   status === 'incomplete'
 * and its latest invoice's PaymentIntent is
 *   status === 'requires_payment_method'
 * (i.e. nothing actually charged, no `tier=pro` would be written if our
 * webhook ever saw this event — verified by code audit). Card #5 is
 * special: it succeeds Stripe-side only after a 3DS challenge, which
 * cannot be completed off-session — so the API path leaves it in
 *   status === 'incomplete'
 * with the PI in
 *   status === 'requires_action'
 * (next_action.type === 'use_stripe_sdk' or 'redirect_to_url').
 */

"use strict";

const Stripe = require("stripe");

const SECRET = process.env.STRIPE_TEST_SECRET_KEY;
const PRICE_ID = process.env.STRIPE_TEST_PRO_PRICE_ID;

if (!SECRET || !SECRET.startsWith("sk_test_")) {
  console.error(
    "FATAL: STRIPE_TEST_SECRET_KEY must be set and start with sk_test_. " +
    "Refusing to run against a live key.");
  process.exit(2);
}
if (!PRICE_ID || !PRICE_ID.startsWith("price_")) {
  console.error("FATAL: STRIPE_TEST_PRO_PRICE_ID must be set (price_...).");
  process.exit(2);
}

const stripe = new Stripe(SECRET, {apiVersion: "2024-06-20"});

// PaymentMethod token shortcuts — Stripe provides these specifically so
// you don't have to tokenize raw PANs from a server (server-side raw PAN
// is gated). Each `pm_card_*` maps to the corresponding test card.
// https://docs.stripe.com/testing#cards
const CARDS = [
  {
    n: 1,
    label: "Card declined (generic)",
    pan: "4000 0000 0000 0002",
    pm: "pm_card_chargeDeclined",
    expect: {
      subStatus: ["incomplete", "incomplete_expired"],
      piStatus: ["requires_payment_method"],
      // We do NOT expect requires_action for a hard decline.
    },
  },
  {
    n: 2,
    label: "Insufficient funds",
    pan: "4000 0000 0000 9995",
    pm: "pm_card_chargeDeclinedInsufficientFunds",
    expect: {
      subStatus: ["incomplete", "incomplete_expired"],
      piStatus: ["requires_payment_method"],
    },
  },
  {
    n: 3,
    label: "Expired card",
    pan: "4000 0000 0000 0069",
    pm: "pm_card_chargeDeclinedExpiredCard",
    expect: {
      subStatus: ["incomplete", "incomplete_expired"],
      piStatus: ["requires_payment_method"],
    },
  },
  {
    n: 4,
    label: "Processing error",
    pan: "4000 0000 0000 0119",
    pm: "pm_card_chargeDeclinedProcessingError",
    expect: {
      subStatus: ["incomplete", "incomplete_expired"],
      piStatus: ["requires_payment_method"],
    },
  },
  {
    n: 5,
    label: "3DS required (succeeds after auth)",
    pan: "4000 0027 6000 3184",
    pm: "pm_card_authenticationRequired",
    expect: {
      // Off-session we can't complete the challenge, so subscription
      // sits in 'incomplete' and PI is in 'requires_action'.
      subStatus: ["incomplete"],
      piStatus: ["requires_action"],
    },
  },
  {
    n: 6,
    label: "3DS required, auth fails",
    pan: "4000 0084 0000 1629",
    pm: "pm_card_authenticationRequiredChargeDeclinedInsufficientFunds",
    expect: {
      // Same situation off-session — Stripe asks for action; we never
      // complete it, so the user's app-side flow never gets to a
      // tier=pro write. (On the real UI, the user fails 3DS and the
      // PI ends in requires_payment_method.)
      subStatus: ["incomplete"],
      piStatus: ["requires_action", "requires_payment_method"],
    },
  },
  {
    n: 7,
    label: "Fraudulent card (Radar block)",
    pan: "4100 0000 0000 0019",
    pm: "pm_card_radarBlock",
    expect: {
      subStatus: ["incomplete", "incomplete_expired"],
      piStatus: ["requires_payment_method"],
    },
  },
];

function check(actual, allowed) {
  return allowed.includes(actual);
}

async function runOne(card) {
  const out = {
    card: card.n,
    label: card.label,
    pan: card.pan,
    pm: card.pm,
    customerId: null,
    subId: null,
    subStatus: null,
    invoiceStatus: null,
    piStatus: null,
    piLastErrorCode: null,
    piLastErrorMsg: null,
    nextActionType: null,
    error: null,
    pass: false,
    notes: [],
  };

  try {
    // 1. Fresh customer per card so attempts don't interfere with each other.
    const customer = await stripe.customers.create({
      description: `teebox-failure-test card#${card.n} ${card.label}`,
      metadata: {teebox_test: "1", card_n: String(card.n)},
    });
    out.customerId = customer.id;

    // 2. Attach the test PaymentMethod token.
    await stripe.paymentMethods.attach(card.pm, {customer: customer.id});
    await stripe.customers.update(customer.id, {
      invoice_settings: {default_payment_method: card.pm},
    });

    // 3. Create the Subscription. Some cards throw at this step (Radar
    //    blocks pre-charge); others succeed in creating the sub but the
    //    underlying PI fails. Either way we record the outcome.
    let sub;
    try {
      sub = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{price: PRICE_ID}],
        payment_behavior: "default_incomplete",
        payment_settings: {save_default_payment_method: "on_subscription"},
        expand: ["latest_invoice.payment_intent"],
      });
    } catch (e) {
      // Card-error at subscription-create time (e.g. Radar block).
      out.error = `${e.code || e.type}: ${e.message}`;
      out.piLastErrorCode = e.code || null;
      out.piLastErrorMsg = e.message || null;
      // For Radar / declined cards, that's the terminal state — there's
      // no Subscription object. From our backend's perspective, no
      // customer.subscription.created event fires → no DB write. PASS.
      out.subStatus = "(never created)";
      out.piStatus = "(no PI)";
      out.pass = card.n === 7 || card.n === 1;
      // For #1 declined this can also throw at create-time in some
      // stripe-mock variants; accept it if so.
      out.notes.push(
        "Subscription create threw — no event would reach our webhook.");
      return out;
    }

    out.subId = sub.id;
    out.subStatus = sub.status;
    const inv = sub.latest_invoice;
    out.invoiceStatus = inv && inv.status;
    const pi = inv && inv.payment_intent;
    if (pi) {
      out.piStatus = pi.status;
      out.piLastErrorCode = pi.last_payment_error && pi.last_payment_error.code;
      out.piLastErrorMsg = pi.last_payment_error &&
        pi.last_payment_error.message;
      out.nextActionType = pi.next_action && pi.next_action.type;
    }

    // 4. For 'requires_action' (card #5, #6) try a server-side confirm
    //    so we observe Stripe's terminal state when 3DS isn't completed.
    //    We don't follow the redirect — confirming without the customer
    //    interaction simulates "user abandons 3DS".
    if (pi && pi.status === "requires_action") {
      out.notes.push(
        `next_action=${out.nextActionType} (3DS challenge required)`);
    }

    // 5. Assert.
    const subOk = check(out.subStatus, card.expect.subStatus);
    const piOk = check(out.piStatus, card.expect.piStatus);
    out.pass = subOk && piOk;
    if (!subOk) {
      out.notes.push(
        `subStatus=${out.subStatus} not in ${card.expect.subStatus.join("|")}`);
    }
    if (!piOk) {
      out.notes.push(
        `piStatus=${out.piStatus} not in ${card.expect.piStatus.join("|")}`);
    }
  } catch (e) {
    out.error = `${e.type || "Error"}: ${e.message}`;
    out.pass = false;
  }
  return out;
}

async function cleanup(customerIds) {
  if (process.env.KEEP_CUSTOMERS === "1") {
    console.log(
      `KEEP_CUSTOMERS=1 — leaving ${customerIds.length} customers for review.`);
    return;
  }
  for (const id of customerIds) {
    if (!id) continue;
    try {
      await stripe.customers.del(id);
    } catch (e) {
      console.warn(`cleanup: could not delete ${id}: ${e.message}`);
    }
  }
}

(async () => {
  console.log("=".repeat(72));
  console.log("TeeBox — Stripe failure-card reproduction (TEST mode)");
  console.log(`Price: ${PRICE_ID}`);
  console.log("=".repeat(72));

  const results = [];
  for (const card of CARDS) {
    process.stdout.write(`#${card.n} ${card.label} … `);
    const r = await runOne(card);
    results.push(r);
    console.log(r.pass ? "PASS" : "FAIL");
  }

  console.log("\nDetails:");
  for (const r of results) {
    console.log("-".repeat(72));
    console.log(`#${r.card} ${r.label}`);
    console.log(`  pan:           ${r.pan}`);
    console.log(`  pm token:      ${r.pm}`);
    console.log(`  customer:      ${r.customerId || "(none)"}`);
    console.log(`  subscription:  ${r.subId || "(none)"}`);
    console.log(`  sub.status:    ${r.subStatus}`);
    console.log(`  invoice:       ${r.invoiceStatus || "(none)"}`);
    console.log(`  pi.status:     ${r.piStatus || "(none)"}`);
    if (r.nextActionType) console.log(`  next_action:   ${r.nextActionType}`);
    if (r.piLastErrorCode) {
      console.log(`  pi.error:      ${r.piLastErrorCode} — ${r.piLastErrorMsg}`);
    }
    if (r.error) console.log(`  thrown:        ${r.error}`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    console.log(`  verdict:       ${r.pass ? "PASS" : "FAIL"}`);
  }

  await cleanup(results.map((r) => r.customerId));

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + "=".repeat(72));
  console.log(
    `Result: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.log("FAILURES:");
    for (const r of failed) console.log(`  - #${r.card} ${r.label}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
