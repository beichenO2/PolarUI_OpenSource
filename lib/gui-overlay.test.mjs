/**
 * GUI overlay registration smoke — memory executors available after overlay boot.
 * ADR-011 P2: uses synthetic fixture (no archived taoci-outreach).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tests/fixtures/workflows/memory-overlay-smoke.json');

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
  const sessionDir = join(tmpdir(), `polarui-overlay-sessions-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  process.env.TAOCI_SESSION_DIR = sessionDir;
  process.env.TAOCI_MOCK_LLM = '1';
  process.env.TAOCI_MOCK_PDF = '1';

  const { loadHeadlessEngine, resetHeadlessEngine } = await import('./headless-engine.mjs');
  resetHeadlessEngine();
  const { resetMemoryRegistration } = await import('./memory-graph/register.mjs');
  resetMemoryRegistration();
  await loadHeadlessEngine();

  const { runWorkflowGraph } = await import('./run-graph.mjs');
  const result = await runWorkflowGraph({
    workflowPath: FIXTURE,
    inputs: {
      conversationId: `overlay-test-${Date.now()}`,
      message: 'overlay smoke message',
    },
  });
  assert.ok(result.node_traces.includes('ScenarioMemoryLoad'), `traces: ${result.node_traces.join(',')}`);
  assert.ok(!result.node_traces.includes('TaociSessionLoad'), 'TaociSessionLoad removed');
});
