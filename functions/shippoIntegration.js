/**
 * functions/shippoIntegration.js
 * ─────────────────────────────────────────────────────────────────────────
 * Shippo shipping-label scaffold — V1 STUB. A full Shippo integration is
 * 2-3 days of work (address validation, rate shopping, tracking webhook,
 * refund-on-cancel, label PDF storage). This file ships the surface area
 * + documentation so that:
 *
 *   1. The `createShippingLabel` callable exists at a stable name. Email
 *      templates / CTAs in the seller UI can already reference it.
 *   2. The `SHIPPO_API_KEY` secret is declared so a deploy doesn't need
 *      a code change to flip features on — just `firebase functions:
 *      secrets:set SHIPPO_API_KEY`.
 *   3. `getShippingFeatureFlag` is a 1-line client gate that returns
 *      `{enabled: bool}` — the seller "Print label & ship" CTA can use
 *      it to decide whether to link to Shippo or to a "use any carrier"
 *      help page.
 *
 * When you're ready to turn this on, see SHIPPING_LABELS_DEPLOY.md at
 * repo root.
 *
 * Reference (DO NOT IMPORT YET — keeps the function cold-start light):
 *   - Shippo API docs:  https://goshippo.com/docs/reference
 *   - Auth:             Authorization: ShippoToken <SHIPPO_API_KEY>
 *   - Create label:     POST /transactions  (with rate_id from POST
 *                       /shipments). Fields we need to map:
 *                         shipment: {address_from, address_to, parcels}
 *                         servicelevel_token: "usps_priority" etc.
 *                         label_file_type: "PDF_4x6"
 *   - Webhook:          POST /tracks/* events update the label /
 *                       shipment status. We'd wire this into a
 *                       new HTTP function that updates
 *                       orders/{orderId}.shippingStatus accordingly.
 *
 * Cost note: Shippo charges $0.05/label as a transaction fee on top of
 * carrier postage. For a v1 marketplace where sellers pay postage,
 * we either eat the $0.05 or pass it through as a line-item.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

// Declare the secret so deploys can wire it later WITHOUT a code change.
// IMPORTANT: do NOT set this secret's value here or in any deploy
// pipeline check-in — value is set via:
//   firebase functions:secrets:set SHIPPO_API_KEY
const SHIPPO_API_KEY = defineSecret("SHIPPO_API_KEY");

const USER_CALLABLE = {
  region: "us-central1",
  memory: "256MiB",
  timeoutSeconds: 30,
  concurrency: 40,
  maxInstances: 20,
};

/**
 * createShippingLabel — callable. SCAFFOLD ONLY.
 *
 *   args: {orderId, fromAddress, toAddress, parcel}
 *
 * V1 behavior: if SHIPPO_API_KEY is not configured, returns
 *   {ok: false, reason: "shippo-not-configured", message: "..."}
 * which the client interprets as "fall back to manual postage."
 *
 * When SHIPPO_API_KEY IS set, this still returns {ok: false} because
 * the actual Shippo /transactions call is intentionally not wired —
 * see SHIPPING_LABELS_DEPLOY.md for the checklist to flip this from
 * scaffold to producer.
 */
exports.createShippingLabel = onCall(
    {...USER_CALLABLE, secrets: [SHIPPO_API_KEY]},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Sign in required.");
      }
      const uid = request.auth.uid;
      const {orderId, fromAddress, toAddress, parcel} = request.data || {};

      if (!orderId) {
        throw new HttpsError("invalid-argument", "orderId required.");
      }

      // Verify the caller is the seller of record on this order. We do
      // this even in the stub so any future deploy that flips the
      // SHIPPO_API_KEY doesn't surprise a non-seller into being able to
      // create a label.
      const db = admin.firestore();
      const orderSnap = await db.collection("orders").doc(orderId).get();
      if (!orderSnap.exists) {
        throw new HttpsError("not-found", "Order not found.");
      }
      const order = orderSnap.data() || {};
      if (order.sellerId !== uid) {
        throw new HttpsError(
            "permission-denied",
            "Only the seller of record can create a label.");
      }

      // Feature-flag gate: is the secret set in this env?
      const apiKey = (() => {
        try { return SHIPPO_API_KEY.value(); } catch (_) { return ""; }
      })();
      if (!apiKey) {
        logger.info("createShippingLabel: stub return, secret not set", {orderId});
        return {
          ok: false,
          reason: "shippo-not-configured",
          message: "Sellers must purchase postage independently in v1. " +
              "Drop the package within 3 business days and mark it shipped " +
              "from your dashboard.",
        };
      }

      // ─── Producer path (DISABLED until the integration is finished) ────
      // When the integration is ready:
      //   1. Validate fromAddress + toAddress (POST /addresses, capture
      //      validation_results.is_valid).
      //   2. Create a shipment (POST /shipments) → rates[].
      //   3. Pick a rate (cheapest, or matching a saved seller preference).
      //   4. Purchase the label (POST /transactions with the rate's
      //      object_id and label_file_type: "PDF_4x6").
      //   5. Persist orders/{orderId}.labelUrl = result.label_url so
      //      onOrderLabelEmail (emailTriggers.js:332) fires the
      //      LabelCreated buyer email.
      //   6. Return {ok: true, labelUrl, trackingNumber, carrier}.
      // ───────────────────────────────────────────────────────────────────
      logger.warn(
          "createShippingLabel: SHIPPO_API_KEY is set but producer path " +
          "is not yet wired — falling back to stub response. See " +
          "SHIPPING_LABELS_DEPLOY.md for the checklist.",
          {orderId, parcelKeys: parcel ? Object.keys(parcel) : []},
      );
      // We still return ok:false so the CTA falls back to manual until
      // the producer is reviewed + wired. Once wired, replace this with
      // the real {ok: true, labelUrl, ...} response.
      return {
        ok: false,
        reason: "shippo-producer-not-wired",
        message: "Shippo key detected but the producer hasn't been " +
            "flipped on yet. See SHIPPING_LABELS_DEPLOY.md.",
        _debug: {fromAddressPresent: !!fromAddress, toAddressPresent: !!toAddress},
      };
    },
);

/**
 * getShippingFeatureFlag — lightweight callable for the client to
 * decide which "ship your item" CTA to render. Returns {enabled: bool}
 * based on whether SHIPPO_API_KEY is set. Cheap enough that the client
 * can call it on every seller-side order page load.
 *
 * The server-side flag is the source of truth (NOT a client const) so
 * we can switch CTAs the instant the secret is rotated without an app
 * release.
 */
exports.getShippingFeatureFlag = onCall(
    {...USER_CALLABLE, secrets: [SHIPPO_API_KEY]},
    async (_request) => {
      let enabled = false;
      try {
        const v = SHIPPO_API_KEY.value();
        enabled = !!(v && v.length > 8);
      } catch (_e) {
        enabled = false;
      }
      return {enabled};
    },
);
