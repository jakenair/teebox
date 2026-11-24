// Storage rules. Needs the storage emulator:
//   firebase emulators:exec --only storage --project=demo-teebox "node --test functions/test/rules/storage-rules.test.js"
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const on = !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;
let env; let T;
const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
test.before(async () => {
  if (!on) return;
  T = require("@firebase/rules-unit-testing");
  const [host, port] = process.env.FIREBASE_STORAGE_EMULATOR_HOST.replace(/^https?:\/\//, "").split(":");
  env = await T.initializeTestEnvironment({projectId: "demo-teebox", storage: {host, port: Number(port),
    rules: fs.readFileSync(path.join(__dirname, "../../../storage.rules"), "utf8")}});
});
test.after(async () => { if (env) await env.cleanup(); });
const put = (uid, p, meta) => {
  const {ref, uploadBytes} = require("firebase/storage");
  const c = uid ? env.authenticatedContext(uid) : env.unauthenticatedContext();
  return uploadBytes(ref(c.storage(), p), img, {contentType: "image/jpeg", ...meta});
};
test("ordinary uploads still work (no metadata, cacheControl, other metadata)", {skip: !on}, async () => {
  await T.assertSucceeds(put("u1", "listings/u1/L1/1_0_a.jpg"));
  await T.assertSucceeds(put("u1", "listings/u1/L1/1_1_b.jpg", {cacheControl: "public, max-age=31536000"}));
  await T.assertSucceeds(put("u1", "listings/u1/L1/1_2_c.webp", {contentType: "image/webp", customMetadata: {note: "x"}}));
  await T.assertSucceeds(put("u1", "avatars/u1/1.jpg"));
  await T.assertSucceeds(put("u1", "passport/u1/pebble/1.jpg"));
});
test("a client can't write the server's resized copies, in any case, new or overwriting", {skip: !on}, async () => {
  for (const n of ["1_0_a.jpg_w400.webp", "1_0_a.jpg_w800.webp", "1_0_a.jpg_w1200.webp", "x_W400.WEBP"]) {
    await T.assertFails(put("u1", "listings/u1/L1/" + n, {contentType: "image/webp"}));
  }
  await T.assertFails(put("u1", "avatars/u1/1.jpg_w200.webp", {contentType: "image/webp"}));
  await T.assertFails(put("u1", "passport/u1/pebble/1.jpg_w400.webp", {contentType: "image/webp"}));
});
test("a client can't claim the server's optimized mark, at upload or later", {skip: !on}, async () => {
  const {ref, updateMetadata} = require("firebase/storage");
  for (const val of ["true", "false", ""]) await T.assertFails(put("u1", "listings/u1/L1/1_3_d.jpg", {customMetadata: {optimized: val}}));
  await T.assertFails(put("u1", "avatars/u1/2.jpg", {customMetadata: {optimized: "true"}}));
  await T.assertFails(put("u1", "passport/u1/pebble/2.jpg", {customMetadata: {optimized: "true"}}));
  await put("u1", "listings/u1/L1/1_4_e.jpg");
  await T.assertFails(updateMetadata(ref(env.authenticatedContext("u1").storage(), "listings/u1/L1/1_4_e.jpg"), {customMetadata: {optimized: "true"}}));
});
test("still refused: someone else's folder, signed out, not an image", {skip: !on}, async () => {
  await T.assertFails(put("u2", "listings/u1/L1/1_0_z.jpg"));
  await T.assertFails(put(null, "listings/u1/L1/1_0_z.jpg"));
  await T.assertFails(put("u1", "listings/u1/L1/1_0_z.svg", {contentType: "image/svg+xml"}));
  await T.assertFails(put("u1", "feed-cache/tiktok/L1/x.jpg"));
});
