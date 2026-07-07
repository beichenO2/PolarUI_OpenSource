/**
 * Browser GUI overlay boot smoke — memory + taoci executors registered.
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

test('GUI overlay boot registers ScenarioMemoryLoad executor', async () => {
  const bundle = findBundle();
  assert.ok(bundle, 'bundle missing');

  const mod = await import(join(assetsDir, bundle));
  const registerExecutor = mod.r ?? mod.registerExecutor;
  assert.equal(typeof registerExecutor, 'function');

  const seen = [];
  const wrapper = (ct, fn) => {
    seen.push(ct);
    return registerExecutor(ct, fn);
  };

  const { registerMemoryGuiExecutors } = await import('./memory-graph/register-gui.mjs');
  const { registerTaociGuiExecutors, resetTaociGuiRegistration } = await import('./taoci-graph/register-gui.mjs');
  registerMemoryGuiExecutors(wrapper);
  resetTaociGuiRegistration();
  registerTaociGuiExecutors(wrapper);

  assert.ok(seen.includes('ScenarioMemoryLoad'));
  assert.ok(seen.includes('ScenarioMemorySave'));
  assert.ok(seen.includes('UserMemoryLoad'));
  assert.ok(seen.includes('TaociSubAgent'));
  assert.ok(!seen.includes('TaociSessionLoad'));
});
