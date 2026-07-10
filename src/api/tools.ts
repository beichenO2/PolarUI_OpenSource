/** Hub host-tool proxy — filesystem / shell / git for workflow executor */
import { hubApiBase } from '@/engine/hub-url'

async function postTool<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${hubApiBase()}/api/ui/tools/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const data = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) {
    throw new Error(String((data as { error?: string }).error ?? `tools/${endpoint} ${res.status}`))
  }
  return data
}

export async function hubFileRead(path: string, encoding = 'utf-8') {
  return postTool<{ content: string; metadata: { path: string; size: number } }>('file-read', { path, encoding })
}

export async function hubFileWrite(path: string, content: string, createDirs = true) {
  return postTool<{ success: boolean; path: string }>('file-write', { path, content, create_dirs: createDirs })
}

export async function hubShellExec(command: string, cwd = '.', timeoutS = 30) {
  return postTool<{ stdout: string; stderr: string; exit_code: number; success: boolean }>(
    'shell-exec',
    { command, cwd, timeout_s: timeoutS },
  )
}

export async function hubGitCommit(opts: {
  message: string
  files?: unknown
  push?: boolean
  branch?: string
  cwd?: string
}) {
  return postTool<{ commit_hash: string; commit_output: string; push_output: string; pushed: boolean }>(
    'git-commit',
    opts,
  )
}

export async function hubSessionSearch(query: string, limit = 10) {
  try {
    return await postTool<{ matches: Array<{ session_id: string; line: number; snippet: string }>; count: number }>(
      'session-search',
      { query, limit },
    )
  } catch {
    return { matches: [], count: 0 }
  }
}

export async function hubGlobSearch(pattern: string, cwd = '.') {
  try {
    return await postTool<{ files: string[]; count: number }>('glob-search', { pattern, cwd })
  } catch {
    return { files: [], count: 0 }
  }
}

export async function hubGrepSearch(pattern: string, path = '.', caseInsensitive = false) {
  try {
    return await postTool<{ matches: Array<{ file: string; line: number; text: string }>; count: number }>(
      'grep-search',
      { pattern, path, case_insensitive: caseInsensitive },
    )
  } catch {
    return { matches: [], count: 0 }
  }
}

export async function hubNotification(message: string, channel = 'desktop', title = 'PolarUI', webhookUrl?: string) {
  try {
    return await postTool<{ sent: boolean; channel: string }>('notification', {
      message,
      channel,
      title,
      webhook_url: webhookUrl,
    })
  } catch {
    return { sent: false, channel, stub: true }
  }
}

export async function hubOutputDisplay(content: unknown, format = 'auto', title = '工作流中间结果') {
  return postTool<{ displayed: boolean; alert_id: string }>('output-display', {
    content,
    format,
    title,
  })
}

export async function hubEcosystemScan() {
  return postTool<{ projects: unknown[]; ssot_map: Record<string, unknown>; count: number }>(
    'ecosystem-scan',
    {},
  )
}
