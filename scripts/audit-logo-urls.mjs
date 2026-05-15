#!/usr/bin/env node
/**
 * scripts/audit-logo-urls.mjs
 *
 * Audits every logo referenced by the Logo Bingo course pool:
 *   1. Reads the canonical course list (bingo-courses.js + manifest.js).
 *   2. For each course id with a bundled PNG, computes the file's
 *      SHA-256 hash and records it.
 *   3. (Optional, --remote) For each course, HEADs/GETs the absolute
 *      CDN URL (https://teeboxmarket.com/assets/logos/{id}.png) and
 *      verifies the bytes hash to the same digest.
 *   4. Writes a JSON report to scripts/logo-audit-report.json
 *      (timestamped). Compare against prior runs to catch silent
 *      uploads — i.e. the bug where someone replaces the bytes under
 *      an existing ID and clients now show a different image.
 *
 * Usage:
 *   node scripts/audit-logo-urls.mjs               # local only
 *   node scripts/audit-logo-urls.mjs --remote      # also fetch CDN
 *   node scripts/audit-logo-urls.mjs --baseline    # write baseline
 *
 * Run without args to verify the bundled PNGs are coherent; with
 * --remote when you're online and want to confirm the live CDN matches
 * the bundle. --baseline writes the current local hashes into a
 * persistent JSON file (scripts/logo-audit-baseline.json) — future
 * runs compare against it to detect silent overwrites.
 *
 * No external dependencies; uses only Node.js built-ins.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const ARGS = new Set(process.argv.slice(2));
const REMOTE = ARGS.has("--remote");
const WRITE_BASELINE = ARGS.has("--baseline");
const CDN_ORIGIN = process.env.LOGO_CDN_ORIGIN || "https://teeboxmarket.com";

const BASELINE_PATH = resolve(__dirname, "logo-audit-baseline.json");
const REPORT_PATH = resolve(__dirname, "logo-audit-report.json");

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function loadCanonicalCourses() {
  const coursesMod = await import(resolve(REPO_ROOT, "bingo-courses.js"));
  const manifestMod = await import(
      resolve(REPO_ROOT, "assets", "logos", "manifest.js"));
  return coursesMod.COURSES
      .filter((c) => manifestMod.LOGOS_AVAILABLE.has(c.id))
      .map((c) => ({id: c.id, shortName: c.shortName || c.name || c.id}));
}

function hashLocal(id) {
  const path = resolve(REPO_ROOT, "assets", "logos", `${id}.png`);
  if (!existsSync(path)) {
    return {ok: false, error: "file missing", path};
  }
  const bytes = readFileSync(path);
  return {ok: true, hash: sha256Hex(bytes), bytes: bytes.length, path};
}

async function fetchRemote(url) {
  // Built-in fetch (Node 18+ has it native). 20s timeout.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {signal: controller.signal});
    if (!res.ok) {
      return {ok: false, status: res.status, error: `HTTP ${res.status}`};
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {ok: true, status: res.status, hash: sha256Hex(buf), bytes: buf.length};
  } catch (err) {
    return {ok: false, error: err && err.message || String(err)};
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const courses = await loadCanonicalCourses();
  console.log(`[audit] auditing ${courses.length} courses ` +
      `(remote=${REMOTE}, baseline=${WRITE_BASELINE})`);

  let baseline = null;
  if (!WRITE_BASELINE && existsSync(BASELINE_PATH)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    } catch (err) {
      console.warn(`[audit] could not parse baseline: ${err.message}`);
    }
  }

  const findings = [];
  let pass = 0;
  let fail = 0;
  for (const c of courses) {
    const local = hashLocal(c.id);
    let remote = null;
    if (REMOTE) {
      const url = `${CDN_ORIGIN}/assets/logos/${c.id}.png`;
      remote = await fetchRemote(url);
    }
    const entry = {
      id: c.id,
      shortName: c.shortName,
      local,
      remote,
    };
    // Verdict
    const problems = [];
    if (!local.ok) problems.push(`local: ${local.error}`);
    if (remote && !remote.ok) problems.push(`remote: ${remote.error}`);
    if (remote && remote.ok && local.ok && remote.hash !== local.hash) {
      problems.push(
          `remote hash ${remote.hash.slice(0, 12)}… differs from ` +
          `local ${local.hash.slice(0, 12)}…`);
    }
    if (baseline && baseline.entries) {
      const prev = baseline.entries.find((e) => e.id === c.id);
      if (prev && prev.localHash && local.ok && prev.localHash !== local.hash) {
        problems.push(
            `local hash ${local.hash.slice(0, 12)}… differs from ` +
            `baseline ${prev.localHash.slice(0, 12)}… ` +
            `(silent overwrite?)`);
      }
    }
    entry.problems = problems;
    if (problems.length) {
      fail += 1;
      console.error(`[FAIL] ${c.id}: ${problems.join("; ")}`);
    } else {
      pass += 1;
    }
    findings.push(entry);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    cdnOrigin: CDN_ORIGIN,
    remote: REMOTE,
    summary: {total: courses.length, pass, fail},
    entries: findings.map((e) => ({
      id: e.id,
      shortName: e.shortName,
      localHash: e.local.ok ? e.local.hash : null,
      localBytes: e.local.ok ? e.local.bytes : null,
      remoteHash: e.remote && e.remote.ok ? e.remote.hash : null,
      remoteStatus: e.remote ? e.remote.status || null : null,
      problems: e.problems,
    })),
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log(`[audit] wrote report → ${REPORT_PATH}`);

  if (WRITE_BASELINE) {
    writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2) + "\n");
    console.log(`[audit] wrote baseline → ${BASELINE_PATH}`);
  }

  console.log(
      `[audit] ${pass}/${courses.length} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(2);
});
