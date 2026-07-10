import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFixture } from './helpers/run-fixture.mjs';

describe('RetryLoop characterization', () => {
  it('retries until exhausted then emits original_input', async () => {
    const run = await runFixture('wf-retry-loop.json');

    assert.equal(run.merged, 'BASE');
    assert.equal(run.loopTraces.length, 3);
    assert.deepEqual(
      run.loopTraces.map((t) => t.stop_reason),
      ['retry', 'retry', 'exhausted'],
    );
    assert.equal(run.loopTraces[2].output_snapshot.exhausted, true);
    assert.ok(run.ran('Validator'));
    assert.ok(run.ran('RetryLoop'));
    assert.equal(run.unhealthy.length, 0);
  });
});
