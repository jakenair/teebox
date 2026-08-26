/**
 * functions/shippoIntegration.js
 * ─────────────────────────────────────────────────────────────────────────
 * Shippo shipping-label integration.
 *
 * Callable `createShippingLabel` is the seller-facing entry point. It:
 *   1. Validates the caller is the order's seller.
 *   2. Resolves the from-address from users/{sellerId}.shippingFrom
 *      (rejects with failed-precondition if unset).
 *   3. Resolves the to-address from orders/{orderId}.shippingAddress
 *      (Stripe AddressElement persisted by stripeWebhook).
 *   4. Posts to Shippo /shipments with async:false → gets rates[].
 *   5. Picks a rate (cheapest USPS <70lb / cheapest UPS Ground >=70lb).
 *   6. Posts to Shippo /transactions with that rate → gets {label_url,
 *      tracking_number, label_file_type}.
 *   7. Writes labelUrl, trackingNumber, carrier, shippingLabelPurchasedAt
 *      to orders/{orderId} — onOrderLabelEmail (emailTriggers.js:332)
 *      then emails the buyer.
 *   8. Tags the order doc with shippingLabelEnv = "test" | "live" so we
 *      never confuse fake vs real labels in the dashboard.
 *
 * Production guard: refuses to call Shippo if the SHIPPO_API_KEY starts
 * with shippo_test_ AND we're running in the teebox-market prod project
 * (process.env.GCLOUD_PROJECT === "teebox-market"). This prevents the
 * foot-gun where a misconfigured prod env binds a test key — the seller
 * would get a fake "SHIPPO_TRANSIT" tracking number that USPS doesn't
 * recognize.
 *
 * Error contract:
 *   {ok: false, reason: "shippo-not-configured", message}    SHIPPO_API_KEY unset
 *   {ok: false, reason: "missing-from-address", message}      seller has no shippingFrom
 *   {ok: false, reason: "missing-to-address", message}        order has no shippingAddress
 *   {ok: false, reason: "test-key-in-prod", message}          guard tripped
 *   {ok: false, reason: "no-rates", message, details}         Shippo returned no rates
 *   {ok: false, reason: "label-purchase-failed", message, details}
 *                                                              transaction failed
 *   {ok: false, reason: "shippo-down", message}               Shippo 5xx / network error
 *   {ok: true, labelUrl, trackingNumber, carrier, rateAmount, env}
 *
 * Cost: Shippo charges $0.05/label as transaction fee on top of carrier
 * postage. Sellers pay this; we mark up zero in v1.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

// Declare the secret. Set via:
//   firebase functions:secrets:set SHIPPO_API_KEY
// Test value starts with shippo_test_; live with shippo_live_.
const SHIPPO_API_KEY = defineSecret("SHIPPO_API_KEY");
// Stripe key for the seller-funded label recovery (partial transfer
// reversal) + the pre-purchase proceeds guard; ops webhook for
// failed-recovery alerts. Same params as index.js — firebase-functions
// dedupes secret definitions by name.
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const {OPS_ALERT_WEBHOOK} = require("./opsAlert");
// Structure 1 (founder ruling 2026-08-25): sellers fund the FULL label
// from their payout. The r180 $15 platform subsidy (LABEL_CAP_USD) is
// retired — see Step 2.5/2.6 in createShippingLabel.

// r181: category→parcel map. Before this, EVERY label was quoted from
// DEFAULT_PARCEL (12×8×4, 2lb) regardless of item — a 48" club or a stand
// bag physically can't ship as quoted, and a mis-declared parcel draws an
// uncapped carrier dimensional adjustment billed to the label purchaser
// (us) after the fact. Keyed off listing.cat at label time via the
// existing overrides.parcel hook; true per-item dims are the parked
// spec-fields work. All dims inches, weights lb.
const CATEGORY_PARCELS = {
  apparel: {length: "12", width: "10", height: "1", weight: "1"},
  accessories: {length: "12", width: "10", height: "4", weight: "2"},
  headcovers: {length: "12", width: "10", height: "4", weight: "1"},
  shoes: {length: "14", width: "10", height: "5", weight: "3"},
  balls: {length: "12", width: "8", height: "4", weight: "3"},
  clubs: {length: "48", width: "6", height: "6", weight: "5"},
  bags: {length: "38", width: "14", height: "12", weight: "12"},
};
function parcelForCategory(cat) {
  const p = CATEGORY_PARCELS[String(cat || "").toLowerCase()];
  return p ? {...p, distance_unit: "in", mass_unit: "lb"} : null;
}

const USER_CALLABLE = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 60, // bumped from 30 — Shippo rate-shop can take ~5-10s
  concurrency: 40,
  maxInstances: 20,
};

// ─── Constants ────────────────────────────────────────────────────────
const SHIPPO_BASE = "https://api.goshippo.com";
// Default parcel: 12 × 8 × 4 inches, 2 lb. Reasonable for a single golf
// glove / single shaft component / small accessory. Sellers will be able
// to override per-listing in a future iteration; v1 uses this for all.
const DEFAULT_PARCEL = {
  length: "12",
  width: "8",
  height: "4",
  distance_unit: "in",
  weight: "2",
  mass_unit: "lb",
};
// Heavy threshold — above this, default carrier picker prefers UPS Ground
// because USPS Priority Mail caps at 70lb and gets expensive past 50lb.
const HEAVY_LB = 70;
const PROD_PROJECT_ID = "teebox-market";

// ─── HTTP helpers ─────────────────────────────────────────────────────

// Tiny fetch wrapper that returns {ok, status, body, networkErr}. We
// avoid throwing on non-2xx so the caller can decide whether to retry.
// Node 22 native fetch is used (no extra dependency).
async function shippoFetch(apiKey, path, body) {
  const url = `${SHIPPO_BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `ShippoToken ${apiKey}`,
        "Content-Type": "application/json",
        // Per Shippo docs — pin the API version so we don't get
        // surprised by a backwards-incompatible change.
        "Shippo-API-Version": "2018-02-08",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // DNS / connection / TLS errors → treat as Shippo-down so the
    // caller surfaces a friendly retry message.
    return {networkErr: err.message || String(err)};
  }
  let parsed = null;
  try {
    parsed = await res.json();
  } catch (_e) {
    // Empty / non-JSON body — keep going with `null`. Some 5xx return
    // an HTML page; that's fine, we'll surface `status`.
  }
  return {ok: res.ok, status: res.status, body: parsed};
}

// ─── Rate picker ──────────────────────────────────────────────────────
// Pick the cheapest rate matching our carrier preference rule:
//   parcel weight < HEAVY_LB lb → cheapest USPS rate of any service level
//   parcel weight >= HEAVY_LB   → cheapest UPS Ground (servicelevel.token
//                                  contains "ups_ground")
// Falls back to the absolute cheapest rate if no rate matches the rule.
// Returns null if there are no rates at all.
function pickRate(rates, parcelWeightLb) {
  if (!Array.isArray(rates) || rates.length === 0) return null;
  const sortable = rates
      .filter((r) => r && r.amount && r.object_id)
      .map((r) => ({...r, _amt: Number(r.amount)}))
      .sort((a, b) => a._amt - b._amt);
  if (sortable.length === 0) return null;

  const heavy = Number(parcelWeightLb) >= HEAVY_LB;
  if (heavy) {
    const upsGround = sortable.find((r) => {
      const tok = (r.servicelevel && r.servicelevel.token) || "";
      return /ups.*ground/i.test(tok);
    });
    if (upsGround) return upsGround;
  }
  // Cheapest usable rate across carriers (founder ruling 2026-08-25).
  // The old sub-70lb branch preferred the cheapest USPS rate regardless of
  // price — fine for small parcels where USPS wins anyway, but USPS
  // dimensional pricing made it buy a $115–172 Ground Advantage label for
  // a 38x14x12 stand bag where UPS quotes $42–58, and a $17–23 label for
  // the 48" club tube where UPS quotes $13–15. Under seller-funded labels
  // that difference lands on the seller for a choice they didn't make.
  return sortable[0];
}

// ─── Address normalizer ──────────────────────────────────────────────
// Shippo wants {name, street1, street2?, city, state, zip, country, phone?,
// email?}. Our internal shape (from Stripe AddressElement) is
// {name, address: {line1, line2, city, state, postal_code, country}}.
// We accept either shape.
function normalizeAddress(addr) {
  if (!addr || typeof addr !== "object") return null;
  // Already-Shippo shape
  if (addr.street1) return addr;
  // Stripe shape
  if (addr.address) {
    return {
      name: addr.name || "",
      street1: addr.address.line1 || "",
      street2: addr.address.line2 || "",
      city: addr.address.city || "",
      state: addr.address.state || "",
      zip: addr.address.postal_code || "",
      country: addr.address.country || "US",
      phone: addr.phone || "",
      email: addr.email || "",
    };
  }
  // Flat shape sometimes used in users/{uid}.shippingFrom
  return {
    name: addr.name || "",
    street1: addr.line1 || addr.street1 || "",
    street2: addr.line2 || addr.street2 || "",
    city: addr.city || "",
    state: addr.state || "",
    zip: addr.postal_code || addr.zip || "",
    country: addr.country || "US",
    phone: addr.phone || "",
    email: addr.email || "",
  };
}

function addressIsComplete(a) {
  return !!(a && a.street1 && a.city && a.state && a.zip);
}

// ─── Main callable ────────────────────────────────────────────────────

exports.createShippingLabel = onCall(
    {...USER_CALLABLE, secrets: [SHIPPO_API_KEY, STRIPE_SECRET_KEY, OPS_ALERT_WEBHOOK]},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Sign in required.");
      }
      const uid = request.auth.uid;
      const data = request.data || {};
      const {orderId} = data;
      const overrides = {
        fromAddress: data.fromAddress || null,
        toAddress: data.toAddress || null,
        parcel: data.parcel || null,
      };

      if (!orderId) {
        throw new HttpsError("invalid-argument", "orderId required.");
      }

      const db = admin.firestore();
      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        throw new HttpsError("not-found", "Order not found.");
      }
      const order = orderSnap.data() || {};

      // Permission gate — seller-of-record only.
      if (order.sellerId !== uid) {
        throw new HttpsError(
            "permission-denied",
            "Only the seller of record can create a label.");
      }

      // Idempotency — if a label already exists, return it instead of
      // re-buying. Sellers double-clicking the button shouldn't drop
      // $0.05 + $8 every retry.
      if (order.labelUrl) {
        return {
          ok: true,
          labelUrl: order.labelUrl,
          trackingNumber: order.trackingNumber || null,
          carrier: order.carrier || null,
          env: order.shippingLabelEnv || null,
          cached: true,
        };
      }

      // Secret presence check.
      const apiKey = (() => {
        try {
          return SHIPPO_API_KEY.value();
        } catch (_) {
          return "";
        }
      })();
      if (!apiKey) {
        logger.info(
            "createShippingLabel: SHIPPO_API_KEY not set", {orderId});
        return {
          ok: false,
          reason: "shippo-not-configured",
          message: "Shipping labels aren't configured yet. " +
              "Purchase postage with any carrier and mark the order shipped " +
              "from your dashboard with the tracking number.",
        };
      }

      // Production guard — refuse test keys in prod project.
      const isTestKey = apiKey.startsWith("shippo_test_");
      const isProdProject = process.env.GCLOUD_PROJECT === PROD_PROJECT_ID;
      if (isTestKey && isProdProject) {
        logger.error(
            "createShippingLabel: test SHIPPO key in prod project — refusing",
            {orderId});
        return {
          ok: false,
          reason: "test-key-in-prod",
          message: "Shipping labels are temporarily unavailable " +
              "while we finish a configuration step. Please retry shortly.",
        };
      }
      const env = isTestKey ? "test" : "live";

      // ─── Resolve from-address ─────────────────────────────────────
      let fromAddress = normalizeAddress(overrides.fromAddress);
      if (!fromAddress) {
        const sellerSnap = await db.collection("users").doc(uid).get();
        const seller = sellerSnap.exists ? sellerSnap.data() : {};
        fromAddress = normalizeAddress(seller.shippingFrom);
        // We don't fall back to a HQ iPostal — the founder's intent is
        // that sellers must explicitly set their ship-from before
        // buying labels, so the return-address on the label reflects
        // who's actually mailing the package.
        if (!fromAddress) {
          return {
            ok: false,
            reason: "missing-from-address",
            message: "Set your ship-from address in Account → Settings → " +
                "Shipping before generating a label.",
          };
        }
        // Stamp the seller's name on top of the address if missing.
        if (!fromAddress.name) {
          fromAddress.name = seller.displayName || "TeeBox seller";
        }
      }
      if (!addressIsComplete(fromAddress)) {
        return {
          ok: false,
          reason: "missing-from-address",
          message: "Your ship-from address is incomplete. Please add " +
              "street, city, state, and ZIP in Account → Settings → Shipping.",
        };
      }

      // ─── Resolve to-address ────────────────────────────────────────
      let toAddress = normalizeAddress(overrides.toAddress);
      if (!toAddress) {
        toAddress = normalizeAddress(
            order.shippingAddress || order.shipping || null);
      }
      if (!toAddress || !addressIsComplete(toAddress)) {
        return {
          ok: false,
          reason: "missing-to-address",
          message: "This order doesn't have a complete shipping address. " +
              "Contact the buyer through messages to confirm before shipping.",
        };
      }

      // ─── Parcel (r181: explicit override > category map > default) ─
      // Category comes from the listing the order references; a deleted
      // listing (or unknown cat) falls back to DEFAULT_PARCEL as before.
      let catParcel = null;
      try {
        if (order.listingId) {
          const lSnap = await admin.firestore()
              .collection("listings").doc(String(order.listingId)).get();
          if (lSnap.exists) catParcel = parcelForCategory(lSnap.data().cat);
        }
      } catch (e) {
        logger.warn("createShippingLabel: listing cat lookup failed " +
            "(using default parcel)", {orderId, err: e.message});
      }
      const parcel = overrides.parcel || catParcel || DEFAULT_PARCEL;

      // ─── Step 1: Create shipment + get rates ───────────────────────
      const shipmentBody = {
        address_from: fromAddress,
        address_to: toAddress,
        parcels: [parcel],
        async: false,
      };
      const shipmentRes = await shippoFetch(
          apiKey, "/shipments/", shipmentBody);

      if (shipmentRes.networkErr) {
        logger.error(
            "createShippingLabel: shipment network error",
            {orderId, err: shipmentRes.networkErr});
        return {
          ok: false,
          reason: "shippo-down",
          message: "Shipping rate lookup failed — please retry in a few minutes.",
        };
      }
      if (!shipmentRes.ok) {
        // 4xx → permanent error (bad address, etc.). 5xx → transient.
        const transient = shipmentRes.status >= 500;
        logger.warn(
            `createShippingLabel: Shippo /shipments ${shipmentRes.status}`,
            {orderId, body: shipmentRes.body});
        return {
          ok: false,
          reason: transient ? "shippo-down" : "no-rates",
          message: transient ?
            "Shipping rate lookup failed — please retry in a few minutes." :
            "We couldn't find any shipping rates for this address. " +
              "Double-check the buyer's address and try again.",
          details: shipmentRes.body || null,
        };
      }

      const rates = (shipmentRes.body && shipmentRes.body.rates) || [];
      if (!rates.length) {
        // Shippo may include messages[] with carrier-specific reasons
        // (e.g. "USPS: ZIP not deliverable"). Surface them so the seller
        // can act.
        const msgs = (shipmentRes.body && shipmentRes.body.messages) || [];
        logger.warn(
            "createShippingLabel: 0 rates from Shippo",
            {orderId, msgs});
        return {
          ok: false,
          reason: "no-rates",
          message: "We couldn't find any shipping rates for this address. " +
              (msgs.length ?
                  `${msgs[0].text || ""} ` :
                  "") +
              "Double-check the buyer's address and try again.",
          details: msgs,
        };
      }

      // ─── Step 2: Pick a rate ──────────────────────────────────────
      const parcelWeightLb = Number(parcel.weight || 0);
      const rate = pickRate(rates, parcelWeightLb);
      if (!rate || !rate.object_id) {
        logger.warn(
            "createShippingLabel: pickRate returned nothing",
            {orderId, rateCount: rates.length});
        return {
          ok: false,
          reason: "no-rates",
          message: "No usable shipping rate was returned. " +
              "Contact support if this persists.",
          details: rates.slice(0, 5),
        };
      }

      // ─── Step 2.5: seller-funded label (Structure 1, founder ruling
      // 2026-08-25 — replaces the r180 $15-cap subsidy) ───────────────
      // The seller funds the FULL label from their payout — no free-label
      // perk, no cap, no category conditional. Flow: the first call returns
      // a price quote (nothing purchased) so the client shows the exact
      // deduction; the seller re-calls with confirmDeduct:true.
      // confirmExcess is honored as consent too so an in-flight r180-era
      // client can't wedge mid-flow.
      const rateUsd = Number(rate.amount || 0);
      const labelCents = Math.round(rateUsd * 100);
      if (data.confirmDeduct !== true && data.confirmExcess !== true) {
        return {
          ok: false,
          reason: "label-deduct-quote",
          quote: true,
          rateAmount: rateUsd,
          deductAmount: Math.round(rateUsd * 100) / 100,
          carrier: rate.provider || "USPS",
          serviceLevel: (rate.servicelevel && rate.servicelevel.name) || null,
        };
      }

      // ─── Step 2.6: pre-purchase proceeds guard (C-guard part b) ─────
      // transfers.createReversal is all-or-nothing and hard-bounded by the
      // transfer's un-reversed amount. If the label costs more than what
      // remains of the seller's proceeds (possible after a partial refund,
      // or a mispriced low-ask item that predates the listing floors),
      // refuse BEFORE buying: nothing is spent, the failure is loud, and
      // support decides. Buying first and failing the reversal would eat
      // the label silently — the exact failure mode this guard retires.
      {
        let remainingCents = null;
        try {
          const stripeClient = require("stripe")(STRIPE_SECRET_KEY.value());
          if (order.transferId) {
            const tr = await stripeClient.transfers.retrieve(order.transferId);
            remainingCents =
              (Number(tr.amount) || 0) - (Number(tr.amount_reversed) || 0);
          }
        } catch (e) {
          logger.warn("label-guard: transfer retrieve failed", {
            orderId, transferId: order.transferId || null, err: e.message});
        }
        if (remainingCents === null) {
          // Can't verify the bound (missing transferId or Stripe blip) —
          // refuse conservatively rather than buy unguarded. Transient;
          // the seller just retries.
          return {
            ok: false,
            reason: "label-guard-unavailable",
            message: "We couldn't verify your payout for this order just " +
              "now. Please try again in a few minutes.",
          };
        }
        if (labelCents > remainingCents) {
          const {opsAlert} = require("./opsAlert");
          await opsAlert("error",
              `Label $${rateUsd.toFixed(2)} exceeds remaining proceeds ` +
              `$${(remainingCents / 100).toFixed(2)} on order ${orderId} — ` +
              "purchase refused; needs a founder decision.");
          return {
            ok: false,
            reason: "label-exceeds-proceeds",
            message: "This label costs more than your remaining proceeds " +
              "for this order, so we can't buy it against your payout. " +
              "Contact support and we'll sort out shipping together.",
            rateAmount: rateUsd,
            remainingProceeds: Math.round(remainingCents) / 100,
          };
        }
      }

      // ─── Step 3: Buy label ────────────────────────────────────────
      const txnBody = {
        rate: rate.object_id,
        label_file_type: "PDF",
        async: false,
      };
      const txnRes = await shippoFetch(apiKey, "/transactions/", txnBody);

      if (txnRes.networkErr) {
        logger.error(
            "createShippingLabel: txn network error",
            {orderId, err: txnRes.networkErr});
        return {
          ok: false,
          reason: "shippo-down",
          message: "Shipping label purchase failed — please retry in a few minutes.",
        };
      }
      if (!txnRes.ok || !txnRes.body) {
        const transient = txnRes.status >= 500;
        logger.warn(
            `createShippingLabel: Shippo /transactions ${txnRes.status}`,
            {orderId, body: txnRes.body});
        return {
          ok: false,
          reason: transient ? "shippo-down" : "label-purchase-failed",
          message: transient ?
            "Shipping label purchase failed — please retry in a few minutes." :
            "Shipping label purchase failed. " +
              "Check your Shippo account funding and try again.",
          details: txnRes.body || null,
        };
      }

      const txn = txnRes.body;
      // Shippo returns status: "SUCCESS" | "ERROR" | "QUEUED". With
      // async:false we should get SUCCESS or ERROR.
      if (txn.status === "ERROR" || !txn.label_url) {
        logger.warn(
            "createShippingLabel: txn ERROR",
            {orderId, messages: txn.messages});
        const firstMsg = (txn.messages && txn.messages[0] &&
            txn.messages[0].text) || "Label purchase failed.";
        return {
          ok: false,
          reason: "label-purchase-failed",
          message: firstMsg,
          details: txn.messages || null,
        };
      }

      // ─── Step 4: Persist label on the order doc ───────────────────
      // emailTriggers.onOrderLabelEmail fires on first labelUrl write,
      // sending the LabelCreated email to the buyer.
      const carrier = rate.provider || "USPS";
      await orderRef.set({
        labelUrl: txn.label_url,
        trackingNumber: txn.tracking_number || null,
        trackingUrl: txn.tracking_url_provider || null,
        carrier,
        shippingLabelRateCents: Math.round(Number(rate.amount || 0) * 100),
        shippingLabelServiceLevel:
          (rate.servicelevel && rate.servicelevel.name) || null,
        shippingLabelToken:
          (rate.servicelevel && rate.servicelevel.token) || null,
        shippingLabelEnv: env,
        shippingLabelPurchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        labelDeductCents: labelCents,
      }, {merge: true});

      // Seller-funded recovery: reverse the FULL label cost from the
      // seller's payout via a partial transfer reversal on the order's
      // transfer (same mechanism the dispute flow uses). The Step 2.6
      // guard verified the bound seconds ago, so this should not fail;
      // if it does anyway (race with a concurrent refund/dispute), keep
      // the label with the seller, do NOT retry, alert at error level,
      // and persist the debt so unrecovered labels are queryable instead
      // of buried in logs. (Shippo's flat $0.05/label transaction fee
      // stays platform-paid — not worth recovering.)
      try {
        const stripeClient = require("stripe")(STRIPE_SECRET_KEY.value());
        await stripeClient.transfers.createReversal(order.transferId, {
          amount: labelCents,
          metadata: {reason: "label_seller_funded", orderId,
            labelRateUsd: String(rateUsd)},
        });
        await orderRef.set({labelRecovered: true}, {merge: true});
      } catch (e) {
        logger.error("label recovery FAILED — label kept, debt recorded",
            {orderId, labelCents, err: e.message});
        try {
          await orderRef.set({
            labelRecovered: false,
            labelDebtCents: labelCents,
          }, {merge: true});
        } catch (_e) { /* best-effort */ }
        try {
          const {opsAlert} = require("./opsAlert");
          await opsAlert("error",
              `Label $${rateUsd.toFixed(2)} on order ${orderId} NOT ` +
              "recovered from seller payout — labelDebtCents recorded, " +
              "reverse manually.");
        } catch (_e) { /* best-effort */ }
      }

      logger.info(
          `createShippingLabel: ${orderId} bought ` +
          `${carrier} ${rate.servicelevel && rate.servicelevel.name} ` +
          `for $${rate.amount} (env=${env})`);

      return {
        ok: true,
        labelUrl: txn.label_url,
        trackingNumber: txn.tracking_number || null,
        carrier,
        rateAmount: Number(rate.amount || 0),
        env,
      };
    },
);

/**
 * getShippingFeatureFlag — lightweight callable for the client to
 * decide which "ship your item" CTA to render. Returns
 *   {enabled, env}
 * `env` is "test" | "live" | null — null when the secret is unset.
 * The client can show a small "TEST MODE" badge in the seller dashboard
 * when env === "test" so beta testers know the labels are fake.
 */
exports.getShippingFeatureFlag = onCall(
    {...USER_CALLABLE, secrets: [SHIPPO_API_KEY]},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Sign in required.");
      }
      let v = "";
      try {
        v = SHIPPO_API_KEY.value() || "";
      } catch (_e) {
        v = "";
      }
      const enabled = !!(v && v.length > 8);
      let env = null;
      if (enabled) {
        env = v.startsWith("shippo_test_") ? "test" : "live";
      }
      return {enabled, env};
    },
);

// Exports surfaced for unit tests / introspection. These are NOT
// `exports.foo = onCall(...)` so they do not register as Cloud Functions.
module.exports._internal = {
  pickRate,
  normalizeAddress,
  addressIsComplete,
  DEFAULT_PARCEL,
  HEAVY_LB,
};
