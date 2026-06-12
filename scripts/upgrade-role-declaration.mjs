#!/usr/bin/env node
/** 升级 agentic.json role_declaration 为结构化对象字段 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../node-defs/agentic.json')
const defs = JSON.parse(fs.readFileSync(file, 'utf8'))

const structured = {
  type: 'object',
  label: '角色声明',
  fields: {
    role: { type: 'select', options: ['master', 'slave', 'peer'], default: 'slave', label: '角色' },
    responsibility: { type: 'text', default: '', label: '职责' },
    constraints: { type: 'text', default: '', label: '约束' },
    consumers: { type: 'text', default: '', label: '消费者' },
  },
}

for (const d of defs) {
  if (!d.category?.startsWith('Agentic')) continue
  if (!d.params) d.params = {}
  d.params.role_declaration = structured
  if (typeof d.params.role_declaration === 'string') {
    d.params._legacy_role_text = d.params.role_declaration
  }
}

fs.writeFileSync(file, JSON.stringify(defs, null, 2) + '\n')
console.log('structured role_declaration on', defs.filter(d => d.category?.startsWith('Agentic')).length, 'nodes')
