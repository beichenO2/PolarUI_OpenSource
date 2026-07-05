#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  parseToolList,
  serializeToolList,
  addTool,
  removeTool,
  activateSkillTools,
  META_TOOL_NAMES,
} from './tool-list.mjs';

assert.deepEqual(parseToolList('[]'), []);
assert.deepEqual(parseToolList('[{"name":"FileRead","desc":"Read"}]'), [
  { name: 'FileRead', desc: 'Read', parameters: { type: 'object', properties: {} } },
]);

const added = addTool([], { name: 'WebSearch', desc: 'Search' });
assert.equal(added.length, 1);
assert.equal(addTool(added, { name: 'WebSearch' }).length, 1);

const removed = removeTool(added, 'WebSearch');
assert.equal(removed.length, 0);
assert.equal(removeTool(added, 'skill_search').length, 1);

const withSkill = activateSkillTools([], ['FileRead', 'CodeExec']);
assert.equal(withSkill.length, 2);

assert.ok(META_TOOL_NAMES.has('skill_search'));
assert.ok(serializeToolList(added).includes('WebSearch'));

console.log('lib/toolcall-gui/tool-list.test.mjs: passed');
