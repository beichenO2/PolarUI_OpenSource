/** ReflectiveContext — 扫描 registry + 约束 + 可选 PromptEvolve 沉淀（00 §3.4） */
import { registry } from './registry'

export interface ReflectiveContextOptions {
  includeDescriptions?: boolean
  includeAgentRules?: boolean
  promptEvolveText?: string
}

export function buildReflectiveContext(opts: ReflectiveContextOptions = {}) {
  const includeDescriptions = opts.includeDescriptions !== false
  const includeAgentRules = opts.includeAgentRules !== false

  const nodes = registry.getAll().filter(n => !n.category.startsWith('SSoT/'))
  const manifest = nodes.map(n => ({
    class_type: n.class_type,
    display_name: n.display_name,
    category: n.category,
    ...(includeDescriptions && n.description ? { description: n.description } : {}),
    inputs: n.inputs.map(i => i.name),
    outputs: n.outputs.map(o => o.name),
  }))

  const constraints = {
    retry_loop: 'Validator(对齐用户需求) → RetryLoop(max_retries=7)',
    memory_boundary: {
      polar_memory: 'MemorySearch / MemoryStore — PolarMemory 块检索',
      polarclaw_learning: 'LearningCapture → PolarClaw/.data/learning-captures.jsonl',
      prompt_evolve: 'PromptEvolve → PolarUI/.data/prompt-evolve/latest.md',
      layout_memory: 'layout-memory.ts — 仅节点坐标，非语义记忆',
    },
    node_invention: '禁止发明 registry 外 class_type',
  }

  const lines: string[] = [
    `## 组件清单（${manifest.length} 个）`,
    JSON.stringify(manifest.slice(0, 80), null, 2),
  ]

  if (includeAgentRules) {
    lines.push(
      '## 约束（RetryLoop 定稿 · 记忆边界）',
      '- passed SSOT = 用户需求，不是 checklist',
      '- RetryLoop 默认 max_retries=7',
      '- PolarMemory ≠ PolarClaw learning store ≠ layout-memory',
      '- 节点类型必须来自 component_manifest',
    )
  }

  if (opts.promptEvolveText?.trim()) {
    lines.push('## 进化沉淀（PromptEvolve）', opts.promptEvolveText.trim())
  }

  return {
    component_manifest: { count: manifest.length, nodes: manifest },
    constraints,
    system_prompt: lines.join('\n\n'),
  }
}
