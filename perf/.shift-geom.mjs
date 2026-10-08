import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {baseConfig} from './lh-config.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tbg-'));
const chrome=await chromeLauncher.launch({userDataDir:dir,chromeFlags:['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--disable-dev-shm-usage']});
const url='https://teeboxmarket.com/';
try {
  await lighthouse(url,{port:chrome.port,output:'json',logLevel:'silent'},baseConfig);
  const res=await lighthouse(url,{port:chrome.port,output:'json',logLevel:'silent',disableStorageReset:true},baseConfig);
  const a=res.lhr.audits;
  console.log('warm CLS', a['cumulative-layout-shift'].numericValue.toFixed(4));
  const items=((a['layout-shifts']||{}).details||{}).items||[];
  for (const it of items) {
    console.log(`\n── ${it.score.toFixed(4)}  ${(it.node||{}).selector}`);
    for (const s of ((it.subItems||{}).items||[])) {
      console.log('   ', JSON.stringify(s).slice(0,400));
    }
    if (it.node && it.node.boundingRect) console.log('    final rect', JSON.stringify(it.node.boundingRect));
  }
  // The raw trace has timing + rects the audit summary drops.
  fs.writeFileSync(path.join(dir,'..','tb-lhr.json'), JSON.stringify(res.lhr.audits['layout-shifts']));
  const ls = (res.artifacts && res.artifacts.traces) ? 'has artifacts' : 'no artifacts';
  console.log('\n', ls);
} finally { await chrome.kill(); try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5});}catch{} process.exit(0); }
