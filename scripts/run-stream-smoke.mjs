#!/usr/bin/env node
/** 02 批次外：LLM stream — 真实 executor + llm-proxy SSE（mock fetch） */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { Graph } from '../src/engine/graph.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()
setLLMClient(null)

const core = readFileSync(join(ROOT, '..', 'node-defs', 'core.json'), 'utf8')
if (!/"stream"/.test(core)) fail('LLM node-def missing stream param')
else ok('LLM node-def has stream param')

const origFetch = globalThis.fetch
const chunks = []
let sawStreamRequest = false

globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/v1/chat/completions')) {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (body.stream !== true) fail('chat request missing stream:true')
    else ok('llm-proxy chat request stream:true')
    sawStreamRequest = true
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const part of ['hel', 'lo']) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`,
          ))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  return origFetch(url, init)
}

const g = new Graph('stream-smoke')
const n1 = g.addNode('PromptInput', 0, 0)
const n2 = g.addNode('LLM', 200, 0)
n2.params.stream = true
g.addLink(n1.id, 0, n2.id, 0)

const { results, unhealthy_nodes } = await executeGraph(g, {
  onStreamChunk: (nodeId, chunk) => chunks.push({ nodeId, chunk }),
})

globalThis.fetch = origFetch

if (unhealthy_nodes.length) fail(`unhealthy: ${unhealthy_nodes[0]?.error}`)
if (!sawStreamRequest) fail('never hit llm-proxy SSE endpoint')
if (chunks.length !== 2) fail(`expected 2 stream chunks, got ${chunks.length}`)
else ok('onStreamChunk fired via real LLM executor + SSE parse')

const llmOut = results.get(n2.id)?.outputs?.response
if (llmOut !== 'hello') fail(`assembled content "${llmOut}" != hello`)
else ok('SSE deltas assembled to full response')

console.log(`\n--- stream-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
