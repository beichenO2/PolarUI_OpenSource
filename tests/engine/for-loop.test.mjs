import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFixture } from './helpers/run-fixture.mjs';

describe('ForLoop characterization', () => {
  it('iterates items up to max_items and collects results', async () => {
    const run = await runFixture('wf-for-loop.json');

    const forLoopId = run.nodeIdFor('ForLoop');
    const forLoopOut = run.result.results?.get?.(forLoopId)?.outputs;

    assert.ok(!run.graph.lgEdges?.length, 'ForLoop fixture must not be stepwise');
    assert.equal(run.runCount('TextTransform'), 3, 'split + 2 loop-body runs');
    // characterization: ForLoop results 收集 loop 体输入（未 uppercase），merged 走 results 汇总
    assert.deepEqual(forLoopOut?.results, ['a', 'b']);
    assert.deepEqual(run.merged, ['a', 'b']);
    assert.equal(forLoopOut?.count, 2);
    assert.equal(forLoopOut?.index, 1);
  });
});
