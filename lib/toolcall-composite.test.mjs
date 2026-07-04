import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolList, scanSkillsDir, skillSearch } from './toolcall-composite.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsRoot = join(__dirname, '../skills');

const catalog = scanSkillsDir(skillsRoot);
assert.ok(catalog.length > 0, 'should find PolarUI skills');

const hits = skillSearch('workflow', catalog);
assert.ok(hits.some((h) => h.name.includes('workflow')));

const list = new ToolList();
for (const t of ToolList.metaTools()) list.addTool(t);
list.activateSkill(hits[0]);
assert.ok(list.list().length >= 2, 'meta tools + optional skill tools');

console.log('toolcall-composite.test.mjs: passed');
