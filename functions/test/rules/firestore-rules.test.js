// functions/test/rules/firestore-rules.test.js
//
// Firestore security-rules tests. These require the Firestore EMULATOR (Java),
// so they do NOT run in the default `npm test`. Run them with:
//   npm run test:rules          (from functions/, needs Java)
// or in CI via .github/workflows/rules-tests.yml (Java is free there).
//
// What they lock — the exact invariants the guest-browse diagnosis relied on:
//   • listings are world-READABLE (anon guests must see the marketplace)…
//   • …but NOT world-writable (anon cannot create/modify listings)
//   • users / orders / conversations are private to their owner/participants
//     (anon and unrelated signed-in users are denied)

const {test, before, after, beforeEach} = require("node:test");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {doc, getDoc, setDoc} = require("firebase/firestore");

// Resolve the rules file relative to THIS file, so cwd doesn't matter.
const RULES_PATH = path.join(__dirname, "..", "..", "..", "firestore.rules");

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-teebox", // demo- prefix => emulator runs with no creds
    firestore: {rules: readFileSync(RULES_PATH, "utf8")},
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// Seed a doc bypassing rules (admin-equivalent context).
async function seed(collPath, id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), collPath, id), data);
  });
}

const db = (ctx) => ctx.firestore();

test("listings: anonymous guest CAN read (guest-browse guarantee)", async () => {
  await seed("listings", "L1", {title: "Scotty Cameron", status: "active"});
  const anon = testEnv.unauthenticatedContext();
  await assertSucceeds(getDoc(doc(db(anon), "listings", "L1")));
});

test("listings: anonymous guest CANNOT write (not world-writable)", async () => {
  const anon = testEnv.unauthenticatedContext();
  await assertFails(
      setDoc(doc(db(anon), "listings", "L2"), {title: "hacked"}));
});

test("users/{uid}: only the owner can read; others + anon denied", async () => {
  await seed("users", "alice", {tier: "free", email: "a@x.com"});
  const alice = testEnv.authenticatedContext("alice");
  const bob = testEnv.authenticatedContext("bob");
  const anon = testEnv.unauthenticatedContext();
  await assertSucceeds(getDoc(doc(db(alice), "users", "alice")));
  await assertFails(getDoc(doc(db(bob), "users", "alice")));
  await assertFails(getDoc(doc(db(anon), "users", "alice")));
});

test("orders/{id}: buyer and seller can read; unrelated user + anon denied", async () => {
  await seed("orders", "O1", {buyerId: "alice", sellerId: "carol", amount: 100});
  const alice = testEnv.authenticatedContext("alice"); // buyer
  const carol = testEnv.authenticatedContext("carol"); // seller
  const mallory = testEnv.authenticatedContext("mallory"); // unrelated
  const anon = testEnv.unauthenticatedContext();
  await assertSucceeds(getDoc(doc(db(alice), "orders", "O1")));
  await assertSucceeds(getDoc(doc(db(carol), "orders", "O1")));
  await assertFails(getDoc(doc(db(mallory), "orders", "O1")));
  await assertFails(getDoc(doc(db(anon), "orders", "O1")));
});

test("conversations/{id}: only participants can read; non-participant + anon denied", async () => {
  await seed("conversations", "C1", {participants: ["alice", "carol"]});
  const alice = testEnv.authenticatedContext("alice");
  const mallory = testEnv.authenticatedContext("mallory");
  const anon = testEnv.unauthenticatedContext();
  await assertSucceeds(getDoc(doc(db(alice), "conversations", "C1")));
  await assertFails(getDoc(doc(db(mallory), "conversations", "C1")));
  await assertFails(getDoc(doc(db(anon), "conversations", "C1")));
});

// ─────────────────────────────────────────────────────────────
// Audit 2026-09-17 — Course Passport + messaging hardening invariants.
// ─────────────────────────────────────────────────────────────
const {serverTimestamp, updateDoc, addDoc, collection} = require("firebase/firestore");
const STORAGE_URL = "https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/passport%2Fu1%2Fpine-valley%2F1.jpg?alt=media";

