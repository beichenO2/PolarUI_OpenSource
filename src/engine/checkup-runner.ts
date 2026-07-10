/**
 * @checkup-agent inbox 守护：SSE 收到事件后自动跑 CheckupTriageAndHeal pipeline
 */
import { subscribeCheckupSse } from './checkup-inbox-client'
import { executeInternalWorkflow } from './pipeline-executor'
import { registry } from './registry'
import type { NodeInstance } from './types'

const processed = new Set<string>()

export type CheckupRunRecord = {
  event_id: string
  started_at: string
  finished_at?: string
  ok: boolean
  error?: string
}

const runs: CheckupRunRecord[] = []

export function getCheckupRunHistory(): CheckupRunRecord[] {
  return [...runs]
}

async function runCheckupPipeline(event: Record<string, unknown>): Promise<void> {
  const def = registry.get('CheckupTriageAndHeal')
  const wf = def?.internal_workflow
  if (!wf) return

  const eventId = String(event.event_id ?? '')
  const node: NodeInstance = {
    id: 'checkup-daemon',
    class_type: 'CheckupTriageAndHeal',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    params: {},
  }
  const rec: CheckupRunRecord = {
    event_id: eventId,
    started_at: new Date().toISOString(),
    ok: false,
  }
  runs.unshift(rec)
  if (runs.length > 50) runs.length = 50

  const result = await executeInternalWorkflow(wf, node, { event })
  rec.finished_at = new Date().toISOString()
  rec.ok = !result.error
  rec.error = result.error
}

export function startCheckupDaemon(): () => void {
  return subscribeCheckupSse((event) => {
    const id = String(event.event_id ?? '')
    if (!id || processed.has(id)) return
    processed.add(id)
    void runCheckupPipeline(event)
  })
}
