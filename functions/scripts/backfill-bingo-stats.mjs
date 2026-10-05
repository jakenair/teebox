#!/usr/bin/env node
/**
 * functions/scripts/backfill-bingo-stats.mjs
 *
 * One-off backfill for users/{uid}.bingoStats, the per-user lifetime counters
 * added to onBingoWinAggregate in r314.
 *
 * WHY THIS EXISTS
 * The trigger only increments from the moment it deployed. Everyone who has
 * ever played before that has games in users/{uid}/bingoGames but no counters,
 * so the stats sheet would tell a long-time player they have played once. This
 * computes the real numbers from bingoGames — the source of truth the trigger
 * itself fires on — and writes them as ABSOLUTE values.
 *
 * Safe to run after the trigger is live: because it sets absolutes derived from
 * bingoGames, and every increment the trigger has made corresponds to a game
 * that IS in bingoGames, the result is correct either way. It is not additive,
 * so running it twice is harmless.
 *
 * WHAT COUNTS AS A PLAYED BOARD
 * A bingoGames doc is created on the user's FIRST TAP, before the board is
 * finished, and gets solvedAt later. The trigger aggregates on the solvedAt
 * transition, so only docs WITH solvedAt count here. Counting bare docs would
 * inflate `played` against what the trigger will add tomorrow.
 *
 * A "win" is a PERFECT 9/9. Every board resolves in single-shot mode, so
 * "solved" would be 100% and carry no information.
 *
 * PRIVACY: aggregates only. This prints counts, never an email, display name
 * or any other user field, and writes nothing to disk.
 *
 * Usage:
 *   node functions/scripts/backfill-bingo-stats.mjs            # dry run
 *   node functions/scripts/backfill-bingo-stats.mjs --write    # apply
 *   node functions/scripts/backfill-bingo-stats.mjs --verify   # compare only
 */

import admin from "firebase-admin";

const WRITE = process.argv.includes("--write");
const VERIFY = process.argv.includes("--verify");

admin.initializeApp({projectId: "teebox-market"});
const db = admin.firestore();

/** Fold one user's game docs into the same shape the trigger maintains. */
function foldGames(docs) {
  const stats = {
    played: 0,
    perfect: 0,
    correctTotal: 0,
    distribution: {},
    lastPlayedDate: "",
  };
  for (const d of docs) {
    const g = d.data() || {};
    if (!g.solvedAt) continue;                 // unfinished board — see header
    const correct = Math.max(0, Math.min(9, Number(g.correctCount) || 0));
    stats.played += 1;
    if (correct === 9) stats.perfect += 1;
    stats.correctTotal += correct;
    const k = String(correct);
    stats.distribution[k] = (stats.distribution[k] || 0) + 1;
    if (d.id > stats.lastPlayedDate) stats.lastPlayedDate = d.id;
  }
  return stats;
}

async function main() {
  console.log(`[backfill] mode: ${VERIFY ? "VERIFY" : WRITE ? "WRITE" : "DRY RUN"}`);

  // One collection-group read beats a per-user subcollection query, and the
  // parent ref carries the uid so no user listing is needed.
  const snap = await db.collectionGroup("bingoGames").get();
  console.log(`[backfill] ${snap.size} bingoGames docs across all users`);

  const byUid = new Map();
  snap.forEach((d) => {
    const uid = d.ref.parent.parent && d.ref.parent.parent.id;
    if (!uid) return;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(d);
  });
  console.log(`[backfill] ${byUid.size} users with at least one game doc`);

  let written = 0, skipped = 0, mismatched = 0, noSolves = 0;
  const dist = {};
  let batch = db.batch(); let inBatch = 0;

  for (const [uid, docs] of byUid) {
    const stats = foldGames(docs);
    if (!stats.played) { noSolves++; continue; }
    for (const [k, n] of Object.entries(stats.distribution)) dist[k] = (dist[k] || 0) + n;

    if (VERIFY) {
      const cur = (await db.doc(`users/${uid}`).get()).data() || {};
      const have = Number((cur.bingoStats || {}).played) || 0;
      if (have !== stats.played) {
        mismatched++;
        // Truncated uid only — enough to chase, not an identifier to leak.
        console.log(`[backfill]   MISMATCH ${uid.slice(0, 6)}…  stored=${have} actual=${stats.played}`);
      }
      continue;
    }

    if (!WRITE) { skipped++; continue; }

    batch.set(db.doc(`users/${uid}`), {
      bingoStats: {
        ...stats,
        backfilledAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    }, {merge: true});
    written++; inBatch++;
    if (inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
  }
  if (WRITE && inBatch) await batch.commit();

  console.log("[backfill] ── summary ─────────────────────────────");
  console.log(`[backfill] users with completed boards : ${byUid.size - noSolves}`);
  console.log(`[backfill] users with no completed board: ${noSolves}`);
  if (VERIFY) console.log(`[backfill] mismatches                  : ${mismatched}`);
  else if (WRITE) console.log(`[backfill] bingoStats written          : ${written}`);
  else console.log(`[backfill] would write                 : ${skipped} (re-run with --write)`);
  const totalSolves = Object.values(dist).reduce((a, b) => a + b, 0);
  console.log(`[backfill] completed boards, all users : ${totalSolves}`);
  console.log("[backfill] score distribution:");
  for (let i = 9; i >= 0; i--) {
    const n = dist[String(i)] || 0;
    if (!n && !totalSolves) continue;
    const pct = totalSolves ? (n * 100 / totalSolves).toFixed(1) : "0.0";
    console.log(`[backfill]   ${i}/9  ${String(n).padStart(5)}  ${pct.padStart(5)}%  ${"█".repeat(Math.round(n * 40 / Math.max(1, totalSolves)))}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[backfill] FAILED:", e && e.message);
  process.exit(1);
});
