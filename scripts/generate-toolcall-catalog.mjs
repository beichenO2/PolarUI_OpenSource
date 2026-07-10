#!/usr/bin/env node
/** 从 node-defs 生成 ToolCall GUI 可用工具目录（排除 ShellExec / 内部节点） */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSkillsDir } from '../lib/toolcall-composite.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_DEFS = join(ROOT, 'node-defs');
const OUT_DIR = join(ROOT, 'dist/toolcall-editor');
const OUT_FILE = join(OUT_DIR, 'catalog.json');

const SKIP = new Set([
  'ShellExec', 'ToolCall', 'LLM', 'Switch', 'Output', 'PromptInput',
  'StaticData', 'Merge', 'Condition', 'Validator', 'RetryLoop',
  'StemCell',
]);

const SKIP_PREFIX = ['Taoci', 'Checkup', 'LG_'];

function loadAllDefs() {
  const index = JSON.parse(readFileSync(join(NODE_DEFS, 'index.json'), 'utf8'));
  const tools = [];
  for (const file of index.files ?? []) {
    const path = join(NODE_DEFS, file);
    let arr;
    try {
      arr = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const def of arr) {
      if (!def?.class_type || def.palette_hidden || def.deprecated) continue;
      if (SKIP.has(def.class_type)) continue;
      if (SKIP_PREFIX.some((p) => def.class_type.startsWith(p))) continue;
      if (def.category?.startsWith('Internal/')) continue;
      tools.push({
        name: def.class_type,
        display_name: def.display_name ?? def.class_type,
        description: (def.description ?? '').slice(0, 200),
        category: def.category ?? '',
      });
    }
  }
  const byName = new Map();
  for (const t of tools) {
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function loadSkills() {
  const dirs = [
    join(ROOT, 'skills'),
    join(process.env.HOME ?? '', '.agents/skills'),
  ];
  const seen = new Set();
  const all = [];
  for (const dir of dirs) {
    for (const entry of scanSkillsDir(dir)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      all.push({
        name: entry.name,
        description: entry.description,
        toolNames: entry.toolNames,
        source: entry.source,
      });
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

mkdirSync(OUT_DIR, { recursive: true });
const catalog = {
  generated_at: new Date().toISOString(),
  meta_tools: [
    { name: 'skill_search', description: '搜索可用 skills/工具包' },
    { name: 'skill_activate', description: '加载 skill 工具到 tool list' },
  ],
  tools: loadAllDefs(),
  skills: loadSkills(),
};
writeFileSync(OUT_FILE, JSON.stringify(catalog, null, 2), 'utf8');
console.log(`generate-toolcall-catalog: ${catalog.tools.length} tools, ${catalog.skills.length} skills → ${OUT_FILE}`);
