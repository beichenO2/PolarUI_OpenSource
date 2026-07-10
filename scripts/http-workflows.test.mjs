/**
 * P2a: load http_workflows from workflow file + CLI flags
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHttpWorkflowDeclarations, parseHttpWorkflowCliArgs } from './http-workflows.mjs';

describe('parseHttpWorkflowCliArgs', () => {
  test('parses repeated --http-workflow JSON', () => {
    const out = parseHttpWorkflowCliArgs([
      'node',
      'x',
      '--workflow',
      'demo',
      '--http-workflow',
      '{"id":"a","url":"http://a/run"}',
      '--http-workflow',
      '{"id":"b","url":"http://b/run","label":"B"}',
    ]);
    assert.deepEqual(out, [
      { id: 'a', url: 'http://a/run' },
      { id: 'b', url: 'http://b/run', label: 'B' },
    ]);
  });

  test('rejects invalid JSON', () => {
    assert.throws(() => parseHttpWorkflowCliArgs(['node', 'x', '--http-workflow', '{']), /JSON/i);
  });
});

describe('loadHttpWorkflowDeclarations', () => {
  test('reads http-workflows.json array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hwf-'));
    try {
      writeFileSync(
        join(dir, 'http-workflows.json'),
        JSON.stringify([{ id: 'demo-http', url: 'http://h/run', label: 'Demo' }]),
      );
      const out = loadHttpWorkflowDeclarations({ workflowDir: dir, cliWorkflows: [] });
      assert.equal(out.length, 1);
      assert.equal(out[0].id, 'demo-http');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads http_workflows key from registry-entry.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hwf-'));
    try {
      writeFileSync(
        join(dir, 'registry-entry.json'),
        JSON.stringify({
          id: 'demo',
          http_workflows: [{ id: 'from-reg', url: 'http://r/run' }],
        }),
      );
      const out = loadHttpWorkflowDeclarations({ workflowDir: dir, cliWorkflows: [] });
      assert.equal(out[0].id, 'from-reg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('merges file then CLI; duplicate id errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hwf-'));
    try {
      writeFileSync(
        join(dir, 'http-workflows.json'),
        JSON.stringify([{ id: 'a', url: 'http://a/run' }]),
      );
      assert.throws(
        () =>
          loadHttpWorkflowDeclarations({
            workflowDir: dir,
            cliWorkflows: [{ id: 'a', url: 'http://b/run' }],
          }),
        /duplicate/i,
      );
      const ok = loadHttpWorkflowDeclarations({
        workflowDir: dir,
        cliWorkflows: [{ id: 'b', url: 'http://b/run' }],
      });
      assert.deepEqual(
        ok.map((x) => x.id),
        ['a', 'b'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('http-workflows.json wins over registry-entry when both present (no dup)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hwf-'));
    try {
      writeFileSync(
        join(dir, 'http-workflows.json'),
        JSON.stringify([{ id: 'file', url: 'http://f/run' }]),
      );
      writeFileSync(
        join(dir, 'registry-entry.json'),
        JSON.stringify({
          id: 'demo',
          http_workflows: [{ id: 'reg', url: 'http://r/run' }],
        }),
      );
      // Prefer dedicated file only (ignore registry key when file exists)
      const out = loadHttpWorkflowDeclarations({ workflowDir: dir, cliWorkflows: [] });
      assert.deepEqual(
        out.map((x) => x.id),
        ['file'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