test("passport: owner can create a round with server createdAt; others cannot", async () => {
  const me = testEnv.authenticatedContext("u1");
  const other = testEnv.authenticatedContext("u2");
  const round = {courseId: "pine-valley", grade: "A+", photos: [STORAGE_URL], hasPhotos: true, createdAt: serverTimestamp()};
  await assertSucceeds(setDoc(doc(db(me), "passport/u1/played", "pine-valley"), round));
  await assertFails(setDoc(doc(db(other), "passport/u1/played", "pine-valley"), round));
});

test("passport: createdAt must be server time on create and immutable on update (no feed pinning)", async () => {
  const me = testEnv.authenticatedContext("u1");
  const future = new Date("2100-01-01");
  await assertFails(setDoc(doc(db(me), "passport/u1/played", "pine-valley"),
    {courseId: "pine-valley", grade: "A", createdAt: future}));
  await seed("passport/u1/played", "pine-valley", {courseId: "pine-valley", grade: "A", createdAt: new Date("2026-09-01")});
  await assertFails(updateDoc(doc(db(me), "passport/u1/played", "pine-valley"), {createdAt: future}));
  await assertSucceeds(updateDoc(doc(db(me), "passport/u1/played", "pine-valley"), {review: "great"}));
});

test("passport: photos must be our Storage bucket; courseId must be slug-shaped", async () => {
  const me = testEnv.authenticatedContext("u1");
  await assertFails(setDoc(doc(db(me), "passport/u1/played", "pine-valley"),
    {courseId: "pine-valley", grade: "A", photos: ["https://evil.example/x.jpg"], createdAt: serverTimestamp()}));
  await assertFails(setDoc(doc(db(me), "passport/u1/played", "Not A Slug!"),
    {courseId: "Not A Slug!", grade: "A", createdAt: serverTimestamp()}));
});

test("passport: likes/comments require an existing parent round; comment createdAt is server time", async () => {
  const fan = testEnv.authenticatedContext("u2");
  // no parent round yet → both denied
  await assertFails(setDoc(doc(db(fan), "passport/u1/played/pine-valley/likes", "u2"), {createdAt: serverTimestamp()}));
  await assertFails(addDoc(collection(db(fan), "passport/u1/played/pine-valley/comments"),
    {authorUid: "u2", text: "nice", createdAt: serverTimestamp()}));
  await seed("passport/u1/played", "pine-valley", {courseId: "pine-valley", grade: "A", createdAt: new Date()});
  await assertSucceeds(setDoc(doc(db(fan), "passport/u1/played/pine-valley/likes", "u2"), {createdAt: serverTimestamp()}));
  await assertSucceeds(addDoc(collection(db(fan), "passport/u1/played/pine-valley/comments"),
    {authorUid: "u2", text: "nice", createdAt: serverTimestamp()}));
  // client-supplied createdAt or spoofed author → denied
  await assertFails(addDoc(collection(db(fan), "passport/u1/played/pine-valley/comments"),
    {authorUid: "u2", text: "nice", createdAt: new Date("2100-01-01")}));
  await assertFails(addDoc(collection(db(fan), "passport/u1/played/pine-valley/comments"),
    {authorUid: "u1", text: "as someone else", createdAt: serverTimestamp()}));
});

test("conversations: create rejects a seeded lastMessageText preview (moderation bypass)", async () => {
  await seed("listings", "L1", {sellerId: "seller", title: "Putter"});
  const buyer = testEnv.authenticatedContext("buyer");
  const base = {participants: ["buyer", "seller"], listingId: "L1", buyerId: "buyer", sellerId: "seller", createdAt: serverTimestamp(), lastMessageAt: serverTimestamp()};
  await assertSucceeds(addDoc(collection(db(buyer), "conversations"), base));
  await assertFails(addDoc(collection(db(buyer), "conversations"), {...base, lastMessageText: "Payment failed — confirm at evil.shop"}));
  await assertFails(addDoc(collection(db(buyer), "conversations"), {...base, lastRead: {seller: serverTimestamp()}}));
});

