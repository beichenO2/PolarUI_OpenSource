#!/usr/bin/env node
/**
 * PlanValidator — LLM 链缺 RetryLoop 警告 smoke
 */
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeNode } from '../src/engine/executor.ts'

let failed = 0
function ok(m) { console.log('OK:', m) }
function fail(m) { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

const ctx = {
  getNodeOutput: () => undefined,
  allResults: new Map(),
  links: [],
}

const badWf = { '1': { class_type: 'LLM', inputs: { prompt: null } } }
const badNode = {
  id: 'pv1',
  class_type: 'PlanValidator',
  inputs: {},
  params: { workflow: badWf },
}

const bad = await executeNode(badNode, ctx)
if (bad.outputs.valid !== false) fail('expected valid=false for LLM-only workflow')
else ok('LLM-only workflow flagged invalid')
const issues = bad.outputs.issues
if (!Array.isArray(issues) || !issues.some(i => String(i).includes('RetryLoop'))) {
  fail(`missing RetryLoop issue: ${JSON.stringify(issues)}`)
} else ok('RetryLoop warning present')

const goodWf = {
  '1': { class_type: 'PromptInput', inputs: {}, params: { content: 'x', expected_output: '.', purpose: 'test' } },
  '2': { class_type: 'LLM', inputs: { prompt: ['1', 0] } },
  '3': { class_type: 'Validator', inputs: { actual_output: ['2', 0], purpose: ['1', 2] } },
  '4': { class_type: 'RetryLoop', inputs: { passed: ['3', 0], original_input: ['1', 0] } },
}
const goodNode = { id: 'pv2', class_type: 'PlanValidator', inputs: {}, params: { workflow: goodWf } }
const good = await executeNode(goodNode, ctx)
if (good.outputs.valid !== true) fail(`expected valid=true for full chain: ${JSON.stringify(good.outputs.issues)}`)
else ok('PromptInput→LLM→Validator→RetryLoop passes PlanValidator')

console.log(`\n--- plan-validator smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
