#!/usr/bin/env node
/**
 * claude-code mock e2e — finish + tool branch smoke (ADR-011 P2 QA).
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLARUI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(POLARUI_ROOT, 'lib/run-graph-cli.mjs');

function run(env, message, label) {
  const r = spawnSync(
    'node',
    [CLI, '--workflow', 'claude-code', '--conversation-id', `qa-${label}-${Date.now()}`, '--message', message],
    {
      cwd: POLARUI_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
  if (r.status !== 0) {
    console.error(`FAIL ${label}: exit=${r.status}`);
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  let payload;
  try {
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).at(-1);
    payload = JSON.parse(line);
  } catch (e) {
    console.error(`FAIL ${label}: bad JSON`, r.stdout);
    process.exit(1);
  }
  if (!payload.ok) {
    console.error(`FAIL ${label}: ok=false`, payload);
    process.exit(1);
  }
  console.log(`PASS ${label}: traces=${JSON.stringify(payload.node_traces)}`);
  return payload;
}

const finish = run(
  { POLARUI_MOCK_LLM: '1', POLARUI_MOCK_LLM_BRANCH: 'finish' },
  'finish smoke',
  'finish',
);
if (!finish.node_traces?.includes('Output')) {
  console.error('FAIL finish: expected Output in traces');
  process.exit(1);
}
if (finish.node_traces?.includes('StemCell') || finish.node_traces?.includes('LG_EvolutionGuard')) {
  console.error('FAIL finish: archived evolution nodes must not run');
  process.exit(1);
}

const tool = run(
  {
    POLARUI_MOCK_LLM: '1',
    POLARUI_MOCK_LLM_BRANCH: 'tool',
    POLARUI_MOCK_TOOLCALL: '1',
    POLARUI_MOCK_TOOL_NAME: 'FileRead',
  },
  'read file',
  'tool-FileRead',
);
if (!tool.node_traces?.includes('ToolCall') || !tool.node_traces?.includes('FileRead')) {
  console.error('FAIL tool: expected ToolCall + FileRead');
  process.exit(1);
}

console.log('claude-code mock e2e: all passed');
