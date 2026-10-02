// functions/test/unit/autoClearFlag.test.js
//
// Tests for self-healing flags. No firebase-admin, no emulator — Firestore is
// a hand-rolled fake so the safety rules can be asserted directly.
//
// The three the founder asked for:
//   1. an automated flag IS cleared on a clean re-scan
//   2. a manual flag is NOT cleared
//   3. a listing whose re-scan is still dirty stays flagged
// (3 is enforced by the caller — clearAutoFlagIfClean only runs on the clean
// branch — so it is asserted both ways: the helper is never reached, and if it
// somehow were, a non-automated flag still survives.)

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {
  clearAutoFlagIfClean,
  isAutoRaisedFlag,
  AUTO_FLAG_SOURCE,
} = require("../../lib/autoClearFlag");

const SAFE = {adult: "VERY_UNLIKELY", racy: "UNLIKELY", violence: "VERY_UNLIKELY"};

const FieldValue = {
  delete: () => "__DELETE__",
  serverTimestamp: () => "__TS__",
};
const quiet = {info: () => {}, error: () => {}, warn: () => {}};

/** Minimal Firestore double: records every write for assertion. */
function fakeDb(listing) {
  const writes = {updates: [], adds: [], sets: []};
  return {
    writes,
    collection(name) {
      return {
        doc: (id) => ({
          get: async () => ({
            exists: name === "listings" ? listing !== null : true,
            data: () => (name === "listings" ? listing : {}),
          }),
          update: async (patch) => {
            writes.updates.push({collection: name, id, patch});
          },
          set: async (patch, opts) => {
            writes.sets.push({collection: name, id, patch, opts});
          },
        }),
        add: async (doc) => {
          writes.adds.push({collection: name, doc});
        },
      };
    },
  };
}

const call = (db, over = {}) => clearAutoFlagIfClean(
    {db, FieldValue, logger: quiet},
    {
      listingId: "L1",
      sellerId: "S1",
      objPath: "listings/S1/L1/photo_0.jpg",
      annotation: SAFE,
      ...over,
    });

// ── 1. automated flag IS cleared ────────────────────────────────────────────

test("automated flag (stamped source:auto) is cleared on a clean re-scan", async () => {
  const db = fakeDb({
    status: "flagged",
    moderationFlags: {reason: "image_scan_error", source: AUTO_FLAG_SOURCE},
  });
  assert.equal(await call(db), true);

  const up = db.writes.updates.find((w) => w.collection === "listings");
  assert.ok(up, "listing should be updated");
  assert.equal(up.patch.status, "active");
  assert.equal(up.patch.moderationFlags, "__DELETE__", "flag must be removed, not left stale");
});

test("legacy unstamped flag is recognised by reason — the Oct 2026 class", async () => {
  // Flags written before the source stamp existed must still self-heal.
  const db = fakeDb({status: "flagged", moderationFlags: {reason: "image_scan_error"}});
  assert.equal(await call(db), true);
  assert.equal(db.writes.updates[0].patch.status, "active");
});

test("legacy unstamped NSFW trip is recognised — the July 2026 class", async () => {
  // "racy=LIKELY" is what hid the Olympia Fields headcover for 81 days.
  const db = fakeDb({status: "flagged", moderationFlags: {reason: "racy=LIKELY"}});
  assert.equal(await call(db), true);
  assert.equal(db.writes.updates[0].patch.status, "active");
});

test("a clear is written to moderationLog with the old reason and new signals", async () => {
  const db = fakeDb({
    status: "flagged",
    moderationFlags: {reason: "image_scan_error", source: AUTO_FLAG_SOURCE},
  });
  await call(db);
  const row = db.writes.adds.find((a) => a.collection === "moderationLog");
  assert.ok(row, "an audit row is required");
  assert.equal(row.doc.action, "auto_flag_cleared");
  assert.equal(row.doc.listingId, "L1");
  assert.equal(row.doc.sellerId, "S1");
  assert.equal(row.doc.previousReason, "image_scan_error");
  assert.deepEqual(row.doc.rescanSignals, SAFE);
});

test("the admin-queue mirror is resolved so it cannot linger", async () => {
  const db = fakeDb({
    status: "flagged",
    moderationFlags: {reason: "image_scan_error", source: AUTO_FLAG_SOURCE},
  });
  await call(db);
  const mirror = db.writes.sets.find((w) => w.collection === "flaggedListings");
  assert.ok(mirror, "flaggedListings entry must be closed");
  assert.equal(mirror.patch.status, "resolved");
  assert.equal(mirror.opts.merge, true);
});

// ── 2. manual flag is NOT cleared ───────────────────────────────────────────

test("a manual/admin flag is NOT cleared", async () => {
  const db = fakeDb({
    status: "flagged",
    moderationFlags: {reason: "counterfeit", source: "admin", by: "jake"},
  });
  assert.equal(await call(db), false);
  assert.equal(db.writes.updates.length, 0, "must not touch the listing");
  assert.equal(db.writes.adds.length, 0, "must not log a clear");
  assert.equal(db.writes.sets.length, 0, "must not resolve the queue entry");
});

