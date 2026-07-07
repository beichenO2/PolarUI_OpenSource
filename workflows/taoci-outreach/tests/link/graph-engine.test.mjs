import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('taoci-outreach graph (structure)', () => {
  it('lg.json 无 ShellExec，含 Switch + ScenarioMemoryLoad', () => {
    const raw = readFileSync(join(ROOT, 'taoci-outreach.lg.json'), 'utf8');
    const graph = JSON.parse(raw);
    const types = Object.values(graph)
      .filter((n) => n && typeof n === 'object' && n.class_type)
      .map((n) => n.class_type);

    assert.ok(!types.includes('ShellExec'), 'ShellExec must be removed');
    assert.ok(types.includes('Switch'));
    assert.ok(types.includes('UserMemoryLoad'));
    assert.ok(types.includes('ScenarioMemoryLoad'));
    assert.ok(types.includes('ScenarioMemorySave'));
    assert.ok(!types.includes('TaociSessionLoad'));
    assert.ok(!types.includes('TaociSessionSave'));
    assert.ok(types.includes('WorkingMemory'));
    assert.ok(types.includes('LLM'));
    assert.ok(types.includes('TaociSubAgent'));
    assert.ok(types.includes('Output'));
    assert.ok(!types.includes('FeishuIM'), 'FeishuIM removed — website-only');
  });

  it('graph engine 执行 S0 路径（mock LLM）', async () => {
    process.env.TAOCI_MOCK_LLM = '1';
    process.env.TAOCI_MOCK_PDF = '1';
    process.env.TAOCI_SESSION_DIR = join(ROOT, '.sessions');

    const { runWorkflowGraph } = await import('../../../../lib/run-graph.mjs');
    const result = await runWorkflowGraph({
      workflowId: 'taoci-outreach',
      inputs: {
        conversationId: `graph-test-${Date.now()}`,
        message: '想套辞胡友财老师，中国药科大学制药工程大三',
      },
    });

    assert.ok(!result.node_traces.includes('ShellExec'), 'must not run ShellExec');
    assert.ok(result.node_traces.includes('ScenarioMemoryLoad'));
    assert.ok(result.node_traces.includes('UserMemoryLoad'));
    assert.ok(result.node_traces.includes('Switch'));
    assert.equal(result.node_traces[0], 'PromptInput');
    assert.ok(!result.node_traces.includes('TaociSubAgent'), 'LG must run one branch only');
    assert.equal(result.node_traces.filter((t) => t === 'ScenarioMemorySave').length, 1);
  });
});