test("conversations: create denied when the other participant has blocked the creator", async () => {
  await seed("listings", "L1", {sellerId: "seller", title: "Putter"});
  await seed("users", "seller", {blocked: {buyer: {blockedAt: new Date()}}});
  const buyer = testEnv.authenticatedContext("buyer");
  await assertFails(addDoc(collection(db(buyer), "conversations"),
    {participants: ["buyer", "seller"], listingId: "L1", buyerId: "buyer", sellerId: "seller", createdAt: serverTimestamp()}));
});

test("conversations: update allows only own lastRead/hidden keys; lastMessage* is callable-only", async () => {
  await seed("conversations", "C1", {participants: ["buyer", "seller"], listingId: "L1", buyerId: "buyer", sellerId: "seller", lastRead: {}, hidden: {}});
  const buyer = testEnv.authenticatedContext("buyer");
  await assertSucceeds(updateDoc(doc(db(buyer), "conversations", "C1"), {"lastRead.buyer": serverTimestamp()}));
  await assertSucceeds(updateDoc(doc(db(buyer), "conversations", "C1"), {"hidden.buyer": serverTimestamp()}));
  await assertFails(updateDoc(doc(db(buyer), "conversations", "C1"), {"lastRead.seller": serverTimestamp()}));
  await assertFails(updateDoc(doc(db(buyer), "conversations", "C1"), {lastMessageText: "spoofed preview"}));
  await assertFails(updateDoc(doc(db(buyer), "conversations", "C1"), {lastMessageSenderId: "buyer", lastMessageAt: serverTimestamp()}));
});

test("users/{uid}: owner can save pushPrefs + bingoPushPrefs (Notifications panel); server-only keys still denied", async () => {
  await seed("users", "alice", {displayName: "Alice"});
  const alice = testEnv.authenticatedContext("alice", {email_verified: true});
  // Exactly what savePushPrefs writes: setDoc(..., {merge: true}) with both maps.
  await assertSucceeds(setDoc(doc(db(alice), "users", "alice"),
      {pushPrefs: {messages: true, offers: false, quietHours: {start: "21:00", end: "08:00", tz: "America/Chicago"}},
        bingoPushPrefs: {dailyReminder: true, reminderHour: 8, streakSaver: false}}, {merge: true}));
  await assertFails(updateDoc(doc(db(alice), "users", "alice"), {emailPrefs: {savedSearchMatches: false}}));
  await assertFails(updateDoc(doc(db(alice), "users", "alice"), {tier: "pro"}));
  const bob = testEnv.authenticatedContext("bob", {email_verified: true});
  await assertFails(setDoc(doc(db(bob), "users", "alice"), {pushPrefs: {messages: false}}, {merge: true}));
});

test("users/{uid}: unverified email cannot update the user doc at all (incl. pushPrefs) — documented gate", async () => {
  await seed("users", "carol", {displayName: "Carol"});
  const carol = testEnv.authenticatedContext("carol", {email_verified: false});
  await assertFails(setDoc(doc(db(carol), "users", "carol"), {pushPrefs: {messages: false}}, {merge: true}));
});

// ─── LIST-FIRST (2026-10-19): listing CREATE no longer requires Stripe ───
// Exactly the fields submitListing writes on create (index.html addDoc).
function listingCreateDoc(sellerId) {
  return {
    sellerId, title: "Vokey SM9 56°", brand: "Titleist", cat: "clubs",
    ask: 120, condition: "good", desc: "Lightly used", badge: "new",
    specCategory: "other", specs: {}, photos: [], status: "active",
    createdAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + 60 * 86400000),
    quantity: 1, quantitySold: 0, requiresAuth: false, authReviewState: "na",
  };
}

