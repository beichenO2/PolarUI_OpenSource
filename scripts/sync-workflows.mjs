#!/usr/bin/env node
/**
 * Sync workflow source → dist/workflows for GUI palette + deployment registry.
 * Clear-then-copy: wipe dist/workflows (except transient preserve), then copy from workflows/.
 * Rebuilds registry.json from registry-entry.json files. Skips .sessions, tests, prompts.
 */
import {
  readdirSync,
  mkdirSync,
  cpSync,
  statSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'workflows');
const DEST = join(ROOT, 'dist/workflows');

const SKIP_DIRS = new Set(['.sessions', 'tests', 'prompts', 'node_modules']);

function shouldCopy(name, abs, relBase) {
  if (name === 'registry-entry.json') return true;
  // ADR-014 D3: PetriDish human-gated artifacts — never sync into dist/registry
  if (name.endsWith('.petri.json')) return false;
  if (name.endsWith('.lg.json')) return false;
  if (name.endsWith('.json') && relBase && name === `${relBase.split('/').pop()}.json`) return true;
  if (name.endsWith('.json') && dirname(abs) === SRC) return true;
  return false;
}

function clearDest() {
  if (!existsSync(DEST)) {
    mkdirSync(DEST, { recursive: true });
    return;
  }
  for (const name of readdirSync(DEST)) {
    rmSync(join(DEST, name), { recursive: true, force: true });
  }
}

/** @type {object[]} */
const registryEntries = [];

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
    if (!shouldCopy(name, abs, relBase)) continue;

    if (name === 'registry-entry.json') {
      try {
        registryEntries.push(JSON.parse(readFileSync(abs, 'utf8')));
      } catch {
        /* skip */
      }
      if (relBase) {
        const subOut = join(DEST, relBase, name);
        mkdirSync(dirname(subOut), { recursive: true });
        cpSync(abs, subOut);
        count += 1;
        console.log(`sync: ${relBase}/${name} → dist/workflows/${relBase}/${name}`);
      }
      continue;
    }

    const rel = relBase ? `${relBase}/${name}` : name;
    // Flat copy for resolveWorkflowPath(dist/workflows/{id}.json)
    const flatOut = join(DEST, name);
    mkdirSync(dirname(flatOut), { recursive: true });
    cpSync(abs, flatOut);
    count += 1;
    console.log(`sync: ${rel} → dist/workflows/${name}`);

    if (relBase) {
      const subOut = join(DEST, relBase, name);
      mkdirSync(dirname(subOut), { recursive: true });
      cpSync(abs, subOut);
    }
  }
  return count;
}

clearDest();
mkdirSync(DEST, { recursive: true });
const n = syncDir(SRC);

writeFileSync(join(DEST, 'registry.json'), JSON.stringify(registryEntries, null, 2) + '\n');
console.log(
  `sync-workflows: rebuilt registry.json (${registryEntries.length} entr${registryEntries.length === 1 ? 'y' : 'ies'})`,
);
console.log(n ? `sync-workflows: ${n} file(s)` : 'sync-workflows: nothing to do');
