const DEFAULT_BASE = 'http://127.0.0.1:11055'

export interface ServiceInfo {
  id?: string
  name?: string
  status?: string
  health_endpoint?: string
  [key: string]: unknown
}

export interface WatchdogStatus {
  running?: boolean
  targets?: {
    name: string
    status: 'healthy' | 'unhealthy' | 'restarting' | 'crash_loop'
    failures?: number
    lastCheck?: string | null
  }[]
}

export async function fetchServices(base = DEFAULT_BASE): Promise<ServiceInfo[]> {
  const res = await fetch(`${base}/api/services`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`services ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

export async function fetchWatchdogStatus(base = DEFAULT_BASE): Promise<WatchdogStatus> {
  const res = await fetch(`${base}/api/watchdog/status`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`watchdog ${res.status}`)
  const data = await res.json()
  if (Array.isArray(data)) {
    return {
      running: true,
      targets: data.map((t: { name: string; status?: string }) => ({
        name: t.name,
        status: (t.status ?? 'unknown') as 'healthy' | 'unhealthy' | 'restarting' | 'crash_loop',
      })),
    }
  }
  return data as WatchdogStatus
}
