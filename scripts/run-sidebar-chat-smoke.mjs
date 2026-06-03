#!/usr/bin/env node
/** 260527 Phase 3 — 侧栏 Chat executeWithMessage + streaming 探针 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

const sidebar = join(ROOT, 'src', 'components', 'ChatSidebar.vue')
const terminal = join(ROOT, 'src', 'components', 'RunTraceTerminal.vue')
if (!existsSync(sidebar)) fail('ChatSidebar.vue missing')
else ok('ChatSidebar.vue present')
if (!existsSync(terminal)) fail('RunTraceTerminal.vue missing')
else ok('RunTraceTerminal.vue present')

const appVue = readFileSync(join(ROOT, 'src', 'App.vue'), 'utf8')
if (!appVue.includes('chatSidebarOpen')) fail('App.vue missing chatSidebarOpen')
else ok('App.vue chat sidebar wired')

setLLMClient({
  chat: async () => ({ content: 'sidebar smoke OK', usage: {} }),
})
bootstrapHeadlessEngine()

const wfPath = join(ROOT, 'workflows', 'test-multi-turn-chat.json')
const graph = loadWorkflowJson(readFileSync(wfPath, 'utf8'))
let streamed = false
let sawNode = false

const result = await executeGraph(graph, {
  runContext: { conversation_id: 'sidebar-smoke', user_message: '你好' },
  externalInputs: { conversation_id: 'sidebar-smoke', message: '你好', user_message: '你好' },
  onStreamChunk: () => { streamed = true },
})

if (result.unhealthy_nodes.length) fail(`execute unhealthy: ${result.unhealthy_nodes[0]?.error}`)
else ok('executeWithMessage path (executeGraph) 0 unhealthy')

if (result.merged_output && String(result.merged_output).includes('sidebar')) sawNode = true
if (streamed || sawNode || result.merged_output) ok('streaming / output path OK')
else fail('no output from chat smoke')

console.log(`\n--- sidebar-chat-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
