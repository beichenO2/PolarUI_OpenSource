#!/usr/bin/env node
import assert from 'node:assert/strict';
import { registerToolcallComposite } from './register.mjs';

const registry = new Map();
registerToolcallComposite((name, fn) => registry.set(name, fn));

assert.ok(registry.has('ToolCall'), 'ToolCall executor registered');

process.env.POLARUI_MOCK_TOOLCALL = '1';
process.env.POLARUI_MOCK_TOOL_NAME = 'FileRead';

const fn = registry.get('ToolCall');
const result = await fn(
  { params: { model: 'GLM-5.1', tool_list: '[]' } },
  { prompt: 'read polaris.json', tool_definitions: [] },
  { lgAccumulatedState: { messages: [] } },
);

assert.equal(result.outputs.branch, 'FileRead');
assert.ok(Array.isArray(result.outputs.tool_calls));
assert.ok(result.outputs.tool_list.length >= 2, 'includes meta tools');
assert.equal(result.outputs.tool_calls[0].function.name, 'FileRead');
// ADR-003: no in-executor dispatch — outputs only intent
assert.equal(result.outputs.dispatched, undefined);
assert.equal(result.outputs.status, undefined);

delete process.env.POLARUI_MOCK_TOOLCALL;
delete process.env.POLARUI_MOCK_TOOL_NAME;

console.log('toolcall-graph/register.test.mjs: passed');
