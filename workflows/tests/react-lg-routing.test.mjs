import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function loadGraph(name) {
  return JSON.parse(readFileSync(join(ROOT, 'dist/workflows', name), 'utf8'));
}

function toolRoutingEdges(graph, toolCallNodeId) {
  return (graph._lg_edges ?? []).filter(
    (e) => e.from === toolCallNodeId && e.kind === 'conditional',
  );
}

describe('ReAct LG tool routing (_lg_edges)', () => {
  it('claude-code: ToolCall(9) → 明面工具节点条件边', () => {
    const graph = loadGraph('claude-code.lg.json');
    const edges = toolRoutingEdges(graph, '9');
    const whens = edges.map((e) => e.when).sort();
    assert.deepEqual(whens, [
      'CodeExec',
      'FileRead',
      'FileWrite',
      'GlobSearch',
      'GrepSearch',
      'MCPCall',
      'WebSearch',
    ]);
    assert.ok(!edges.some((e) => e.to === '6'), 'ToolCall must not loop directly to LLM');
  });

  it('hermes: ToolCall(11) → 明面工具节点条件边', () => {
    const graph = loadGraph('hermes.lg.json');
    const edges = toolRoutingEdges(graph, '11');
    const whens = edges.map((e) => e.when).sort();
    assert.deepEqual(whens, [
      'BrowserAction',
      'CodeExec',
      'FileRead',
      'MCPCall',
      'WebSearch',
    ]);
    assert.ok(!edges.some((e) => e.to === '9'), 'ToolCall must not loop directly to LLM');
  });

  it('claude-code graph engine: ToolCall → FileRead 单路径', async () => {
    process.env.POLARUI_MOCK_LLM = '1';
    process.env.POLARUI_MOCK_LLM_BRANCH = 'tool';
    process.env.POLARUI_MOCK_TOOLCALL = '1';
    process.env.POLARUI_MOCK_TOOL_NAME = 'FileRead';
    delete process.env.TAOCI_MOCK_LLM;

    const { resetHeadlessEngine } = await import('../../lib/headless-engine.mjs');
    const { resetMockRegistration } = await import('../../lib/test-mocks/register.mjs');
    const { resetTaociRegistration } = await import('../../lib/taoci-graph/register.mjs');
    resetHeadlessEngine();
    resetMockRegistration();
    resetTaociRegistration();

    const { runWorkflowGraph } = await import('../../lib/run-graph.mjs');
    const result = await runWorkflowGraph({
      workflowId: 'claude-code',
      inputs: { conversationId: `cc-${Date.now()}`, message: 'read file' },
    });

    assert.ok(result.node_traces.includes('ToolCall'));
    assert.ok(result.node_traces.includes('FileRead'));
    assert.ok(!result.node_traces.includes('WebSearch'));

    delete process.env.POLARUI_MOCK_LLM;
    delete process.env.POLARUI_MOCK_LLM_BRANCH;
    delete process.env.POLARUI_MOCK_TOOLCALL;
    delete process.env.POLARUI_MOCK_TOOL_NAME;
  });

  it('hermes graph engine: ToolCall → FileRead 单路径', async () => {
    process.env.POLARUI_MOCK_LLM = '1';
    process.env.POLARUI_MOCK_LLM_BRANCH = 'tool';
    process.env.POLARUI_MOCK_TOOLCALL = '1';
    process.env.POLARUI_MOCK_TOOL_NAME = 'FileRead';
    delete process.env.TAOCI_MOCK_LLM;

    const { resetHeadlessEngine } = await import('../../lib/headless-engine.mjs');
    const { resetMockRegistration } = await import('../../lib/test-mocks/register.mjs');
    const { resetTaociRegistration } = await import('../../lib/taoci-graph/register.mjs');
    resetHeadlessEngine();
    resetMockRegistration();
    resetTaociRegistration();

    const { runWorkflowGraph } = await import('../../lib/run-graph.mjs');
    const result = await runWorkflowGraph({
      workflowId: 'hermes',
      inputs: { conversationId: `hermes-${Date.now()}`, message: 'read file' },
    });

    assert.ok(result.node_traces.includes('ToolCall'));
    assert.ok(result.node_traces.includes('FileRead'));
    assert.ok(!result.node_traces.includes('WebSearch'));

    delete process.env.POLARUI_MOCK_LLM;
    delete process.env.POLARUI_MOCK_LLM_BRANCH;
    delete process.env.POLARUI_MOCK_TOOLCALL;
    delete process.env.POLARUI_MOCK_TOOL_NAME;
  });

  it('hermes-react-replay: ToolCall(6) 条件边', () => {
    const graph = loadGraph('hermes-react-replay.lg.json');
    const edges = toolRoutingEdges(graph, '6');
    assert.deepEqual(edges.map((e) => e.when).sort(), ['CodeExec', 'FileRead', 'WebSearch']);
  });

  it('polarclaw-feishu: ToolCall(8) 条件边', () => {
    const graph = loadGraph('polarclaw-feishu.lg.json');
    const edges = toolRoutingEdges(graph, '8');
    assert.deepEqual(edges.map((e) => e.when).sort(), [
      'KnowLeverSearch',
      'Notification',
      'WebSearch',
    ]);
  });
});
