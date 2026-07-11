/**
 * 加载工作流 JSON — 内置 /workflows + 用户 custom/*
 */
import { loadWorkflowJson } from './loader'
import { getCustomWorkflow, isCustomWorkflowRef, customWorkflowIdFromRef } from './custom-workflows'
import type { Graph } from './graph'

async function loadWorkflowFromDisk(ref: string): Promise<Graph | null> {
  const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node)
  if (!isNode) return null
  try {
    const injected = (globalThis as {
      __POLARUI_NODE_FS__?: Pick<typeof import('node:fs'), 'readFileSync' | 'existsSync'>
    }).__POLARUI_NODE_FS__
    const { readFileSync, existsSync } = injected ?? await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const file = ref.endsWith('.json') ? ref : `${ref}.json`
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    // dist/workflows (GUI bundle) then source workflows/ (headless CLI, unregistered demos)
    const searchRoots = [
      join(moduleDir, '../../workflows'),
      join(moduleDir, '../../../workflows'),
    ]
    for (const wfDir of searchRoots) {
      const path = join(wfDir, file)
      if (existsSync(path)) return loadWorkflowJson(readFileSync(path, 'utf8'))
    }
    return null
  } catch {
    return null
  }
}

export async function loadWorkflowByRef(ref: string): Promise<Graph | null> {
  if (isCustomWorkflowRef(ref)) {
    const id = customWorkflowIdFromRef(ref)
    const rec = getCustomWorkflow(id)
    if (!rec) return null
    const { Graph: G } = await import('./graph')
    return G.fromWorkflow(rec.workflow)
  }

  const fromDisk = await loadWorkflowFromDisk(ref)
  if (fromDisk) return fromDisk

  try {
    const path = ref.endsWith('.json') ? `/workflows/${ref}` : `/workflows/${ref}.json`
    const res = await fetch(path, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    return loadWorkflowJson(await res.text())
  } catch {
    return loadWorkflowFromDisk(ref)
  }
}

export async function loadWorkflowJsonText(ref: string): Promise<string | null> {
  if (isCustomWorkflowRef(ref)) {
    const rec = getCustomWorkflow(customWorkflowIdFromRef(ref))
    if (!rec) return null
    return JSON.stringify(rec.workflow, null, 2)
  }
  const g = await loadWorkflowFromDisk(ref)
  if (g) return JSON.stringify(g.toApiFormat(), null, 2)
  try {
    const path = ref.endsWith('.json') ? `/workflows/${ref}` : `/workflows/${ref}.json`
    const res = await fetch(path, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}
