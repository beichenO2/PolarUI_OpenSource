#!/usr/bin/env node
/**
 * 一次性：将 node-defs/agentic.json 范式写入 workflows/registry.json（含 node_def），
 * 并生成 node-defs/registry-paradigms.json 供引擎加载。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const AGENTIC = join(ROOT, 'node-defs/registry-paradigms.json')
const REGISTRY = join(ROOT, 'PolarUI/workflows/registry.json')
const OUT_PARADIGMS = join(ROOT, 'node-defs/registry-paradigms.json')
const INDEX = join(ROOT, 'node-defs/index.json')

const agentic = JSON.parse(readFileSync(AGENTIC, 'utf8'))
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))

const registeredFiles = new Set(
  registry.map(e => (e.file || '').replace(/\.json$/i, '').replace(/^.*\//, '')),
)
const existingParadigm = new Set(
  registry.filter(e => e.paradigm_class_type).map(e => e.paradigm_class_type),
)

const toAdd = []
for (const def of agentic) {
  const ct = def.class_type
  if (!ct || ct === 'AgentWorkflow') continue
  const iw = def.internal_workflow
  if (iw) {
    const slug = iw.replace(/\.json$/i, '').replace(/^.*\//, '')
    if (registeredFiles.has(slug)) continue
  }
  if (existingParadigm.has(ct)) continue
  toAdd.push({
    id: `paradigm-${ct}`,
    name: def.display_name || ct,
    description: def.description || '',
    category: 'agentic',
    nodeCount: 0,
    file: '',
    paradigm_class_type: ct,
    node_def: def,
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  existingParadigm.add(ct)
}

const merged = [...registry, ...toAdd]
writeFileSync(REGISTRY, JSON.stringify(merged, null, 2) + '\n')

// 引擎仍须全部 Agentic 节点定义（含已有 internal_workflow 的管线类）
writeFileSync(OUT_PARADIGMS, JSON.stringify(agentic, null, 2) + '\n')

const index = JSON.parse(readFileSync(INDEX, 'utf8'))
index.files = index.files.filter(f => f !== 'agentic.json')
if (!index.files.includes('registry-paradigms.json')) {
  const agenticIdx = index.files.indexOf('agentic.json')
  if (agenticIdx >= 0) index.files.splice(agenticIdx, 1, 'registry-paradigms.json')
  else index.files.push('registry-paradigms.json')
}
writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n')

console.log(`registry.json: +${toAdd.length} paradigm entries (total ${merged.length})`)
console.log(`registry-paradigms.json: ${agentic.length} node defs`)
console.log('index.json: removed agentic.json, added registry-paradigms.json')
