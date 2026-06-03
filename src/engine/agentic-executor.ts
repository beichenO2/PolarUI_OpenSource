/**
 * AgenticUnit / AgenticChain executors — 工作层 + 核验层 + 重试循环
 */
import { getLLMClient } from '../sdk/llm-proxy'
import { formatRoleDeclaration } from './role-prompt'
import type { NodeInstance } from './types'
import type { ExecutionResult } from './executor'

function buildSystemPrompt(node: NodeInstance, base: string): string {
  const roleText = formatRoleDeclaration(node.params.role_declaration)
  if (roleText) {
    return `${base}\n\n## 角色声明\n${roleText}`
  }
  return base
}

async function callWorkLayer(
  node: NodeInstance,
  taskInput: unknown,
  purpose: string,
  feedback?: string,
  expectedPattern?: string,
  priorKnowledge?: string,
): Promise<string> {
  const model = (node.params.work_model as string) || 'GLM-5.1'
  let systemPrompt = buildSystemPrompt(
    node,
    '你是 Agentic 工作层。根据任务输入产出可直接核验的结构化或文本输出。'
  )
  if (priorKnowledge?.trim()) {
    systemPrompt = `${systemPrompt}\n\n## 上轮进化沉淀（PromptEvolve）\n${priorKnowledge.trim()}`
  }
  const jsonHint = expectedPattern?.includes('action')
    ? '\n\n## 输出格式\n仅输出一个 JSON 对象，不要用 markdown 代码块，不要附加解释。'
    : ''
  const rawInput = typeof taskInput === 'string' ? taskInput : JSON.stringify(taskInput, null, 2)
  const maxLen = Number(node.params.max_input_chars ?? 12000)
  const trimmedInput = rawInput.length > maxLen
    ? `${rawInput.slice(0, maxLen)}\n...[truncated ${rawInput.length - maxLen} chars]`
    : rawInput
  const userParts = [
    purpose ? `## 总体目的\n${purpose}` : '',
    `## 任务输入\n${trimmedInput}`,
    expectedPattern ? `## 须匹配的正则\n${expectedPattern}` : '',
    feedback ? `## 上次核验失败反馈\n${feedback}\n请修正后重新输出。` : '',
    jsonHint,
  ].filter(Boolean)

  const result = await getLLMClient().chat(
    model,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userParts.join('\n\n') },
    ],
    { temperature: 0.3, timeoutMs: 180_000 }
  )
  const raw = result.content.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  return fence ? fence[1]!.trim() : raw
}

function extractJsonSubstring(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fence ? fence[1]! : text).trim()
  const obj = raw.match(/\{[\s\S]*\}/)
  return obj ? obj[0] : raw
}

function verifyOutputRegex(expectedPattern: string, actual: string): boolean {
  const candidate = extractJsonSubstring(actual)
  if (!expectedPattern?.trim()) return !!candidate.trim()
  try {
    return new RegExp(expectedPattern).test(candidate)
  } catch {
    return candidate.includes(expectedPattern)
  }
}

async function callVerifyLayer(
  node: NodeInstance,
  purpose: string,
  expectedPattern: string,
  actualOutput: string,
): Promise<{ passed: boolean; reason: string }> {
  return verifyOutputAgainstPurpose(purpose, expectedPattern, actualOutput, node.params)
}

/** 核验层 — 对齐用户需求 SSOT（AgenticUnit · Validator 共用） */
export async function verifyOutputAgainstPurpose(
  purpose: string,
  expectedPattern: string,
  actualOutput: string,
  params: Record<string, unknown> = {},
): Promise<{ passed: boolean; reason: string }> {
  const regexOk = verifyOutputRegex(expectedPattern, actualOutput)
  const verifyMode = String(params.verify_mode ?? 'llm')

  if (verifyMode === 'regex') {
    return {
      passed: regexOk,
      reason: regexOk ? 'regex match' : `regex mismatch: ${expectedPattern || '(non-empty)'}`,
    }
  }

  const pseudoNode = { params } as NodeInstance
  const model = String(params.verify_model ?? params.work_model ?? 'GLM-5.1')
  const systemPrompt = buildSystemPrompt(
    pseudoNode,
    '你是 Agentic 核验层。收到三层输入：总体目的、预期输出正则、实际输出。判断实际输出是否满足目的与正则约束。只回复 JSON：{"passed":boolean,"reason":"..."}',
  )
  const userContent = [
    purpose ? `## 总体目的（用户需求 SSOT）\n${purpose}` : '',
    `## 预期输出正则\n${expectedPattern || '(非空输出即可)'}`,
    `## 实际输出\n${actualOutput}`,
    regexOk ? '## 提示\n本地正则预检已通过，请确认语义也符合总体目的。' : '## 提示\n本地正则预检未通过，请严格判定。',
  ].filter(Boolean).join('\n\n')

  try {
    const result = await getLLMClient().chat(
      model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      { temperature: 0.2, timeoutMs: 60_000 },
    )
    const match = result.content.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { passed?: boolean; reason?: string }
      return { passed: !!parsed.passed, reason: String(parsed.reason ?? '') }
    }
  } catch {
    // fall through to regex
  }

  return {
    passed: regexOk,
    reason: regexOk ? 'regex fallback pass' : 'verify LLM unavailable; regex failed',
  }
}

