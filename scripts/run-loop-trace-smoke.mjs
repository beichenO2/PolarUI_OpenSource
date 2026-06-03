#!/usr/bin/env node
/**
 * LoopTrace + 回边有界调度 smoke
 * 用法: node --import ./scripts/txt-raw-loader.mjs --import tsx scripts/run-loop-trace-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson, computeBackLinks } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = join(ROOT, 'workflows', 'test-retry-loop-backedge.json')

let failed = 0
function ok(m) { console.log('OK:', m) }
function fail(m) { console.error('FAIL:', m); failed++ }

const loaded = bootstrapHeadlessEngine()
ok(`node-defs loaded (${loaded})`)

const graph = loadWorkflowJson(readFileSync(WF, 'utf8'))
const backLinks = computeBackLinks(graph)
if (backLinks.size === 0) fail('no back-edge detected')
else ok(`back-edge links: ${backLinks.size}`)

const { results, runTrace, unhealthy_nodes } = await executeGraph(graph)
if (unhealthy_nodes.length) fail(`unhealthy: ${JSON.stringify(unhealthy_nodes)}`)
else ok('executeGraph completed')

const loops = runTrace?.loop_traces ?? []
if (loops.length !== 3) fail(`expected 3 loop_traces, got ${loops.length}`)
else ok(`loop_traces: ${loops.length}`)

const reasons = loops.map(l => l.stop_reason)
if (reasons[0] !== 'retry' || reasons[1] !== 'retry' || reasons[2] !== 'exhausted') {
  fail(`stop_reasons ${reasons.join(',')} != retry,retry,exhausted`)
} else ok(`stop_reasons: ${reasons.join(' → ')}`)

const retryNode = graph.nodes.find(n => n.class_type === 'RetryLoop')
const rlResult = retryNode ? results.get(retryNode.id) : undefined
if (rlResult?.outputs.exhausted !== true) fail('RetryLoop should exhaust on attempt 3')
else ok('RetryLoop exhausted after 3 inter-round refreshes')

const lastRetryInput = rlResult?.outputs.retry_input
if (lastRetryInput !== 'BASE') fail(`retry_input should stay SSOT "BASE", got ${JSON.stringify(lastRetryInput)}`)
else ok('retry_input inter-round refresh = original SSOT only')

console.log(`\n--- loop-trace smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
