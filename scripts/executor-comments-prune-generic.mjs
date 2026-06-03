#!/usr/bin/env node
/** 去掉无信息量的「xxx：Class业务中间量 / Class：条件分支」类行尾注释 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const p = join(__dir, '../src/engine/executor.ts')
let t = readFileSync(p, 'utf8')
let n = 0
t = t.replace(/\s+\/\/ [^:\n]+：\w+业务中间量/g, () => { n++; return '' })
t = t.replace(/\s+\/\/ \w+：条件分支/g, () => { n++; return '' })
t = t.replace(/\s+\/\/ fetch 响应，后续根据 ok\/status 分支/g, () => { n++; return '' })
writeFileSync(p, t)
console.log('pruned generic suffix comments:', n)
