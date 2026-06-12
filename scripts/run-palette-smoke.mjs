#!/usr/bin/env node
/**
 * 左栏 palette smoke — 对齐 00 §6 + 06 用户定稿 + 10 用户说
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { registry } from '../src/engine/registry.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

const wf = registry.getPaletteNodes('WF')
const has = (pal, ct) => pal.some(n => n.class_type === ct)
const hasCat = (pal, cat) => pal.some(n => n.category === cat || n.category.startsWith(`${cat}/`))

// 00 §6：Memory / Evolve / History 分组
if (!hasCat(wf, 'Memory')) fail('WF palette missing Memory category')
else ok('WF palette: Memory')
if (!has(wf, 'MemorySearch')) fail('MemorySearch not in WF palette')
else ok('MemorySearch visible')

if (!hasCat(wf, 'Evolve')) fail('WF palette missing Evolve category')
else ok('WF palette: Evolve')
for (const ct of ['LearningCapture', 'ExperienceCapture', 'PromptEvolve']) {
  if (!has(wf, ct)) fail(`${ct} not in WF Evolve palette`)
  else ok(`Evolve/${ct}`)
}

if (!hasCat(wf, 'History')) fail('WF palette missing History category')
else ok('WF palette: History')

// 培养皿 + 干细胞均在左栏
if (!has(wf, 'PetriDish')) fail('WF palette missing PetriDish')
else ok('WF PetriDish（子图进化）')
if (!has(wf, 'StemCell')) fail('WF palette missing StemCell')
else ok('WF StemCell（权柄入口 · 主图读写）')

// Internal 原语不在 palette
for (const hidden of ['LG_Pluripotent', 'LG_Entry', 'LG_Differentiate']) {
  if (has(wf, hidden)) fail(`${hidden} leaked to palette`)
}
ok('Internal 原语未进 palette')

// 左栏 palette：Tab 文案「组件」
const app = readFileSync(join(ROOT, 'src/App.vue'), 'utf8')
if (/组件库/.test(app)) fail('App.vue still contains 组件库')
else ok('App.vue 无「组件库」措辞')
if (!/>组件</.test(app)) fail('App.vue missing 组件 tab label')
else ok('左栏 Tab「组件」')

if (!app.includes("'Memory'") || !app.includes("'Evolve'")) {
  fail('App.vue palette category order missing Memory/Evolve')
} else ok('App.vue palette 含 Memory · Evolve 分组序')

// 06 用户定稿：废止口径 grep（活跃路径）
const FORBIDDEN = [
  { label: '不在画布画回边', re: /不在画布画回边/ },
  { label: 'PolarUI 不是 LangGraph 唯一定位', re: /不是 LangGraph/ },
  { label: '组件库作总称', re: /组件库/ },
]
const SCAN = [
  join(ROOT, 'src/App.vue'),
  join(ROOT, 'src/engine/planner-engine.ts'),
  join(ROOT, 'polaris.json'),
  join(ROOT, '.cursor/skills/polarui-planner/SKILL.md'),
  join(ROOT, '..', 'Reference/INDEX.md'),
]
for (const file of SCAN) {
  const text = readFileSync(file, 'utf8')
  for (const { label, re } of FORBIDDEN) {
    if (re.test(text)) fail(`${file}: forbidden 「${label}」`)
  }
}
ok('06 用户定稿：活跃路径无废止口径')

console.log(`\n--- palette smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
