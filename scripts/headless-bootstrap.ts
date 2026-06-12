/**
 * Headless engine bootstrap — load node-defs + register executors for CLI smoke tests.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registry } from '../src/engine/registry.ts'
import type { NodeDef } from '../src/engine/types.ts'

const ECOSYSTEM_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
process.env.POLARISOR_ROOT = process.env.POLARISOR_ROOT ?? ECOSYSTEM_ROOT
const PROMPTS = join(ECOSYSTEM_ROOT, 'PolarUI/prompts')

function injectModeFrames(): void {
  const g = globalThis as Record<string, string>
  g.__POLARUI_WF_FRAME__ = readFileSync(join(PROMPTS, 'mode-wf-system.txt'), 'utf8').trim()
  g.__POLARUI_LG_FRAME__ = readFileSync(join(PROMPTS, 'mode-lg-system.txt'), 'utf8').trim()
}

injectModeFrames()

import '../src/engine/executor.ts'

export function bootstrapHeadlessEngine(nodeDefsDir = join(ECOSYSTEM_ROOT, 'PolarUI', 'node-defs')): number {
  const indexPath = join(nodeDefsDir, 'index.json')
  if (!existsSync(indexPath)) {
    throw new Error(`node-defs index not found: ${indexPath}`)
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as { files: string[] }
  let loaded = 0
  for (const file of index.files) {
    const path = join(nodeDefsDir, file)
    if (!existsSync(path)) continue
    for (const def of JSON.parse(readFileSync(path, 'utf-8')) as NodeDef[]) {
      if (!def.class_type) continue
      registry.register(def)
      loaded++
    }
  }
  return loaded
}
