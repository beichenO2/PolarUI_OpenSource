#!/usr/bin/env node
/**
 * Patch bundle ToolCall executor — ADR-003 intent-only:
 * outputs tool_calls + tool_list + branch/tool for LG _lg_edges routing.
 * Does NOT execute tools (no W5t / hub dispatch).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(ROOT, 'dist/assets');

const OLD =
  'return{outputs:{tool_calls:m.toolCalls,raw:m.content},duration_ms:0}});Xe("Condition"';

const NEW = `const _tc=m.toolCalls??[],_tn=String((_tc[0]?.function?.name??_tc[0]?.name??""));return{outputs:{tool_calls:_tc,raw:m.content,tool_list:Array.isArray(p)?p:[],branch:_tn,tool:_tn,state:{branch:_tn,tool:_tn,tool_calls:_tc}},duration_ms:0}});Xe("Condition"`;

function findBundle() {
  return readdirSync(assetsDir)
    .filter((f) => f.startsWith('index-') && f.endsWith('.js'))
    .map((f) => join(assetsDir, f));
}

let patched = 0;
for (const path of findBundle()) {
  const src = readFileSync(path, 'utf8');
  if (src.includes('_tn=String((_tc[0]')) {
    console.log(`skip ToolCall (already patched): ${path}`);
    continue;
  }
  if (!src.includes(OLD)) {
    console.error(`ToolCall needle not found in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, src.replace(OLD, NEW), 'utf8');
  console.log(`patched ToolCall intent-only: ${path}`);
  patched += 1;
}

console.log(patched ? `patch-toolcall-executor: ${patched} file(s)` : 'patch-toolcall-executor: nothing to do');
