/**
 * SSoT Actions — execution logic for "Up to date" and "Execute pending"
 * Both actions delegate to PolarClaw Agent via /api/agent/chat
 */

interface FeatureStatusResult {
  req_id: string
  name: string
  status: 'done' | 'in_progress' | 'planned' | 'blocked'
  test_status: 'passed' | 'failed' | 'not_tested' | 'pending'
  reason: string
}

interface UpToDateResult {
  features: FeatureStatusResult[]
  error?: string
}

interface ExecPendingResult {
  executed: { name: string; status: string; commit_hash?: string }[]
  error?: string
}

export interface SsotActionCallbacks {
  onProgress?: (msg: string) => void
  onFeatureUpdated?: (reqId: string, featureName: string, status: string) => void
  onComplete?: () => void
  onError?: (err: string) => void
}

async function findPolarClawUrl(): Promise<string> {
  const candidates = ['http://localhost:4800', 'http://localhost:4810']
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

async function callPolarClaw(url: string, message: string, conversationId?: string): Promise<string> {
  const res = await fetch(`${url}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      conversation_id: conversationId || `polarui-ssot-${Date.now()}`,
    }),
  })
  if (!res.ok) {
    throw new Error(`PolarClaw returned ${res.status}: ${await res.text()}`)
  }
  const data = await res.json() as { content?: string; reply?: string }
  return data.content || data.reply || ''
}

function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch { /* not valid */ }
  }
  const codeBlock = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]) } catch { /* not valid */ }
  }
  return null
}

export async function runUpToDate(
  projectName: string,
  callbacks?: SsotActionCallbacks,
): Promise<UpToDateResult> {
  callbacks?.onProgress?.('正在连接 PolarClaw...')
  const clawUrl = await findPolarClawUrl()

  callbacks?.onProgress?.(`正在检查 ${projectName} 的功能状态...`)

  const prompt = `检查项目 "${projectName}" 的所有 feature 实际完成状态。

请执行以下步骤：
1. 读取 ~/Polarisor/${projectName}/polaris.json 获取需求和功能列表
2. 对每个 feature，检查项目源代码中是否存在对应实现
3. 如果有测试文件，查看测试是否通过
4. 查看 Git log 确认最近的相关改动

最终返回纯 JSON（不要有其他内容）：
{"features": [{"req_id": "R1", "name": "功能名", "status": "done|in_progress|planned|blocked", "test_status": "passed|failed|not_tested|pending", "reason": "30字以内的判断依据"}]}`

  try {
    const reply = await callPolarClaw(clawUrl, prompt)
    const parsed = extractJson(reply) as { features?: FeatureStatusResult[] } | null

    if (!parsed?.features) {
      callbacks?.onError?.('PolarClaw 返回格式异常，无法解析')
      return { features: [], error: 'parse_error' }
    }

    callbacks?.onProgress?.(`获取到 ${parsed.features.length} 个功能状态，正在更新 polaris.json...`)

    const patchBody = {
      requirements: parsed.features.reduce((acc, f) => {
        let reqGroup = acc.find(r => r.id === f.req_id)
        if (!reqGroup) {
          reqGroup = { id: f.req_id, features: [] }
          acc.push(reqGroup)
        }
        reqGroup.features.push({ name: f.name, status: f.status, test_status: f.test_status })
        return acc
      }, [] as Array<{ id: string; features: Array<{ name: string; status: string; test_status: string }> }>),
    }

    await fetch(`/api/polaris/${encodeURIComponent(projectName)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    })

    for (const f of parsed.features) {
      callbacks?.onFeatureUpdated?.(f.req_id, f.name, f.status)
    }

    callbacks?.onComplete?.()
    return { features: parsed.features }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    callbacks?.onError?.(msg)
    return { features: [], error: msg }
  }
}

export async function runExecutePending(
  projectName: string,
  ssotData: Record<string, unknown>,
  callbacks?: SsotActionCallbacks,
): Promise<ExecPendingResult> {
  callbacks?.onProgress?.('正在连接 PolarClaw...')
  const clawUrl = await findPolarClawUrl()

  const requirements = (ssotData.requirements || []) as Array<{
    id: string; need?: string; name?: string; approach?: string
    features?: Array<{ name: string; status: string }>
  }>

  const pendingTasks: Array<{ reqId: string; need: string; approach: string; featureName: string }> = []
  for (const req of requirements) {
    const need = req.need || req.name || ''
    for (const feat of req.features || []) {
      if (feat.status !== 'done') {
        pendingTasks.push({
          reqId: req.id,
          need,
          approach: req.approach || '',
          featureName: feat.name,
        })
      }
    }
  }

  if (pendingTasks.length === 0) {
    callbacks?.onProgress?.('所有功能均已完成！')
    callbacks?.onComplete?.()
    return { executed: [] }
  }

  callbacks?.onProgress?.(`共 ${pendingTasks.length} 项待执行`)
  const results: ExecPendingResult['executed'] = []

  for (let i = 0; i < pendingTasks.length; i++) {
    const task = pendingTasks[i]
    callbacks?.onProgress?.(`[${i + 1}/${pendingTasks.length}] 执行: ${task.featureName}`)

    const prompt = `实现项目 "${projectName}" 的功能 "${task.featureName}"。

所属需求 (${task.reqId}): ${task.need}
实现方案: ${task.approach}

请执行：
1. 分析项目 ~/Polarisor/${projectName}/ 的代码结构
2. 编写/修改代码实现该功能
3. 如有测试框架，编写对应测试
4. 运行测试确认通过
5. Git commit 改动
6. 更新 ~/Polarisor/${projectName}/polaris.json 中该 feature 的 status 为 done

完成后返回纯 JSON: {"status": "done", "files_changed": ["path1", "path2"], "commit_hash": "abc1234"}`

    try {
      const reply = await callPolarClaw(clawUrl, prompt, `polarui-exec-${projectName}-${i}`)
      const parsed = extractJson(reply) as { status?: string; commit_hash?: string } | null

      results.push({
        name: task.featureName,
        status: parsed?.status || 'unknown',
        commit_hash: parsed?.commit_hash,
      })

      callbacks?.onFeatureUpdated?.(task.reqId, task.featureName, parsed?.status || 'done')
    } catch (err) {
      results.push({ name: task.featureName, status: 'error' })
      callbacks?.onProgress?.(`  ⚠️ ${task.featureName} 执行失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  callbacks?.onComplete?.()
  return { executed: results }
}
