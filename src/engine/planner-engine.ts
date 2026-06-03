import { registry } from './registry'
import { chatCompletion, isPrivPortalHealthy } from '@/sdk/llm-proxy'
import type { NodeDef } from './types'

interface PlannerParams {
  model: string
  strategy: 'linear' | 'parallel' | 'iterative'
  max_depth: number
  reflect: boolean
}

interface PlanResult {
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  reasoning: string
  components_used: string[]
}

let reflectiveCache: { manifest: string; timestamp: number } | null = null
const CACHE_TTL_MS = 30_000

function buildComponentManifest(): string {
  const allNodes = registry.getAll()
  const lines: string[] = ['可用节点类型：']

  for (const node of allNodes) {
    if (node.category.startsWith('SSoT/')) continue
    const inputs = node.inputs.map(i => `${i.name}:${i.type}`).join(', ')
    const outputs = node.outputs.map(o => `${o.name}:${o.type}`).join(', ')
    lines.push(`- ${node.class_type}(${node.display_name}): ${node.description || ''} | inputs:[${inputs}] outputs:[${outputs}]`)
  }

  return lines.join('\n')
}

async function getPlannerRulesContext(userGoal: string): Promise<string> {
  try {
    const { loadRulesBundle, selectProtocolRules, selectNormRules, mergeRulesText } = await import('./rules-client')
    const all = await loadRulesBundle()
    const norms = selectNormRules(all)
    const protos = selectProtocolRules(userGoal, all)
    const merged = mergeRulesText([...norms, ...protos])
    if (merged.trim()) return merged
  } catch {
    /* rules-bundle 未就绪时跳过 */
  }
  return ''
}

const ROLE_COGNITION = [
  '**角色认知**：你是 PolarUI 规划模块（Master）。你生成的工作流 JSON 是给执行引擎（Slave）消费的产物，不是给自己用的笔记。',
  '方案必须通用、可执行；节点类型必须来自组件清单，不可发明新类型。',
].join('\n')

function getReflectiveContext(): string {
  const now = Date.now()
  if (reflectiveCache && (now - reflectiveCache.timestamp) < CACHE_TTL_MS) {
    return reflectiveCache.manifest
  }

  const manifest = buildComponentManifest()
  const constraints = [
    '约束规则：',
    '- P1 复杂度控制：优先复用已有节点 > 组合 > 新建',
    '- P4 先设计后执行：复杂目标先分解再编排',
    '- **RetryLoop 优先**：凡含 LLM/AgenticUnit 且产出可核验，默认 Validator(对齐用户需求) → RetryLoop(max_retries=7)',
    '- 所有节点类型必须来自上述清单，不可发明新类型',
    '- 节点间引用使用 ["节点ID", slot序号] 格式',
    '- 输出纯 JSON 格式的工作流',
  ].join('\n')

  const full = `${manifest}\n\n${constraints}`
  reflectiveCache = { manifest: full, timestamp: now }
  return full
}

function buildStrategyPrompt(strategy: string, maxDepth: number): string {
  switch (strategy) {
    case 'parallel':
      return `规划策略：并行。尽可能让独立步骤并行执行，减少总深度。逻辑链最大深度 ${maxDepth} 层。`
    case 'iterative':
      return `规划策略：迭代。允许循环和反馈环路，适用于需要多轮改进的任务。逻辑链最大深度 ${maxDepth} 层。`
    default:
      return `规划策略：线性。按顺序逐步执行，每步依赖上一步输出。逻辑链最大深度 ${maxDepth} 层。`
  }
}

/**
 * Execute the Planner node: call LLM Proxy to generate a workflow from a goal.
 */
export async function executePlanner(
  goal: string,
  params: PlannerParams,
): Promise<PlanResult> {
  const healthy = await isPrivPortalHealthy()
  if (!healthy) {
    throw new Error('PolarPrivate 不可用或 Vault 未解锁。请确认 PolarPrivate 正在运行。')
  }

  const rulesContext = await getPlannerRulesContext(goal)

  const systemPrompt = [
    '你是 PolarUI 规划模块——一个工作流逻辑链规划器。',
    '你的任务是根据用户目标生成一个可执行的 PolarUI 工作流 JSON。',
    ROLE_COGNITION,
    rulesContext ? `\n## 触发规则\n${rulesContext}` : '',
    '',
    params.reflect ? getReflectiveContext() : buildComponentManifest(),
    '',
    buildStrategyPrompt(params.strategy, params.max_depth),
    '',
    '含 LLM 的推荐子结构（除非用户明确不要重试）：',
    'PromptInput → LLM → Validator(purpose←PromptInput) → RetryLoop(passed←Validator, original_input←PromptInput) → Output',
    'RetryLoop 轮间：retry_input 仅回流用户需求 SSOT（不携带 retry_hint/错误摘要）；轮内修正走 intra_round_hint 或图内回边。',
    '',
    '输出格式：',
    '```json',
    '{',
    '  "workflow": { "1": { "class_type": "...", "inputs": {...} }, ... },',
    '  "reasoning": "为什么选择这些节点和这个结构",',
    '  "components_used": ["节点类型1", "节点类型2", ...]',
    '}',
    '```',
    '只输出 JSON，不要其他文字。',
  ].join('\n')

  const reply = await chatCompletion(
    params.model,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `目标：${goal}` },
    ],
    { temperature: 0.7, maxTokens: 4096 },
  )

  const jsonMatch = reply.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('LLM 返回了结果但未能解析为 JSON')
  }

  const parsed = JSON.parse(jsonMatch[0]) as PlanResult
  if (!parsed.workflow || typeof parsed.workflow !== 'object') {
    throw new Error('LLM 返回的 JSON 中缺少 workflow 字段')
  }

  return parsed
}