test("listings: verified email + NO Stripe onboarding → create ALLOWED (list-first Gate 1)", async () => {
  await seed("users", "newseller", {displayName: "New Seller"}); // no stripeChargesEnabled at all
  const me = testEnv.authenticatedContext("newseller", {email_verified: true});
  await assertSucceeds(addDoc(collection(db(me), "listings"), listingCreateDoc("newseller")));
});

test("listings: UNVERIFIED email → create DENIED even though schema is valid", async () => {
  await seed("users", "unverified", {displayName: "Unverified", stripeChargesEnabled: true});
  const me = testEnv.authenticatedContext("unverified", {email_verified: false});
  await assertFails(addDoc(collection(db(me), "listings"), listingCreateDoc("unverified")));
});

test("listings: phone sign-in counts as verified (existing isEmailVerified semantics)", async () => {
  const me = testEnv.authenticatedContext("phoneguy", {
    email_verified: false, firebase: {sign_in_provider: "phone"},
  });
  await assertSucceeds(addDoc(collection(db(me), "listings"), listingCreateDoc("phoneguy")));
});

test("listings: daily cap — counter at 10 inside the window → DENIED; lapsed window → ALLOWED; owner can read counter, not write it", async () => {
  const me = testEnv.authenticatedContext("busy", {email_verified: true});
  const inWindow = new Date(Date.now() + 6 * 3600000);
  await seed("users/busy/rateLimits", "listingCreate", {count: 10, resetAt: inWindow});
  await assertFails(addDoc(collection(db(me), "listings"), listingCreateDoc("busy")));
  await seed("users/busy/rateLimits", "listingCreate", {count: 9, resetAt: inWindow});
  await assertSucceeds(addDoc(collection(db(me), "listings"), listingCreateDoc("busy")));
  const lapsed = new Date(Date.now() - 60000);
  await seed("users/busy/rateLimits", "listingCreate", {count: 10, resetAt: lapsed});
  await assertSucceeds(addDoc(collection(db(me), "listings"), listingCreateDoc("busy")));
  await assertSucceeds(getDoc(doc(db(me), "users/busy/rateLimits", "listingCreate")));
  await assertFails(setDoc(doc(db(me), "users/busy/rateLimits", "listingCreate"), {count: 0, resetAt: lapsed}));
  const other = testEnv.authenticatedContext("nosy", {email_verified: true});
  await assertFails(getDoc(doc(db(other), "users/busy/rateLimits", "listingCreate")));
});

test("listings: cannot create a listing for someone else, nor pre-set a hidden/server status", async () => {
  const me = testEnv.authenticatedContext("mallory", {email_verified: true});
  await assertFails(addDoc(collection(db(me), "listings"), listingCreateDoc("victim")));
  await assertFails(addDoc(collection(db(me), "listings"), {...listingCreateDoc("mallory"), status: "hidden"}));
  await assertFails(addDoc(collection(db(me), "listings"), {...listingCreateDoc("mallory"), hiddenReason: "x"}));
});

// ── Phase 3 likes: listings/{id}/watchers/{uid} is server-written only ──────
test("watchers: a liker can read their OWN watcher doc; others and anon cannot", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "listings/L1"), {title: "x", status: "active"});
    await setDoc(doc(ctx.firestore(), "listings/L1/watchers/alice"), {addedAt: new Date()});
  });
  const alice = testEnv.authenticatedContext("alice").firestore();
  const bob = testEnv.authenticatedContext("bob").firestore();
  const anon = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(alice, "listings/L1/watchers/alice")));
  await assertFails(getDoc(doc(bob, "listings/L1/watchers/alice")));
  await assertFails(getDoc(doc(anon, "listings/L1/watchers/alice")));
});

