#!/usr/bin/env node
/**
 * scripts/build-sunday-nine.mjs
 *
 * data/sunday-nine-player-database.xlsx (exported from the "Sunday Nine –
 * Player Database" Google Sheet) -> sunday-nine/players.json and
 * sunday-nine/grids.json, plus the copies the Cloud Function scores against
 * (functions/data/sunday-nine-*.json).
 *
 * Rules applied here:
 *   - A yellow cell is unverified: the field goes into the player's `unk`
 *     list, and categories.js never matches a player on an unknown field.
 *   - The sponsor column is not read (out of v1).
 *   - Grids: GRID_DAYS grids from SUNDAY_NINE_EPOCH are generated with the
 *     shared engine, checked (every square >= 3 valid players, a perfect
 *     grid exists with 9 different players) and pinned. Dates already in
 *     grids.json keep their grid even if the data changes; the build fails
 *     if a pinned grid stops passing the check.
 *
 * Usage:  node scripts/build-sunday-nine.mjs [--report]
 * Then:   node scripts/sync-sunday-nine.mjs   (regenerates the server copy)
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {readSheet} from "./lib/xlsx-lite.mjs";
import {CATEGORIES, matches, slug} from "../sunday-nine/categories.js";
import {
  SUNDAY_NINE_EPOCH, addDays, checkGrid, generateGrid, normName,
} from "../sunday-nine/engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const XLSX = resolve(ROOT, "data/sunday-nine-player-database.xlsx");
const OUT_DIR = resolve(ROOT, "sunday-nine");
const FN_DATA = resolve(ROOT, "functions/data");
const GRID_DAYS = 60;
const YELLOW = new Set(["FFFFFF00", "FFFFF1CC", "FFFFF2CC"]);

// Other spellings people type, from the sheet notes (official-name
// differences between pgatour.com, owgr.com, livgolf.com and dpworldtour.com).
const ALIASES = {
  "Billy Mayfair": ["Bill Mayfair"],
  "Josele Ballester": ["Jose Luis Ballester"],
  "Sam Bennett": ["Samuel Bennett"],
  "Haotong Li": ["Li Haotong"],
  "Cameron Davis": ["Cam Davis"],
  "K.H. Lee": ["Kyoung-Hoon Lee"],
  "Kyoung-Hoon Lee": ["K.H. Lee"],
  "Sam Stevens": ["Samuel Stevens"],
  "Tom Kim": ["Joohyung Kim"],
  "S.H. Kim": ["Seonghyeon Kim"],
  "Si Woo Kim": ["Siwoo Kim"],
  "Matt Fitzpatrick": ["Matthew Fitzpatrick"],
  "Nicolai Hojgaard": ["Nicolai Hoejgaard"],
  "Rasmus Hojgaard": ["Rasmus Hoejgaard"],
};

const COLS = {
  name: 0, country: 1, college: 2, ncaa: 3, masters: 4, pga: 5, usopen: 6,
  open: 7, total: 8, players: 9, fedex: 10, cup: 11, world1: 12, liv: 13,
  sponsor: 14, decade: 15, olympic: 16, wins: 17, usam: 18,
};
// Sheet column -> the `field` key categories.js checks against `unk`.
const UNK_FIELD = {
  1: "country", 2: "college", 3: "ncaa", 4: "majors", 5: "majors", 6: "majors",
  7: "majors", 8: "majors", 9: "players", 10: "fedex", 11: "cup", 12: "world1",
  13: "liv", 15: "decade", 16: "olympic", 17: "wins", 18: "usam",
};

const problems = [];
const yn = (v, who, col) => {
  if (v === "Y" || v === "N") return v;
  problems.push(`${who}: ${col} is "${v}" (expected Y/N) — treated as unknown`);
  return null;
};
const int = (v, who, col) => {
  if (v === "" || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || Math.round(n) !== n) {
    problems.push(`${who}: ${col} is "${v}" (expected a whole number)`);
    return 0;
  }
  return n;
};

function buildPlayers() {
  const {rows} = readSheet(XLSX, "Players");
  const header = rows[0].map((c) => c && c.v);
  if (header[COLS.usam] !== "U.S. Amateur winner" || header[COLS.name] !== "Name") {
    throw new Error("Players tab columns moved — update COLS in build-sunday-nine.mjs");
  }
  const players = [];
  const seen = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cell = (k) => (row[COLS[k]] && row[COLS[k]].v || "").trim();
    const name = cell("name");
    if (!name) continue;
    const unk = new Set();
    for (const [ci, field] of Object.entries(UNK_FIELD)) {
      const c = row[+ci];
      if (c && c.fill && YELLOW.has(c.fill)) unk.add(field);
    }
    const p = {
      id: slug(name),
      n: name,
      c: cell("country"),
      col: cell("college"),
      ncaa: yn(cell("ncaa"), name, "NCAA title"),
      maj: ["masters", "pga", "usopen", "open"].map((k) => int(cell(k), name, k)),
      pl: yn(cell("players"), name, "Players"),
      fx: yn(cell("fedex"), name, "FedEx/Tour Championship"),
      cup: ({"Y – Both": "B", "Y – Ryder Cup": "R", "Y – Presidents Cup": "P", "N": "N"})[cell("cup")] || null,
      w1: yn(cell("world1"), name, "World No. 1"),
      liv: yn(cell("liv"), name, "LIV"),
      dec: /^\d{4}s$/.test(cell("decade")) ? cell("decade") : "",
      oly: (() => {
        const v = cell("olympic");
        if (v === "N") return "N";
        if (/Gold/.test(v)) return "G";
        if (/Silver/.test(v)) return "S";
        if (/Bronze/.test(v)) return "B";
        if (/^Y/.test(v)) return "Y";
        problems.push(`${name}: Olympic is "${v}" — treated as unknown`);
        return null;
      })(),
      wins: int(cell("wins"), name, "PGA Tour wins"),
      ua: yn(cell("usam"), name, "U.S. Amateur"),
    };
    if (p.cup === null) problems.push(`${name}: Ryder/Presidents is "${cell("cup")}" — treated as unknown`);
    // Any value we could not parse is unknown, same as a yellow cell.
    for (const [k, field] of [["ncaa", "ncaa"], ["pl", "players"], ["fx", "fedex"], ["cup", "cup"],
      ["w1", "world1"], ["liv", "liv"], ["oly", "olympic"], ["ua", "usam"]]) {
      if (p[k] === null) { unk.add(field); p[k] = "N"; }
    }
    const total = cell("total");
    if (total !== "" && Number(total) !== p.maj.reduce((a, b) => a + b, 0)) {
      problems.push(`${name}: Total majors ${total} != sum of the four majors`);
    }
    if (unk.size) p.unk = [...unk].sort();
    const aka = ALIASES[name];
    if (aka) p.aka = aka;
    const key = normName(name);
    if (seen.has(key)) problems.push(`duplicate player: ${name} (rows ${seen.get(key)} and ${r + 1})`);
    seen.set(key, r + 1);
    players.push(p);
  }
  const ids = new Set();
  for (const p of players) {
    if (ids.has(p.id)) throw new Error("duplicate player id " + p.id);
    ids.add(p.id);
  }
  players.sort((a, b) => a.n.localeCompare(b.n));
  return players;
}

function main() {
  const report = process.argv.includes("--report");
  const players = buildPlayers();

  const gridsPath = resolve(OUT_DIR, "grids.json");
  const prev = existsSync(gridsPath) ? JSON.parse(readFileSync(gridsPath, "utf8")) : {grids: {}};
  const grids = {};
  const failures = [];
  for (let i = 0; i < GRID_DAYS; i++) {
    const date = addDays(SUNDAY_NINE_EPOCH, i);
    const grid = prev.grids[date]
      ? {date, rows: prev.grids[date].rows, cols: prev.grids[date].cols}
      : generateGrid(date, players);
    const res = checkGrid(grid, players);
    if (!res.ok) failures.push(`${date}: ${res.why} ${JSON.stringify(res.counts || [])}`);
    grids[date] = {rows: grid.rows, cols: grid.cols, counts: res.counts};
  }
  // Keep pinned grids past the window too (they were published).
  for (const [date, g] of Object.entries(prev.grids)) {
    if (!grids[date]) {
      const res = checkGrid({date, rows: g.rows, cols: g.cols}, players);
      if (!res.ok) failures.push(`${date}: ${res.why}`);
      grids[date] = {rows: g.rows, cols: g.cols, counts: res.counts};
    }
  }
  if (failures.length) {
    console.error("[sunday-nine] grid check FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }

  mkdirSync(OUT_DIR, {recursive: true});
  mkdirSync(FN_DATA, {recursive: true});
  const playersJson = JSON.stringify({version: 1, count: players.length, players});
  const gridsJson = JSON.stringify({version: 1, epoch: SUNDAY_NINE_EPOCH, grids}, null, 1);
  writeFileSync(resolve(OUT_DIR, "players.json"), playersJson);
  writeFileSync(gridsPath, gridsJson);
  writeFileSync(resolve(FN_DATA, "sunday-nine-players.json"), playersJson);
  writeFileSync(resolve(FN_DATA, "sunday-nine-grids.json"), gridsJson);

  const unkCount = players.filter((p) => p.unk).length;
  console.log(`[sunday-nine] ${players.length} players (${unkCount} with an unverified field), ` +
    `${Object.keys(grids).length} grids checked, all squares >= 3 answers`);
  if (problems.length) console.log("[sunday-nine] data problems:\n  " + problems.join("\n  "));
  if (report) {
    const rows = CATEGORIES.map((c) => [c.id, players.filter((p) => matches(p, c)).length]);
    console.log("[sunday-nine] category sizes:\n  " + rows.map(([a, b]) => `${a} ${b}`).join("\n  "));
  }
}

main();
