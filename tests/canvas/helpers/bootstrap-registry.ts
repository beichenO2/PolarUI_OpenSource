/**
 * Bootstrap node registry from node-defs/ for headless canvas tests.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registry } from '../../../src/engine/registry'
import type { NodeDef } from '../../../src/engine/types'

const NODE_DEFS = join(dirname(fileURLToPath(import.meta.url)), '../../../node-defs')

let bootstrapped = false

export function bootstrapRegistryForTests(): void {
  if (bootstrapped) return
  bootstrapped = true

  const index = JSON.parse(readFileSync(join(NODE_DEFS, 'index.json'), 'utf8')) as {
    version: number
    files: string[]
  }

  for (const file of index.files) {
    const defs = JSON.parse(readFileSync(join(NODE_DEFS, file), 'utf8')) as NodeDef[]
    for (const def of defs) {
      if (!registry.get(def.class_type)) {
        registry.register(def)
      }
    }
  }
}
