import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFixture } from './helpers/run-fixture.mjs';

function tracedNodeIds(run) {
  return run.traces.filter((t) => !t.skipped).map((t) => t.nodeId);
}

describe('stepwise execution', () => {
  it('_entry + _lg_edges runs single path only', async () => {
    const run = await runFixture('lg-stepping.json');

    assert.ok(run.graph.lgEdges?.length, 'stepwise graph must load _lg_edges');
    assert.equal(run.graph.lgEntry, '1');
    assert.deepEqual(run.classTypes, ['StaticData', 'TextTransform', 'Output']);
    assert.equal(run.outputFor('TextTransform')?.result, 'STEP1');
    // characterization: stepwise Output.merged 为 state 信封，非叶子文本
    assert.deepEqual(run.merged, { messages: [] });
    assert.equal(run.runCount('StaticData'), 1, 'orphan StaticData off _lg_edges must not run');
    assert.ok(!tracedNodeIds(run).includes('3'), 'orphan node 3 must not appear in node_traces');
  });
});
