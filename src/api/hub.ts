import type { Workflow, ExecutionState } from '@/engine/types'

class HubAPI {
  private baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || ''
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url
  }

  async getAgents(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/api/ui/agents`)
    return res.json()
  }

  async getPrompts(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/api/ui/prompts`)
    return res.json()
  }

  async submitWorkflow(workflow: Record<string, unknown>): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/api/ui/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'polar-ui',
        prompt: `## 工作流执行请求\n\n\`\`\`json\n${JSON.stringify(workflow, null, 2)}\n\`\`\``,
        options: ['执行完成', '执行出错，查看详情'],
      }),
    })
    return res.json()
  }

  async getSSoT(project: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/polaris/${project}`)
    return res.json()
  }

  async getServices(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/api/ui/services`)
    return res.json()
  }

  async getAlerts(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/api/ui/alerts`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : (data as { alerts?: unknown[] }).alerts ?? []
  }

  connectSSE(onEvent: (event: { type: string; data: unknown }) => void): EventSource {
    const es = new EventSource(`${this.baseUrl}/api/ui/stream`)
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        onEvent({ type: e.type || 'message', data })
      } catch { /* ignore parse errors */ }
    }
    es.onerror = () => {
      console.warn('[PolarUI] SSE connection error, will auto-reconnect')
    }
    return es
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ui/agents`, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  }
}

export const hubApi = new HubAPI()
