import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('test-lg-react-replay (ADR-003 tool routing)', () => {
  it('lg.json ToolCall 后有按 tool_name 的条件边', () => {
    const raw = readFileSync(join(ROOT, 'dist/workflows/test-lg-react-replay.lg.json'), 'utf8');
    const graph = JSON.parse(raw);
    const edges = graph._lg_edges ?? [];
    const fromToolCall = edges.filter((e) => e.from === '6' && e.kind === 'conditional');
    const whens = fromToolCall.map((e) => e.when).sort();
    assert.deepEqual(whens, ['CodeExec', 'FileRead', 'WebSearch']);
  });

  it('graph engine 单路径：ToolCall → FileRead，不跑 WebSearch/CodeExec', async () => {
    delete process.env.TAOCI_MOCK_LLM;
    process.env.POLARUI_MOCK_LLM = '1';
    process.env.POLARUI_MOCK_LLM_BRANCH = 'tool';
    process.env.POLARUI_MOCK_TOOLCALL = '1';
    process.env.POLARUI_MOCK_TOOL_NAME = 'FileRead';

    const { resetHeadlessEngine } = await import('../../lib/headless-engine.mjs');
    const { resetMockRegistration } = await import('../../lib/test-mocks/register.mjs');
    const { resetTaociRegistration } = await import('../../lib/taoci-graph/register.mjs');
    resetHeadlessEngine();
    resetMockRegistration();
    resetTaociRegistration();

    const { runWorkflowGraph } = await import('../../lib/run-graph.mjs');
    const result = await runWorkflowGraph({
      workflowId: 'test-lg-react-replay',
      inputs: {
        conversationId: `react-${Date.now()}`,
        message: 'react smoke',
      },
    });

    assert.ok(result.node_traces.includes('ToolCall'));
    assert.ok(result.node_traces.includes('FileRead'));
    assert.ok(!result.node_traces.includes('WebSearch'), 'LG must not run all tool branches');
    assert.ok(!result.node_traces.includes('CodeExec'), 'LG must not run all tool branches');

    delete process.env.POLARUI_MOCK_LLM;
    delete process.env.POLARUI_MOCK_LLM_BRANCH;
    delete process.env.POLARUI_MOCK_TOOLCALL;
    delete process.env.POLARUI_MOCK_TOOL_NAME;
  });
});
