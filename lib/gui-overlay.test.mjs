/**
 * GUI overlay registration smoke — memory executors available after src bootstrap.
 * ADR-011 P2: uses synthetic fixture (no archived taoci-outreach).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tests/fixtures/workflows/memory-overlay-smoke.json');

function findBundle() {
  const assetsDir = join(ROOT, 'dist/assets');
  return readdirSync(assetsDir).find((f) => f.startsWith('index-') && f.endsWith('.js'));
}

test('build bundle: no patch scripts; overlay registration in main chunk', () => {
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.ok(!html.includes('gui-overlay-boot.mjs'), 'index.html must not load gui-overlay-boot.mjs');
  assert.ok(!html.includes('export-web-button.mjs'), 'index.html must not load export-web-button.mjs');
  assert.ok(!existsSync(join(ROOT, 'dist/assets/gui-overlay-boot.mjs')), 'stale gui-overlay-boot.mjs');
  assert.ok(!existsSync(join(ROOT, 'dist/assets/export-web-button.mjs')), 'stale export-web-button.mjs');

  const assetsDir = join(ROOT, 'dist/assets');
  const bundle = findBundle();
  assert.ok(bundle, 'index-*.js bundle missing — run npm run build');
  const bundleSrc = readFileSync(join(assetsDir, bundle), 'utf8');
  assert.ok(bundleSrc.includes('导出网站'), 'bundle must include ExportWebButton marker');

  const overlayChunk = readdirSync(assetsDir).find((f) => f.startsWith('register-gui-') && f.endsWith('.js'));
  assert.ok(overlayChunk, 'register-gui chunk missing — overlay not bundled');
  const overlaySrc = readFileSync(join(assetsDir, overlayChunk), 'utf8');
  assert.ok(overlaySrc.includes('ScenarioMemoryLoad'), 'register-gui chunk must register ScenarioMemoryLoad');
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
