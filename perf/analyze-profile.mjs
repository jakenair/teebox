#!/usr/bin/env node
/** perf/analyze-profile.mjs — self-time attribution from a Profiler.stop() dump. */
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(process.argv[2] || 'perf/results/boot-profile.json', 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
// timeDeltas[i] is the gap BEFORE samples[i]; attribute it to that sample's node.
p.samples.forEach((id, i) => {
  self.set(id, (self.get(id) || 0) + (p.timeDeltas[i] || 0) / 1000);
});
const label = (n) => {
  const f = n.callFrame;
  const where = f.url ? f.url.replace(/^https?:\/\/[^/]+/, '').slice(-42) : '(native)';
  return `${(f.functionName || '(anonymous)').slice(0, 38).padEnd(38)} ${where}:${f.lineNumber + 1}`;
};
const rows = [...self.entries()]
    .map(([id, ms]) => ({ms, n: byId.get(id)}))
    .filter((r) => r.n)
    .sort((a, b) => b.ms - a.ms);
const total = rows.reduce((s, r) => s + r.ms, 0);
console.log(`\n  total sampled main-thread time: ${Math.round(total)}ms over ${p.samples.length} samples\n`);
console.log('  self-time  share  function / location');
for (const r of rows.slice(0, 24)) {
  if (r.ms < 4) break;
  console.log(`  ${(Math.round(r.ms) + 'ms').padStart(8)}  ${(100 * r.ms / total).toFixed(1).padStart(5)}%  ${label(r.n)}`);
}
// Walk up from the heaviest non-native frames to show who called them.
const parentOf = new Map();
p.nodes.forEach((n) => (n.children || []).forEach((ch) => parentOf.set(ch, n.id)));
console.log('\n  ── call chains for the top 5 script frames ──');
let shown = 0;
for (const r of rows) {
  if (shown >= 5) break;
  if (!r.n.callFrame.url) continue;
  const chain = [];
  let cur = r.n.id;
  while (cur && chain.length < 9) {
    const n = byId.get(cur);
    if (!n) break;
    chain.push((n.callFrame.functionName || '(anon)') +
      (n.callFrame.url ? ':' + (n.callFrame.lineNumber + 1) : ''));
    cur = parentOf.get(cur);
  }
  console.log(`  ${Math.round(r.ms)}ms  ${chain.reverse().join(' → ')}`);
  shown++;
}
console.log('');

// ── by script ─────────────────────────────────────────────────────────────
// Far more actionable than per-function: on this page almost every named frame
// is third-party, and the question is which vendor to defer, not which closure.
const byUrl = new Map();
for (const [id, ms] of self.entries()) {
  const n = byId.get(id); if (!n) continue;
  const u = n.callFrame.url || '(native / browser internals)';
  byUrl.set(u, (byUrl.get(u) || 0) + ms);
}
const urls = [...byUrl.entries()].sort((a, b) => b[1] - a[1]);
const scripted = urls.filter(([u]) => u !== '(native / browser internals)')
    .reduce((s, [, ms]) => s + ms, 0);
console.log(`  ── self-time by script (${Math.round(scripted)}ms attributable to JS) ──`);
for (const [u, ms] of urls) {
  if (ms < 5) break;
  const short = u.replace(/^https?:\/\//, '').split('?')[0].slice(0, 62);
  console.log(`  ${(Math.round(ms) + 'ms').padStart(8)}  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${short}`);
}
console.log('');
