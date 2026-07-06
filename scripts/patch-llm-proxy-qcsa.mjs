#!/usr/bin/env node
/**
 * Patch bundle llm-proxy: 3-bit QCSA → 4-bit QCSA（对齐 PolarPrivate CAPABILITY_CLOUD_MAP）
 * SSoT: lib/llm-proxy/qcsa-model.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFragments } from '../lib/llm-proxy/qcsa-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(ROOT, 'dist/assets');
const MARKER = '"GLM-5.1":"0000"';

const OLD_BLOCK_3BIT = 'tcn={"GLM-5.1":"100","GLM-5":"100","GLM-5-TURBO":"001","GLM-TURBO":"001","ASTRON-CODE-LATEST":"100","CLAUDE-SONNET":"100","CLAUDE-3-SONNET":"100","CLAUDE-3-5-SONNET":"100","QWEN-PLUS":"100","QWEN-MAX":"100"};function v5t(l,f="cloud"){const d=(l??"").trim(),m=(tcn[d.toUpperCase()]??d).toUpperCase();if(m==="L000"||m==="L100"||m==="L101")return m;if(m==="E000")return"E000";if(/^[01]{3}$/.test(m))return f==="local"?`L${m}`:m;throw new Error(`Unknown model code "${m}". Cloud: 000–111. Local: L000, L100, L101. Embed: E000.`)}function ncn(){return`${z6e}/chat/completions`}const rcn=["001","000"];function Q2t(l,f){return l===502&&/ctyun|Cannot connect to upstream/i.test(f)}function icn(l){return l==="100"||l==="110"||l==="111"?[l,...rcn]:[l]}';

const OLD_BLOCK_BROKEN_4BIT = 'tcn={"GLM-5.1":"0000","GLM-5":"1000","GLM-5-TURBO":"0010","GLM-TURBO":"0010","ASTRON-CODE-LATEST":"0001","CLAUDE-SONNET":"1000","CLAUDE-3-SONNET":"1000","CLAUDE-3-5-SONNET":"1000","QWEN-PLUS":"1100","QWEN-MAX":"1100","DS-V4-FLASH":"0010","DS-V4-PRO":"0100","MINIMAX-M3":"0110","QWEN3.7-PLUS":"1100"};function v5t(l,f="cloud"){const d=(l??"").trim(),raw=(tcn[d.toUpperCase()]??d),u=raw.toUpperCase();if(u==="L0000"||u==="L0001"||/^L[01]{4}$/i.test(raw))return u;if(u==="E000")return"E000";if(/^V[01]{4}$/i.test(raw))return raw.toUpperCase();if(/^[01]{4}$/.test(raw))return f==="local"?"L"+raw:raw;if(/^[01]{3}$/.test(raw)){const m={000:"0000",001:"0010",010:"0100",011:"0110",100:"0000",101:"0101",110:"1100",111:"1110"}[raw];if(m)return f==="local"?"L"+m:m}throw new Error(`Unknown model code "${raw}". Cloud: 0000–1111, V0000–V1111. Local: L0000/L0001. Embed: E000.`)}function ncn(){return`${z6e}/chat/completions`}const rcn=["0010","0000"];function icn(l){return l==="1000"||l==="1100"||l==="1110"||l==="1001"||l==="1101"?[l,...rcn]:l==="0001"||l==="0011"||l==="0101"||l==="1011"?[l,"0000","0010"]:[l]};function Q2t(l,f){return l===502&&/ctyun|Cannot connect to upstream/i.test(f)}';

const { tcn, v5t, icn } = bundleFragments();
const NEW_BLOCK = `${tcn};${v5t}function ncn(){return\`\${z6e}/chat/completions\`}${icn};function Q2t(l,f){return l===502&&/ctyun|Cannot connect to upstream/i.test(f)}`;

function findBundle() {
  return readdirSync(assetsDir)
    .filter((f) => f.startsWith('index-') && f.endsWith('.js'))
    .map((f) => join(assetsDir, f));
}

let patched = 0;
for (const path of findBundle()) {
  const src = readFileSync(path, 'utf8');
  if (src.includes(MARKER) && src.includes('{"000":"0000"')) {
    console.log(`skip llm-proxy-qcsa (already patched): ${path}`);
    continue;
  }
  const oldBlock = src.includes(OLD_BLOCK_BROKEN_4BIT)
    ? OLD_BLOCK_BROKEN_4BIT
    : OLD_BLOCK_3BIT;
  if (!src.includes(oldBlock)) {
    console.error(`llm-proxy-qcsa needle not found in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, src.replace(oldBlock, NEW_BLOCK), 'utf8');
  console.log(`patched llm-proxy 4-bit QCSA: ${path}`);
  patched += 1;
}

console.log(patched ? `patch-llm-proxy-qcsa: ${patched} file(s)` : 'patch-llm-proxy-qcsa: nothing to do');