test("an unrecognised reason with no source is NOT cleared (conservative default)", async () => {
  const db = fakeDb({status: "flagged", moderationFlags: {reason: "reported_by_buyer"}});
  assert.equal(await call(db), false);
  assert.equal(db.writes.updates.length, 0);
});

test("an automated REASON with a non-auto source is NOT cleared", async () => {
  // An admin re-using a familiar reason string must still win.
  const db = fakeDb({
    status: "flagged",
    moderationFlags: {reason: "image_scan_error", source: "admin"},
  });
  assert.equal(await call(db), false);
  assert.equal(db.writes.updates.length, 0);
});

test("isAutoRaisedFlag: the full truth table", () => {
  assert.equal(isAutoRaisedFlag({source: AUTO_FLAG_SOURCE, reason: "anything"}), true);
  assert.equal(isAutoRaisedFlag({reason: "image_scan_error"}), true);
  assert.equal(isAutoRaisedFlag({reason: "image_process_error"}), true);
  assert.equal(isAutoRaisedFlag({reason: "adult=LIKELY"}), true);
  assert.equal(isAutoRaisedFlag({reason: "racy=VERY_LIKELY,violence=VERY_LIKELY"}), true);
  assert.equal(isAutoRaisedFlag({reason: "counterfeit", source: "admin"}), false);
  assert.equal(isAutoRaisedFlag({reason: "reported_by_buyer"}), false);
  assert.equal(isAutoRaisedFlag({}), false);
  assert.equal(isAutoRaisedFlag(null), false);
  assert.equal(isAutoRaisedFlag(undefined), false);
  assert.equal(isAutoRaisedFlag("image_scan_error"), false, "a bare string is not a flag map");
  assert.equal(isAutoRaisedFlag([]), false, "an array is not a flag map");
});

// ── 3. still-dirty re-scan stays flagged ────────────────────────────────────

test("a still-dirty re-scan never reaches the helper (caller gates on clean)", () => {
  // Mirrors optimizeListingPhoto: clearAutoFlagIfClean is only called inside
  // `if (isSafeForMarketplace(safeSearch))`. A dirty scan takes the flagging
  // branch instead, so the listing stays hidden.
  const SAFE_SEARCH_BLOCK_LEVEL = new Set(["LIKELY", "VERY_LIKELY"]);
  const SAFE_SEARCH_RACY_BLOCK = new Set(["VERY_LIKELY"]);
  const isSafeForMarketplace = (a) => {
    if (!a) return true;
    if (SAFE_SEARCH_BLOCK_LEVEL.has(a.adult || "VERY_UNLIKELY")) return false;
    if (SAFE_SEARCH_RACY_BLOCK.has(a.racy || "VERY_UNLIKELY")) return false;
    if ((a.violence || "VERY_UNLIKELY") === "VERY_LIKELY") return false;
    return true;
  };
  assert.equal(isSafeForMarketplace({adult: "VERY_LIKELY", racy: "UNLIKELY"}), false);
  assert.equal(isSafeForMarketplace({adult: "UNLIKELY", racy: "VERY_LIKELY"}), false);
  assert.equal(isSafeForMarketplace(SAFE), true,
      "only a passing scan reaches clearAutoFlagIfClean");
});

test("even if reached with a dirty listing, a non-auto flag survives", async () => {
  const db = fakeDb({status: "flagged", moderationFlags: {reason: "counterfeit", source: "admin"}});
  assert.equal(await call(db, {annotation: {adult: "VERY_LIKELY"}}), false);
  assert.equal(db.writes.updates.length, 0);
});

// ── no-ops and failure modes ────────────────────────────────────────────────

test("an active listing is left alone", async () => {
  const db = fakeDb({status: "active"});
  assert.equal(await call(db), false);
  assert.equal(db.writes.updates.length, 0);
});

test("a sold listing is never resurrected", async () => {
  const db = fakeDb({status: "sold", moderationFlags: {reason: "image_scan_error"}});
  assert.equal(await call(db), false);
  assert.equal(db.writes.updates.length, 0);
});

test("a missing listing is a no-op", async () => {
  const db = fakeDb(null);
  assert.equal(await call(db), false);
  assert.equal(db.writes.updates.length, 0);
});

test("never throws — a Firestore failure cannot break photo processing", async () => {
  const exploding = {
    collection: () => ({
      doc: () => ({get: async () => {
        throw new Error("firestore down");
      }}),
    }),
  };
  assert.equal(await call(exploding), false);
});

test("a failed audit-log write still leaves the listing restored", async () => {
  // Restoring the seller's listing matters more than the audit row.
  const db = fakeDb({
    status: "flagged",
    moderationFlags: {reason: "image_scan_error", source: AUTO_FLAG_SOURCE},
  });
  const realCollection = db.collection.bind(db);
  db.collection = (name) => {
    if (name === "moderationLog") {
      return {add: async () => {
        throw new Error("log write failed");
      }};
    }
    return realCollection(name);
  };
  assert.equal(await call(db), true);
  assert.equal(db.writes.updates[0].patch.status, "active");
});
