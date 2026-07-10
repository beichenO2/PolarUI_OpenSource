#!/usr/bin/env node
/** Remove stale vite bundles in dist/assets before src rebuild. */
import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(ROOT, 'dist/assets');

const REMOVE = [
  /^index-.*\.(js|css)$/,
  /^main-.*\.(js|css)$/,
  /^headless-api-.*\.js$/,
  /^evolution-gate-.*\.js$/,
  /^stem-cell-mutation-.*\.js$/,
  /^headless-keepalive-.*\.js$/,
  /^headless\.mjs$/,
  /^gui-overlay-boot\.mjs$/,
  /^export-web-button\.mjs$/,
];

if (!existsSync(assetsDir)) {
  console.log('clean-dist-assets: no dist/assets — skip');
  process.exit(0);
}

let count = 0;
for (const name of readdirSync(assetsDir)) {
  if (!REMOVE.some((re) => re.test(name))) continue;
  unlinkSync(join(assetsDir, name));
  console.log(`clean-dist-assets: removed ${name}`);
  count += 1;
}
console.log(count ? `clean-dist-assets: ${count} file(s)` : 'clean-dist-assets: nothing to remove');
