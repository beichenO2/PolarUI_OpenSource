/**
 * P2a: compile-site-config merges/validates http_workflows[]
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileSiteConfig, normalizeHttpWorkflows } from './compile-site-config.mjs';

function baseOpts(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'csc-'));
  writeFileSync(join(root, 'snap.json'), '{"nodes":{}}');
  return {
    releaseId: 'demo',
    workflowId: 'demo',
    releaseRoot: root,
    exportEntry: 'cli',
    compileSteps: ['config'],
    workflowSnapshotRel: 'snap.json',
    memorySchemaRel: 'config/memory-schema.json',
    registry: { id: 'demo' },
    requiredExecutors: ['LLM'],
    polaruiRoot: '/tmp/polarui',
    ...extra,
    _cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('normalizeHttpWorkflows', () => {
  test('requires id and url', () => {
    assert.throws(() => normalizeHttpWorkflows([{ label: 'x' }]), /id.*required|required.*id/i);
    assert.throws(() => normalizeHttpWorkflows([{ id: 'a' }]), /url.*required|required.*url/i);
  });

  test('rejects duplicate ids', () => {
    assert.throws(
      () =>
        normalizeHttpWorkflows([
          { id: 'a', url: 'http://x/run' },
          { id: 'a', url: 'http://y/run' },
        ]),
      /duplicate.*id|id.*duplicate/i,
    );
  });

  test('keeps optional fields and defaults timeout_ms', () => {
    const out = normalizeHttpWorkflows([
      { id: 'demo-http', url: 'http://host.docker.internal:3941/run', label: 'Demo', description: 'd', timeout_ms: 60000 },
      { id: 'other', url: 'http://127.0.0.1:9/run' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].label, 'Demo');
    assert.equal(out[0].description, 'd');
    assert.equal(out[0].timeout_ms, 60000);
    assert.equal(out[1].timeout_ms, undefined);
  });
});

describe('compileSiteConfig http_workflows', () => {
  test('omits http_workflows when empty', () => {
    const opts = baseOpts();
    try {
      const { config } = compileSiteConfig(opts);
      assert.equal('http_workflows' in config, false);
    } finally {
      opts._cleanup();
    }
  });

  test('merges http_workflows into site.config', () => {
    const opts = baseOpts({
      httpWorkflows: [
        { id: 'demo-http', label: 'HTTP Demo', url: 'http://host.docker.internal:3941/run', timeout_ms: 60000 },
      ],
    });
    try {
      const { config } = compileSiteConfig(opts);
      assert.deepEqual(config.http_workflows, [
        { id: 'demo-http', label: 'HTTP Demo', url: 'http://host.docker.internal:3941/run', timeout_ms: 60000 },
      ]);
    } finally {
      opts._cleanup();
    }
  });

  test('throws on invalid http_workflows during compile', () => {
    const opts = baseOpts({ httpWorkflows: [{ id: 'x' }] });
    try {
      assert.throws(() => compileSiteConfig(opts), /url/i);
    } finally {
      opts._cleanup();
    }
  });
});
