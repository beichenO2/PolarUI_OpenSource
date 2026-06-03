#!/usr/bin/env node
/**
 * polaris.json feature → node-defs 覆盖率审计（严格：须 100%）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const PROJECT_MAP = {
  AutoOffice: 'autooffice',
  Clock: 'clock',
  digist: 'digist',
  KnowLever: 'knowlever',
  PolarDesign: 'polar-design',
  PolarMemory: 'polar-memory',
  PolarPort: 'polar-port',
  PolarProcess: 'polar-process',
  tqsdk: 'tqsdk',
}

const ZH_HINTS = {
  摄入: ['ingest'],
  编译: ['compile'],
  检索: ['search'],
  搜索: ['search'],
  向量: ['search'],
  构建: ['build'],
  导出: ['export', 'pdf'],
  番茄: ['timer', 'pomodoro', 'clock'],
  任务: ['task'],
  日程: ['schedule'],
  习惯: ['habit'],
  统计: ['stats'],
  模板: ['template'],
  渲染: ['render', 'content'],
  质量: ['quality'],
  设计: ['design'],
  回测: ['backtest', 'tq'],
  策略: ['strategy', 'tq'],
  风控: ['risk', 'tq'],
  采集: ['collect', 'scrape', 'digest', 'crawl'],
  消化: ['digest', 'fuse', 'summarize'],
  记忆: ['memory'],
  端口: ['port'],
  进程: ['process'],
  守护: ['watchdog', 'process'],
  检修: ['checkup'],
}

function loadNodes() {
  const byProject = {}
  const allNames = []
  const dir = path.join(ROOT, 'node-defs')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    byProject[f.replace('.json', '')] = arr
    for (const n of arr) {
      allNames.push(n.class_type.toLowerCase())
      allNames.push((n.display_name ?? '').toLowerCase())
      allNames.push((n.description ?? '').toLowerCase())
    }
  }
  return { byProject, allNames }
}

function tokenize(s) {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}

function projectCorpus(nodes) {
  const parts = []
  for (const n of nodes ?? []) {
    parts.push(n.class_type, n.display_name ?? '', n.description ?? '')
  }
  return parts.join(' ').toLowerCase()
}

function featureCovered(name, corpus, globalNames) {
  const tokens = tokenize(name)
  if (!tokens.length) return false
  const expanded = [...tokens]
  for (const t of tokens) {
    for (const [zh, hints] of Object.entries(ZH_HINTS)) {
      if (name.includes(zh)) expanded.push(...hints)
    }
  }
  const hay = `${corpus} ${globalNames.join(' ')}`
  if (hay.includes(name.toLowerCase())) return true
  const hit = expanded.filter((t) => t.length >= 2 && hay.includes(t)).length
  return hit >= Math.min(2, tokens.length) || expanded.some((t) => t.length >= 4 && hay.includes(t))
}

function collectFeatures(projectDir) {
  const pjPath = path.join(ROOT, projectDir, 'polaris.json')
  if (!fs.existsSync(pjPath)) return []
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
  const out = []
  for (const req of pj.requirements ?? []) {
    for (const f of req.features ?? []) {
      if (f.status === 'done' || f.status === 'in_progress') {
        out.push({ name: f.name, status: f.status, req: req.id ?? req.name })
      }
    }
  }
  return out
}

const { byProject, allNames } = loadNodes()
const MIN_COVERAGE = Number(process.env.ECOLOGY_COVERAGE_MIN ?? 100)

console.log('--- Ecology feature → node-defs coverage (100% gate) ---\n')

let failed = 0
const gaps = []

for (const [proj, ndKey] of Object.entries(PROJECT_MAP)) {
  const features = collectFeatures(proj)
  if (!features.length) continue
  const corpus = projectCorpus(byProject[ndKey])
  const uncovered = []
  for (const f of features) {
    if (!featureCovered(f.name, corpus, allNames)) uncovered.push(f.name)
  }
  const pct = Math.round(((features.length - uncovered.length) / features.length) * 100)
  const nodeCount = byProject[ndKey]?.length ?? 0
  const line = `${proj}: ${pct}% (${features.length - uncovered.length}/${features.length}) nodes=${nodeCount}`
  if (pct < MIN_COVERAGE) {
    console.error('FAIL:', line)
    for (const u of uncovered) console.error(`  - ${u}`)
    gaps.push({ proj, uncovered, pct })
    failed++
  } else console.log('OK:', line)
}

if (failed) {
  console.error(`\n${failed} project(s) below ${MIN_COVERAGE}% — 须补 node-defs 或修正 polaris feature 定义`)
  const reportPath = path.join(ROOT, 'PolarUI/scripts/coverage-gaps.json')
  fs.writeFileSync(reportPath, JSON.stringify(gaps, null, 2))
  console.error(`Wrote ${reportPath}`)
}

process.exit(failed ? 1 : 0)
