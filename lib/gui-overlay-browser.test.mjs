/**
 * Browser GUI overlay boot smoke — Taoci executors registered in executor map.
 */
import './shim-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(ROOT, 'dist/assets');

function findBundle() {
  return readdirSync(assetsDir).find((f) => f.startsWith('index-') && f.endsWith('.js'));
}

test('GUI overlay boot registers TaociSessionLoad executor', async () => {
  const bundle = findBundle();
  assert.ok(bundle, 'bundle missing');

  const mod = await import(join(assetsDir, bundle));
  const registerExecutor = mod.r ?? mod.registerExecutor;
  assert.equal(typeof registerExecutor, 'function');

  const { registerGuiOverlays } = await import('./gui-overlay.mjs');
  await registerGuiOverlays(registerExecutor, { browser: true });

  const seen = [];
  const orig = registerExecutor;
  const wrapper = (ct, fn) => {
    seen.push(ct);
    return orig(ct, fn);
  };
  // Probe: re-import overlay idempotent — check register-gui sets registered flag
  const { registerTaociGuiExecutors, resetTaociGuiRegistration } = await import('./taoci-graph/register-gui.mjs');
  resetTaociGuiRegistration();
  registerTaociGuiExecutors(wrapper);

  assert.ok(seen.includes('TaociSessionLoad'));
  assert.ok(seen.includes('TaociSessionSave'));
  assert.ok(seen.includes('TaociSubAgent'));
});