function resolvePurpose(inputs: Record<string, unknown>, node: NodeInstance): string {
  const raw = inputs.purpose ?? node.params.purpose
  if (raw && typeof raw === 'object') {
    const obj = raw as { purpose?: unknown; content?: unknown }
    if (obj.purpose != null) return String(obj.purpose)
    if (obj.content != null) return String(obj.content)
  }
  return String(raw ?? '')
}

export async function executeAgenticUnit(node: NodeInstance, inputs: Record<string, unknown>): Promise<ExecutionResult> {
  const start = Date.now()
  const taskInput = inputs.task_input ?? inputs.input ?? ''
  const purpose = resolvePurpose(inputs, node)
  const expectedPattern = String(inputs.expected_pattern ?? node.params.expected_pattern ?? '')
  const priorKnowledge = String(inputs.prior_knowledge ?? node.params.prior_knowledge ?? '')
  const maxRetries = Number(node.params.max_retries ?? 7)

  let lastOutput = ''
  let attempts = 0
  let feedback: string | undefined

  for (attempts = 1; attempts <= maxRetries; attempts++) {
    lastOutput = await callWorkLayer(node, taskInput, purpose, feedback, expectedPattern, priorKnowledge)
    const verification = await callVerifyLayer(node, purpose, expectedPattern, lastOutput)
    if (verification.passed) {
      return {
        outputs: {
          verified_output: lastOutput,
          validation_report: {
            passed: true,
            attempts,
            purpose,
            expected_pattern: expectedPattern,
            actual_output: lastOutput,
            reason: verification.reason,
          },
        },
        duration_ms: Date.now() - start,
      }
    }
    feedback = verification.reason || `输出未通过核验。期望匹配: ${expectedPattern || '(非空输出)'}`
  }

  return {
    outputs: {
      verified_output: lastOutput,
      validation_report: {
        passed: false,
        attempts: attempts - 1,
        purpose,
        expected_pattern: expectedPattern,
        actual_output: lastOutput,
      },
    },
    duration_ms: Date.now() - start,
    error: `核验失败，已重试 ${maxRetries} 次`,
  }
}

interface ChainStep {
  purpose?: string
  expected_pattern?: string
  task_input?: unknown
}

export async function executeAgenticChain(node: NodeInstance, inputs: Record<string, unknown>): Promise<ExecutionResult> {
  const start = Date.now()
  const chainSpec = inputs.chain_spec as { steps?: ChainStep[] } | ChainStep[] | undefined
  const steps: ChainStep[] = Array.isArray(chainSpec)
    ? chainSpec
    : chainSpec?.steps ?? Array.from({ length: Number(node.params.steps ?? 3) }, () => ({}))

  let currentInput = inputs.initial_input ?? inputs.task_input ?? ''
  const stepReports: object[] = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const unitNode: NodeInstance = {
      ...node,
      params: { ...node.params, max_retries: node.params.max_retries ?? 7 },
    }
    const result = await executeAgenticUnit(unitNode, {
      task_input: step.task_input ?? currentInput,
      purpose: step.purpose ?? `链步骤 ${i + 1}/${steps.length}`,
      expected_pattern: step.expected_pattern ?? '',
    })
    stepReports.push(result.outputs.validation_report as object)

    if (result.error) {
      const failStrategy = (node.params.fail_strategy as string) || 'abort'
      if (failStrategy === 'abort') {
        return {
          outputs: { final_output: result.outputs.verified_output, chain_report: { steps: stepReports, failed_at: i } },
          duration_ms: Date.now() - start,
          error: result.error,
        }
      }
      if (failStrategy === 'restart_chain') {
        i = -1
        currentInput = inputs.initial_input ?? inputs.task_input ?? ''
        stepReports.length = 0
        continue
      }
      // retry_step: continue with last output
    }
    currentInput = String(result.outputs.verified_output ?? '')
  }

  return {
    outputs: {
      final_output: currentInput,
      chain_report: { steps: stepReports, passed: true },
    },
    duration_ms: Date.now() - start,
  }
}
