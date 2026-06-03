#!/usr/bin/env node
/** 260526 Phase6 — polaris R11 skills + registry community-skill / polar-native 验收 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const POLARIS = join(ROOT, 'polaris.json')
const REGISTRY = join(ROOT, 'workflows', 'registry.json')

const COMMUNITY = [
  { id: 'skill-brainstorming', skills_ref: '.agents/skills/brainstorming/SKILL.md', priority: 'P0' },
  { id: 'skill-verification-before-completion', skills_ref: '.agents/skills/verification-before-completion/SKILL.md', priority: 'P0' },
  { id: 'skill-systematic-debugging', skills_ref: '.agents/skills/systematic-debugging/SKILL.md', priority: 'P0' },
  { id: 'skill-officecli', skills_ref: '.cursor/skills/officecli/SKILL.md', priority: 'P1' },
  { id: 'skill-humanizer-zh', skills_ref: '.agents/skills/humanizer-zh/SKILL.md', priority: 'P1' },
]

const POLAR_NATIVE = [
  { id: 'test-demo-fileread' },
  { id: 'test-lg-mode-general' },
  { id: 'test-lg-mode-coding' },
  { id: 'test-lg-mode-report' },
  { id: 'hermes-lg' },
  { id: 'claude-code-lg' },
  { file: 'evolution-loop.json', label: 'evolution-loop' },
]

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

const polaris = JSON.parse(readFileSync(POLARIS, 'utf8'))
const r11 = polaris.requirements?.find(r => r.id === 'R11')
if (!r11) fail('polaris.json missing R11 Skills 双线')
else ok('polaris R11 present')

const feat = r11?.features?.find(f => f.name === '社区 Skill 清单')
const skills = feat?.skills ?? []
if (skills.length < 5) fail(`R11 community skills count ${skills.length} < 5`)
else ok(`R11 lists ${skills.length} community skills`)

for (const s of COMMUNITY) {
  const byRef = skills.find(x => x.skills_ref === s.skills_ref)
  if (!byRef) fail(`R11 missing skills_ref ${s.skills_ref}`)
  const homeAbs = join(process.env.HOME || '', s.skills_ref.startsWith('.') ? s.skills_ref : `.${s.skills_ref}`)
  if (!existsSync(homeAbs)) fail(`skill file missing: ${homeAbs}`)
  else ok(`skill path ${s.id}`)
}

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
const byId = Object.fromEntries(registry.map(e => [e.id, e]))

for (const spec of POLAR_NATIVE) {
  const e = spec.id ? byId[spec.id] : registry.find(r => r.file === spec.file)
  const label = spec.id || spec.label
  if (!e) fail(`registry missing polar-native ${label}`)
  else if (e.category !== 'polar-native') fail(`${label} category=${e.category} expected polar-native`)
  else ok(`polar-native ${label}`)
}

for (const s of COMMUNITY) {
  const e = byId[s.id]
  if (!e) fail(`registry missing community-skill ${s.id}`)
  else if (e.category !== 'community-skill') fail(`${s.id} category=${e.category}`)
  else if (e.skills_ref !== s.skills_ref) fail(`${s.id} skills_ref mismatch`)
  else ok(`community-skill ${s.id}`)
}

console.log(`\n--- skills-registry smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
