#!/usr/bin/env node
/** 03 批次外：空壳节点审计 — pipeline/LG 节点允许无单文件 executor */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NODE_DEFS = join(ROOT, 'node-defs')

const PIPELINE_SUFFIX = /Pipeline$/
const LG_PREFIX = /^LG_/
const SSoT_PREFIX = /^SSoT_/
const ALLOWLIST = new Set([
  'AgentWorkflow', 'ProcessWatchdog', 'CheckupTriageAndHeal', 'ClockEventDriver',
  'SelfHealUnit', 'MemoryAgent', 'DesignCritique', 'DesignGenerate', 'DesignPreview',
  'DesignResolve', 'DigestPipeline', 'KnowLeverCompilePipeline', 'PolarDesignPipeline',
  'AutoOfficePipeline', 'TQChampionSave', 'TQCourseTrain', 'TQEvolutionPipeline',
  'TQLobsterAdapter', 'TQPerpetualEvolver', 'TQResearchPipeline', 'LGRunExportWF',
  'LG_ConditionalEdge', 'LG_Differentiate', 'LG_End', 'LG_Entry', 'LG_EvolutionGuard',
  'LG_LLM', 'LG_Pluripotent', 'LG_Stop', 'LG_ToolNode',
])

const idx = JSON.parse(readFileSync(join(NODE_DEFS, 'index.json'), 'utf8'))
const types = new Set()
for (const f of idx.files) {
  for (const d of JSON.parse(readFileSync(join(NODE_DEFS, f), 'utf8'))) {
    types.add(d.class_type)
  }
}

const engineDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine')
const executorFiles = readdirSync(engineDir).filter(f => f.endsWith('.ts'))
const execSrc = executorFiles.map(f => readFileSync(join(engineDir, f), 'utf8')).join('\n')
const registered = new Set([...execSrc.matchAll(/registerExecutor\('([^']+)'/g)].map(m => m[1]))

const unregistered = [...types].filter(t => {
  if (registered.has(t)) return false
  if (ALLOWLIST.has(t) || PIPELINE_SUFFIX.test(t) || LG_PREFIX.test(t) || SSoT_PREFIX.test(t)) return false
  return true
}).sort()

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

console.log(`node-defs: ${types.size}, registerExecutor: ${registered.size}, unregistered (non-pipeline): ${unregistered.length}`)
if (unregistered.length) console.log('INFO unregistered:', unregistered.join(', '))

// 已知空壳须 deprecated 或 palette_hidden
const KNOWN_SHELLS = ['OutputDisplay']
for (const ct of KNOWN_SHELLS) {
  if (!types.has(ct)) continue
  const defs = idx.files.flatMap(f => JSON.parse(readFileSync(join(NODE_DEFS, f), 'utf8')))
  const def = defs.find(d => d.class_type === ct)
  if (def && !def.deprecated && !def.palette_hidden) {
    fail(`${ct} still visible empty shell`)
  }
}

ok('empty-shell-audit complete')

console.log(`\n--- empty-shell-audit: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
