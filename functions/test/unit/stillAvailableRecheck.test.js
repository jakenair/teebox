"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {cancelReason} = require("../../stillAvailableRecheck")._stillAvailableRecheck;

const U = {email: "a@b.com", disabled: false};
const act = new Set(["L1"]);

test("recheck keeps eligible users and cancels every ineligible case", () => {
  assert.equal(cancelReason({user: U, gate: {allowed: true}, entry: {version: "new"}, activeIds: act}), "");
  assert.equal(cancelReason({user: U, gate: {allowed: true}, entry: {version: "viewed", items: ["L1", "L2"]}, activeIds: act}), "");
  assert.equal(cancelReason({user: null, gate: null, entry: {version: "new"}, activeIds: act}), "account-deleted");
  assert.equal(cancelReason({user: {...U, disabled: true}, gate: {allowed: true}, entry: {version: "new"}, activeIds: act}), "disabled");
  assert.equal(cancelReason({user: U, gate: {allowed: false, reason: "opted-out"}, entry: {version: "new"}, activeIds: act}), "opted-out");
  assert.equal(cancelReason({user: U, gate: {allowed: false, reason: "suppressed"}, entry: {version: "new"}, activeIds: act}), "suppressed");
  assert.equal(cancelReason({user: U, gate: {allowed: false, reason: "no-marketing-consent"}, entry: {version: "new"}, activeIds: act}), "no-marketing-consent");
  assert.equal(cancelReason({user: U, gate: {allowed: true}, entry: {version: "viewed", items: ["L2"]}, activeIds: act}), "all-items-gone");
});
