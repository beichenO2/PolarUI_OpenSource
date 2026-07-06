#!/usr/bin/env node
/**
 * Sync workflow source → dist/workflows for GUI palette + deployment registry.
 * Only copies graph/registry JSON — skips .sessions, tests, prompts, etc.
 */
import { readdirSync, mkdirSync, cpSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'workflows');
const DEST = join(ROOT, 'dist/workflows');

const SKIP_DIRS = new Set(['.sessions', 'tests', 'prompts', 'feishu', 'node_modules']);

function shouldCopy(name, abs) {
  if (name === 'registry-entry.json') return true;
  if (name.endsWith('.lg.json')) return true;
  // Top-level workflow json (not under subdirs like test-mind-audit)
  if (name.endsWith('.json') && dirname(abs) === SRC) return true;
  return false;
}

function syncDir(dir, relBase = '') {
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      count += syncDir(abs, relBase ? `${relBase}/${name}` : name);
      continue;
    }
    if (!shouldCopy(name, abs)) continue;
    const rel = relBase ? `${relBase}/${name}` : name;
    const outName = rel.includes('/') ? name : rel;
    const out = join(DEST, outName);
    mkdirSync(dirname(out), { recursive: true });
    cpSync(abs, out);
    count += 1;
    console.log(`sync: ${rel} → dist/workflows/${outName}`);
  }
  return count;
}

mkdirSync(DEST, { recursive: true });
const n = syncDir(SRC);
console.log(n ? `sync-workflows: ${n} file(s)` : 'sync-workflows: nothing to do');
