#!/usr/bin/env node
/**
 * 260519 任务书端到端集成验证
 */
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let failed = 0
function fail(m) { console.error('FAIL:', m); failed++ }
function ok(m) { console.log('OK:', m) }

// 1. node-defs 树状索引
const idx = JSON.parse(fs.readFileSync(path.join(root, 'node-defs/index.json'), 'utf8'))
if (idx.version !== 2 || idx.files.length < 10) fail('node-defs index v2')
else ok(`node-defs v2: ${idx.files.length} files`)

let nodeCount = 0
for (const f of idx.files) {
  const arr = JSON.parse(fs.readFileSync(path.join(root, 'PolarUI', 'node-defs', f), 'utf8'))
  nodeCount += arr.length
}
if (nodeCount < 120) fail(`node count ${nodeCount} < 120`)
else ok(`node-defs total: ${nodeCount} components`)

// 2. 协议规则 9 个
const protocols = fs.readdirSync(path.join(root, 'Agent_core/rules/protocols')).filter(f => f.endsWith('.md'))
if (protocols.length < 9) fail(`protocols ${protocols.length} < 9`)
else ok(`Agent_core protocols: ${protocols.length}`)

// 3. mdc 派生
const mdc = fs.readdirSync(path.join(root, '.cursor/rules')).filter(f => f.startsWith('polarisor-'))
if (mdc.length < 8) fail(`mdc files ${mdc.length} < 8`)
else ok(`cursor mdc derived: ${mdc.length}`)

// 4. polaris.json 合法
try {
  JSON.parse(fs.readFileSync(path.join(root, 'PolarUI/polaris.json'), 'utf8'))
  ok('PolarUI polaris.json valid JSON')
} catch (e) {
  fail(`polaris.json invalid: ${e.message}`)
}

// 5. 关键引擎文件
for (const f of [
  'PolarUI/src/engine/executor.ts',
  'PolarUI/src/engine/agentic-executor.ts',
  'PolarUI/src/engine/meta-executor.ts',
  'PolarUI/src/engine/custom-workflows.ts',
  'PolarUI/src/engine/custom-agents.ts',
  'PolarUI/src/engine/ecosystem-architecture.ts',
  'PolarUI/src/components/EcosystemArchitecture.vue',
  'PolarProcess/src/watchdog.ts',
  'PolarCopilot/hub/src/alerts/router.ts',
]) {
  if (!fs.existsSync(path.join(root, f))) fail(`missing ${f}`)
  else ok(`exists ${path.basename(f)}`)
}

// 6. workflows 无 ReportGenerator
let rg = 0
for (const wf of fs.readdirSync(path.join(root, 'PolarUI/workflows')).filter(f => f.endsWith('.json') && f !== 'registry.json')) {
  if (fs.readFileSync(path.join(root, 'PolarUI/workflows', wf), 'utf8').includes('ReportGenerator')) rg++
}
if (rg) fail(`${rg} workflows still reference ReportGenerator`)
else ok('workflows ReportGenerator-free')

// 7. GLOSSARY §3 行数
const gloss = fs.readFileSync(path.join(root, 'Agent_core/reference/GLOSSARY.md'), 'utf8')
const s3rows = (gloss.match(/^\| [^|]/gm) || []).filter(l => gloss.indexOf('§3') < gloss.indexOf(l) && gloss.indexOf('§4') > gloss.indexOf(l))
if (s3rows.length < 40) fail(`GLOSSARY §3 rows ~${s3rows.length} < 40`)
else ok(`GLOSSARY §3: ${s3rows.length} entries`)

// 7. executor 无占位 stub
const execSrc = fs.readFileSync(path.join(root, 'PolarUI/src/engine/executor.ts'), 'utf8')
if (/WebSearch 占位/.test(execSrc)) fail('WebSearch still placeholder')
else ok('WebSearch uses DIGiST API')
if (/replace\(\/\\b\(In conclusion/.test(execSrc)) fail('DeAiFlavor still regex stub')
else ok('DeAiFlavor uses AutoOffice /api/quality')

// 7b. 运行时规则注入 CLI
try {
  const out = execSync('node Agent_core/scripts/inject-rules.mjs "git commit 完成"', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (!out.includes('协议：Git')) fail('inject-rules did not match git protocol')
  else ok('inject-rules CLI runtime')
} catch (e) {
  fail(`inject-rules CLI: ${e.message}`)
}

if (!fs.existsSync(path.join(root, 'Agent_core/rules/engine/runtime-inject.mjs'))) {
  fail('missing runtime-inject.mjs')
} else ok('runtime-inject.mjs present')

try {
  const skillOut = execSync('node Agent_core/scripts/inject-rules.mjs --skill pc-solo-web', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (!skillOut.includes('PolarCopilot Solo Web')) fail('skill invoke pc-solo-web failed')
  else ok('skill explicit invoke CLI')
} catch (e) {
  fail(`skill invoke: ${e.message}`)
}

// 8. Agentic pipeline 校验（子进程）
try {
  execSync('node scripts/validate-agentic-pipelines.mjs', { cwd: path.join(root, 'PolarUI'), stdio: 'pipe' })
  ok('validate-agentic-pipelines pass')
} catch {
  fail('validate-agentic-pipelines failed')
}

console.log(`\n--- E2E integration: ${failed ? failed + ' failures' : 'ALL PASS'} ---`)
process.exit(failed ? 1 : 0)
