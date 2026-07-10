import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(ROOT, 'tests/fixtures/workflows');

function loadGraph(name) {
  // Registered workflow from source; others from test fixtures (ADR-011 P2)
  if (name === 'claude-code.json') {
    return JSON.parse(readFileSync(join(ROOT, 'workflows/claude-code/claude-code.json'), 'utf8'));
  }
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function toolRoutingEdges(graph, toolCallNodeId) {
  return (graph._lg_edges ?? []).filter(
    (e) => e.from === toolCallNodeId && e.kind === 'conditional',
  );
}

function assertNoDirectToolCallLoop(graph, toolCallNodeId, llmNodeId) {
  const bad = (graph._lg_edges ?? []).find(
    (e) => e.from === toolCallNodeId && e.to === llmNodeId && e.kind === 'static',
  );
  assert.ok(!bad, `ToolCall(${toolCallNodeId}) must not loop directly to LLM(${llmNodeId})`);
}

describe('ReAct stepwise tool routing (_lg_edges)', () => {
  it('claude-code: ToolCall(9) → 明面工具节点条件边', () => {
    const graph = loadGraph('claude-code.json');
    const edges = toolRoutingEdges(graph, '9');
    const whens = edges.map((e) => e.when).sort();
    assert.deepEqual(whens, [
      'CodeExec',
      'FileRead',
      'FileWrite',
      'GlobSearch',
      'GrepSearch',
      'MCPCall',
      'SubAgent',
      'WebSearch',
    ]);
    assertNoDirectToolCallLoop(graph, '9', '6');
  });

  it('hermes: ToolCall(11) → 明面工具节点条件边（含 SubAgent/MemoryStore）', () => {
    const graph = loadGraph('hermes.json');
    const edges = toolRoutingEdges(graph, '11');
    const whens = edges.map((e) => e.when).sort();
    assert.deepEqual(whens, [
      'BrowserAction',
      'CodeExec',
      'FileRead',
      'MCPCall',
      'MemoryStore',
      'SubAgent',
      'WebSearch',
    ]);
    assertNoDirectToolCallLoop(graph, '11', '9');
  });

  it('claude-code graph engine: ToolCall → FileRead 单路径', async () => {
    process.env.POLARUI_MOCK_LLM = '1';
    process.env.POLARUI_MOCK_LLM_BRANCH = 'tool';
    process.env.POLARUI_MOCK_TOOLCALL = '1';
    process.env.POLARUI_MOCK_TOOL_NAME = 'FileRead';
    delete process.env.TAOCI_MOCK_LLM;

    const { resetHeadlessEngine } = await import('../../lib/headless-engine.mjs');
    const { resetMockRegistration } = await import('../../lib/test-mocks/register.mjs');
    resetHeadlessEngine();
    resetMockRegistration();

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

  it('hermes graph engine: ToolCall → SubAgent 单路径', async () => {
    process.env.POLARUI_MOCK_LLM = '1';
    process.env.POLARUI_MOCK_LLM_BRANCH = 'tool';
    process.env.POLARUI_MOCK_TOOLCALL = '1';
    process.env.POLARUI_MOCK_TOOL_NAME = 'SubAgent';
    delete process.env.TAOCI_MOCK_LLM;

    const { resetHeadlessEngine } = await import('../../lib/headless-engine.mjs');
    const { resetMockRegistration } = await import('../../lib/test-mocks/register.mjs');
    resetHeadlessEngine();
    resetMockRegistration();

    const { runWorkflowGraph } = await import('../../lib/run-graph.mjs');
    const result = await runWorkflowGraph({
      workflowPath: join(FIXTURES, 'hermes.json'),
      inputs: { conversationId: `hermes-${Date.now()}`, message: 'delegate task' },
    });

    assert.ok(result.node_traces.includes('ToolCall'));
    assert.ok(result.node_traces.includes('SubAgent'));
    assert.ok(!result.node_traces.includes('WebSearch'));

    delete process.env.POLARUI_MOCK_LLM;
    delete process.env.POLARUI_MOCK_LLM_BRANCH;
    delete process.env.POLARUI_MOCK_TOOLCALL;
    delete process.env.POLARUI_MOCK_TOOL_NAME;
  });

  it('hermes-react-replay: ToolCall(6) 条件边', () => {
    const graph = loadGraph('hermes-react-replay.json');
    const edges = toolRoutingEdges(graph, '6');
    assert.deepEqual(edges.map((e) => e.when).sort(), ['CodeExec', 'FileRead', 'WebSearch']);
  });

});
