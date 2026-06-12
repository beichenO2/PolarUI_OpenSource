#!/usr/bin/env node
/**
 * 为 executor.ts / pipeline-executor.ts 补中文业务注释（polarui-component 四条）。
 * 幂等：上一行已有 // 或 /** 则跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '../..')
const EXECUTOR = join(__dir, '../src/engine/executor.ts')
const PIPELINE = join(__dir, '../src/engine/pipeline-executor.ts')
const NODE_DEFS = join(ROOT, 'PolarUI', 'node-defs')

const BATCH2_DONE = new Set([
  'LLM', 'ToolCall', 'Condition', 'Switch', 'Validator', 'TextTransform', 'JsonParse',
  'Merge', 'StaticData', 'PromptInput', 'Output', 'RetryLoop', 'SampleLoop', 'ForLoop',
  'WhileLoop', 'MapReduce', 'PromptInject', 'HumanApproval', 'RegexMatch',
])

function loadClassDescriptions() {
  const map = {}
  const index = JSON.parse(readFileSync(join(NODE_DEFS, 'index.json'), 'utf8'))
  for (const file of index.files) {
    const raw = JSON.parse(readFileSync(join(NODE_DEFS, file), 'utf8'))
    const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([k, v]) => ({ class_type: k, ...v }))
    for (const def of entries) {
      if (!def || typeof def !== 'object') continue
      const ct = def.class_type || def.classType
      if (!ct) continue
      map[ct] = String(def.description || def.display_name || ct).slice(0, 220)
    }
  }
  return map
}

const DESC = loadClassDescriptions()

function prevHasComment(lines, i) {
  if (i <= 0) return true
  let j = i - 1
  while (j >= 0 && lines[j].trim() === '') j--
  if (j < 0) return true
  const p = lines[j].trim()
  return p.startsWith('//') || p.startsWith('/**') || p.startsWith('*') || p.endsWith('*/')
}

function indentOf(line) {
  return (line.match(/^(\s*)/) || ['', ''])[1]
}

const VAR_HINTS = {
  base: '生态服务根地址：节点 params.api_base 优先于默认端口',
  url: '拼好的 HTTP 请求地址',
  res: 'fetch 响应，后续根据 ok/status 分支',
  data: '接口 JSON 正文',
  query: '检索关键词：inputs 槽优先，trim 后空则用默认',
  queryRaw: '原始 query 槽（可能是对象，需展平为字符串）',
  username: 'Clock 多用户隔离用的用户名',
  syncKey: 'Clock 同步密钥（X-Sync-Key）',
  token: 'Clock 用户会话 token（X-Token）',
  path: '文件或 API 路径（inputs 优先于 params）',
  command: '待执行的 shell 命令行',
  cwd: '命令工作目录（相对仓库根解析）',
  timeoutS: '子进程/HTTP 超时秒数',
  optional: '缺文件时不失败，输出空 content',
  encoding: '文本文件读取编码',
  message: 'Git 提交说明或通知正文',
  files: 'Git 暂存文件列表（可选）',
  push: '提交后是否 push 到远端',
  branch: '目标分支名',
  pattern: 'Glob/Grep 匹配模式',
  content: '写入或读取的文本内容',
  allowed: 'PermissionGate 是否放行下游',
  whitelist: '工具白名单 JSON 数组',
  mode: '组件运行模式（ask/whitelist 等）',
  toolName: '待校验的工具/动作名',
  project: 'polaris.json 对应项目名',
  model: 'LLM/VLM 模型 id',
  prompt: '发给模型的用户提示',
  imageUrl: 'VLM 图像 URL 或 data URL',
  max: 'RetryLoop 轮间上限次数',
  attempt: '当前轮次（runner 注入 _attempt）',
  passed: 'Validator 是否通过',
  n: 'SampleLoop 独立抽样次数',
  cost: '本步累计费用',
  limit: '预算上限',
  pct: '已用预算占比（%）',
  record: '经验捕获结构化记录',
  snap: 'Clock snapshot 或降级数据',
  action: '子操作类型（如 backup create/list）',
  id: '服务/模板/任务 id',
  topic: 'DIGiST/KnowLever 主题',
  user: 'KnowLever/PolarMemory 用户 id',
  key: 'PolarMemory 块 id',
  operation: 'MemoryStore 读/写操作',
  lang: 'CodeExec 语言',
  code: 'CodeExec 待执行源码',
  server: 'MCP 服务器标识',
  tool: 'MCP 工具名',
  args: 'MCP 工具参数对象',
  event: 'Checkup 事件载荷',
  approved: '人工审批是否通过',
  skillMd: '蒸馏出的 Skill Markdown',
  preferences: '用户偏好 JSON',
  maxResults: 'WebSearch 最大条数',
  candidates: 'FileRead 依次尝试的路径列表',
  lastErr: 'FileRead 最后一次读盘错误',
  headers: 'HTTP 附加头（Sync-Key / Token）',
  format: 'AutoOffice 输出格式（html/pdf 等）',
  port: '默认服务端口（用于 serviceHint）',
  label: '错误提示中的服务显示名',
}

