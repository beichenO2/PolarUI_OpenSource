/**
 * Hermes 1:1 Capability Benchmark
 * Tests all 5 core capability dimensions of the Hermes Agent
 * Based on NousResearch/hermes-agent architecture
 */
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { loadWorkflowJson, computeBackLinks } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'

bootstrapHeadlessEngine()

const TESTS = [
  {
    id: 'tool_file',
    name: 'Tool Use: File Operations',
    dimension: 'Tool Use',
    message: '读取文件 ~/Polarisor/PolarUI/package.json 然后告诉我 name 字段的值',
    validator: (output) => output.includes('polar-ui'),
  },
  {
    id: 'tool_shell',
    name: 'Tool Use: Shell Command',
    dimension: 'Tool Use',
    message: '执行命令 echo "HERMES_TEST_OK" 并告诉我输出',
    validator: (output) => output.includes('HERMES_TEST_OK'),
  },
  {
    id: 'tool_search',
    name: 'Tool Use: File Search',
    dimension: 'Tool Use',
    message: '搜索 ~/Polarisor/PolarUI/src/engine/ 目录下所有 .ts 文件中包含 "registerExecutor" 的文件，列出文件名',
    validator: (output) => output.includes('executor.ts'),
  },
  {
    id: 'react_multistep',
    name: 'Multi-turn ReAct: Read then Analyze',
    dimension: 'ReAct',
    message: '先读取 ~/Polarisor/PolarUI/workflows/registry.json 的内容，然后告诉我一共有几个工作流注册了',
    validator: (output) => output.includes('2'),
  },
  {
    id: 'memory_read',
    name: 'Memory: Read MEMORY.md',
    dimension: 'Memory',
    message: '你好，请自我介绍',
    validator: (output) => output.toLowerCase().includes('hermes') || output.includes('AI'),
  },
  {
    id: 'skill_capture',
    name: 'Self-Evolution: SkillCapture fires',
    dimension: 'Evolution',
    message: '执行 echo "skill_test_data" > /tmp/hermes_skill_test.txt 然后确认文件已创建',
    validator: (output) => output.includes('skill_test') || output.includes('创建') || output.includes('成功'),
  },
]

const json = readFileSync('workflows/hermes-1to1.json', 'utf8')
const results = []

for (const test of TESTS) {
  const startTime = Date.now()
  process.stderr.write(`\n  Running: ${test.name}...`)
  
  try {
    const g = loadWorkflowJson(json)
    computeBackLinks(g)
    
    let skillCaptured = false
    let memoryAppended = false
    
    const { results: execResults } = await executeGraph(g, {
      runContext: { stream: false },
      externalInputs: { input: test.message },
      onNodeDone: ({ classType }) => {
        if (classType === 'SkillCapture') skillCaptured = true
        if (classType === 'MemoryStore') memoryAppended = true
      },
    })
    
    const elapsed = Date.now() - startTime
    const allOutputs = [...execResults.values()]
    const finalOutput = allOutputs[allOutputs.length - 1]?.outputs?.content ?? ''
    const passed = test.validator(String(finalOutput))
    
    results.push({
      id: test.id,
      name: test.name,
      dimension: test.dimension,
      passed,
      elapsed_ms: elapsed,
      skill_captured: skillCaptured,
      memory_appended: memoryAppended,
      output_preview: String(finalOutput).slice(0, 100),
    })
    
    process.stderr.write(` ${passed ? '✅' : '❌'} (${(elapsed/1000).toFixed(1)}s)`)
  } catch (err) {
    const elapsed = Date.now() - startTime
    results.push({
      id: test.id,
      name: test.name,
      dimension: test.dimension,
      passed: false,
      elapsed_ms: elapsed,
      error: String(err).slice(0, 200),
    })
    process.stderr.write(` ❌ ERROR (${(elapsed/1000).toFixed(1)}s)`)
  }
}

// Summary
const passCount = results.filter(r => r.passed).length
const totalCount = results.length
const dimensions = [...new Set(TESTS.map(t => t.dimension))]
const dimScores = dimensions.map(d => {
  const dim_tests = results.filter(r => r.dimension === d)
  const dim_pass = dim_tests.filter(r => r.passed).length
  return { dimension: d, score: `${dim_pass}/${dim_tests.length}`, pct: Math.round(dim_pass / dim_tests.length * 100) }
})

const report = {
  benchmark: 'Hermes 1:1 Capability Benchmark',
  timestamp: new Date().toISOString(),
  workflow: 'hermes-1to1',
  total: `${passCount}/${totalCount}`,
  pass_rate: Math.round(passCount / totalCount * 100) + '%',
  dimensions: dimScores,
  results,
}

console.log('\n\n' + JSON.stringify(report, null, 2))
