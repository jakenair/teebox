/**
 * functions/listingAssist.js — Listing v2 AI assist (founder go 2026-09-24).
 *
 * Callable `draftListingFromPhotos`: seller has taken photos and picked a
 * spec category; we ask Claude (Haiku 4.5 — cheapest current model whose
 * vision reads club stampings; ~$0.01/listing at 4 photos) for a draft:
 *   { title, description, condition, specs{...}, price{low,mid,high,
 *     rationale, compsUsed} }
 * EVERYTHING is a suggestion pre-filled into editable fields client-side.
 * Nothing here writes a listing; nothing auto-publishes.
 *
 * Replaces the retired Gemini pair (generateListingDescription +
 * suggestListingPrice) — one assist path, one processor disclosed in
 * privacy.html §6 (Anthropic; Gemini entry removed in the same r257 bump
 * that deletes those functions).
 *
 * Guardrails (founder rulings):
 *  - AI_ASSIST_DISABLED=true env kill switch → {ok:false, reason:'disabled'}
 *  - 25 calls/user/day (pro shops batch-list trade-ins; 10 was too low)
 *  - $50/month HARD spend cap tracked in aiUsage/{YYYY-MM}; refuse at cap
 *  - every call logged to aiDraftLogs (uid, category, output, tokens, cost)
 *    so the founder can see who is near the limit
 *  - graceful degrade: ANY failure returns {ok:false, reason} — the sell
 *    form works identically without the assist.
 *
 * Input: { category, images: [{data: <base64 jpeg ≤ ~400KB>, mediaType}],
 *          specs: {..partial..}, brand?, model? }
 * Images arrive as client-downscaled base64 (photos aren't in Storage yet
 * at draft time — upload happens at submit), max 4, ~800px.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODEL = "claude-haiku-4-5";
// $ per 1M tokens (claude-haiku-4-5, cached 2026-06 pricing table).
const IN_PER_M = 1.0;
const OUT_PER_M = 5.0;
const MONTHLY_CAP_USD = 50;
const DAILY_LIMIT = 25;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 600 * 1024; // ~450KB binary per image after downscale

const SPEC_CATEGORIES = [
  "driver", "fairway", "hybrid", "iron-set", "single-iron", "wedge",
  "putter", "balls", "bag", "apparel", "shoes", "headcover",
  "accessories", "other",
];

const USER_CALLABLE = {
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 60,
  concurrency: 20,
  maxInstances: 10,
};

function monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

exports.draftListingFromPhotos = onCall(
    {...USER_CALLABLE, secrets: [ANTHROPIC_API_KEY]},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Sign in required.");
      }
      const uid = request.auth.uid;
      if (process.env.AI_ASSIST_DISABLED === "true") {
        return {ok: false, reason: "disabled"};
      }
      const data = request.data || {};
      const category = String(data.category || "").toLowerCase();
      if (!SPEC_CATEGORIES.includes(category)) {
        return {ok: false, reason: "bad-category"};
      }
      const images = Array.isArray(data.images) ?
        data.images.slice(0, MAX_IMAGES) : [];
      if (!images.length) return {ok: false, reason: "no-images"};
      for (const im of images) {
        if (!im || typeof im.data !== "string" ||
            im.data.length > MAX_IMAGE_B64 ||
            !/^image\/(jpeg|png|webp)$/.test(String(im.mediaType || ""))) {
          return {ok: false, reason: "bad-image"};
        }
      }
      const partialSpecs = (data.specs && typeof data.specs === "object") ?
        data.specs : {};
      // r259: the client sends the category's REQUIRED spec keys so Caddie
      // can REPORT what it could not read instead of leaving a required
      // dropdown silently empty (founder bug: putter "length" came back
      // blank with no explanation).
      const requiredFields = Array.isArray(data.requiredFields) ?
        data.requiredFields.slice(0, 20).map((k) => String(k).slice(0, 40)) : [];

      const db = admin.firestore();

      // ── Guardrail 1: per-user daily limit (25/day, founder ruling) ──
      const dayRef = db.collection("users").doc(uid)
          .collection("rateLimits").doc(`aiDraft_${dayKey()}`);
      const allowed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(dayRef);
        const n = snap.exists ? (Number(snap.data().count) || 0) : 0;
        if (n >= DAILY_LIMIT) return false;
        tx.set(dayRef, {
          count: n + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        return true;
      });
      if (!allowed) return {ok: false, reason: "daily-limit"};

      // ── Guardrail 2: $50/month hard cap ──
      const usageRef = db.collection("aiUsage").doc(monthKey());
      const usageSnap = await usageRef.get();
      const spent = usageSnap.exists ?
        (Number(usageSnap.data().costUsd) || 0) : 0;
      if (spent >= MONTHLY_CAP_USD) {
        logger.warn("draftListingFromPhotos: monthly cap reached", {spent});
        return {ok: false, reason: "budget"};
      }

      // ── Comps from our own data (weighted higher than model knowledge) ──
      // priceHistory/{slug} carries the sold-price sparkline data. We can
      // only look it up when the seller already typed brand+model.
      let comps = null;
      const brand = String(data.brand || partialSpecs.brand || "").trim();
      const model = String(data.model || partialSpecs.model || "").trim();
      if (brand && model) {
        try {
          const slug = `${brand} ${model}`.toLowerCase()
              .replace(/[^a-z0-9]+/g, "-").slice(0, 80);
          const hist = await db.collection("priceHistory").doc(slug).get();
          if (hist.exists) {
            const sales = (hist.data().sales || []).slice(-20);
            if (sales.length) {
              comps = {
                count: sales.length,
                pricesUsd: sales.map((s) =>
                  Math.round((Number(s.priceCents) || 0) / 100)),
              };
            }
          }
        } catch (_e) { /* comps are optional */ }
      }

      // ── The call ──
      const system =
        "You draft golf-equipment marketplace listings from photos. " +
        "Respond with ONLY a JSON object — no markdown fences, no prose. " +
        "Schema: {\"title\": string (<=80 chars, brand + model + key spec, " +
        "no hype words), \"description\": string (2-4 plain sentences, " +
        "factual, mention visible wear honestly, no hype), \"condition\": " +
        "one of [\"New with Tags\",\"Like New\",\"Very Good\",\"Good\"," +
        "\"Fair\"], \"specs\": object (ONLY keys you can actually read " +
        "from the photos or infer with high confidence: brand, model, " +
        "loft, flex, shaftBrand, shaftModel, shaftType, dexterity, " +
        "setComposition, bounce, grind, length, headStyle, grip, size, " +
        "type, quantity — omit anything uncertain, never guess " +
        "stampings), \"unreadable\": object (see below), " +
        "\"price\": {\"low\": int USD, \"mid\": int, " +
        "\"high\": int, \"rationale\": string (one line), \"compsUsed\": " +
        "int}. " +
        "CRITICAL — brand and model are SEPARATE fields. \"brand\" is the " +
        "manufacturer alone (Scotty Cameron, Titleist, TaylorMade, Ping); " +
        "\"model\" is ONLY the product name and NEVER the manufacturer. " +
        "For a Scotty Cameron Studio Style Newport 2: brand is " +
        "\"Scotty Cameron\", model is \"Studio Style Newport 2\". Never put " +
        "the brand in model, never repeat the brand inside model. " +
        "REQUIRED_FIELDS lists the spec keys this listing must have. For " +
        "every required key you cannot determine confidently, OMIT it from " +
        "specs and add it to \"unreadable\" as key -> a short hint " +
        "(<=8 words) telling the seller where that detail is normally " +
        "found, e.g. {\"length\": \"check the shaft band\", \"loft\": " +
        "\"stamped on the sole\"}. Use {} when you read everything. Never " +
        "invent a value to avoid reporting it unreadable. " +
        "Price from the model's used-market value given condition. " +
        "When OUR_SOLD_COMPS is present, weight those real sold prices " +
        "ABOVE general knowledge and set compsUsed to their count; " +
        "otherwise compsUsed is 0. If dexterity is visible (face angle in " +
        "address photos), include it. Read loft/model stampings only when " +
        "legible.";

      const userContent = images.map((im) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: im.mediaType,
          data: im.data,
        },
      }));
      userContent.push({
        type: "text",
        text: JSON.stringify({
          specCategory: category,
          REQUIRED_FIELDS: requiredFields,
          sellerEnteredSpecs: partialSpecs,
          OUR_SOLD_COMPS: comps,
        }),
      });

      let resp;
      try {
        const Anthropic = require("@anthropic-ai/sdk");
        const client = new Anthropic({apiKey: ANTHROPIC_API_KEY.value()});
        resp = await client.messages.create({
          model: MODEL,
          max_tokens: 1200,
          system,
          messages: [{role: "user", content: userContent}],
        });
      } catch (err) {
        logger.error("draftListingFromPhotos: API call failed",
            {uid, err: err && err.message});
        return {ok: false, reason: "unavailable"};
      }

      // ── Parse (strict JSON contract; tolerate stray fences) ──
      let draft = null;
      try {
        const text = (resp.content || [])
            .filter((b) => b.type === "text").map((b) => b.text).join("");
        const cleaned = text.trim()
            .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        draft = JSON.parse(cleaned);
      } catch (err) {
        logger.warn("draftListingFromPhotos: unparseable output", {uid});
      }

      // ── Cost accounting + founder-reviewable log (always, even on
      //    parse failure — the tokens were spent) ──
      const inTok = (resp.usage && resp.usage.input_tokens) || 0;
      const outTok = (resp.usage && resp.usage.output_tokens) || 0;
      const costUsd = (inTok * IN_PER_M + outTok * OUT_PER_M) / 1e6;
      try {
        await usageRef.set({
          costUsd: admin.firestore.FieldValue.increment(costUsd),
          calls: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        await db.collection("aiDraftLogs").add({
          uid, category, model: MODEL,
          imageCount: images.length,
          partialSpecs,
          compsUsed: comps ? comps.count : 0,
          draft: draft || null,
          unreadableKeys: (draft && draft.unreadable) ?
            Object.keys(draft.unreadable).slice(0, 12) : [],
          parseFailed: !draft,
          inputTokens: inTok, outputTokens: outTok,
          costUsd: Math.round(costUsd * 1e6) / 1e6,
          at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        logger.error("draftListingFromPhotos: accounting write failed", e);
      }

      if (!draft || typeof draft !== "object") {
        return {ok: false, reason: "unparseable"};
      }
      // Server-side shape clamp — the client treats this as pre-fill only.
      return {
        ok: true,
        title: String(draft.title || "").slice(0, 120),
        description: String(draft.description || "").slice(0, 2000),
        condition: ["New with Tags", "Like New", "Very Good", "Good", "Fair"]
            .includes(draft.condition) ? draft.condition : null,
        unreadable: (draft.unreadable && typeof draft.unreadable === "object" &&
          !Array.isArray(draft.unreadable)) ?
          Object.fromEntries(Object.entries(draft.unreadable).slice(0, 12)
              .map(([k, v]) => [String(k).slice(0, 40),
                String(v).slice(0, 80)])) : {},
        specs: (draft.specs && typeof draft.specs === "object") ?
          Object.fromEntries(Object.entries(draft.specs).slice(0, 30)
              .map(([k, v]) => [String(k).slice(0, 40),
                String(v).slice(0, 120)])) : {},
        price: (draft.price && typeof draft.price === "object") ? {
          low: Math.max(0, Math.round(Number(draft.price.low) || 0)),
          mid: Math.max(0, Math.round(Number(draft.price.mid) || 0)),
          high: Math.max(0, Math.round(Number(draft.price.high) || 0)),
          rationale: String(draft.price.rationale || "").slice(0, 200),
          compsUsed: Math.max(0, Math.round(Number(draft.price.compsUsed) || 0)),
        } : null,
      };
    },
);
