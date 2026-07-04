#!/usr/bin/env node
/**
 * ADR-004 门禁：所有 workflow JSON 不得含 ShellExec class_type 或字符串引用。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WORKFLOW_DIRS = [
  join(ROOT, 'dist/workflows'),
  join(ROOT, 'workflows'),
];

function walkJsonFiles(dir, acc = []) {
  if (!statSync(dir, { throwIfNoEntry: false })) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJsonFiles(p, acc);
    else if (name.endsWith('.json')) acc.push(p);
  }
  return acc;
}

function findShellExecRefs(obj, path = '') {
  const hits = [];
  if (typeof obj === 'string') {
    // 允许描述性否定，如「无 ShellExec」
    if (obj.includes('ShellExec') && !/无\s*ShellExec/.test(obj)) {
      hits.push({ path, value: obj.slice(0, 120) });
    }
    return hits;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => hits.push(...findShellExecRefs(v, `${path}[${i}]`)));
    return hits;
  }
  if (obj && typeof obj === 'object') {
    if (obj.class_type === 'ShellExec') {
      hits.push({ path: path || 'node', value: 'class_type: ShellExec' });
    }
    for (const [k, v] of Object.entries(obj)) {
      hits.push(...findShellExecRefs(v, path ? `${path}.${k}` : k));
    }
  }
  return hits;
}

function main() {
  const files = new Set();
  for (const dir of WORKFLOW_DIRS) {
    for (const f of walkJsonFiles(dir)) files.add(f);
  }

  let failed = 0;
  for (const filePath of [...files].sort()) {
    const obj = JSON.parse(readFileSync(filePath, 'utf8'));
    const hits = findShellExecRefs(obj);
    if (hits.length) {
      failed++;
      console.error(`FAIL ${relative(ROOT, filePath)}:`);
      for (const h of hits.slice(0, 5)) {
        console.error(`  ${h.path}: ${h.value}`);
      }
    }
  }

  if (failed) {
    console.error(`\nvalidate-workflows-no-shellexec: ${failed} file(s) still contain ShellExec`);
    process.exit(1);
  }
  console.log(`validate-workflows-no-shellexec: OK (${files.size} files)`);
}

main();
