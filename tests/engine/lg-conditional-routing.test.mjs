import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFixture } from './helpers/run-fixture.mjs';

function leafValue(run, label) {
  const leaf = run.graph.nodes.find((n) => n.params?.value === label);
  return leaf ? run.result.results?.get(leaf.id)?.outputs?.data : undefined;
}

function tracedNodeIds(run) {
  return run.traces.filter((t) => !t.skipped).map((t) => t.nodeId);
}

describe('stepwise conditional routing', () => {
  it('Switch + _lg_edges when=tool routes to tool branch only', async () => {
    const run = await runFixture('lg-switch-routing.json');

    assert.deepEqual(run.classTypes, ['StaticData', 'Switch', 'StaticData', 'Output']);
    assert.equal(leafValue(run, 'TOOL_PATH'), 'TOOL_PATH');
    assert.equal(leafValue(run, 'FINISH_PATH'), undefined);
    assert.equal(run.outputFor('Switch')?.branch, 'tool');
    assert.deepEqual(run.merged, { messages: [], branch: 'tool' });
    assert.ok(!tracedNodeIds(run).includes('4'), 'FINISH_PATH node 4 must not run');
    assert.ok(!tracedNodeIds(run).includes('6'), 'finish Output node 6 must not run');
  });

  it('Switch + _lg_edges when=finish routes to finish branch only', async () => {
    const fixture = await import('./helpers/run-fixture.mjs').then((m) => m.loadFixture('lg-switch-routing.json'));
    fixture['1'].params.value = 'finish';
    const run = await runFixture(fixture);

    assert.deepEqual(run.classTypes, ['StaticData', 'Switch', 'StaticData', 'Output']);
    assert.equal(leafValue(run, 'FINISH_PATH'), 'FINISH_PATH');
    assert.equal(leafValue(run, 'TOOL_PATH'), undefined);
    assert.equal(run.outputFor('Switch')?.branch, 'finish');
    assert.deepEqual(run.merged, { messages: [], branch: 'finish' });
    assert.ok(!tracedNodeIds(run).includes('3'), 'TOOL_PATH node 3 must not run');
    assert.ok(!tracedNodeIds(run).includes('5'), 'tool Output node 5 must not run');
  });

  it('three-branch Switch prunes unselected paths (tool)', async () => {
    const run = await runFixture('lg-three-branch-routing.json');
    assert.equal(run.outputFor('Switch')?.branch, 'tool');
    assert.deepEqual(tracedNodeIds(run), ['1', '2', '3', '6']);
    assert.ok(!tracedNodeIds(run).includes('4'));
    assert.ok(!tracedNodeIds(run).includes('5'));
    assert.ok(!tracedNodeIds(run).includes('7'));
    assert.ok(!tracedNodeIds(run).includes('8'));
  });

  it('three-branch Switch prunes unselected paths (clarify)', async () => {
    const fixture = await import('./helpers/run-fixture.mjs').then((m) => m.loadFixture('lg-three-branch-routing.json'));
    fixture['1'].params.value = 'clarify';
    const run = await runFixture(fixture);
    assert.equal(run.outputFor('Switch')?.branch, 'clarify');
    assert.deepEqual(tracedNodeIds(run), ['1', '2', '5', '8']);
    assert.ok(!tracedNodeIds(run).includes('3'));
    assert.ok(!tracedNodeIds(run).includes('4'));
    assert.ok(!tracedNodeIds(run).includes('6'));
    assert.ok(!tracedNodeIds(run).includes('7'));
  });

  it('mock LLM branch drives _lg_edges conditional routing', async () => {
    const toolRun = await runFixture('lg-llm-routing.json', {
      env: { POLARUI_MOCK_LLM: '1', POLARUI_MOCK_LLM_BRANCH: 'tool' },
    });
    assert.ok(toolRun.ran('LLM'));
    assert.equal(leafValue(toolRun, 'TOOL_BRANCH'), 'TOOL_BRANCH');
    assert.equal(leafValue(toolRun, 'FINISH_BRANCH'), undefined);
    assert.equal(toolRun.outputFor('Switch')?.branch, 'tool');
    assert.ok(!tracedNodeIds(toolRun).includes('5'));
    assert.ok(!tracedNodeIds(toolRun).includes('7'));

    const finishRun = await runFixture('lg-llm-routing.json', {
      env: { POLARUI_MOCK_LLM: '1', POLARUI_MOCK_LLM_BRANCH: 'finish' },
    });
    assert.equal(leafValue(finishRun, 'FINISH_BRANCH'), 'FINISH_BRANCH');
    assert.equal(leafValue(finishRun, 'TOOL_BRANCH'), undefined);
    assert.equal(finishRun.outputFor('Switch')?.branch, 'finish');
    assert.ok(!tracedNodeIds(finishRun).includes('4'));
    assert.ok(!tracedNodeIds(finishRun).includes('6'));
  });
});
