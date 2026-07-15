import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileProductManifest } from './compile-product-manifest.mjs';

test('loads a workflow product manifest and injects release identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'product-manifest-'));
  mkdirSync(join(root, 'workflow'), { recursive: true });
  writeFileSync(join(root, 'workflow/product.manifest.json'), JSON.stringify({
    contract_version: '1.0',
    product: { id: 'claude-code', name: 'Claude Code', context_label: '项目', route_label: '路线' },
    workflow: { id: 'source-workflow', endpoint: 'http://127.0.0.1:8065/run/source-workflow/flow.json' },
    stages: [{ key: 'work', label: '工作', component_key: 'generic_chat', internal_states: ['start'], actions: [] }],
  }));
  const result = await compileProductManifest({
    workflowDir: join(root, 'workflow'),
    workflowId: 'claude-code',
    releaseId: 'claude-code_2',
  });
  assert.equal(result.workflow.id, 'claude-code');
  assert.equal(result.product.id, 'claude-code-2');
  assert.match(result.workflow.endpoint, /claude-code\/flow\.json$/);
});

test('rejects recursive layout keys before export', async () => {
  const root = mkdtempSync(join(tmpdir(), 'product-manifest-bad-'));
  mkdirSync(join(root, 'workflow'), { recursive: true });
  writeFileSync(join(root, 'workflow/product.manifest.json'), JSON.stringify({ layout: { children: [] } }));
  await assert.rejects(
    compileProductManifest({ workflowDir: join(root, 'workflow'), workflowId: 'bad', releaseId: 'bad' }),
  );
});
