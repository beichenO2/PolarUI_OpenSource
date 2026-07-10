/**
 * Resolve PolarUI bundle assets directory.
 * POLARUI_BUNDLE_DIR overrides default dist/assets (e.g. for QA against alternate outDir).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_ROOT = dirname(fileURLToPath(import.meta.url));
const POLARUI_ROOT = join(LIB_ROOT, '..');

/** @returns {string} absolute path to assets directory */
export function resolveAssetsDir() {
  const raw = process.env.POLARUI_BUNDLE_DIR ?? 'dist/assets';
  return isAbsolute(raw) ? raw : join(POLARUI_ROOT, raw);
}

/** @returns {string | null} absolute path to index-*.js main bundle */
export function resolveMainBundle() {
  const assetsDir = resolveAssetsDir();
  if (!existsSync(assetsDir)) return null;
  const hit = readdirSync(assetsDir)
    .filter((f) => f.startsWith('index-') && f.endsWith('.js'))
    .sort()
    .at(-1);
  return hit ? join(assetsDir, hit) : null;
}

/** @returns {string} absolute path to headless.mjs */
export function resolveHeadlessEntry() {
  return join(resolveAssetsDir(), 'headless.mjs');
}
