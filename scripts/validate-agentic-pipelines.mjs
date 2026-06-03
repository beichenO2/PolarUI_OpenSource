#!/usr/bin/env node
/**
 * Agent G 健康检查：internal_workflow ↔ workflows/*.json ↔ registry.json
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadNodeDefs, validateWorkflowWiring } from '../cli/wire-integrity-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const nodeDefsDir = path.join(root, 'node-defs')
const nodeDefs = loadNodeDefs(nodeDefsDir)
const workflowsDir = path.join(root, 'PolarUI/workflows')
const registryPath = path.join(workflowsDir, 'registry.json')

let failed = 0
function fail(msg) {
  console.error('FAIL:', msg)
  failed++
}
function ok(msg) {
  console.log('OK:', msg)
}

const paradigmsPath = path.join(nodeDefsDir, 'registry-paradigms.json')
if (!fs.existsSync(paradigmsPath)) {
  console.error('FAIL: missing node-defs/registry-paradigms.json (SSOT: workflows/registry.json paradigms)')
  process.exit(1)
}
const agentic = JSON.parse(fs.readFileSync(paradigmsPath, 'utf8'))
const withInternal = agentic.filter((d) => d.internal_workflow)

for (const def of withInternal) {
  const wfPath = path.join(workflowsDir, `${def.internal_workflow}.json`)
  if (!fs.existsSync(wfPath)) {
    fail(`${def.class_type}: missing ${def.internal_workflow}.json`)
    continue
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(wfPath, 'utf8'))
  } catch (e) {
    fail(`${def.class_type}: invalid JSON — ${e.message}`)
    continue
  }
  const nodes = Object.keys(data).filter((k) => !k.startsWith('_'))
  if (nodes.length < 2) fail(`${def.class_type}: workflow has < 2 nodes`)
  else ok(`${def.class_type} → ${def.internal_workflow}.json (${nodes.length} nodes)`)

  if (!def.expandable) fail(`${def.class_type}: missing expandable: true`)

  const isLgSpec = data._library === 'LG' || Array.isArray(data._lg_edges)
  if (!isLgSpec) {
    const wiringErrors = validateWorkflowWiring(data, nodeDefs)
    for (const msg of wiringErrors) {
      fail(`${def.internal_workflow}: ${msg}`)
    }
  } else {
    ok(`${def.internal_workflow}: LG spec (skip WF wiring check)`)
  }
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
const workflowEntries = registry.filter((e) => e.file)
const filesInRegistry = new Set(workflowEntries.map((e) => e.file.replace(/\.json$/, '')))
for (const def of withInternal) {
  const file = `${def.internal_workflow}.json`
  if (!workflowEntries.some((e) => e.file === file)) {
    fail(`registry missing entry for ${file}`)
  }
}

const migrated = ['PolarPilot', 'EcosystemScanner', 'SkillCapture']
for (const ct of migrated) {
  const d = agentic.find((x) => x.class_type === ct)
  if (!d) fail(`missing ${ct}`)
  else if (!d.category.startsWith('Agentic')) fail(`${ct} category is ${d.category}, expected Agentic`)
  else ok(`${ct} in ${d.category}`)
}

if (agentic.some((d) => d.class_type === 'ReportGenerator')) {
  fail('ReportGenerator should be removed')
} else ok('ReportGenerator removed')

// All class_types in pipeline workflows must exist in node-defs
const allTypes = new Set()
for (const f of fs.readdirSync(nodeDefsDir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
  for (const d of JSON.parse(fs.readFileSync(path.join(nodeDefsDir, f), 'utf8'))) {
    allTypes.add(d.class_type)
  }
}
for (const def of withInternal) {
  const data = JSON.parse(fs.readFileSync(path.join(workflowsDir, `${def.internal_workflow}.json`), 'utf8'))
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('_')) continue
    const ct = v.class_type
    if (!allTypes.has(ct)) fail(`${def.internal_workflow} node ${k}: unknown class_type ${ct}`)
  }
}
ok('all pipeline node class_types registered in node-defs')

console.log(`\n--- ${withInternal.length} pipelines, ${failed} failures ---`)
process.exit(failed > 0 ? 1 : 0)
