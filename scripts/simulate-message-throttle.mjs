#!/usr/bin/env node
// scripts/simulate-message-throttle.mjs
//
// Simulate the new `notifyOnNewMessage` first-per-(recipient × thread ×
// 4-hour-window) throttling rule against a corpus of message events.
//
// Usage:
//   node scripts/simulate-message-throttle.mjs                 # synthetic data
//   node scripts/simulate-message-throttle.mjs --input=foo.json
//
// Expected JSON shape for --input:
//   [
//     { "cid": "conv_1", "senderId": "u_a", "recipientId": "u_b",
//       "createdAt": 1715600000000 },
//     ...
//   ]
//
// Output: counts and % reduction.

import fs from "node:fs";
import path from "node:path";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/* ────────────────────────── arg parsing ────────────────────────── */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

/* ────────────────────────── synthetic data ────────────────────────── */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSynthetic({conversations = 20, messagesPer = 50, seed = 42} = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  const startedAt = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago

  for (let c = 0; c < conversations; c++) {
    const cid = `conv_${c}`;
    const a = `u_${c}_a`;
    const b = `u_${c}_b`;
    // Bias each conversation toward a "burst pattern" (active negotiation)
    // vs. "trickle pattern" (occasional check-in).
    const isBursty = rnd() < 0.6;

    let t = startedAt + Math.floor(rnd() * 12 * 60 * 60 * 1000); // first msg time
    for (let m = 0; m < messagesPer; m++) {
      // Gap distribution:
      //   bursty: mostly 30s–10min, occasional 12h jump
      //   trickle: mostly 30min–8h, occasional multi-day
      let gapMs;
      if (isBursty) {
        gapMs = rnd() < 0.85
          ? 30 * 1000 + Math.floor(rnd() * 10 * 60 * 1000) // 30s–10min
          : 12 * 60 * 60 * 1000 + Math.floor(rnd() * 24 * 60 * 60 * 1000); // 12–36h
      } else {
        gapMs = rnd() < 0.7
          ? 30 * 60 * 1000 + Math.floor(rnd() * 7.5 * 60 * 60 * 1000) // 30m–8h
          : 24 * 60 * 60 * 1000 + Math.floor(rnd() * 3 * 24 * 60 * 60 * 1000); // 1–4d
      }
      t += gapMs;
      const senderId = rnd() < 0.5 ? a : b;
      const recipientId = senderId === a ? b : a;
      out.push({cid, senderId, recipientId, createdAt: t});
    }
  }
  // Global chronological order (mimics a Firestore time-ordered dump).
  out.sort((x, y) => x.createdAt - y.createdAt);
  return out;
}

/* ────────────────────────── simulator ────────────────────────── */
function simulate(events) {
  // watermark[recipientId][cid] = last-email-sent-ms
  const watermark = new Map();
  let oldRuleEmails = 0; // every message → email
  let newRuleEmails = 0; // first per (recipient × thread × 4h)
  let throttled = 0;

  for (const ev of events) {
    oldRuleEmails += 1;
    const key = ev.recipientId;
    if (!watermark.has(key)) watermark.set(key, new Map());
    const perThread = watermark.get(key);
    const last = perThread.get(ev.cid) || 0;

    if (!last || ev.createdAt - last >= FOUR_HOURS_MS) {
      newRuleEmails += 1;
      perThread.set(ev.cid, ev.createdAt);
    } else {
      throttled += 1;
    }
  }

  const reductionPct = oldRuleEmails === 0
    ? 0
    : ((oldRuleEmails - newRuleEmails) / oldRuleEmails) * 100;

  return {
    totalMessages: events.length,
    oldRuleEmails,
    newRuleEmails,
    throttled,
    reductionPct: Number(reductionPct.toFixed(2)),
  };
}

/* ────────────────────────── main ────────────────────────── */
let events;
if (args.input) {
  const p = path.resolve(args.input);
  events = JSON.parse(fs.readFileSync(p, "utf8"));
  console.log(`[simulate] loaded ${events.length} events from ${p}`);
} else {
  events = generateSynthetic({conversations: 20, messagesPer: 50});
  console.log(`[simulate] generated ${events.length} synthetic events ` +
    "(20 conv × 50 msg, mixed bursty + trickle patterns)");
}

const result = simulate(events);
console.log("");
console.log("── Throttle simulation result ────────────────────────────");
console.log(`Total messages              : ${result.totalMessages}`);
console.log(`Emails under OLD rule       : ${result.oldRuleEmails}`);
console.log(`Emails under NEW rule (4h)  : ${result.newRuleEmails}`);
console.log(`Messages throttled (silent) : ${result.throttled}`);
console.log(`Reduction                   : ${result.reductionPct}%`);
console.log("──────────────────────────────────────────────────────────");
