/**
 * PolarClaw HTTP client — shared by SSoT actions and Planner (runPolarClaw).
 */

export async function findPolarClawUrl(): Promise<string> {
  const candidates = ['http://localhost:3910', 'http://localhost:4800', 'http://localhost:4810']
  for (const url of candidates) {
    try {
      const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return url
    } catch { /* try next */ }
  }
  try {
    const portRes = await fetch('/api/ports', { signal: AbortSignal.timeout(2000) })
    if (portRes.ok) {
      const ports = (await portRes.json()) as Array<{ port: number; service?: string; project?: string }>
      const claw = ports.find(p =>
        (p.service || '').toLowerCase().includes('polarclaw') ||
        (p.project || '').toLowerCase().includes('polarclaw')
      )
      if (claw) return `http://localhost:${claw.port}`
    }
  } catch { /* fallback */ }
  return 'http://localhost:4800'
}

export async function callPolarClawAgent(
  url: string,
  message: string,
  conversationId?: string,
): Promise<string> {
  const res = await fetch(`${url}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      conversation_id: conversationId || `polarui-${Date.now()}`,
    }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) {
    throw new Error(`PolarClaw returned ${res.status}: ${await res.text()}`)
  }
  const data = await res.json() as { content?: string; reply?: string }
  return data.content || data.reply || ''
}

export function extractWorkflowJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { workflow?: Record<string, unknown> }
      if (parsed.workflow && typeof parsed.workflow === 'object') return parsed.workflow
      return parsed as Record<string, unknown>
    } catch { /* not valid */ }
  }
  const codeBlock = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlock) {
    try {
      const parsed = JSON.parse(codeBlock[1]) as { workflow?: Record<string, unknown> }
      if (parsed.workflow && typeof parsed.workflow === 'object') return parsed.workflow
      return parsed as Record<string, unknown>
    } catch { /* not valid */ }
  }
  return null
}