test("watchers: no client may create, update or delete a watcher doc (setWatch callable only)", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "listings/L2"), {title: "y", status: "active"});
    await setDoc(doc(ctx.firestore(), "listings/L2/watchers/alice"), {addedAt: new Date()});
  });
  const alice = testEnv.authenticatedContext("alice").firestore();
  await assertFails(setDoc(doc(alice, "listings/L2/watchers/alice"), {addedAt: new Date(), priceWhenAdded: 1}));
  await assertFails(setDoc(doc(alice, "listings/L2/watchers/bob"), {addedAt: new Date()}));
  const {deleteDoc} = require("firebase/firestore");
  await assertFails(deleteDoc(doc(alice, "listings/L2/watchers/alice")));
});

// ── messageReveals (2026-10-29): "Show message anyway" tap log ──────────────
test("messageReveals: a participant can log a reveal about THEMSELVES; nothing else", async () => {
  const {addDoc, collection, serverTimestamp, updateDoc, deleteDoc} = require("firebase/firestore");
  await seed("conversations", "C1", {participants: ["alice", "bob"], buyerId: "alice", sellerId: "bob"});
  const alice = testEnv.authenticatedContext("alice").firestore();
  const mallory = testEnv.authenticatedContext("mallory").firestore();
  const anon = testEnv.unauthenticatedContext().firestore();
  const row = (uid, extra = {}) => ({uid, messageId: "m1", conversationId: "C1",
    hosts: ["s55.524178039.cfd"], createdAt: serverTimestamp(), ...extra});
  const ref = await assertSucceeds(addDoc(collection(alice, "messageReveals"), row("alice")));
  // about someone else's uid
  await assertFails(addDoc(collection(alice, "messageReveals"), row("bob")));
  // not a participant of the conversation
  await assertFails(addDoc(collection(mallory, "messageReveals"), row("mallory")));
  // signed out
  await assertFails(addDoc(collection(anon, "messageReveals"), row("alice")));
  // client-chosen timestamp / extra fields
  await assertFails(addDoc(collection(alice, "messageReveals"), row("alice", {createdAt: new Date(0)})));
  await assertFails(addDoc(collection(alice, "messageReveals"), row("alice", {note: "x"})));
  // append-only, admin-read only
  await assertFails(getDoc(doc(alice, "messageReveals", ref.id)));
  await assertFails(updateDoc(doc(alice, "messageReveals", ref.id), {hosts: []}));
  await assertFails(deleteDoc(doc(alice, "messageReveals", ref.id)));
});

// ── r421: view counts are server-owned (recordListingView only) ──────────────
test("listings: a seller cannot seed or edit viewDays / views7d; view bookkeeping collections are closed", async () => {
  const me = testEnv.authenticatedContext("seller421", {email_verified: true});
  await assertFails(addDoc(collection(db(me), "listings"), {...listingCreateDoc("seller421"), viewDays: {"20261119": 500}}));
  await assertFails(addDoc(collection(db(me), "listings"), {...listingCreateDoc("seller421"), views7d: 500}));
  await seed("listings", "L421", {...listingCreateDoc("seller421"), status: "active"});
  await assertFails(updateDoc(doc(db(me), "listings", "L421"), {viewDays: {"20261119": 500}}));
  await assertFails(updateDoc(doc(db(me), "listings", "L421"), {views7d: 500}));
  await assertFails(updateDoc(doc(db(me), "listings", "L421"), {"viewDays.20261119": 5}));
  // The legit seller direct-write path still works (renew/updatedAt).
  await assertSucceeds(updateDoc(doc(db(me), "listings", "L421"), {updatedAt: new Date()}));
  const anon = testEnv.unauthenticatedContext();
  for (const c of [me, anon]) {
    await assertFails(setDoc(doc(db(c), "listingViews", "L421_x"), {listingId: "L421"}));
    await assertFails(setDoc(doc(db(c), "viewIpLimits", "abc"), {n: 0}));
    await assertFails(getDoc(doc(db(c), "viewIpLimits", "abc")));
  }
});

