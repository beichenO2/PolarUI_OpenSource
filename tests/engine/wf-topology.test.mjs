import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFixture } from './helpers/run-fixture.mjs';

describe('WF topology execution', () => {
  it('linear 3-node graph executes in topological order with correct output', async () => {
    const run = await runFixture('wf-linear.json');

    assert.deepEqual(run.classTypes, ['StaticData', 'TextTransform', 'Output']);
    assert.equal(run.merged, 'HELLO');
    assert.equal(run.contentFromOutput('Output'), 'HELLO');
    assert.equal(run.unhealthy.length, 0);
    assert.ok(!run.graph.lgEdges?.length, 'topology fixture must not be stepwise');
  });
});
