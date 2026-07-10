import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFixture } from './helpers/run-fixture.mjs';

function tracedNodeIds(run) {
  return run.traces.filter((t) => !t.skipped).map((t) => t.nodeId);
}

describe('stepwise state accumulation', () => {
  it('lgAccumulatedState carries task + LLM branch across Switch', async () => {
    const run = await runFixture('lg-state-accumulation.json', {
      env: {
        POLARUI_MOCK_LLM: '1',
        POLARUI_MOCK_LLM_BRANCH: 'tool',
        POLARUI_MOCK_TOOL_NAME: 'FileRead',
      },
    });

    const switchOut = run.outputFor('Switch');
    assert.ok(switchOut?.state, 'Switch must expose accumulated state');
    assert.equal(switchOut.state.branch, 'tool');
    assert.equal(switchOut.state.tool, 'FileRead');
    assert.equal(switchOut.state.task, 'accumulate-state');
    assert.equal(switchOut.branch, 'tool');
    assert.deepEqual(run.classTypes, ['PromptInput', 'LLM', 'Switch', 'Output']);
    assert.deepEqual(tracedNodeIds(run), ['1', '2', '3', '4'], 'linear stepwise path only');
  });
});
