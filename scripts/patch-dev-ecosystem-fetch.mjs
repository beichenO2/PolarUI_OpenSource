/**
 * Dev fix: ecosystem panel fetches PolarProcess via absolute :11055 → CORS on :5170.
 * Patch bundle to use same-origin /api/services (vite proxy).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(ROOT, 'dist/assets');

const FROM = 'I8t="http://127.0.0.1:11055"';
const TO = 'I8t=""';

let patched = 0;
for (const file of readdirSync(assetsDir)) {
  if (!file.startsWith('index-') || !file.endsWith('.js')) continue;
  const path = join(assetsDir, file);
  const src = readFileSync(path, 'utf8');
  if (!src.includes(FROM)) continue;
  writeFileSync(path, src.replace(FROM, TO));
  console.log(`patch-dev-ecosystem-fetch: ${file}`);
  patched++;
}

if (!patched) {
  console.log('patch-dev-ecosystem-fetch: nothing to patch (already done or bundle hash changed)');
}