// ── r422: list now, publish after payouts ────────────────────────────────────
function awaitingDoc(sellerId) {
  return {...listingCreateDoc(sellerId), status: "hidden", hiddenReason: "awaiting_payouts"};
}

test("r422 create: unready seller may save hidden/awaiting_payouts; ready seller may save active; other hidden reasons and stray reasons denied", async () => {
  await seed("users", "unready", {displayName: "U"});
  await seed("users", "ready", {displayName: "R", stripeChargesEnabled: true});
  const u = testEnv.authenticatedContext("unready", {email_verified: true});
  const r = testEnv.authenticatedContext("ready", {email_verified: true});
  await assertSucceeds(addDoc(collection(db(u), "listings"), awaitingDoc("unready")));
  await assertSucceeds(addDoc(collection(db(r), "listings"), listingCreateDoc("ready")));
  await assertFails(addDoc(collection(db(u), "listings"), {...awaitingDoc("unready"), hiddenReason: "payouts_pending"}));
  await assertFails(addDoc(collection(db(u), "listings"), {...listingCreateDoc("unready"), hiddenReason: "awaiting_payouts"}));
  await assertFails(addDoc(collection(db(u), "listings"), {...awaitingDoc("unready"), status: "active"}));
  // legacyUnreadyActiveCreate() is true today: an old build's plain active
  // create by an unready seller is still admitted (server demotes it).
  await assertSucceeds(addDoc(collection(db(u), "listings"), listingCreateDoc("unready")));
});

test("r422 update: awaiting listing — owner may attach photos only; cannot publish it or change the reason", async () => {
  await seed("users", "unready2", {displayName: "U"});
  await seed("listings", "AW1", {...awaitingDoc("unready2"), createdAt: new Date()});
  const u = testEnv.authenticatedContext("unready2", {email_verified: true});
  const photo = "https://firebasestorage.googleapis.com/v0/b/teebox-market.firebasestorage.app/o/listings%2FAW1%2Fa.jpg?alt=media";
  await assertSucceeds(updateDoc(doc(db(u), "listings", "AW1"), {photos: [photo]}));
  await assertFails(updateDoc(doc(db(u), "listings", "AW1"), {status: "active"}));
  await assertFails(updateDoc(doc(db(u), "listings", "AW1"), {status: "active", hiddenReason: null}));
  await assertFails(updateDoc(doc(db(u), "listings", "AW1"), {hiddenReason: "payouts_pending"}));
  await assertFails(updateDoc(doc(db(u), "listings", "AW1"), {expiresAt: new Date(Date.now() + 9e9)}));
  // Even a now-ready seller can't self-publish: publishing is server-only.
  await seed("users", "unready2", {displayName: "U", stripeChargesEnabled: true});
  await assertFails(updateDoc(doc(db(u), "listings", "AW1"), {status: "active"}));
});

test("r422 renew: expired → active needs a payment-ready seller; an unready seller renews to awaiting_payouts", async () => {
  await seed("users", "unready3", {displayName: "U"});
  await seed("users", "ready3", {displayName: "R", stripeChargesEnabled: true});
  const past = new Date(Date.now() - 86400000);
  const future = new Date(Date.now() + 90 * 86400000);
  await seed("listings", "EX1", {...listingCreateDoc("unready3"), createdAt: past, status: "expired"});
  await seed("listings", "EX2", {...listingCreateDoc("ready3"), createdAt: past, status: "expired"});
  const u = testEnv.authenticatedContext("unready3", {email_verified: true});
  const r = testEnv.authenticatedContext("ready3", {email_verified: true});
  await assertFails(updateDoc(doc(db(u), "listings", "EX1"), {status: "active", expiresAt: future}));
  await assertSucceeds(updateDoc(doc(db(u), "listings", "EX1"),
      {status: "hidden", hiddenReason: "awaiting_payouts", expiresAt: future}));
  await assertSucceeds(updateDoc(doc(db(r), "listings", "EX2"), {status: "active", expiresAt: future}));
  // a 7-day-paused listing stays server-only
  await seed("listings", "HP1", {...listingCreateDoc("unready3"), createdAt: past, status: "hidden", hiddenReason: "payouts_pending"});
  await assertFails(updateDoc(doc(db(u), "listings", "HP1"), {photos: []}));
});

