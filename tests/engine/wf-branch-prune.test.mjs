import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFixture } from './helpers/run-fixture.mjs';

describe('WF branch pruning (Condition)', () => {
  it('truthy input runs only true-leaf StaticData', async () => {
    const run = await runFixture('wf-condition-branch.json');

    // characterization: Condition 会剪掉未选侧叶子，但两侧 Output 仍会执行
    assert.equal(run.runCount('StaticData'), 2, 'input + one leaf');
    assert.equal(run.contentFromOutput('Output', 0), 'TRUE_LEAF');
    // characterization: 未选侧 Output 拿到 Condition 的 result 布尔值，而非叶子内容
    assert.equal(run.contentFromOutput('Output', 1), true);
    assert.equal(run.merged, true);
  });

  it('falsy input runs only false-leaf StaticData', async () => {
    const fixture = await import('./helpers/run-fixture.mjs').then((m) => m.loadFixture('wf-condition-branch.json'));
    fixture['1'].params.value = '';
    const run = await runFixture(fixture);

    assert.equal(run.runCount('StaticData'), 2, 'input + one leaf');
    assert.equal(run.contentFromOutput('Output', 1), 'FALSE_LEAF');
    // characterization: 未选侧 Output 仍执行，内容为 Condition result
    assert.equal(run.contentFromOutput('Output', 0), true);
    assert.equal(run.merged, 'FALSE_LEAF');
  });
});
