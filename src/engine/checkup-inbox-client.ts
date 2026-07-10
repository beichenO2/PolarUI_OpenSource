/** @checkup-agent inbox — poll + SSE client for PolarUI CheckupEventInbox */

import { hubApiBase } from './hub-url'

export const CHECKUP_AGENT_ID = '@checkup-agent'
export const CHECKUP_INBOX_TOPIC = '@checkup-agent.inbox'

function hubBase(): string {
  return hubApiBase()
}

export async function fetchLatestCheckupEvent(): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${hubBase()}/api/ui/events?agent_id=${encodeURIComponent(CHECKUP_AGENT_ID)}&limit=10`,
    { signal: AbortSignal.timeout(8000) },
  )
  if (!res.ok) return null
  const rows = (await res.json()) as Array<{ topic?: string; payload?: { type?: string; event?: Record<string, unknown> } }>
  for (const row of rows) {
    if (row.topic === CHECKUP_INBOX_TOPIC && row.payload?.type === 'checkup_event' && row.payload.event) {
      return row.payload.event
    }
  }
  return null
}

export function subscribeCheckupSse(onEvent: (event: Record<string, unknown>) => void): () => void {
  const es = new EventSource(`${hubBase()}/api/ui/checkup/stream`)
  es.addEventListener('checkup_event', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as { event?: Record<string, unknown> }
      if (data.event) onEvent(data.event)
    } catch { /* ignore */ }
  })
  es.onerror = () => { /* EventSource auto-reconnects */ }
  return () => es.close()
}

/** Wait for next checkup event via SSE (preferred) with poll fallback */
export async function waitForCheckupEvent(timeoutMs = 8000): Promise<Record<string, unknown> | null> {
  const existing = await fetchLatestCheckupEvent()
  if (existing) return existing

  return new Promise((resolve) => {
    let done = false
    const finish = (ev: Record<string, unknown> | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      unsub()
      resolve(ev)
    }
    const unsub = subscribeCheckupSse((ev) => finish(ev))
    const poll = setInterval(() => {
      void fetchLatestCheckupEvent().then((ev) => { if (ev) finish(ev) })
    }, 2000)
    const timer = setTimeout(() => finish(null), timeoutMs)
  })
}
