#!/usr/bin/env npx tsx
/**
 * PolarUI E2E 演示脚本
 *
 * 模拟完整链路：PolarClaw 生成工作流 JSON → PolarUI 加载
 *
 * 用法：npx tsx scripts/e2e-demo.ts "帮我写一份雷达系统实验报告"
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const OUTPUT_DIR = join(process.cwd(), 'workflows')
const HUB_URL = process.env.POLARUI_HUB_URL || 'http://localhost:8040'
const POLARCLAW_URL = process.env.POLARCLAW_URL || 'http://localhost:3210'

const prompt = process.argv.slice(2).join(' ') || '帮我写一份雷达系统实验报告'

console.log('═══════════════════════════════════════════')
console.log('◈ PolarUI E2E 演示')
console.log('═══════════════════════════════════════════')
console.log(`\n📝 Prompt: "${prompt}"`)
console.log(`🔗 PolarClaw: ${POLARCLAW_URL}`)
console.log(`🔗 Hub: ${HUB_URL}`)
console.log('')

async function main() {
  // Step 1: 尝试调用 PolarClaw 生成工作流
  console.log('Step 1: 调用 PolarClaw 生成工作流...')

  let workflowJson: Record<string, unknown> | null = null

  try {
    const res = await fetch(`${POLARCLAW_URL}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `请生成一个 PolarUI 工作流 JSON。\n需求：${prompt}\n\n规则：\n- 输出纯 JSON 对象\n- 格式：{ "1": { "class_type": "...", "inputs": {...} } }\n- 合法节点类型：LLM, WebSearch, FileRead, FileWrite, GitCommit, SSoTQuery, KnowLeverSearch, ContentRender, ShellExec, TextTransform, JsonParse, Output, PromptInput, HumanApproval, PolarPilot`,
        conversation_id: `polarui-e2e-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (res.ok) {
      const data = await res.json() as { reply?: string; content?: string }
      const text = data.reply || data.content || ''
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        workflowJson = JSON.parse(match[0])
        console.log('   ✅ PolarClaw 返回了工作流 JSON')
      }
    }
  } catch {
    console.log('   ⚠️  PolarClaw 未运行，使用本地生成...')
  }

  // Fallback: 本地生成（模拟 PolarClaw 的输出）
  if (!workflowJson) {
    workflowJson = generateForPrompt(prompt)
    console.log('   ✅ 本地生成工作流完成')
  }

  // Step 2: 保存为 JSON 文件
  console.log('\nStep 2: 保存工作流文件...')
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })
  const filename = `workflow-${Date.now()}.json`
  const filepath = join(OUTPUT_DIR, filename)
  writeFileSync(filepath, JSON.stringify(workflowJson, null, 2))
  console.log(`   ✅ 已保存: ${filepath}`)

  // Step 3: 显示工作流结构
  console.log('\nStep 3: 工作流结构预览')
  const nodes = workflowJson as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  console.log(`   节点数: ${Object.keys(nodes).length}`)
  console.log('')
  for (const [id, node] of Object.entries(nodes)) {
    const inputRefs = Object.entries(node.inputs)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k}←[${(v as unknown[])[0]}]`)
    console.log(`   [${id}] ${node.class_type}${inputRefs.length ? ' (' + inputRefs.join(', ') + ')' : ''}`)
  }

  // Step 4: 尝试提交到 Hub
  console.log('\nStep 4: 提交到 Hub...')
  try {
    const res = await fetch(`${HUB_URL}/api/ui/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'polar-ui-e2e',
        prompt: `## PolarUI 工作流已生成\n\n**Prompt**: ${prompt}\n**节点数**: ${Object.keys(nodes).length}\n\n\`\`\`json\n${JSON.stringify(nodes, null, 2)}\n\`\`\``,
        options: ['查看工作流', '继续'],
      }),
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) console.log('   ✅ 已提交到 Hub')
    else console.log('   ⚠️  Hub 返回错误')
  } catch {
    console.log('   ⚠️  Hub 不可达')
  }

  // Step 5: 提示用户在 PolarUI 中打开
  console.log('\n═══════════════════════════════════════════')
  console.log('✅ E2E 链路完成！')
  console.log('')
  console.log('在 PolarUI 中查看：')
  console.log(`  1. 打开 http://localhost:5173`)
  console.log(`  2. 点击顶栏 "📂 打开 JSON"`)
  console.log(`  3. 选择 ${filepath}`)
  console.log(`  4. 工作流将自动加载并布局在画布上`)
  console.log('═══════════════════════════════════════════')
}

function generateForPrompt(prompt: string): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const lower = prompt.toLowerCase()

  if (lower.includes('实验报告') || lower.includes('报告')) {
    return {
      '1': { class_type: 'PromptInput', inputs: { content: prompt, system_prompt: '你是专业的实验报告撰写助手，按学术规范（标题/摘要/引言/方法/结果/讨论/结论）格式化。' } },
      '2': { class_type: 'FileRead', inputs: { path: ['1', 1], encoding: 'utf-8' } },
      '3': { class_type: 'WebSearch', inputs: { query: ['1', 0], max_results: 5 } },
      '4': { class_type: 'LLM', inputs: { prompt: ['1', 0], context: ['2', 0], model: 'claude-sonnet', max_steps: 10, temperature: 0.3 } },
      '5': { class_type: 'ContentRender', inputs: { data: ['4', 1], template_id: '实验报告' }, params: { format: 'docx' } },
      '6': { class_type: 'Output', inputs: { content: ['5', 0], format: 'auto', save_to: './output/实验报告.docx' } },
    }
  }

  if (lower.includes('搜索') || lower.includes('调研')) {
    return {
      '1': { class_type: 'PromptInput', inputs: { content: prompt, system_prompt: '你是研究分析师，擅长整理和归纳信息。' } },
      '2': { class_type: 'WebSearch', inputs: { query: ['1', 0], max_results: 10 } },
      '3': { class_type: 'KnowLeverSearch', inputs: { query: ['1', 0], top_k: 5 } },
      '4': { class_type: 'LLM', inputs: { prompt: ['1', 0], context: ['2', 0], model: 'claude-sonnet', max_steps: 15 } },
      '5': { class_type: 'Output', inputs: { content: ['4', 0], format: 'markdown' } },
    }
  }

  if (lower.includes('代码') || lower.includes('开发') || lower.includes('修复')) {
    return {
      '1': { class_type: 'PromptInput', inputs: { content: prompt, system_prompt: '你是高级软件工程师。' } },
      '2': { class_type: 'FileRead', inputs: { path: ['1', 1], encoding: 'utf-8' } },
      '3': { class_type: 'LLM', inputs: { prompt: ['1', 0], context: ['2', 0], model: 'claude-sonnet', max_steps: 20 } },
      '4': { class_type: 'FileWrite', inputs: { path: ['1', 1], content: ['3', 0], create_dirs: true } },
      '5': { class_type: 'ShellExec', inputs: { command: ['3', 0], cwd: '.', timeout_s: 30 } },
      '6': { class_type: 'GitCommit', inputs: { message: ['3', 0], files: ['4', 0], push: true } },
      '7': { class_type: 'Output', inputs: { content: ['6', 0], format: 'auto' } },
    }
  }

  return {
    '1': { class_type: 'PromptInput', inputs: { content: prompt, system_prompt: '' } },
    '2': { class_type: 'LLM', inputs: { prompt: ['1', 0], context: ['1', 1], model: 'claude-sonnet', max_steps: 20, temperature: 0.7 } },
    '3': { class_type: 'Output', inputs: { content: ['2', 0], format: 'auto' } },
  }
}

main().catch(console.error)
