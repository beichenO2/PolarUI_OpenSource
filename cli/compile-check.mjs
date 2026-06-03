#!/usr/bin/env node
/**
 * PolarUI Compile Check — validate workflow JSON against registered nodes
 *
 * Usage:
 *   node cli/compile-check.mjs <workflow.json>
 *   node cli/compile-check.mjs --all         # check all in workflows/
 *   node cli/compile-check.mjs --strict      # treat warnings as errors
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { loadNodeDefs, validateWorkflowWiring } from './wire-integrity-check.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const ECOSYSTEM_ROOT = resolve(ROOT, '..')
const WORKFLOWS_DIR = join(ROOT, 'workflows')
const NODE_DEFS_DIR = join(ECOSYSTEM_ROOT, 'node-defs')

let NODE_DEFS
try {
  NODE_DEFS = loadNodeDefs(NODE_DEFS_DIR)
} catch (e) {
  console.error(`ERROR: cannot load node-defs: ${e.message}`)
  process.exit(1)
}

const REGISTERED_NODES = new Set(NODE_DEFS.keys())

const VALID_INPUT_TYPES = new Set(['string', 'object', 'any', 'number', 'boolean'])

function extractWireRefs(val, prefix = '') {
  const refs = []
  if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
    refs.push({ refId: val[0], slotIdx: val[1], path: prefix || '?' })
  } else if (val && typeof val === 'object' && !Array.isArray(val)) {
    for (const [k, v] of Object.entries(val)) {
      refs.push(...extractWireRefs(v, prefix ? `${prefix}.${k}` : k))
    }
  }
  return refs
}

function compileCheck(filePath, strict = false) {
  const errors = []
  const warnings = []

  if (!existsSync(filePath)) {
    errors.push(`File not found: ${filePath}`)
    return { errors, warnings, file: filePath }
  }

  let json
  try {
    const raw = readFileSync(filePath, 'utf-8')
    json = JSON.parse(raw)
  } catch (e) {
    errors.push(`Invalid JSON: ${e.message}`)
    return { errors, warnings, file: filePath }
  }

  if (typeof json !== 'object' || json === null) {
    errors.push('Workflow must be a JSON object')
    return { errors, warnings, file: filePath }
  }

  const nodeIds = new Set(Object.keys(json).filter(k => !k.startsWith('_')))
  if (nodeIds.size === 0) {
    errors.push('Workflow has no nodes')
    return { errors, warnings, file: filePath }
  }

  for (const [id, node] of Object.entries(json)) {
    if (id.startsWith('_')) continue
    if (!node.class_type) {
      errors.push(`Node "${id}": missing class_type`)
      continue
    }

    if (!REGISTERED_NODES.has(node.class_type)) {
      errors.push(`Node "${id}": unknown class_type "${node.class_type}" — not in registered node set`)
      continue
    }

    const nodeDef = NODE_DEFS.get(node.class_type)
    if (nodeDef?.palette_hidden) {
      errors.push(
        `Node "${id}": class_type "${node.class_type}" 为 Internal（palette_hidden）— 工作流只能使用组件库内可见组件`,
      )
    } else if (nodeDef?.category?.startsWith('Internal/')) {
      errors.push(
        `Node "${id}": class_type "${node.class_type}" 属于 Internal 分类 — 工作流只能使用组件库内可见组件`,
      )
    }

    if (node.class_type === 'PromptInput') {
      const eo = node.inputs?.expected_output ?? node.params?.expected_output ?? node.params?.expected_pattern
      const eoStr = typeof eo === 'string' ? eo.trim() : eo != null ? JSON.stringify(eo) : ''
      if (!eoStr) {
        errors.push(`Node "${id}" (PromptInput): expected_output 必填 — JSON 分块对象`)
        continue
      }
      try {
        const obj = typeof eo === 'object' && eo ? eo : JSON.parse(eoStr)
        const keys = Object.keys(obj)
        if (!keys.length) {
          errors.push(`Node "${id}" (PromptInput): expected_output JSON 至少 1 个分块字段`)
        }
        for (const k of keys) {
          if (typeof obj[k] !== 'string' || !String(obj[k]).trim()) {
            errors.push(`Node "${id}" (PromptInput): expected_output.${k} 须为非空正则字符串`)
          }
        }
      } catch {
        errors.push(`Node "${id}" (PromptInput): expected_output 须为 JSON 对象（键=分块名，值=正则）`)
      }
    }

    if (!node.inputs || typeof node.inputs !== 'object') {
      errors.push(`Node "${id}": missing or invalid inputs object`)
      continue
    }

    for (const [inputKey, inputVal] of Object.entries(node.inputs)) {
      const refs = extractWireRefs(inputVal)
      for (const { refId, slotIdx, path } of refs) {
        if (!nodeIds.has(String(refId))) {
          errors.push(`Node "${id}".inputs.${path}: references non-existent node "${refId}"`)
        }
        if (typeof slotIdx !== 'number' || slotIdx < 0) {
          warnings.push(`Node "${id}".inputs.${path}: slot index ${slotIdx} may be invalid`)
        }
      }
    }
  }

  const referenced = new Set()
  for (const [id, node] of Object.entries(json)) {
    if (id.startsWith('_')) continue
    for (const inputVal of Object.values(node.inputs || {})) {
      for (const { refId } of extractWireRefs(inputVal)) {
        referenced.add(String(refId))
      }
    }
  }

  for (const id of nodeIds) {
    const node = json[id]
    if (!node?.class_type) continue
    const hasInputRefs = Object.values(node.inputs || {}).some(v => extractWireRefs(v).length > 0)
    if (!hasInputRefs && !referenced.has(id) && nodeIds.size > 1) {
      warnings.push(`Node "${id}" (${node.class_type}): isolated node — no connections`)
    }
  }

  const wiringErrors = validateWorkflowWiring(json, NODE_DEFS)
  for (const msg of wiringErrors) {
    errors.push(msg)
  }

  const MIN_BRANCH = { Switch: 2, Condition: 2 }
  const outgoingSlots = new Map()
  for (const id of nodeIds) outgoingSlots.set(id, new Set())
  for (const [toId, node] of Object.entries(json)) {
    if (toId.startsWith('_')) continue
    for (const inputVal of Object.values(node.inputs || {})) {
      for (const { refId, slotIdx } of extractWireRefs(inputVal)) {
        if (!outgoingSlots.has(refId)) outgoingSlots.set(refId, new Set())
        outgoingSlots.get(refId).add(slotIdx)
      }
    }
  }
  for (const [id, node] of Object.entries(json)) {
    if (id.startsWith('_')) continue
    const min = MIN_BRANCH[node.class_type]
    if (!min) continue
    const def = NODE_DEFS.get(node.class_type)
    const label = def?.display_name || node.class_type
    const connected = outgoingSlots.get(id)?.size ?? 0
    if (node.class_type === 'Switch') {
      try {
        const cases = JSON.parse(String(node.params?.cases ?? '[]'))
        if (Array.isArray(cases) && cases.length < min) {
          errors.push(
            `Node "${id}" (${label}): Case 列表须至少 ${min} 项，当前 ${cases.length} 项`,
          )
        }
      } catch {
        errors.push(`Node "${id}" (${label}): cases 参数须为合法 JSON 数组`)
      }
    }
    if (connected < min) {
      errors.push(
        `Node "${id}" (${label}): 多路分支须至少接出 ${min} 条不同出口连线，当前 ${connected} 条`,
      )
    }
  }

  const classOf = (nid) => json[nid]?.class_type
  const refsFrom = (nid) => {
    const out = []
    for (const val of Object.values(json[nid]?.inputs || {})) {
      for (const r of extractWireRefs(val)) out.push(r.refId)
    }
    return out
  }
  const refsTo = (targetId) => {
    const from = []
    for (const [nid, node] of Object.entries(json)) {
      if (nid.startsWith('_')) continue
      for (const val of Object.values(node.inputs || {})) {
        for (const r of extractWireRefs(val)) {
          if (r.refId === targetId) from.push(nid)
        }
      }
    }
    return from
  }

  const agenticTypes = new Set(['AgenticUnit', 'AgentWorkflow', 'AgenticChain'])
  for (const id of nodeIds) {
    if (classOf(id) !== 'LLM') continue
    if (/b$/.test(id) && nodeIds.has(id.slice(0, -1))) continue
    const feedsAgentic = refsTo(id).some(tid => agenticTypes.has(classOf(tid)))
    if (feedsAgentic) continue
    const validators = refsTo(id).filter(vid => classOf(vid) === 'Validator')
    if (!validators.length) {
      errors.push(`Node "${id}" (LLM): 缺少下游 Validator（须 LLM → Validator → RetryLoop → 回连 LLM）`)
      continue
    }
    const viaValidatorRetry = validators.some(vid =>
      refsTo(vid).some(rid => classOf(rid) === 'RetryLoop'),
    )
    if (!viaValidatorRetry) {
      errors.push(`Node "${id}" (LLM): 缺少 Validator → RetryLoop（passed 接线）`)
    }
  }

  if (strict) {
    errors.push(...warnings.map(w => `[strict] ${w}`))
    warnings.length = 0
  }

  return { errors, warnings, file: filePath }
}

function printResult(result) {
  const icon = result.errors.length > 0 ? '❌' : result.warnings.length > 0 ? '⚠️' : '✅'
  console.log(`\n${icon} ${result.file}`)

  for (const e of result.errors) {
    console.log(`  ERROR: ${e}`)
  }
  for (const w of result.warnings) {
    console.log(`  WARN:  ${w}`)
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('  All checks passed.')
  }
}

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const checkAll = args.includes('--all')
const jsonOut = args.includes('--json')
const files = args.filter(a => !a.startsWith('--'))

let results = []

if (checkAll) {
  if (!existsSync(WORKFLOWS_DIR)) {
    console.error('ERROR: workflows/ directory not found')
    process.exit(1)
  }
  const wfFiles = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json') && f !== 'registry.json')
  if (wfFiles.length === 0) {
    console.log('No workflow files found in workflows/')
    process.exit(0)
  }
  results = wfFiles.map(f => compileCheck(join(WORKFLOWS_DIR, f), strict))
} else if (files.length > 0) {
  results = files.map(f => compileCheck(resolve(f), strict))
} else {
  console.log('Usage: node cli/compile-check.mjs <workflow.json> [--strict]')
  console.log('       node cli/compile-check.mjs --all [--strict]')
  process.exit(0)
}

console.log(`\n═══ PolarUI Compile Check ═══`)
if (!jsonOut) results.forEach(printResult)

const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0)
const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0)

if (jsonOut) {
  const summary = {
    checked: results.length,
    errors: totalErrors,
    warnings: totalWarnings,
    status: totalErrors > 0 ? 'FAIL' : 'PASS',
    files: results.map(r => ({
      file: r.file,
      errors: r.errors,
      warnings: r.warnings,
      status: r.errors.length > 0 ? 'FAIL' : 'PASS',
    })),
  }
  console.log(JSON.stringify(summary))
} else {
  console.log(`\n${results.length} file(s) checked: ${totalErrors} error(s), ${totalWarnings} warning(s)`)
}

if (totalErrors > 0) {
  if (!jsonOut) console.log('\n❌ COMPILE FAILED — fix errors above')
  process.exit(1)
} else {
  if (!jsonOut) console.log('\n✅ COMPILE PASSED')
  process.exit(0)
}
