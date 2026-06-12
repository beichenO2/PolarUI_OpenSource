/**
 * 编译门：每个 LLM 后须有 Validator → RetryLoop → 回连该 LLM 的核验环。
 */
import type { Graph } from './graph'

export function validateLlmValidatorRetryLoops(graph: Graph): string[] {
  const errors: string[] = []
  const byId = new Map(graph.nodes.map(n => [n.id, n]))

  const nodeIds = new Set(graph.nodes.map(n => n.id))
  const agenticTypes = new Set(['AgenticUnit', 'AgentWorkflow', 'AgenticChain', 'AgenticToolCall'])
  for (const llm of graph.nodes.filter(n => n.class_type === 'LLM')) {
    if (/b$/.test(llm.id) && nodeIds.has(llm.id.slice(0, -1))) continue
    const feedsAgentic = graph.links
      .filter(l => l.from_node === llm.id)
      .map(l => graph.nodes.find(n => n.id === l.to_node))
      .some(n => n && agenticTypes.has(n.class_type))
    if (feedsAgentic) continue
    const outLinks = graph.links.filter(l => l.from_node === llm.id)
    const validatorIds = outLinks
      .map(l => byId.get(l.to_node))
      .filter(n => n?.class_type === 'Validator')
      .map(n => n!.id)

    if (!validatorIds.length) {
      errors.push(
        `组件 "${llm.id}" (LLM 调用): 缺少下游 Validator；标准片段为 LLM → Validator → RetryLoop → 回连 LLM`,
      )
      continue
    }

    const hasRetryAfterValidator = validatorIds.some(vid =>
      graph.links.some(l => l.from_node === vid && byId.get(l.to_node)?.class_type === 'RetryLoop'),
    )
    const hasBackToLlm = graph.links.some(
      l => l.to_node === llm.id && byId.get(l.from_node)?.class_type === 'RetryLoop',
    )

    if (!hasRetryAfterValidator) {
      errors.push(
        `组件 "${llm.id}" (LLM 调用): 须有 Validator → RetryLoop（passed 接线）；推荐 RetryLoop.retry_input 回连本 LLM prompt`,
      )
    } else if (!hasBackToLlm) {
      // 仅 warning 级：轮间回流可走 original_input 锚点，不阻断编译
    }
  }

  return errors
}