function inferLineComment(line, classType) {
  const t = line.trim()
  if (t.startsWith('else if (')) return '// 备选条件：上一分支未命中'
  if (t.startsWith('else {')) return '// 默认分支'
  if (t.startsWith('if (')) {
    if (t.includes('!res.ok')) return '// HTTP 非成功：抛错（含生态服务拉起提示）'
    if (t.includes('res.ok')) return '// HTTP 成功才解析 body'
    if (t.includes('optional')) return '// optional：失败不阻断工作流'
    if (t.includes('passed')) return '// Validator/RetryLoop 通过则结束重试'
    if (t.includes('attempt >=')) return '// 达到轮次上限'
    if (t.includes('mode ===')) return '// 按 capture_mode 过滤是否记录'
    if (t.includes('typeof') && t.includes('object')) return '// 槽位可能是对象，需展平'
    if (t.includes('POLAR_HEADLESS')) return '// 无头 dry-run：跳过真实 git'
    if (t.includes('looksLikeShell')) return '// 过滤非 shell 文本，避免误执行'
    if (t.includes('isElectronRuntime')) return '// Electron 走 IPC，浏览器走 Hub'
    if (t.includes('auto_apply') || t.includes('auto_save')) return '// 显式开启才自动写盘'
    if (t.includes('push_suggestion')) return '// 写入进化建议 inbox 待人审'
    if (t.includes('onWhitelist') || t.includes('needsApproval')) return '// PermissionGate 白名单/ask 决策'
    if (t.includes('injected')) return '// 已注入 event，跳过 inbox 等待'
    if (t.includes('useVlm') || t.includes('screenshotB64')) return '// 有截图时走 VLM 视觉诊断'
    if (t.includes('!path') || t.includes("includes('{')")) return '// 占位符或未填路径：跳过'
    if (t.includes('existing')) return '// 节点已配置 token 则直接复用'
    if (t.includes('cached')) return '// 进程内 token 缓存命中'
    if (t.includes('!login.ok')) return '// Clock 登录失败不可继续'
    if (t.includes('!token')) return '// 登录响应缺少 token'
    if (t.includes('syncKey')) return '// 附带 X-Sync-Key 请求头'
    if (t.includes('key)')) return '// 请求头携带鉴权字段'
    return `// ${classType || '组件'}：条件分支`
  }
  if (t.startsWith('for (')) {
    if (t.includes('candidates')) return '// 依次尝试相对路径与仓库根路径'
    if (t.includes('queryKeys')) return '// 将 inputs/params 编入 query string'
    if (t.includes('ECOSYSTEM_HTTP')) return '// 批量注册生态 HTTP 原子组件'
    if (t.includes('PIPELINE_CLASS_TYPES')) return '// 注册 internal_workflow 范式执行器'
    return '// 遍历直至终止条件满足'
  }
  if (t.startsWith('while (')) return '// 循环直至条件不满足'
  const assign = t.match(/^(const|let)\s+(\w+)\s*=/)
  if (assign) {
    const name = assign[2]
    if (VAR_HINTS[name]) return `// ${VAR_HINTS[name]}`
    if (t.includes('apiBase(')) return '// 解析 api_base，默认连本地生态端口'
    if (t.includes('JSON.parse')) return '// 解析 params 中的 JSON 配置'
    return `// ${name}：${classType || '本步'}业务中间量`
  }
  return null
}

function annotateFile(filePath, startLine = 1) {
  const lines = readFileSync(filePath, 'utf8').split('\n')
  const out = []
  let activeClass = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1
    const inScope = lineNo >= startLine

    const reg = line.match(/^registerExecutor\('([^']+)'/)
    if (reg && inScope) {
      activeClass = reg[1]
      const ct = activeClass
      const oneLine = /createApiExecutor\(|createGetQueryExecutor\(|=>\s*\w+\(/.test(line)
      if (!BATCH2_DONE.has(ct) && !prevHasComment(out, out.length)) {
        const desc = DESC[ct] || ct
        out.push(`${indentOf(line)}/** ${ct}：${desc} */`)
      }
      out.push(line)
      if (i + 1 < lines.length) {
        const nxt = lines[i + 1]
        if (
          /^\s*async\s*\(/.test(nxt)
          && !BATCH2_DONE.has(ct)
          && !oneLine
          && !prevHasComment(out, out.length)
        ) {
          out.push(`${indentOf(nxt)}/** ${ct}：${DESC[ct] || ct} */`)
        }
      }
      continue
    }

    if (inScope && /^\s*(const |let |if\s*\(|else if\s*\(|else\s*\{|for\s*\(|while\s*\()/.test(line)) {
      const skipBatch2 = BATCH2_DONE.has(activeClass) && lineNo < 745
      if (!skipBatch2 && !prevHasComment(out, out.length)) {
        const c = inferLineComment(line, activeClass)
        if (c) out.push(`${indentOf(line)}${c}`)
      }
    }

    out.push(line)
  }

  writeFileSync(filePath, out.join('\n'), 'utf8')
  console.log('OK', filePath, 'lines', out.length)
}

annotateFile(EXECUTOR, 655)
annotateFile(PIPELINE, 1)
