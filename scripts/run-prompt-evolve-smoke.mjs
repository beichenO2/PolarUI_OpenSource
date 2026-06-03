#!/usr/bin/env node
/** PromptEvolve + PromptInject memory_blocks + ExperienceCapture auto_apply（00 §3.4 用户定调） */
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeNode } from '../src/engine/executor.ts'
import {
  PROMPT_EVOLVE_AUTO_APPLY_PATH,
  PROMPT_EVOLVE_LATEST_PATH,
} from '../src/engine/prompt-evolve-utils.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ECOSYSTEM = join(ROOT, '..')

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

const ctx = {
  getNodeOutput: () => undefined,
  allResults: new Map(),
  links: [],
  runTrace: { loop_traces: [] },
}

// 1. LearningCapture → PromptEvolve 闭环
const lc = await executeNode(
  {
    id: 'lc1',
    class_type: 'LearningCapture',
    x: 0, y: 0, width: 200, height: 80,
    params: {
      endpoint: '',
      fallback_path: 'PolarUI/.data/test-learning-captures.jsonl',
      decision: { action: 'tool', target: 'digist' },
      result: { ok: true },
    },
  },
  ctx,
)

if (!lc.outputs?.capture_id) fail('LearningCapture missing capture_id')
else ok(`LearningCapture ${lc.outputs.capture_id}`)

if (!lc.outputs?.polarclaw_wake) fail('LearningCapture polarclaw_wake not set')
else ok('LearningCapture wake_self_learning → learning-capture.last.json')

const pe = await executeNode(
  {
    id: 'pe1',
    class_type: 'PromptEvolve',
    x: 0, y: 0, width: 200, height: 80,
    params: {
      target: 'prompt_inject',
      read_auto_apply: false,
      capture: lc.outputs?.capture,
    },
  },
  ctx,
)

const pk = String(pe.outputs?.prior_knowledge ?? '')
if (!pk.includes('digist')) fail('PromptEvolve did not distill decision')
else ok('PromptEvolve distills LearningCapture → prior_knowledge')

const latestPath = join(ECOSYSTEM, PROMPT_EVOLVE_LATEST_PATH)
if (!existsSync(latestPath)) fail(`missing ${PROMPT_EVOLVE_LATEST_PATH}`)
else ok('PromptEvolve wrote latest.md')

// 2. PromptInject ← MemorySearch.blocks
const pi = await executeNode(
  {
    id: 'pi1',
    class_type: 'PromptInject',
    x: 0, y: 0, width: 200, height: 80,
    params: {
      role: '助手',
      use_trigger_engine: false,
      memory_blocks: {
        blocks: [{ title: '偏好', content: '用户偏好 RetryLoop 默认 7 轮' }],
      },
    },
  },
  ctx,
)

const sp = String(pi.outputs?.system_prompt ?? '')
if (!sp.includes('RetryLoop') || !sp.includes('7')) fail('PromptInject missing memory_blocks content')
else ok('PromptInject merges MemorySearch.blocks')

// 3. ExperienceCapture auto_apply
const autoPath = join(ECOSYSTEM, PROMPT_EVOLVE_AUTO_APPLY_PATH)
try { unlinkSync(autoPath) } catch { /* absent */ }

const ec = await executeNode(
  {
    id: 'ec1',
    class_type: 'ExperienceCapture',
    x: 0, y: 0, width: 200, height: 80,
    params: {
      auto_apply: true,
      capture_mode: 'success_only',
      trigger_event: 'success',
      context: { lesson: 'cron tick passed' },
    },
  },
  ctx,
)

if (!ec.outputs?.auto_applied) fail('ExperienceCapture auto_apply not applied')
else ok('ExperienceCapture auto_apply writes file')

if (!existsSync(autoPath)) fail(`missing ${PROMPT_EVOLVE_AUTO_APPLY_PATH}`)
else {
  const body = readFileSync(autoPath, 'utf8')
  if (!body.includes('cron tick')) fail('auto-apply file missing context')
  else ok('auto-apply file contains distilled context')
}

// 4. ReflectiveContext — registry 扫描 + 记忆边界
const rc = await executeNode(
  {
    id: 'rc1',
    class_type: 'ReflectiveContext',
    x: 0, y: 0, width: 200, height: 80,
    params: { include_prompt_evolve: false },
  },
  ctx,
)

const manifest = rc.outputs?.component_manifest
if (!manifest?.count || manifest.count < 50) fail(`ReflectiveContext manifest too small: ${manifest?.count}`)
else ok(`ReflectiveContext manifest ${manifest.count} nodes`)

const cstr = rc.outputs?.constraints
if (!cstr?.memory_boundary?.layout_memory) fail('ReflectiveContext missing memory_boundary')
else ok('ReflectiveContext memory_boundary (禁止混写)')

const rcSp = String(rc.outputs?.system_prompt ?? '')
if (!rcSp.includes('RetryLoop') || !rcSp.includes('7')) fail('ReflectiveContext missing RetryLoop 定稿')
else ok('ReflectiveContext system_prompt')

console.log(`\n--- prompt-evolve smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
