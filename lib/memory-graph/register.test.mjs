import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerMemoryExecutors, resetMemoryRegistration } from './register.mjs';

test('registers User/Scenario/Session memory executors', () => {
  resetMemoryRegistration();
  const types = [];
  registerMemoryExecutors((t) => types.push(t));
  assert.ok(types.includes('UserMemoryLoad'));
  assert.ok(types.includes('ScenarioMemoryLoad'));
  assert.ok(types.includes('ScenarioMemorySave'));
  assert.ok(types.includes('SessionMemoryLoad'));
  assert.ok(types.includes('SessionMemorySave'));
});

test('UserMemoryLoad is read-only shape', async () => {
  resetMemoryRegistration();
  let fn;
  registerMemoryExecutors((type, f) => { if (type === 'UserMemoryLoad') fn = f; });
  assert.ok(fn);
  const r = await fn({}, { memory: { user: { major: '制药工程' } } }, {});
  assert.equal(r.outputs.user_memory.major, '制药工程');
});
