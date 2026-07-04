#!/usr/bin/env node
/**
 * Patch PolarUI bundle: executeGraph (LX) delegates to LG runner (S4t) when library === 'LG'.
 * WF workflows continue using topological LX; LG workflows use step-wise _lg_edges routing.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(ROOT, 'dist/assets');

const NEEDLE = 'async function LX(l,f={}){var X,ee,Z,re;';
const REPLACEMENT = 'async function LX(l,f={}){if(String(l.library??"")==="LG")return S4t(l,f);var X,ee,Z,re;';

const SWITCH_NEEDLE = 'f("Switch",async(p,m,v)=>{const b=v.lgAccumulatedState??{},E=typeof b.branch=="string"?b.branch:"finish";return{outputs:{state:b,branch:E,selected:E,value:E},duration_ms:0}})';
const SWITCH_REPLACEMENT = 'f("Switch",async(p,m,v)=>{const b=v.lgAccumulatedState??{};let E=typeof b.branch=="string"?b.branch:"";if(!E){const raw=m.value??m.selected;E=typeof raw=="string"?raw:String(raw?.step??raw?.branch??raw??"")}E||(E="finish");return{outputs:{state:{...b,branch:E},branch:E,selected:E,value:E},duration_ms:0}})';

function findBundle() {
  return readdirSync(assetsDir)
    .filter((f) => f.startsWith('index-') && f.endsWith('.js'))
    .map((f) => join(assetsDir, f));
}

let totalPatches = 0;
for (const path of findBundle()) {
  const original = readFileSync(path, 'utf8');
  let src = original;
  let filePatches = 0;

  if (src.includes(REPLACEMENT.slice(0, 60))) {
    console.log(`skip LX (already patched): ${path}`);
  } else if (!src.includes(NEEDLE)) {
    console.error(`LX needle not found in ${path}`);
    process.exit(1);
  } else {
    src = src.replace(NEEDLE, REPLACEMENT);
    console.log(`patched LX→S4t: ${path}`);
    filePatches += 1;
  }

  if (src.includes(SWITCH_REPLACEMENT.slice(0, 80))) {
    console.log(`skip Switch (already patched): ${path}`);
  } else if (src.includes(SWITCH_NEEDLE)) {
    src = src.replace(SWITCH_NEEDLE, SWITCH_REPLACEMENT);
    console.log(`patched Switch LG: ${path}`);
    filePatches += 1;
  } else {
    console.warn(`Switch needle not found in ${path} (optional)`);
  }

  if (src !== original) {
    writeFileSync(path, src, 'utf8');
    totalPatches += filePatches;
  }
}

if (totalPatches === 0) {
  console.log('patch-lg-runner: nothing to do');
} else {
  console.log(`patch-lg-runner: ${totalPatches} patch(es) applied`);
}
