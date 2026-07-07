/**
 * AC-R01~R05 export release tests
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportRelease, resolveReleaseId } from './export-release.mjs';
import { verifyRelease } from './verify-release.mjs';

const WEB_ROOT = join(process.env.HOME ?? '~', 'Desktop/Web_related');
const TEST_PREFIX = `test-export-${randomUUID().slice(0, 8)}`;
const TEST_ROOT = join(WEB_ROOT, TEST_PREFIX);

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

test('resolveReleaseId incremental', () => {
  mkdirSync(join(TEST_ROOT, 'wf-demo'), { recursive: true });
  assert.equal(resolveReleaseId('wf-demo', TEST_ROOT), 'wf-demo_1');
  mkdirSync(join(TEST_ROOT, 'wf-demo_1'), { recursive: true });
  assert.equal(resolveReleaseId('wf-demo', TEST_ROOT), 'wf-demo_1_1');
});

describe('AC-R01/R02 export taoci-outreach', () => {
  test('creates release with manifest and snapshot', async () => {
    const r = await exportRelease({
      workflow: 'taoci-outreach',
      webRoot: TEST_ROOT,
      skipPreflight: true,
      compileOnly: true,
      exportEntry: 'cli',
      silent: true,
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.release_id, 'taoci-outreach');
    assert.ok(existsSync(r.release_path));
    assert.equal(r.manifest.workflow_id, 'taoci-outreach');
    assert.ok(existsSync(join(r.release_path, 'workflow/snapshot.lg.json')));
    assert.ok(existsSync(join(r.release_path, 'config/memory-schema.json')));

    const log = readFileSync(join(r.release_path, 'EXPORT.log'), 'utf8');
    assert.match(log, /Step 3 compileWorkflowGraph/);
    assert.match(log, /Step 10 verifyRelease/);
    assert.ok(verifyRelease(r.release_path).ok);
  });

  test('AC-R02 incremental creates _1', async () => {
    const r = await exportRelease({
      workflow: 'taoci-outreach',
      webRoot: TEST_ROOT,
      skipPreflight: true,
      compileOnly: true,
      exportEntry: 'cli',
      silent: true,
    });
    assert.equal(r.release_id, 'taoci-outreach_1');
    assert.ok(existsSync(r.release_path));
  });
});

test('AC-R04 compile steps >= 6', async () => {
  const r = await exportRelease({
    workflow: 'taoci-outreach',
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
    workflow: 'taoci-outreach',
    webRoot: TEST_ROOT,
    skipPreflight: true,
    compileOnly: true,
    exportEntry: 'cli',
    silent: true,
  });
  const gui = await exportRelease({
    workflow: 'taoci-outreach',
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
