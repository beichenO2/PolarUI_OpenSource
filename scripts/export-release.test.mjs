/**
 * AC-R01~R05 export release tests + pipeline refactor coverage
 * (atomic staging, numeric release ids, executor scan, checksum verify).
 * ADR-011 P2: exports claude-code (sole registered workflow).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportRelease, resolveReleaseId } from './export-release.mjs';
import { verifyRelease } from './verify-release.mjs';
import { graphNodeTypes } from './graph-utils.mjs';

const WEB_ROOT = join(process.env.HOME ?? '~', 'Desktop/Web_related');
const TEST_PREFIX = `test-export-${randomUUID().slice(0, 8)}`;
const TEST_ROOT = join(WEB_ROOT, TEST_PREFIX);
const WORKFLOW_ID = 'claude-code';

before(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  try {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort cleanup */
  }
});

test('resolveReleaseId first export', () => {
  const id = resolveReleaseId('wf-demo', TEST_ROOT);
  assert.equal(id, 'wf-demo');
});

test('resolveReleaseId numeric increment (no _1_1 chains)', () => {
  mkdirSync(join(TEST_ROOT, 'wf-demo'), { recursive: true });
  assert.equal(resolveReleaseId('wf-demo', TEST_ROOT), 'wf-demo_1');
  mkdirSync(join(TEST_ROOT, 'wf-demo_1'), { recursive: true });
  assert.equal(resolveReleaseId('wf-demo', TEST_ROOT), 'wf-demo_2');
  mkdirSync(join(TEST_ROOT, 'wf-demo_2'), { recursive: true });
  mkdirSync(join(TEST_ROOT, 'wf-demo_7'), { recursive: true });
  assert.equal(resolveReleaseId('wf-demo', TEST_ROOT), 'wf-demo_8');
});

test('resolveReleaseId --from-release reduces to base then increments', () => {
  // legacy chained name should not grow another suffix
  assert.equal(resolveReleaseId('wf-demo', TEST_ROOT, 'wf-demo_1'), 'wf-demo_8');
  assert.equal(resolveReleaseId('wf-demo', TEST_ROOT, 'wf-demo_1_1'), 'wf-demo_8');
});

