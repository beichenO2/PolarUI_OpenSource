#!/usr/bin/env node
/** 13 / 16：intra_round_hint 轮内注入 LLM，retry_input 仍为 SSOT */
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeNode } from '../src/engine/executor.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

let capturedUser = ''
setLLMClient({
  async chat(_model, messages) {
    capturedUser = messages.find(m => m.role === 'user')?.content ?? ''
    return { content: 'ok', toolCalls: [], usage: {}, model: 'mock' }
  },
  async listModels() { return [] },
  async healthCheck() { return { ok: true, vault_unlocked: true } },
})

const ctx = {
  getNodeOutput: () => undefined,
  allResults: new Map(),
  links: [],
  workflowLibrary: 'WF',
  runTrace: { loop_traces: [] },
}

const llmNode = {
  id: 'llm1',
  class_type: 'LLM',
  x: 0, y: 0, width: 200, height: 80,
  inputs: {},
  params: {
    model: 'GLM-5.1',
    prompt: 'BASE TASK',
    intra_round_hint: 'fix JSON fence',
  },
}

const withHint = await executeNode(llmNode, ctx)
if (!withHint.outputs?.response) fail('LLM with hint failed')
else if (!capturedUser.includes('轮内修正提示') || !capturedUser.includes('fix JSON fence')) {
  fail(`intra_round_hint not injected: ${capturedUser.slice(0, 120)}`)
} else ok('LLM prompt includes intra_round_hint (轮内修正)')

const rl = await executeNode(
  {
    id: 'rl1',
    class_type: 'RetryLoop',
    x: 0, y: 0, width: 200, height: 80,
    inputs: {},
    params: {
      max_retries: 7,
      _attempt: 1,
      passed: false,
      retry_hint: 'regex mismatch',
      original_input: 'USER SSOT',
    },
  },
  ctx,
)
if (rl.outputs?.retry_input !== 'USER SSOT') fail('retry_input must stay SSOT')
else ok('RetryLoop retry_input = original_input only')
if (rl.outputs?.intra_round_hint !== 'regex mismatch') fail('intra_round_hint not echoed')
else ok('RetryLoop outputs intra_round_hint from retry_hint')

console.log(`\n--- intra-round-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
