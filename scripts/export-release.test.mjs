/**
 * AC-R01~R05 export release tests + pipeline refactor coverage
 * (atomic staging, numeric release ids, executor scan, checksum verify).
 * ADR-011 P2: exports claude-code (sole registered workflow).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync, readdirSync, writeFileSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { exportRelease, parseArgs as parseExportArgs, resolveReleaseId } from './export-release.mjs';
import { verifyRelease } from './verify-release.mjs';
import { verifyOrthogonality } from './verify-orthogonality.mjs';
import { graphNodeTypes } from './graph-utils.mjs';
import { buildNativeDeploymentPlan } from './deploy-web-release.mjs';

const WEB_ROOT = join(process.env.HOME ?? '~', 'Desktop/Web_related');
const TEST_PREFIX = `test-export-${randomUUID().slice(0, 8)}`;
const TEST_ROOT = join(WEB_ROOT, TEST_PREFIX);
const WORKFLOW_ID = 'claude-code';

test('native export CLI accepts an explicit external database mode', () => {
  const args = parseExportArgs([
    'node', 'scripts/export-release.mjs', '--workflow', WORKFLOW_ID,
    '--template-flavor', 'native', '--database-mode', 'external',
  ]);
  assert.equal(args.databaseMode, 'external');
});

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

describe('AC-R06 orthogonality gate', () => {
  /** @type {string[]} */
  const cleanup = [];

  after(() => {
    for (const dir of cleanup) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best effort */
      }
    }
  });

  test('verifyOrthogonality passes clean staging fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ortho-clean-'));
    cleanup.push(dir);
    writeFileSync(join(dir, '.env.example'), 'POLARFLOW_LLM_API_KEY=\nEMAIL_PASSWORD=\nPORT=8065\n');
    writeFileSync(join(dir, 'site.config.json'), '{"url":"http://127.0.0.1:8065/run"}');
    const v = verifyOrthogonality(dir);
    assert.ok(v.ok, v.errors.join('\n'));
  });

  test('verifyOrthogonality rejects dev port reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ortho-port-'));
    cleanup.push(dir);
    writeFileSync(join(dir, '.env.example'), 'PORT=\n');
    writeFileSync(join(dir, 'bad.json'), '{"url":"http://127.0.0.1:8120/run"}');
    const v = verifyOrthogonality(dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('8120')), v.errors.join('\n'));
  });

  test('verifyOrthogonality rejects external symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ortho-link-'));
    cleanup.push(dir);
    writeFileSync(join(dir, '.env.example'), 'PORT=\n');
    mkdirSync(join(dir, 'engine', 'vendor'), { recursive: true });
    symlinkSync('~/Polarisor/PolarFlow', join(dir, 'engine', 'vendor', 'polarflow'));
    const v = verifyOrthogonality(dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('symlink outside staging')), v.errors.join('\n'));
  });

  test('verifyOrthogonality rejects non-empty env secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ortho-env-'));
    cleanup.push(dir);
    writeFileSync(join(dir, '.env.example'), 'POLARFLOW_LLM_API_KEY=sk-live-secret\n');
    const v = verifyOrthogonality(dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('env secret')), v.errors.join('\n'));
  });

  test('verifyOrthogonality skips upstream vendor .env.example secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ortho-upstream-'));
    cleanup.push(dir);
    writeFileSync(join(dir, '.env.example'), 'POLARFLOW_LLM_API_KEY=\n');
    mkdirSync(join(dir, 'upstream/librechat'), { recursive: true });
    writeFileSync(
      join(dir, 'upstream/librechat/.env.example'),
      'OPENAI_API_KEY=user_provided\nJWT_SECRET=16f8c0ef4a5d391b26034086c628469d3f9f497f08163ab9b40137092f2909ef\n',
    );
    const v = verifyOrthogonality(dir);
    assert.ok(v.ok, v.errors.join('\n'));
  });

  test('export fails at orthogonality when staging would contain :8120', async () => {
    const r = await exportRelease({
      workflow: WORKFLOW_ID,
      webRoot: TEST_ROOT,
      skipPreflight: true,
      compileOnly: true,
      silent: true,
    });
    if (!r.ok && r.stage === 'orthogonality') {
      assert.match(r.error, /8120|12790|Polarisor|\.env\.example|symlink/);
      assert.ok(!existsSync(r.release_path ?? join(TEST_ROOT, r.release_id ?? 'missing')));
      return;
    }
    assert.ok(r.ok, `expected orthogonality failure or ok with clean template: ${JSON.stringify(r)}`);
    assert.match(readFileSync(join(r.release_path, 'EXPORT.log'), 'utf8'), /Step 10\.5 verifyOrthogonality/);
    rmSync(r.release_path, { recursive: true, force: true, maxRetries: 3 });
  });
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

