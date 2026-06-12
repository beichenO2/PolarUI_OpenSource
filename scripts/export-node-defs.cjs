#!/usr/bin/env node
/**
 * validate-node-defs.cjs
 *
 * 验证 ~/Polarisor/PolarUI/node-defs.json 的格式完整性。
 * node-defs.json 是生态级唯一信源（SSoT），不再从 TS 硬编码导出。
 *
 * 用法: node scripts/export-node-defs.cjs [--fix]
 *   --fix  自动修复可修复问题（去重、排序）
 */
const fs = require('fs');
const path = require('path');

const ssotPath = path.join(__dirname, '..', '..', 'node-defs.json');
const symlinkPath = path.join(__dirname, '..', 'public', 'node-defs.json');
const fix = process.argv.includes('--fix');

if (!fs.existsSync(ssotPath)) {
  console.error(`[FAIL] SSoT file not found: ${ssotPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(ssotPath, 'utf-8');
let defs;
try {
  defs = JSON.parse(raw);
} catch (e) {
  console.error(`[FAIL] Invalid JSON: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(defs)) {
  console.error(`[FAIL] Expected array, got ${typeof defs}`);
  process.exit(1);
}

const errors = [];
const seen = new Map();

for (let i = 0; i < defs.length; i++) {
  const d = defs[i];
  const loc = `[${i}]`;

  if (!d.class_type) errors.push(`${loc} missing class_type`);
  if (!d.category) errors.push(`${loc} missing category`);
  if (!d.display_name) errors.push(`${loc} missing display_name`);
  if (!Array.isArray(d.inputs)) errors.push(`${loc} inputs must be array`);
  if (!Array.isArray(d.outputs)) errors.push(`${loc} outputs must be array`);

  if (d.class_type && seen.has(d.class_type)) {
    errors.push(`${loc} duplicate class_type "${d.class_type}" (first at [${seen.get(d.class_type)}])`);
  }
  if (d.class_type) seen.set(d.class_type, i);
}

if (errors.length > 0) {
  console.error(`[FAIL] ${errors.length} validation error(s):`);
  errors.forEach(e => console.error(`  - ${e}`));
  if (!fix) process.exit(1);
}

if (fix) {
  const unique = new Map();
  for (const d of defs) {
    if (d.class_type) unique.set(d.class_type, d);
  }
  const sorted = [...unique.values()].sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.class_type.localeCompare(b.class_type);
  });
  fs.writeFileSync(ssotPath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`[FIXED] Wrote ${sorted.length} unique defs (sorted by category → class_type)`);
}

// Verify symlink
try {
  const target = fs.readlinkSync(symlinkPath);
  if (!target.includes('node-defs.json')) {
    console.warn(`[WARN] Symlink target unexpected: ${target}`);
  }
} catch {
  console.warn(`[WARN] ${symlinkPath} is not a symlink — Vite dev server may serve stale data`);
}

console.log(`[OK] ${defs.length} node definitions validated in ${ssotPath}`);