/**
 * runPolarClaw：经 PolarClaw Agent 生成工作流 JSON 并上画布（02 批次外纳入）
 */
export async function executePlannerViaPolarClaw(goal: string): Promise<PlanResult> {
  const { findPolarClawUrl, callPolarClawAgent, extractWorkflowJson } = await import('./polarclaw-client')
  const clawUrl = await findPolarClawUrl()
  const manifest = buildComponentManifest()
  const prompt = [
    '你是 PolarUI 规划模块。根据用户目标生成 PolarUI 工作流 JSON。',
    manifest,
    '',
    '输出纯 JSON：',
    '{"workflow":{"1":{"class_type":"...","inputs":{...}}},"reasoning":"...","components_used":[]}',
    '',
    `用户目标：${goal}`,
  ].join('\n')

  const reply = await callPolarClawAgent(clawUrl, prompt, `polarui-plan-${Date.now()}`)
  const workflow = extractWorkflowJson(reply)
  if (!workflow) {
    throw new Error('PolarClaw 返回无法解析为 workflow JSON')
  }

  let parsed: PlanResult
  try {
    const jsonMatch = reply.match(/\{[\s\S]*\}/)
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) as PlanResult : { workflow: workflow as PlanResult['workflow'], reasoning: reply.slice(0, 200), components_used: [] }
  } catch {
    parsed = { workflow: workflow as PlanResult['workflow'], reasoning: reply.slice(0, 200), components_used: [] }
  }

  if (!parsed.workflow || typeof parsed.workflow !== 'object') {
    throw new Error('PolarClaw 返回的 JSON 中缺少 workflow 字段')
  }
  return parsed
}

/**
 * Validate a workflow for connectivity, type compatibility, and cycles.
 */
export function validateWorkflow(
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
  checks: { connectivity: boolean; types: boolean; cycles: boolean },
): { valid: boolean; issues: string[]; suggestions: string[] } {
  const issues: string[] = []
  const suggestions: string[] = []

  const nodeIds = new Set(Object.keys(workflow))

  for (const [id, node] of Object.entries(workflow)) {
    const def = registry.get(node.class_type)
    if (!def) {
      issues.push(`节点 ${id}: 未知类型 "${node.class_type}"`)
      continue
    }

    if (checks.connectivity) {
      for (const [key, val] of Object.entries(node.inputs)) {
        if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
          if (!nodeIds.has(val[0])) {
            issues.push(`节点 ${id}: 输入 "${key}" 引用了不存在的节点 "${val[0]}"`)
          }
        }
      }
    }

    if (checks.types) {
      for (const [key, val] of Object.entries(node.inputs)) {
        if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
          const sourceId = val[0]
          const sourceSlot = val[1] as number
          const sourceDef = registry.get(workflow[sourceId]?.class_type || '')
          if (sourceDef && def) {
            const sourceOutput = sourceDef.outputs[sourceSlot]
            const targetInput = def.inputs.find(i => i.name === key)
            if (sourceOutput && targetInput && targetInput.type !== 'any' && sourceOutput.type !== 'any' && sourceOutput.type !== targetInput.type) {
              issues.push(`节点 ${id}: 输入 "${key}" 类型不兼容 (期望 ${targetInput.type}，实际 ${sourceOutput.type})`)
            }
          }
        }
      }
    }
  }

  if (checks.cycles) {
    const visited = new Set<string>()
    const stack = new Set<string>()

    function hasCycle(nodeId: string): boolean {
      if (stack.has(nodeId)) return true
      if (visited.has(nodeId)) return false
      visited.add(nodeId)
      stack.add(nodeId)

      const node = workflow[nodeId]
      if (node) {
        for (const val of Object.values(node.inputs)) {
          if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
            if (hasCycle(val[0])) return true
          }
        }
      }

      stack.delete(nodeId)
      return false
    }

    for (const id of nodeIds) {
      if (hasCycle(id)) {
        issues.push(`检测到循环引用涉及节点 ${id}`)
        break
      }
    }
  }

  if (issues.length === 0) {
    suggestions.push('工作流验证通过，可以执行')
  } else {
    suggestions.push('修复上述问题后重新验证')
  }

  return { valid: issues.length === 0, issues, suggestions }
}
