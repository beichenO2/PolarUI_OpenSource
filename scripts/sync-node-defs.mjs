#!/usr/bin/env node
/** Copy versioned node-defs/ → dist output (build artifact). Clear dest first so removals sync. */
import { cpSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node-defs');
const DEST = process.argv[2]
  ? join(ROOT, process.argv[2], 'node-defs')
  : join(ROOT, 'dist/node-defs');

if (!existsSync(SRC)) {
  console.error(`sync-node-defs: missing source ${SRC}`);
  process.exit(1);
}

const indexPath = join(SRC, 'index.json');
let files = null;
if (existsSync(indexPath)) {
  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (Array.isArray(index.files)) files = index.files;
  } catch (e) {
    console.error(`sync-node-defs: bad index.json: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

mkdirSync(dirname(DEST), { recursive: true });
if (existsSync(DEST)) {
  rmSync(DEST, { recursive: true, force: true });
}
mkdirSync(DEST, { recursive: true });

if (files) {
  cpSync(indexPath, join(DEST, 'index.json'));
  for (const name of files) {
    const from = join(SRC, name);
    if (!existsSync(from)) {
      console.error(`sync-node-defs: missing ${from} (listed in index.json)`);
      process.exit(1);
    }
    const to = join(DEST, name);
    // R11 两层结构（primitives/、functions/）：子目录条目先建父目录
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  console.log(`sync-node-defs: ${SRC} → ${DEST} (${files.length} packs + index)`);
} else {
  cpSync(SRC, DEST, { recursive: true, force: true });
  console.log(`sync-node-defs: ${SRC} → ${DEST} (full tree)`);
}
