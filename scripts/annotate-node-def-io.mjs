#!/usr/bin/env node
/**
 * 为 node-defs 中缺失的 inputs/outputs.description 补全（华为式字段说明）。
 * 用法：node scripts/annotate-node-def-io.mjs [--dry-run]
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NODE_DEFS = path.resolve(__dirname, '../node-defs')
const dryRun = process.argv.includes('--dry-run')

const IO_HINTS = {
  prompt: '用户或上游传入的提示/任务正文，作为本组件主要处理对象。',
  context: '可选上下文（记忆块、RAG、前置节点输出等）。',
  intra_round_hint: 'RetryLoop 轮内修正提示；仅当前迭代有效，非轮间 SSOT。',
  response: '本组件产出的主结果，供下游连线消费。',
  usage: 'Token/调用元数据；可无下游连线（蒸馏采集）。',
  content: '汇聚到终点的交付内容（任意类型）。',
  text: '待处理的文本输入。',
  data: '通用数据载荷（对象/数组/标量）。',
  input: '上游传入的通用输入。',
  result: '处理结果输出。',
  passed: '校验是否通过（boolean）。',
  approved: '审批/门禁是否通过。',
  trigger: '触发信号（定时、事件或上游脉冲）。',
  items: '待迭代的集合（数组或列表）。',
  list: '列表型输入。',
  value: '待分支或判断的值。',
  tool_definitions: '可用工具定义（JSON），供 ToolCall 选用。',
  validation_spec: '校验规格：期望模式、用途说明等。',
  actual_output: '待验证的实际产出。',
  retry_hint: '轮内重试提示（可选）。',
  original_input: 'RetryLoop 锚定的原始用户需求。',
  sample: 'SampleLoop 单次独立采样输入。',
  score: '采样得分（用于选优）。',
  candidate: '候选产出。',
  selected: '选优后的结果。',
  system_prompt: '注入 LLM 的系统提示。',
  workflow: '工作流图或注册引用。',
  valid: '图/配置是否通过完备性检验。',
  image: '图像 URL 或 base64 输入。',
  schema: 'JSON Schema，用于结构化解析。',
  permission_request: '权限请求对象（action、tool_name 等）。',
}

function describeSlot(slot, io, displayName) {
  if (slot.description?.trim()) return slot
  const hint = IO_HINTS[slot.name]
  const desc =
    hint
    ?? `${displayName} · ${io}「${slot.name}」（类型 ${slot.type}）${slot.optional ? '，可选' : ''}`
  return { ...slot, description: desc }
}

function processFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const data = JSON.parse(raw)
  const list = Array.isArray(data) ? data : [data]
  let changed = 0
  for (const node of list) {
    if (!node.class_type) continue
    const label = node.display_name || node.class_type
    if (Array.isArray(node.inputs)) {
      node.inputs = node.inputs.map(s => {
        const next = describeSlot(s, '输入', label)
        if (next !== s) changed++
        return next
      })
    }
    if (Array.isArray(node.outputs)) {
      node.outputs = node.outputs.map(s => {
        const next = describeSlot(s, '输出', label)
        if (next !== s) changed++
        return next
      })
    }
  }
  if (changed > 0 && !dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2) + '\n', 'utf8')
  }
  return changed
}

const index = JSON.parse(fs.readFileSync(path.join(NODE_DEFS, 'index.json'), 'utf8'))
let total = 0
for (const f of index.files) {
  const p = path.join(NODE_DEFS, f)
  const n = processFile(p)
  if (n) console.log(`${f}: +${n} descriptions`)
  total += n
}
console.log(dryRun ? `[dry-run] would update ${total} slots` : `Updated ${total} slot descriptions`)
