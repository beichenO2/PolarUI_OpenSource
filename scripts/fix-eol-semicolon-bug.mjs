#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
for (const rel of ['src/engine/executor.ts', 'src/engine/pipeline-executor.ts']) {
  const p = join(__dir, '..', rel)
  let t = readFileSync(p, 'utf8')
  const before = (t.match(/\uFF1B/g) || []).length
  t = t.replace(/([)\}'\d])\uFF1B(?=[\u4e00-\u9fffA-Za-z_*])/g, '$1  // ')
  t = t.replace(/\{\uFF1B(?=[A-Za-z_])/g, '{  // ')
  writeFileSync(p, t)
  const after = (t.match(/\uFF1B/g) || []).length
  console.log(rel, 'fullwidth-semicolon', before, '->', after)
}
