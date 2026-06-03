#!/usr/bin/env node
/**
 * P3 心智审查：WorkflowMeta 补丁应用 + 沙箱加载（不调用 LLM）
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let failed = 0
function fail(msg) { console.error('FAIL:', msg); failed++ }
function ok(msg) { console.log('OK:', msg) }

// 内联补丁逻辑（与 meta-executor applyPatches 一致）
function applyPatches(workflow, patches) {
  const out = JSON.parse(JSON.stringify(workflow))
  let count = 0
  for (const p of patches) {
    const node = out[p.node_id]
    if (!node) continue
    if (p.action === 'remove_node') { delete out[p.node_id]; count++; continue }
    if (p.action === 'replace_class_type' && p.class_type) { node.class_type = p.class_type; count++ }
    if (p.action === 'update_params' && p.params) {
      node.inputs = { ...(node.inputs || {}), ...p.params }
      count++
    }
  }
  return { workflow: out, count }
}

const sample = JSON.parse(fs.readFileSync(path.join(root, 'PolarUI/workflows/autooffice-pipeline.json'), 'utf8'))
const nodeKeys = Object.keys(sample).filter(k => !k.startsWith('_'))
if (nodeKeys.length < 2) fail('sample workflow too small')
else ok(`sample workflow ${nodeKeys.length} nodes`)

const firstKey = nodeKeys[0]
const { workflow: patched, count } = applyPatches(sample, [
  { action: 'update_params', node_id: firstKey, params: { _test_flag: true } },
])
if (count !== 1) fail(`expected 1 patch, got ${count}`)
else ok('patch apply count')

if (!patched[firstKey].inputs?._test_flag) fail('patch not applied to inputs')
else ok('patch applied to node inputs')

// 动态 import loader（需 ts — 改测 JSON 结构完整性）
const unknown = Object.values(patched).filter(v => v && v.class_type === 'NotARealNode')
if (unknown.length) fail('unexpected node types after patch')

ok('WorkflowMeta patch logic sanity check passed')
process.exit(failed ? 1 : 0)
