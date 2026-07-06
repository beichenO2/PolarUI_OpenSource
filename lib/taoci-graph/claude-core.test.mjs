import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeCodeCliOutput } from './claude-core.mjs';

describe('parseClaudeCodeCliOutput', () => {
  it('parses --output-format json success result', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '{"ready":true,"reply":"ok"}',
      num_turns: 1,
    });
    const r = parseClaudeCodeCliOutput(stdout);
    assert.equal(r.ok, true);
    assert.equal(r.text, '{"ready":true,"reply":"ok"}');
    assert.equal(r.turns, 1);
  });

  it('falls back to plain text', () => {
    const r = parseClaudeCodeCliOutput('plain answer');
    assert.equal(r.ok, true);
    assert.equal(r.text, 'plain answer');
  });
});
