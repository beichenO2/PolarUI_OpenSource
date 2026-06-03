/**
 * 工作流接线完整性校验（CLI / 编译脚本用）
 * 与 src/engine/wire-integrity.ts 规则一致。
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export const WIRING_EXEMPT_CLASS_TYPES = new Set(['NoteCard'])

export function loadNodeDefs(nodeDefsDir) {
  const indexPath = join(nodeDefsDir, 'index.json')
  if (!existsSync(indexPath)) {
    throw new Error(`node-defs index not found: ${indexPath}`)
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf-8'))
  const defs = new Map()
  for (const file of index.files) {
    const path = join(nodeDefsDir, file)
    if (!existsSync(path)) continue
    for (const d of JSON.parse(readFileSync(path, 'utf-8'))) {
      if (d.class_type) defs.set(d.class_type, d)
    }
  }
  return defs
}

function workflowNodeEntries(json) {
  return Object.entries(json).filter(([k]) => !k.startsWith('_'))
}

/**
 * @param {Record<string, unknown>} json API 格式工作流
 * @param {Map<string, { inputs?: { name: string, optional?: boolean }[], display_name?: string }>} nodeDefs
 */
function isWireRef(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string'
}

function isWired(val) {
  if (isWireRef(val)) return true
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return Object.values(val).some(v => isWireRef(v))
  }
  if (typeof val === 'string' && val.length > 0) return true
  return false
}

export function validateWorkflowWiring(json, nodeDefs) {
  const errors = []
  const entries = workflowNodeEntries(json)

  for (const [id, node] of entries) {
    if (WIRING_EXEMPT_CLASS_TYPES.has(node.class_type)) continue
    const def = nodeDefs.get(node.class_type)
    if (!def) continue
    const label = def.display_name || node.class_type

    for (let i = 0; i < (def.inputs || []).length; i++) {
      const inp = def.inputs[i]
      if (inp.optional) continue
      const val = node.inputs?.[inp.name]
      const paramVal = node.params?.[inp.name]
      const wired = isWired(val)
        || (paramVal !== undefined && paramVal !== null && String(paramVal).length > 0)
      if (!wired) {
        errors.push(`Node "${id}" (${label}): 输入「${inp.name}」未连接`)
      }
    }
  }

  return errors
}
