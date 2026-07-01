import { complete } from '../lib/claude-core.mjs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

async function prompt(name, ctx) {
  const tpl = await readFile(join(PROMPTS, name), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] ?? '');
}

export async function runReputationAgent({ teacher, student }) {
  const system = await prompt('subagent-reputation.md', { teacher_name: teacher.name });
  const user = `导师: ${JSON.stringify(teacher)}\n学生: ${student.profile}`;
  const out = await complete({ system, user, json: true });
  return { status: 'done', ...out };
}

export async function runAuthorshipAgent({ teacher }) {
  const system = await prompt('subagent-authorship.md', { teacher_name: teacher.name });
  const user = `导师: ${JSON.stringify(teacher)}\n请检索近五年论文，分析署名顺序与通讯作者模式，标注可疑情况（需注明证据不足时勿断言）。`;
  const out = await complete({ system, user, json: true });
  return { status: 'done', ...out };
}

export async function runDirectionsAgent({ teacher, student }) {
  const system = await prompt('subagent-directions.md', { teacher_name: teacher.name });
  const user = `导师: ${JSON.stringify(teacher)}\n学生背景:\n${student.profile}`;
  const out = await complete({ system, user, json: true });
  return { status: 'done', ...out };
}
