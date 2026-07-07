/**
 * GUI overlay registration smoke — Taoci executors available after overlay boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('patch artifacts: gui-overlay-boot + index.html + overlay copy', () => {
  const boot = join(ROOT, 'dist/assets/gui-overlay-boot.mjs');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.ok(existsSync(boot), 'dist/assets/gui-overlay-boot.mjs missing — run npm run patch:gui-overlay');
  assert.ok(html.includes('gui-overlay-boot.mjs'), 'index.html must load gui-overlay-boot.mjs');
  assert.ok(existsSync(join(ROOT, 'dist/overlay/gui-overlay.mjs')));
  assert.ok(existsSync(join(ROOT, 'dist/overlay/memory-graph/register-gui.mjs')));
  const bootSrc = readFileSync(boot, 'utf8');
  assert.ok(bootSrc.includes('registerGuiOverlays'));
  assert.ok(!bootSrc.includes('register.mjs'), 'browser overlay must not import headless register.mjs');
});

test('headless overlay registers ScenarioMemoryLoad', async () => {
  process.env.TAOCI_MOCK_LLM = '1';
  process.env.TAOCI_MOCK_PDF = '1';
  process.env.TAOCI_SESSION_DIR = join(ROOT, 'workflows/taoci-outreach/.sessions');

  const { loadHeadlessEngine, resetHeadlessEngine } = await import('./headless-engine.mjs');
  resetHeadlessEngine();
  const { resetMemoryRegistration } = await import('./memory-graph/register.mjs');
  resetMemoryRegistration();
  const engine = await loadHeadlessEngine();

  const seen = new Set();
  const orig = engine.registerExecutor;
  engine.registerExecutor = (ct, fn) => {
    seen.add(ct);
    return orig(ct, fn);
  };
  // Re-register probe — taoci already registered on first load
  const { runWorkflowGraph } = await import('./run-graph.mjs');
  const result = await runWorkflowGraph({
    workflowId: 'taoci-outreach',
    inputs: {
      conversationId: `overlay-test-${Date.now()}`,
      message: '想套辞胡友财老师，药大大三',
    },
  });
  assert.ok(result.node_traces.includes('ScenarioMemoryLoad'), `traces: ${result.node_traces.join(',')}`);
  assert.ok(!result.node_traces.includes('TaociSessionLoad'), 'TaociSessionLoad removed');
});
