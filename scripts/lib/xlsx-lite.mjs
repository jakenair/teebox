// scripts/lib/xlsx-lite.mjs
//
// Minimal .xlsx reader for build scripts — no npm dependency. Reads a sheet's
// cell values (shared strings, inline strings, numbers, cached formula
// results) and each cell's fill colour, which is all the Sunday Nine build
// needs (yellow fill = unverified). Not a general-purpose parser: no dates,
// rich-text runs are flattened, merged cells are ignored.

import {readFileSync} from "node:fs";
import {inflateRawSync} from "node:zlib";

function unzip(buf) {
  // End of central directory record: scan back from the end for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx-lite: not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("xlsx-lite: bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + csize);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

const textOf = (xml) => decode([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

export function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read one worksheet by its tab name.
 * @return {{rows: Array<Array<{v: string, fill: string|null}>>}}
 *   rows[r][c] — 0-based; fill is the ARGB of a solid fill, or null.
 */
export function readSheet(path, sheetName) {
  const files = unzip(readFileSync(path));
  const get = (n) => {
    const f = files.get(n);
    if (!f) throw new Error(`xlsx-lite: missing ${n}`);
    return f.toString("utf8");
  };
  const shared = [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  const styles = get("xl/styles.xml");
  const fills = [...(styles.match(/<fills[\s\S]*?<\/fills>/) || [""])[0].matchAll(/<fill>([\s\S]*?)<\/fill>/g)]
      .map((m) => {
        if (!/patternType="solid"/.test(m[1])) return null;
        const c = m[1].match(/<fgColor rgb="([0-9A-Fa-f]{8})"/);
        return c ? c[1].toUpperCase() : null;
      });
  const xfFill = [...(styles.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [""])[0].matchAll(/<xf ([^>]*?)\/?>/g)]
      .map((m) => {
        const f = m[1].match(/fillId="(\d+)"/);
        return f ? fills[+f[1]] || null : null;
      });

  const wb = get("xl/workbook.xml");
  const sheetTag = [...wb.matchAll(/<sheet ([^>]*)\/>/g)].map((m) => m[1])
      .find((a) => decode((a.match(/name="([^"]*)"/) || [])[1] || "") === sheetName);
  if (!sheetTag) throw new Error(`xlsx-lite: no sheet named ${sheetName}`);
  const rid = sheetTag.match(/r:id="([^"]+)"/)[1];
  const rels = get("xl/_rels/workbook.xml.rels");
  const target = [...rels.matchAll(/<Relationship ([^>]*)\/>/g)].map((m) => m[1])
      .find((a) => a.includes(`Id="${rid}"`)).match(/Target="([^"]+)"/)[1];
  const xml = get("xl/" + target.replace(/^\/?xl\//, ""));

  const rows = [];
  for (const rm of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = +rm[1] - 1;
    const row = [];
    for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[2];
      const inner = cm[3] || "";
      const t = (attrs.match(/ t="(\w+)"/) || [])[1];
      const s = (attrs.match(/ s="(\d+)"/) || [])[1];
      const vRaw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let v = "";
      if (t === "s") v = shared[+vRaw] ?? "";
      else if (t === "inlineStr") v = textOf(inner);
      else if (vRaw !== undefined) v = decode(vRaw);
      row[colIndex(cm[1])] = {v, fill: s !== undefined ? xfFill[+s] || null : null};
    }
    rows[r] = row;
  }
  return {rows};
}
