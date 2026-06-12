#!/usr/bin/env node
/**
 * Function Calling Stability Benchmark
 * Tests each available model 20 times for tool_calls response stability.
 * Same subscription models run serially; different subscriptions run in parallel.
 */

const PROXY_URL = 'http://127.0.0.1:12790/v1/chat/completions'
const RUNS_PER_MODEL = 20
const DELAY_MS = 2000

const MODELS_BY_SUBSCRIPTION = {
  'aliyun.codingplan': ['qwen3.5-plus', 'qwen3-max-2026-01-23'],
  'ctyun.codingplan': ['GLM-5.1', 'GLM-5', 'GLM-5-Turbo'],
  'glm51.enterprise': ['astron-code-latest'],
  'minimax': ['MiniMax-M3'],
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'FileRead',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to read' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ShellExec',
      description: 'Execute a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'Command to execute' } }, required: ['command'] },
    },
  },
]

const PROMPT = 'Read the file package.json and tell me the project name.'

async function testOnce(model) {
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a coding assistant. Always use tools to complete tasks.' },
          { role: 'user', content: PROMPT },
        ],
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 200,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) {
      const text = await res.text()
      return { status: 'http_error', code: res.status, detail: text.slice(0, 100) }
    }
    const data = await res.json()
    const msg = data.choices?.[0]?.message
    if (!msg) return { status: 'no_message' }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const tc = msg.tool_calls[0]
      const name = tc.function?.name ?? tc.name ?? 'unknown'
      return { status: 'tool_calls', tool: name }
    }
    const content = msg.content || ''
    if (/<tool_use|<tool_call|<function_call/.test(content)) {
      return { status: 'xml_tool', content: content.slice(0, 80) }
    }
    return { status: 'text_only', content: content.slice(0, 80) }
  } catch (err) {
    return { status: 'error', detail: String(err).slice(0, 100) }
  }
}

async function benchmarkModel(model) {
  const results = { tool_calls: 0, xml_tool: 0, text_only: 0, error: 0, http_error: 0, no_message: 0 }
  const toolNames = {}

  for (let i = 0; i < RUNS_PER_MODEL; i++) {
    const r = await testOnce(model)
    results[r.status] = (results[r.status] || 0) + 1
    if (r.tool) toolNames[r.tool] = (toolNames[r.tool] || 0) + 1
    if (i < RUNS_PER_MODEL - 1) await new Promise(r => setTimeout(r, DELAY_MS))
    process.stdout.write('.')
  }
  return { model, results, toolNames }
}

async function benchmarkSubscription(models) {
  const outcomes = []
  for (const model of models) {
    process.stdout.write(`  ${model} `)
    const result = await benchmarkModel(model)
    process.stdout.write(` done\n`)
    outcomes.push(result)
  }
  return outcomes
}

console.log(`\n═══ Function Calling Stability Benchmark ═══`)
console.log(`Models: ${Object.values(MODELS_BY_SUBSCRIPTION).flat().length}`)
console.log(`Runs per model: ${RUNS_PER_MODEL}`)
console.log(`Delay between runs: ${DELAY_MS}ms`)
console.log(`Total estimated time: ~${Math.ceil(Object.values(MODELS_BY_SUBSCRIPTION).reduce((a, b) => Math.max(a, b.length), 0) * RUNS_PER_MODEL * (DELAY_MS + 5000) / 60000)}min\n`)

const subscriptions = Object.entries(MODELS_BY_SUBSCRIPTION)
const allResults = await Promise.all(subscriptions.map(([sub, models]) => {
  console.log(`Starting subscription: ${sub} (${models.join(', ')})`)
  return benchmarkSubscription(models)
}))

console.log('\n═══ Results ═══\n')
console.log('| Model | tool_calls | xml_tool | text_only | error | Stability |')
console.log('|-------|-----------|----------|-----------|-------|-----------|')

for (const subResults of allResults) {
  for (const { model, results, toolNames } of subResults) {
    const total = RUNS_PER_MODEL
    const stability = ((results.tool_calls / total) * 100).toFixed(0)
    const topTool = Object.entries(toolNames).sort((a, b) => b[1] - a[1])[0]
    console.log(`| ${model} | ${results.tool_calls}/${total} | ${results.xml_tool}/${total} | ${results.text_only}/${total} | ${results.error + results.http_error}/${total} | ${stability}% ${topTool ? `(${topTool[0]})` : ''} |`)
  }
}

console.log('\n═══ Done ═══\n')