test("r422: payoutReminders log is server-only", async () => {
  await seed("payoutReminders", "unready4", {anchorMs: 1, count: 1});
  const u = testEnv.authenticatedContext("unready4", {email_verified: true});
  await assertFails(getDoc(doc(db(u), "payoutReminders", "unready4")));
  await assertFails(setDoc(doc(db(u), "payoutReminders", "unready4"), {cancelledAtMs: 1}));
});

// ─────────────────────────────────────────────────────────────
// 2026-11-23 — admin is the admin:true custom claim; an approved
// authenticity review locks direct photo writes.
// ─────────────────────────────────────────────────────────────
test("admin reads need the admin claim; a verified email is not enough", async () => {
  await seed("flaggedListings", "F1", {listingId: "F1"});
  const claim = testEnv.authenticatedContext("boss", {admin: true});
  const email = testEnv.authenticatedContext("boss2", {email: "owner@example.test", email_verified: true});
  const str = testEnv.authenticatedContext("boss3", {admin: "true"});
  await assertSucceeds(getDoc(doc(db(claim), "flaggedListings", "F1")));
  for (const c of [email, str, testEnv.authenticatedContext("x"), testEnv.unauthenticatedContext()]) {
    await assertFails(getDoc(doc(db(c), "flaggedListings", "F1")));
  }
});

test("approved review: the owner can't swap photos with a direct write; pending still can", async () => {
  const mine = {...listingCreateDoc("rev1"), requiresAuth: true, ask: 400};
  await seed("listings", "RV1", {...mine, authReviewState: "approved"});
  await seed("listings", "RV2", {...mine, authReviewState: "pending"});
  const me = testEnv.authenticatedContext("rev1", {email_verified: true});
  const photos = {photos: [STORAGE_URL], updatedAt: serverTimestamp()};
  await assertFails(updateDoc(doc(db(me), "listings", "RV1"), photos));
  await assertSucceeds(updateDoc(doc(db(me), "listings", "RV1"), {updatedAt: serverTimestamp()}));
  await assertSucceeds(updateDoc(doc(db(me), "listings", "RV2"), photos));
});

test("seller delete: refused while a buyer's checkout holds the listing, allowed otherwise", async () => {
  const {deleteDoc, Timestamp} = require("firebase/firestore");
  const mine = listingCreateDoc("del1");
  const me = testEnv.authenticatedContext("del1", {email_verified: true});
  const later = Timestamp.fromMillis(Date.now() + 6e5);
  const past = Timestamp.fromMillis(Date.now() - 6e4);
  const cases = [
    ["DG1", {status: "pending", pendingUntil: later}, false], ["DG2", {quantityReserved: 1, pendingUntil: later}, false],
    ["DG3", {pendingPaymentIntentId: "pi_1", pendingUntil: later}, false], ["DG4", {status: "pending"}, false],
    ["DG5", {status: "pending", pendingUntil: past}, true], ["DG6", {quantityReserved: 0}, true], ["DG7", {status: "sold"}, false],
    ["DG8", {}, true],
  ];
  for (const [id, over, ok] of cases) {
    await seed("listings", id, {...mine, ...over});
    await (ok ? assertSucceeds : assertFails)(deleteDoc(doc(db(me), "listings", id)));
  }
  await seed("listings", "DG9", {...mine, status: "pending", pendingUntil: later});
  await assertFails(deleteDoc(doc(db(testEnv.authenticatedContext("someoneelse")), "listings", "DG9")));
  await assertSucceeds(deleteDoc(doc(db(testEnv.authenticatedContext("boss", {admin: true})), "listings", "DG9")));
});
