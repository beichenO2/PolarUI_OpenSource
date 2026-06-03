#!/usr/bin/env node
/**
 * SampleLoop smoke — 对齐 07 / 13 用户定稿：
 * 同输入独立 N 次选优 · 与 RetryLoop 反馈重跑正交（不是抽奖混写）
 */
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeNode } from '../src/engine/executor.ts'

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

const ctx = {
  getNodeOutput: () => undefined,
  allResults: new Map(),
  links: [],
  runTrace: { loop_traces: [] },
}

// 1. max_score 选优
const node = {
  id: 'sl1',
  class_type: 'SampleLoop',
  x: 0, y: 0, width: 200, height: 80,
  params: {
    n_samples: 3,
    selection: 'max_score',
    _attempt: 3,
    _collected_samples: ['a', 'b'],
    _collected_scores: [1, 2],
    sample: 'c',
    score: 5,
    original_input: 'seed',
  },
}

const r = await executeNode(node, ctx)
if (r.outputs?.selected !== 'c') fail(`selected ${r.outputs?.selected}`)
else ok('max_score picks c (score 5)')
if (!r.outputs?.exhausted) fail('not exhausted')
else ok('exhausted after N samples')

// 2. 轮间 retry_input 保持 original（独立采样，不携带上轮 output 当反馈）
const mid = await executeNode(
  {
    id: 'sl2',
    class_type: 'SampleLoop',
    x: 0, y: 0, width: 200, height: 80,
    params: {
      n_samples: 3,
      selection: 'last',
      _attempt: 1,
      original_input: 'BASE',
      sample: 'attempt-1-output',
      score: 1,
    },
  },
  { ...ctx, runTrace: { loop_traces: [] } },
)
if (mid.outputs?.retry_input !== 'BASE') fail(`SampleLoop retry_input should stay original, got ${JSON.stringify(mid.outputs?.retry_input)}`)
else ok('SampleLoop retry_input = original（非反馈重跑）')
if (mid.outputs?.should_sample !== true) fail('SampleLoop should emit should_sample not should_retry')
else ok('SampleLoop should_sample ≠ RetryLoop should_retry (07 正交)')

// 3. RetryLoop 对照：轮间仍 SSOT，但语义是 should_retry
const rl = await executeNode(
  {
    id: 'rl1',
    class_type: 'RetryLoop',
    x: 0, y: 0, width: 200, height: 80,
    params: { max_retries: 3, _attempt: 1, passed: false, original_input: 'BASE', retry_hint: 'fix lint' },
  },
  { ...ctx, runTrace: { loop_traces: [] } },
)
if (rl.outputs?.retry_input !== 'BASE') fail('RetryLoop retry_input must be SSOT only')
else ok('RetryLoop retry_input = SSOT (13 用户定稿)')
if (rl.outputs?.should_retry !== true) fail('RetryLoop missing should_retry')
else ok('RetryLoop should_retry (反馈重跑语义)')

console.log(`\n--- sample-loop smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
