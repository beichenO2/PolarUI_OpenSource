#!/usr/bin/env node
/** 为 agentic.json 中所有 Agentic 类节点添加 role_declaration 参数 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../node-defs/agentic.json')
const defs = JSON.parse(fs.readFileSync(file, 'utf8'))
const decl = {
  role_declaration: {
    type: 'text',
    default: '',
    label: '角色声明（注入 system prompt）',
  },
}
let n = 0
for (const d of defs) {
  if (!d.category?.startsWith('Agentic')) continue
  if (!d.params) d.params = {}
  if (!d.params.role_declaration) {
    d.params = { ...decl, ...d.params }
    n++
  }
}
fs.writeFileSync(file, JSON.stringify(defs, null, 2) + '\n')
console.log('patched', n, 'agentic nodes')
