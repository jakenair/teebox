import * as fontkit from 'fontkit';
const S='/System/Library/Fonts/Supplemental/';
const files={'DM Sans':'dmsans.woff2','Playfair Display':'playfair.woff2','Arial':S+'Arial.ttf','Arial Bold':S+'Arial Bold.ttf',
  'Times New Roman':S+'Times New Roman.ttf','Times New Roman Bold':S+'Times New Roman Bold.ttf','Georgia':S+'Georgia.ttf','Georgia Bold':S+'Georgia Bold.ttf'};
const out={};
console.log('  font                   upm   hhea asc/desc/gap          typo asc/desc/gap        win asc/desc   USE_TYPO');
for (const [n,p] of Object.entries(files)) {
  const f=fontkit.openSync(p); const o=f['OS/2'], h=f.hhea;
  out[n]={upm:f.unitsPerEm,hhea:[h.ascent,h.descent,h.lineGap],typo:[o.typoAscender,o.typoDescender,o.typoLineGap],win:[o.winAscent,o.winDescent],useTypo:!!(o.fsSelection&0x80)};
  console.log(`  ${n.padEnd(22)} ${String(f.unitsPerEm).padStart(4)}   ${String(h.ascent).padStart(5)} ${String(h.descent).padStart(6)} ${String(h.lineGap).padStart(4)}            ${String(o.typoAscender).padStart(5)} ${String(o.typoDescender).padStart(6)} ${String(o.typoLineGap).padStart(4)}          ${String(o.winAscent).padStart(5)} ${String(o.winDescent).padStart(5)}    ${out[n].useTypo}`);
}
import fs from 'node:fs'; fs.writeFileSync('vmetrics.json', JSON.stringify(out,null,1));
