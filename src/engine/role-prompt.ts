/** 将 role_declaration 格式化为 LLM system prompt 片段 */
export function formatRoleDeclaration(rd: unknown): string {
  if (!rd) return ''
  if (typeof rd === 'string') return rd.trim()
  if (typeof rd === 'object' && rd !== null) {
    const o = rd as Record<string, string>
    const parts: string[] = []
    if (o.role) parts.push(`你的角色是 ${o.role}。`)
    if (o.responsibility) parts.push(`你的职责是 ${o.responsibility}。`)
    if (o.constraints) parts.push(`约束：${o.constraints}`)
    if (o.consumers) parts.push(`消费者：${o.consumers}`)
    return parts.join('\n')
  }
  return ''
}

export function defaultRoleDeclaration(): Record<string, string> {
  return { role: 'slave', responsibility: '', constraints: '', consumers: '' }
}
