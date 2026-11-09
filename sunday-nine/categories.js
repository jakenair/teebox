// sunday-nine/categories.js — the ONE authored list of Sunday Nine categories.
//
// Shared verbatim by the browser (ES module import), the build script that
// pre-generates and validates grids, and the Cloud Function that scores games
// (scripts/sync-sunday-nine.mjs generates the CommonJS copy at
// functions/lib/sundayNineCore.js). Never reimplement a predicate elsewhere.
//
// A player record (built from data/sunday-nine-player-database.xlsx by
// scripts/build-sunday-nine.mjs) looks like:
//   {id, n, aka, c, col, ncaa, maj:[masters,pga,usopen,open], pl, fx, cup,
//    w1, liv, dec, oly, wins, ua, unk}
// `unk` lists the fields whose sheet cell is yellow (unverified). A player
// whose field is unknown never satisfies a category that reads that field:
// he is not counted for it and is not accepted as an answer for it.
//
// Sponsor is deliberately absent from v1 (founder ruling 2026-11-06), and a
// blank college never matches a college category.

export const CATEGORY_FIELDS = {
  country: "c", college: "col", ncaa: "ncaa", majors: "maj", players: "pl",
  fedex: "fx", cup: "cup", world1: "w1", liv: "liv", decade: "dec",
  olympic: "oly", wins: "wins", usam: "ua",
};

function known(p, field) {
  return !(p.unk && p.unk.indexOf(field) !== -1);
}

function majorTotal(p) {
  return p.maj[0] + p.maj[1] + p.maj[2] + p.maj[3];
}

const COLLEGES = [
  "Oklahoma State", "Arizona State", "Texas", "Georgia", "Wake Forest",
  "UNLV", "Florida", "Houston", "Georgia Tech", "Stanford", "Illinois",
  "Florida State", "USC", "UCLA", "Clemson", "Alabama", "LSU", "Oklahoma",
  "North Carolina", "Auburn", "Texas A&M", "SMU", "Arizona", "Vanderbilt",
  "Ohio State", "California", "Washington", "San Diego State", "Ole Miss",
  "Arkansas", "TCU", "Kent State", "Augusta", "BYU", "Duke", "Virginia",
  "Texas Tech", "North Texas", "Minnesota", "Pepperdine",
];

const COUNTRIES = [
  "United States", "England", "Australia", "South Africa", "Japan", "Spain",
  "Sweden", "South Korea", "Canada", "Scotland", "Ireland",
  "Northern Ireland", "New Zealand", "Denmark", "Germany", "Argentina",
  "France", "Italy", "Belgium", "Wales", "Norway", "Colombia",
];

const DECADES = ["1950s", "1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];

function buildCategories() {
  const out = [];
  const add = (id, label, group, field, test) => out.push({id, label, group, field, test});

  add("masters", "Won the Masters", "masters", "majors", (p) => p.maj[0] > 0);
  add("pga", "Won the PGA Championship", "pga", "majors", (p) => p.maj[1] > 0);
  add("usopen", "Won the U.S. Open", "usopen", "majors", (p) => p.maj[2] > 0);
  add("open", "Won The Open", "open", "majors", (p) => p.maj[3] > 0);
  add("multi-major", "2+ major wins", "majorcount", "majors", (p) => majorTotal(p) >= 2);
  add("players", "Won The Players", "players", "players", (p) => p.pl === "Y");
  add("fedex", "Won FedEx Cup or Tour Championship", "fedex", "fedex", (p) => p.fx === "Y");
  add("ryder", "Played in the Ryder Cup", "ryder", "cup", (p) => p.cup === "R" || p.cup === "B");
  add("presidents", "Played in the Presidents Cup", "presidents", "cup", (p) => p.cup === "P" || p.cup === "B");
  add("world1", "Reached World No. 1", "world1", "world1", (p) => p.w1 === "Y");
  add("liv", "Played on LIV Golf", "liv", "liv", (p) => p.liv === "Y");
  add("ncaa", "NCAA individual champion", "ncaa", "ncaa", (p) => p.ncaa === "Y");
  add("usam", "Won the U.S. Amateur", "usam", "usam", (p) => p.ua === "Y");
  add("olympian", "Olympic golfer", "olympic", "olympic", (p) => p.oly !== "N");
  add("medal", "Olympic medalist", "olympic", "olympic", (p) => p.oly === "G" || p.oly === "S" || p.oly === "B");
  add("wins10", "10+ PGA Tour wins", "wins", "wins", (p) => p.wins >= 10);
  add("wins20", "20+ PGA Tour wins", "wins", "wins", (p) => p.wins >= 20);
  for (const c of COLLEGES) {
    add("col-" + slug(c), "Played at " + c, "college", "college", (p) => p.col === c);
  }
  for (const c of COUNTRIES) {
    add("cty-" + slug(c), "From " + c, "country", "country", (p) => p.c === c);
  }
  for (const d of DECADES) {
    add("dec-" + d, "Turned pro in the " + d, "decade", "decade", (p) => p.dec === d);
  }
  return out;
}

export function slug(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const CATEGORIES = buildCategories();

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// True iff the player satisfies the category AND the field it reads is
// verified for him. This is the only function scoring may call.
export function matches(p, cat) {
  if (!p || !cat) return false;
  if (!known(p, cat.field)) return false;
  return !!cat.test(p);
}

// Groups that can never share a grid: two values of one field would make
// some squares impossible or trivially nested (Olympian vs medalist,
// 10+ vs 20+ wins, Ryder Cup on both axes).
export function groupsClash(a, b) {
  return a.group === b.group;
}
