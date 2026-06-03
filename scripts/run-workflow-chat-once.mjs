#!/usr/bin/env node
/**
 * 单次 workflow chat 执行 — 供 PolarClaw /api/workflow/chat 子进程调用
 * Usage:
 *   npx tsx scripts/run-workflow-chat-once.mjs --workflow X --conversation-id Y --message "..."
 *   npx tsx scripts/run-workflow-chat-once.mjs ... --stream   # NDJSON 事件流 stdout
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { emitStreamLine, toolEventFromNode } from './chat-stream-events.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const streamMode = process.argv.includes('--stream')
const workflowId = arg('workflow') ?? arg('workflow-id')
const conversationId = arg('conversation-id') ?? arg('conversation_id')
const message = arg('message')
const userId = arg('user-id') ?? 'chat-user'

if (!workflowId || !conversationId || !message) {
  const err = { error: 'usage: --workflow <id|file> --conversation-id <id> --message <text> [--stream]' }
  if (streamMode) emitStreamLine({ type: 'error', message: err.error })
  else console.error(JSON.stringify(err))
  process.exit(2)
}

bootstrapHeadlessEngine()

const registryPath = join(ROOT, 'workflows/registry.json')
let filePath = workflowId.endsWith('.json') ? workflowId : `${workflowId}.json`
if (existsSync(registryPath)) {
  const reg = JSON.parse(readFileSync(registryPath, 'utf8'))
  const entry = reg.find(e => e.id === workflowId)
  if (entry) filePath = entry.file
}

const abs = join(ROOT, 'workflows', filePath.replace(/^workflows\//, ''))
if (!existsSync(abs)) {
  const err = { error: `workflow not found: ${abs}` }
  if (streamMode) emitStreamLine({ type: 'error', message: err.error })
  else console.error(JSON.stringify(err))
  process.exit(1)
}

const graph = loadWorkflowJson(readFileSync(abs, 'utf8'))
const runContext = {
  conversation_id: conversationId,
  user_id: userId,
  user_message: message,
  skip_permissions: true,
}
const externalInputs = {
  conversation_id: conversationId,
  user_id: userId,
  message,
  user_message: message,
}

try {
  const result = graph.library === 'LG'
    ? await executeLGSpec(graph, {
        runContext,
        externalInputs,
        onStep: ({ nodeId, stepIndex, classType }) => {
          if (!streamMode) return
          emitStreamLine({
            type: 'step_start',
            node_id: nodeId,
            class_type: classType ?? 'LGStep',
            attempt: stepIndex + 1,
          })
        },
      })
    : await executeGraph(graph, {
        runContext,
        externalInputs,
        onStreamChunk: (nodeId, chunk) => {
          if (streamMode) emitStreamLine({ type: 'text_delta', delta: chunk, node_id: nodeId })
        },
        onNodeStart: ({ nodeId, classType, attempt }) => {
          if (streamMode) emitStreamLine({ type: 'step_start', node_id: nodeId, class_type: classType, attempt })
        },
        onNodeDone: ({ nodeId, classType, result }) => {
          if (!streamMode) return
          for (const ev of toolEventFromNode(classType, result.outputs ?? {}, result.error)) {
            emitStreamLine({ ...ev, node_id: nodeId })
          }
          emitStreamLine({
            type: 'step_done',
            node_id: nodeId,
            class_type: classType,
            duration_ms: result.duration_ms,
            ...(result.error ? { error: result.error } : {}),
          })
        },
      })

  const payload = {
    conversation_id: conversationId,
    workflow_id: workflowId,
    content: result.merged_output != null ? String(result.merged_output) : null,
    unhealthy_nodes: result.unhealthy_nodes,
    status: result.unhealthy_nodes.length ? 'error' : 'completed',
  }

  if (streamMode) {
    emitStreamLine({
      type: 'final',
      content: payload.content,
      status: payload.status,
      unhealthy_nodes: payload.unhealthy_nodes,
      conversation_id: conversationId,
      workflow_id: workflowId,
    })
  } else {
    console.log(JSON.stringify(payload))
  }

  process.exit(result.unhealthy_nodes.length ? 1 : 0)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (streamMode) emitStreamLine({ type: 'error', message: msg })
  else console.error(JSON.stringify({ error: msg }))
  process.exit(1)
}
