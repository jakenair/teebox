// ─────────────────────────────────────────────────────────────────────────────
// Logo Bingo — cross-platform parity monitor
// ─────────────────────────────────────────────────────────────────────────────
// Runs daily at 04:05 ET (just after the email + Pro smoke tests so a
// human triaging alerts sees all three at once) and confirms that what
// iOS would show for today equals what web would show for today.
//
// Since both clients now fetch /dailyPuzzles/{date} from Firestore, the
// only way they can diverge is:
//   1. The doc doesn't exist for today (scheduled write failed).
//   2. The doc exists but has unexpected shape.
//   3. The doc's algorithm output disagrees with the canonical
//      selectDailyCourses() — i.e. someone wrote to dailyPuzzles
//      bypassing the function. (Rules forbid client writes, but
//      Admin SDK / migration scripts could.)
//
// On any of those, we log an error and POST to SMOKE_ALERT_WEBHOOK
// using the same alert pattern as emailSmokeTest.js. Failure-mode
// mirrors that file: Firestore record (bingoMonitorRuns/{date}) +
// logger.error + best-effort webhook.
//
// Why we still need a monitor when both clients pull the same doc:
// the Firestore document is a single point of failure. If the
// scheduled function fails to write today's puzzle, BOTH clients
// fall back to local dailySeed() — that path is deterministic per
// snapshot of inputs, but the iOS snapshot can be stale. The monitor
// catches the missing-doc case before users notice.
// ─────────────────────────────────────────────────────────────────────────────

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onRequest} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const {defineSecret} = require("firebase-functions/params");
// Shared secret for the manual ops-trigger HTTP endpoints (replaces the
// guessable static X-Smoke-Trigger: 1 header).
const MANUAL_TRIGGER_SECRET = defineSecret("MANUAL_TRIGGER_SECRET");
const admin = require("firebase-admin");
const https = require("https");
const http = require("http");
const {URL} = require("url");

const {__test: bingoTest} = require("./bingoDailyPuzzle");
const {selectDailyCourses, CANON, GENERATOR_VERSION} = bingoTest;

// Same secret the email + Pro smokes use — POST when something fails.
const SMOKE_ALERT_WEBHOOK = defineSecret("SMOKE_ALERT_WEBHOOK");

function todayUtcDateKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Core monitor logic ─────────────────────────────────────────────────────
//
// Both clients fetch the same Firestore doc, so "iOS view" and "web view"
// are by construction the SAME bytes. What we monitor here is:
//
//   A. Does the doc exist for today?
//   B. Does the doc have 9 well-formed courses?
//   C. Do the doc's course IDs match what the canonical algorithm would
//      produce *right now* for the same date? (Catches: someone wrote
//      to the doc bypassing the function; canon JSON drifted from what
//      the function shipped with.)
//   D. Does each course have a non-empty logoUrl?
async function runMonitor({trigger}) {
  const today = todayUtcDateKey();
  const result = {
    date: today,
    trigger,
    checks: [],
    ok: true,
    startedAt: Date.now(),
  };

  const fail = (name, message, extra) => {
    result.ok = false;
    result.checks.push({name, ok: false, message, ...extra});
  };
  const pass = (name, extra) => {
    result.checks.push({name, ok: true, ...extra});
  };

  const db = admin.firestore();

  // A. Doc exists.
  const ref = db.doc(`dailyPuzzles/${today}`);
  let snap;
  try {
    snap = await ref.get();
  } catch (err) {
    fail("docFetch", `Firestore read failed: ${err && err.message || err}`);
    await writeMonitorRun(db, today, result);
    if (!result.ok) await tryAlert(result);
    return result;
  }
  if (!snap.exists) {
    fail("docExists", `dailyPuzzles/${today} not written`);
    await writeMonitorRun(db, today, result);
    await tryAlert(result);
    return result;
  }
  pass("docExists");

  const data = snap.data() || {};

  // B. Shape check.
  if (!Array.isArray(data.courses) || data.courses.length !== 9) {
    fail("docShape",
        `courses missing or wrong length: ${
          Array.isArray(data.courses) ? data.courses.length : "not-array"}`);
  } else {
    pass("docShape");
  }

  // C. Algorithm parity. The canon snapshot is what THIS process holds;
  // if it differs from what the doc was written with, we still flag —
  // could mean the scheduled function deployed an updated canon but
  // the monitor function's revision lagged (or vice versa).
  let canonical;
  try {
    canonical = selectDailyCourses(today);
  } catch (err) {
    fail("selectLocal", `selectDailyCourses threw: ${err && err.message || err}`);
    canonical = null;
  }
  if (canonical && Array.isArray(canonical.courses) && Array.isArray(data.courses)) {
    const docVer = Number(data.generatorVersion);
    // INTENTIONALLY-PRESERVED older board: when a new generator version
    // ships, writePuzzleForDate keeps any board for a date <= today at its
    // existing (lower) version so already-played puzzles + leaderboards never
    // change. That board legitimately differs from what the current code
    // produces, so it is NOT drift — skip the board/version comparison (and
    // therefore never alert) when doc.generatorVersion < the current version.
    // Full detection is preserved whenever versions match.
    const preserved = Number.isFinite(docVer) && docVer < GENERATOR_VERSION;
    if (preserved) {
      pass("algorithmParity",
          {skipped: "preserved-version", docVersion: docVer,
            currentVersion: GENERATOR_VERSION});
      pass("generatorVersion",
          {skipped: "preserved-version", docVersion: docVer});
    } else {
      const docIds = data.courses.map((c) => c && c.id).join(",");
      const localIds = canonical.courses.map((c) => c && c.id).join(",");
      if (docIds !== localIds) {
        fail("algorithmParity",
            "doc courses differ from selectDailyCourses() output",
            {docIds, localIds});
      } else {
        pass("algorithmParity", {ids: docIds});
      }
      if (docVer !== GENERATOR_VERSION) {
        fail("generatorVersion",
            `doc.generatorVersion=${data.generatorVersion} but ` +
            `monitor expects ${GENERATOR_VERSION}`);
      } else {
        pass("generatorVersion");
      }
    }
    if (data.seed !== CANON.seed) {
      fail("seedDrift",
          `doc.seed=${data.seed} but monitor's canon seed=${CANON.seed}`);
    } else {
      pass("seedDrift");
    }
  }

  // D. logoUrl presence.
  if (Array.isArray(data.courses)) {
    const missing = data.courses
        .filter((c) => !c || typeof c.logoUrl !== "string" || !c.logoUrl)
        .map((c) => c && c.id);
    if (missing.length) {
      fail("logoUrlsPresent",
          `courses missing logoUrl: ${missing.join(",")}`);
    } else {
      pass("logoUrlsPresent");
    }
  }

  result.durationMs = Date.now() - result.startedAt;
  await writeMonitorRun(db, today, result);
  if (!result.ok) await tryAlert(result);
  return result;
}

