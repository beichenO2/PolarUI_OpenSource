#!/usr/bin/env node
/**
 * Production build — src/ → dist/ (assets only; data dirs preserved).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.POLARUI_OUT_DIR ?? 'dist';
const IS_SRC_ONLY = process.env.POLARUI_BUILD_SRC === '1';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`=== PolarUI build → ${OUT}/ ===\n`);

console.log('▶ vue-tsc --noEmit');
run('npx', ['vue-tsc', '--noEmit']);

if (OUT === 'dist') {
  console.log('\n▶ clean-dist-assets.mjs');
  run('node', ['scripts/clean-dist-assets.mjs']);
}

console.log('\n▶ vite build --config vite.config.build.ts');
run('npx', ['vite', 'build', '--config', 'vite.config.build.ts']);

console.log(`\n▶ sync-node-defs.mjs (${OUT})`);
run('node', ['scripts/sync-node-defs.mjs', OUT]);

console.log('\n▶ write-headless-entry.mjs');
run('node', ['scripts/write-headless-entry.mjs', OUT]);

console.log(`\n▶ patch-gui-overlay-boot.mjs (${OUT})`);
run('node', ['scripts/patch-gui-overlay-boot.mjs', OUT]);

console.log(`\n▶ patch-export-web-button.mjs (${OUT})`);
run('node', ['scripts/patch-export-web-button.mjs', OUT]);

if (!IS_SRC_ONLY) {
  console.log('\n▶ generate:toolcall-catalog');
  run('npm', ['run', 'generate:toolcall-catalog']);

  console.log('\n▶ sync:workflows');
  run('npm', ['run', 'sync:workflows']);
}

console.log(`\nbuild complete → ${OUT}/`);
