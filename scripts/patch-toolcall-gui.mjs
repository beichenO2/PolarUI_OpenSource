#!/usr/bin/env node
/**
 * Patch bundle inspector — ToolCall tool_list 专用 GUI 挂载点（ADR-003）
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(ROOT, 'dist/assets');

const OLD = ':dn.type==="text"?Yh((Dt(),Kt("textarea",{key:3,"onUpdate:modelValue":Yo=>dl.value[Si]=Yo,class:"param-input param-textarea",rows:"4",placeholder:Si==="prompt"?"输入任务描述，如：帮我写一份雷达实验报告...":""},null,8,Jpn)),[[Yg,dl.value[Si]]]):Yh((Dt(),Kt("input",{key:4,type:"text","onUpdate:modelValue":Yo=>dl.value[Si]=Yo,class:"param-input"},null,8,Xpn)),[[Yg,dl.value[Si]]])';

const NEW = ':Si==="tool_list"||dn.type==="tool_list"?(Dt(),Kt("div",{key:"tl",class:"param-row polar-tool-list-row"},[Ce("label",null,on(dn.label||Si),1),Ce("div",{class:"polar-tool-list-host"}),Yh(Ce("input",{type:"hidden","data-tool-list-sync":"1","onUpdate:modelValue":Yo=>dl.value[Si]=Yo},null,512),[[Yg,dl.value[Si]]])])):dn.type==="text"?Yh((Dt(),Kt("textarea",{key:3,"onUpdate:modelValue":Yo=>dl.value[Si]=Yo,class:"param-input param-textarea",rows:"4",placeholder:Si==="prompt"?"输入任务描述，如：帮我写一份雷达实验报告...":""},null,8,Jpn)),[[Yg,dl.value[Si]]]):Yh((Dt(),Kt("input",{key:4,type:"text","onUpdate:modelValue":Yo=>dl.value[Si]=Yo,class:"param-input"},null,8,Xpn)),[[Yg,dl.value[Si]]])';

const MARKER = 'polar-tool-list-host';

function findBundle() {
  return readdirSync(assetsDir)
    .filter((f) => f.startsWith('index-') && f.endsWith('.js'))
    .map((f) => join(assetsDir, f));
}

let patched = 0;
for (const path of findBundle()) {
  const src = readFileSync(path, 'utf8');
  if (src.includes(MARKER)) {
    console.log(`skip toolcall-gui (already patched): ${path}`);
    continue;
  }
  if (!src.includes(OLD)) {
    console.error(`toolcall-gui needle not found in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, src.replace(OLD, NEW), 'utf8');
  console.log(`patched toolcall-gui inspector: ${path}`);
  patched += 1;
}

console.log(patched ? `patch-toolcall-gui: ${patched} file(s)` : 'patch-toolcall-gui: nothing to do');
