"use strict";
// Everything the Seller API needs, for a sandbox (test key) request.
// There is no Storage, no Auth, no email, push, moderation log or any other
// service in here, and the database handle refuses every collection that
// isn't sandbox_*. Keep it that way: test/unit/sellerApiSandbox.test.js
// checks this file's imports.

const {sandboxDb} = require("./sandboxDb");
const {checkUrl} = require("./photoFetch");
const config = require("./sellerApiConfig");

// A partner can test the content_violation error with this word in the text.
const VIOLATION_WORD = "sandboxviolation";

/** Sandbox sellers live in sandbox_users; they are not Firebase accounts. */
function sandboxAuth(db) {
  return {getUser: async (uid) => {
    const s = await db.doc(`users/${uid}`).get();
    if (!s.exists) throw new Error("no such sandbox seller");
    const u = s.data();
    return {uid, disabled: u.disabled === true, emailVerified: u.emailVerified !== false, providerData: []};
  }};
}

async function fetchPhoto(url) {
  const c = checkUrl(url); // shape only: nothing is downloaded or stored
  if (!c.ok) throw new Error(c.reason);
  return {url: c.url.toString()};
}

async function scanText(fields) {
  const hit = Object.values(fields || {}).some((v) => String(v || "").toLowerCase().includes(VIOLATION_WORD));
  return hit ? {clean: false, category: "sandbox_test"} : {clean: true};
}

function sandboxDeps({firestore, FieldValue, Timestamp, logError, nowMs}) {
  const db = sandboxDb(firestore);
  return {
    db, auth: sandboxAuth(db), FieldValue, Timestamp, cfg: config.resolve("test"),
    scanText, fetchPhoto,
    storePhoto: async ({url}) => url,
    isPhotoUrl: (u) => checkUrl(u).ok,
    logError, ...(nowMs ? {nowMs} : {}),
  };
}

module.exports = {sandboxDeps, sandboxAuth, fetchPhoto, scanText, VIOLATION_WORD};