// ── Firestore writer ───────────────────────────────────────────────────────
async function writeMonitorRun(db, date, payload) {
  try {
    await db.collection("bingoMonitorRuns").doc(date)
        .collection("runs").add({
          ...payload,
          recordedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
  } catch (err) {
    logger.error(
        `[BINGO_MONITOR] writeMonitorRun failed: ${err && err.message || err}`);
  }
}

// ── Alert webhook ──────────────────────────────────────────────────────────
async function tryAlert(result) {
  let url;
  try {
    url = SMOKE_ALERT_WEBHOOK.value();
  } catch (_e) {
    logger.error("[BINGO_MONITOR] FAIL (no webhook set)", result);
    return;
  }
  if (!url) {
    logger.error("[BINGO_MONITOR] FAIL (webhook empty)", result);
    return;
  }

  const fails = result.checks.filter((c) => !c.ok);
  const summary = fails.map(
      (c) => `${c.name}: ${c.message || "fail"}`).join("\n");
  const message =
    `TeeBox Bingo Cross-Platform Monitor FAILED\n` +
    `Date: ${result.date}\n` +
    `Trigger: ${result.trigger}\n` +
    `Failures:\n${summary}`;

  const body = JSON.stringify({text: message, content: message, message});
  try {
    await postJson(url, body);
  } catch (err) {
    logger.error(
        `[BINGO_MONITOR] webhook POST failed: ${err && err.message || err}`);
  }

  logger.error("[BINGO_MONITOR] FAIL", result);
}

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (e) {
      reject(new Error(`invalid SMOKE_ALERT_WEBHOOK URL: ${e.message}`));
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: parsed.pathname + parsed.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10_000,
    }, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`webhook POST returned ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("webhook POST timeout"));
    });
    req.write(body);
    req.end();
  });
}

// ── Scheduled trigger ──────────────────────────────────────────────────────
exports.dailyBingoMonitor = onSchedule({
  schedule: "every day 04:05",
  timeZone: "America/New_York",
  region: "us-central1",
  secrets: [SMOKE_ALERT_WEBHOOK],
  timeoutSeconds: 60,
  memory: "256MiB",
}, async () => {
  await runMonitor({trigger: "schedule"});
});

// ── Manual trigger ─────────────────────────────────────────────────────────
exports.dailyBingoMonitorManual = onRequest({
  region: "us-central1",
  secrets: [SMOKE_ALERT_WEBHOOK, MANUAL_TRIGGER_SECRET],
  timeoutSeconds: 60,
  memory: "256MiB",
}, async (req, res) => {
  // Authenticated by a shared secret in the X-Smoke-Trigger header (was the
  // guessable static "1"). Constant-ish compare via !== on the secret value.
  if (req.method !== "POST" ||
      req.get("X-Smoke-Trigger") !== MANUAL_TRIGGER_SECRET.value()) {
    res.status(404).send("Not found");
    return;
  }
  const out = await runMonitor({trigger: "manual"});
  res.status(out.ok ? 200 : 500).json(out);
});
