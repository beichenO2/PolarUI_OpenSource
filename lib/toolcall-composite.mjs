/**
 * ToolCall 复合组件 — tool list + skill 搜索/加载（对齐 PolarClaw skill-discovery）
 * ADR-003 基础设施；GUI 集成待后续。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/** @typedef {{ name: string; description: string; toolNames: string[]; skillDir: string; source: string }} SkillEntry */

/**
 * @param {string} skillsDir
 * @returns {SkillEntry[]}
 */
export function scanSkillsDir(skillsDir, source = 'local') {
  if (!existsSync(skillsDir)) return [];
  const entries = [];
  for (const name of readdirSync(skillsDir)) {
    const skillDir = join(skillsDir, name);
    if (!statSync(skillDir).isDirectory()) continue;
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const raw = readFileSync(skillMd, 'utf8');
    const desc = parseFrontmatterDescription(raw) || name;
    entries.push({
      name,
      description: desc,
      toolNames: extractToolNames(skillDir),
      skillDir,
      source,
    });
  }
  return entries;
}

function parseFrontmatterDescription(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return '';
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^description:\s*(.+)/);
    if (kv) return kv[1].replace(/^["']|["']$/g, '').trim();
  }
  return '';
}

function extractToolNames(skillDir) {
  for (const file of ['tools.ts', 'tools.js', 'tools.mjs']) {
    const p = join(skillDir, file);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf8');
    const names = [];
    const re = /name:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) names.push(m[1]);
    return names;
  }
  return [];
}

/**
 * skill_search — 搜索可用 skills
 * @param {string} query
 * @param {SkillEntry[]} catalog
 */
export function skillSearch(query, catalog) {
  const q = query.toLowerCase();
  return catalog.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.toolNames.some((t) => t.toLowerCase().includes(q)),
  );
}

/**
 * Tool list 容器（ToolCall 复合组件运行时状态）
 */
export class ToolList {
  constructor() {
    /** @type {Map<string, object>} OpenAI function defs */
    this.tools = new Map();
    /** @type {Map<string, SkillEntry>} activated skills */
    this.skills = new Map();
  }

  /** @param {object} def OpenAI function or { name, desc, parameters } */
  addTool(def) {
    const name = def.function?.name ?? def.name;
    if (!name) return;
    const normalized =
      def.function ??
      {
        name,
        description: def.desc ?? def.description ?? name,
        parameters: def.parameters ?? { type: 'object', properties: {} },
      };
    this.tools.set(name, {
      type: 'function',
      function: normalized,
    });
  }

  /** @param {SkillEntry} skill */
  activateSkill(skill) {
    this.skills.set(skill.name, skill);
    for (const toolName of skill.toolNames) {
      this.addTool({
        name: toolName,
        description: `[${skill.name}] ${toolName}`,
        parameters: { type: 'object', properties: {} },
      });
    }
  }

  list() {
    return [...this.tools.values()];
  }

  /** 元工具：加载需要的工具 */
  static metaTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'skill_search',
          description: '搜索可用 skills/工具包。返回后可 skill_activate 加载进 tool list。',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'skill_activate',
          description: '加载指定 skill 的工具到当前 tool list。',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
    ];
  }
}

export default ToolList;