describe('AC-R01/R02 export claude-code', () => {
  test('creates release with manifest and snapshot', async () => {
    const r = await exportRelease({
      workflow: WORKFLOW_ID,
      webRoot: TEST_ROOT,
      skipPreflight: true,
      compileOnly: true,
      exportEntry: 'cli',
      silent: true,
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.release_id, WORKFLOW_ID);
    assert.ok(existsSync(r.release_path));
    assert.equal(r.manifest.workflow_id, WORKFLOW_ID);
    assert.equal(r.manifest.web_root, r.release_path, 'manifest.web_root must be final path, not staging');
    assert.ok(existsSync(join(r.release_path, 'workflow/snapshot.json')));
    assert.ok(existsSync(join(r.release_path, 'config/memory-schema.json')));

    const log = readFileSync(join(r.release_path, 'EXPORT.log'), 'utf8');
    assert.match(log, /Step 3 compileWorkflowGraph/);
    assert.match(log, /Step 10 verifyRelease/);
    assert.ok(existsSync(join(r.release_path, 'EXPORT.log.json')), 'structured log present');
    assert.ok(verifyRelease(r.release_path).ok);
  });

  test('AC-R02 incremental creates _1', async () => {
    const r = await exportRelease({
      workflow: WORKFLOW_ID,
      webRoot: TEST_ROOT,
      skipPreflight: true,
      compileOnly: true,
      exportEntry: 'cli',
      silent: true,
    });
    assert.equal(r.release_id, `${WORKFLOW_ID}_1`);
    assert.ok(existsSync(r.release_path));
  });
});

test('AC-R04 compile steps >= 6', async () => {
  const r = await exportRelease({
    workflow: WORKFLOW_ID,
    webRoot: TEST_ROOT,
    skipPreflight: true,
    compileOnly: true,
    exportEntry: 'cli',
    silent: true,
  });
  assert.ok(r.ok);
  assert.ok(r.manifest.compile_steps.length >= 6);
  assert.ok(!existsSync(join(r.release_path, 'workflows')));
  rmSync(r.release_path, { recursive: true, force: true });
});

test('AC-R05 dual entry same compile_steps', async () => {
  const cli = await exportRelease({
    workflow: WORKFLOW_ID,
    webRoot: TEST_ROOT,
    skipPreflight: true,
    compileOnly: true,
    exportEntry: 'cli',
    silent: true,
  });
  const gui = await exportRelease({
    workflow: WORKFLOW_ID,
    webRoot: TEST_ROOT,
    skipPreflight: true,
    compileOnly: true,
    exportEntry: 'gui',
    silent: true,
  });
  assert.deepEqual(cli.manifest.compile_steps, gui.manifest.compile_steps);
  assert.equal(gui.manifest.export_entry, 'gui');
  assert.equal(cli.manifest.export_entry, 'cli');
});

test('executor scan reads numbered-key graph format', async () => {
  const lg = JSON.parse(readFileSync(join(TEST_ROOT, `${WORKFLOW_ID}/workflow/snapshot.json`), 'utf8'));
  const types = graphNodeTypes(lg);
  assert.ok(types.length > 0, 'numbered-key graph must yield node types');
  assert.ok(types.includes('LLM'));
  assert.ok(types.includes('Output'));

  const executors = JSON.parse(
    readFileSync(join(TEST_ROOT, `${WORKFLOW_ID}/config/required-executors.json`), 'utf8'),
  );
  assert.deepEqual(executors.executors, types, 'release must carry the real executor list');
});

test('failed export leaves no release dir and no staging garbage', async () => {
  const beforeNames = readdirSync(TEST_ROOT);
  const r = await exportRelease({
    workflow: 'no-such-workflow',
    webRoot: TEST_ROOT,
    skipPreflight: true,
    compileOnly: true,
    silent: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'input');
  assert.deepEqual(readdirSync(TEST_ROOT), beforeNames, 'no dirs created on failure');
  assert.ok(!readdirSync(TEST_ROOT).some((n) => n.startsWith('.staging-')), 'no staging leftovers');
});

test('verifyRelease catches snapshot tampering (checksum)', async () => {
  const r = await exportRelease({
    workflow: WORKFLOW_ID,
    webRoot: TEST_ROOT,
    skipPreflight: true,
    compileOnly: true,
    silent: true,
  });
  assert.ok(r.ok);
  assert.ok(verifyRelease(r.release_path).ok);
  const snapPath = join(r.release_path, 'workflow/snapshot.json');
  writeFileSync(snapPath, readFileSync(snapPath, 'utf8') + '\n');
  const v = verifyRelease(r.release_path);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('checksum mismatch')));
  rmSync(r.release_path, { recursive: true, force: true });
});

test('AC-R03 release DB isolation', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { default: PolarDb } = await import(
    `file://${join(WEB_ROOT, '_template/polar/db.mjs')}`
  );
  const r1 = mkdtempSync(join(tmpdir(), 'release-a-'));
  const r2 = mkdtempSync(join(tmpdir(), 'release-b-'));
  const db1 = new PolarDb(join(r1, 'data'));
  const db2 = new PolarDb(join(r2, 'data'));
  db2.ensureUser('alice');
  assert.equal(db1.listUsers().includes('alice'), false);
  rmSync(r1, { recursive: true, force: true });
  rmSync(r2, { recursive: true, force: true });
});

test('AC-L01 README attribution', () => {
  const readme = readFileSync(join(WEB_ROOT, '_template/README.md'), 'utf8');
  assert.match(readme, /LibreChat/);
  assert.match(readme, /MIT/);
  assert.match(readme, /github\.com\/danny-avila\/LibreChat/);
});

test('P2a export merges --http-workflow into site.config + librechat.yaml', async () => {
  const r = await exportRelease({
    workflow: WORKFLOW_ID,
    webRoot: TEST_ROOT,
    skipPreflight: true,
    compileOnly: true,
    silent: true,
    httpWorkflows: [
      {
        id: 'p2a-demo-http',
        label: 'P2a Demo',
        description: 'export-release http_workflows smoke',
        url: 'http://host.docker.internal:3941/run',
        timeout_ms: 60000,
      },
    ],
  });
  assert.ok(r.ok, JSON.stringify(r));
  const cfg = JSON.parse(readFileSync(join(r.release_path, 'site.config.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.http_workflows));
  assert.equal(cfg.http_workflows[0].id, 'p2a-demo-http');
  assert.equal(cfg.http_workflows[0].url, 'http://host.docker.internal:3941/run');
  const lc = readFileSync(join(r.release_path, 'librechat.yaml'), 'utf8');
  assert.match(lc, /p2a-demo-http/);
  assert.match(lc, /P2a Demo/);
  rmSync(r.release_path, { recursive: true, force: true });
});