test('native export contains polar-web and excludes LibreChat runtime', async () => {
  const r = await exportRelease({
    workflow: WORKFLOW_ID,
    webRoot: TEST_ROOT,
    templateFlavor: 'native',
    skipPreflight: true,
    compileOnly: true,
    silent: true,
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.manifest.template_flavor, 'native');
  assert.ok(existsSync(join(r.release_path, 'product.manifest.json')));
  assert.ok(existsSync(join(r.release_path, 'Dockerfile')));
  assert.ok(existsSync(join(r.release_path, 'db/migrations/0001_identity.sql')));
  assert.ok(existsSync(join(r.release_path, 'compose.yml')));
  assert.ok(existsSync(join(r.release_path, 'compose.external-db.yml')));
  const config = JSON.parse(readFileSync(join(r.release_path, 'site.config.json'), 'utf8'));
  assert.equal(config.web.identity.provider, 'native-postgresql');
  assert.equal(config.web.database_mode, 'bundled');
  assert.equal(existsSync(join(r.release_path, 'librechat.yaml')), false);
  assert.equal(existsSync(join(r.release_path, 'upstream/librechat')), false);
  rmSync(r.release_path, { recursive: true, force: true });
});

test('native external compile-only export records external database mode', async () => {
  const r = await exportRelease({
    workflow: WORKFLOW_ID,
    webRoot: TEST_ROOT,
    templateFlavor: 'native',
    databaseMode: 'external',
    skipPreflight: true,
    compileOnly: true,
    silent: true,
  });
  assert.ok(r.ok, JSON.stringify(r));
  const config = JSON.parse(readFileSync(join(r.release_path, 'site.config.json'), 'utf8'));
  assert.equal(config.web.database_mode, 'external');
  rmSync(r.release_path, { recursive: true, force: true });
});

test('native deployment defaults to bundled compose and keeps database volumes', () => {
  const plan = buildNativeDeploymentPlan({
    databaseMode: 'bundled',
    releaseRoot: '/tmp/native-release',
    releaseId: 'demo',
    webPort: 4012,
    environment: {
      POSTGRES_PASSWORD: 'database-secret',
      AUTH_PEPPER: 'x'.repeat(32),
      PUBLIC_APP_ORIGIN: 'https://workflow.example.test',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      SMTP_FROM: 'Workflow <noreply@example.test>',
      SMTP_SECURE: 'false',
    },
  });
  assert.match(plan.command, /docker compose/);
  assert.match(plan.command, /compose\.yml/);
  assert.match(plan.command, /up --build web/);
  assert.doesNotMatch(plan.cleanupCommand, /\s-v(?:\s|$)/);
  assert.equal(plan.databaseMode, 'bundled');
});

test('external native deployment requires DATABASE_URL and runs only web', () => {
  assert.throws(() => buildNativeDeploymentPlan({
    databaseMode: 'external',
    releaseRoot: '/tmp/native-release',
    releaseId: 'demo',
    webPort: 4012,
    environment: {
      AUTH_PEPPER: 'x'.repeat(32),
      PUBLIC_APP_ORIGIN: 'https://workflow.example.test',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      SMTP_FROM: 'Workflow <noreply@example.test>',
      SMTP_SECURE: 'false',
    },
  }), /DATABASE_URL/);

  const plan = buildNativeDeploymentPlan({
    databaseMode: 'external',
    releaseRoot: '/tmp/native-release',
    releaseId: 'demo',
    webPort: 4012,
    environment: {
      DATABASE_URL: 'postgresql://db.example.test/workflow',
      AUTH_PEPPER: 'x'.repeat(32),
      PUBLIC_APP_ORIGIN: 'https://workflow.example.test',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      SMTP_FROM: 'Workflow <noreply@example.test>',
      SMTP_SECURE: 'false',
    },
  });
  assert.match(plan.command, /docker run/);
  assert.match(plan.command, /--env-file/);
  assert.doesNotMatch(plan.command, /postgresql:\/\/db\.example\.test/);
  assert.doesNotMatch(plan.command, /docker compose/);
  assert.equal(plan.databaseMode, 'external');
});
