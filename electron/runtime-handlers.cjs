const { spawn } = require('node:child_process')
const { homedir } = require('node:os')
const { join, resolve, relative, isAbsolute } = require('node:path')

const POLARISOR_ROOT = resolve(process.env.POLARISOR_ROOT ?? join(homedir(), 'Polarisor'))

function resolveWithinRoot(rawPath, cwd) {
  const base = cwd ? resolveWithinRoot(cwd) : POLARISOR_ROOT
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath)
  const rel = relative(POLARISOR_ROOT, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path outside Polarisor root: ${rawPath}`)
  }
  return abs
}

function runShell(command, cwd = '.', timeoutS = 30) {
  const workdir = resolveWithinRoot(cwd)
  const timeoutMs = Math.min(timeoutS * 1000, 120_000)

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd: workdir,
      shell: true,
      env: { ...process.env, POLARISOR_ROOT },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ stdout, stderr, exit_code: code ?? 1, success: (code ?? 1) === 0 })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function handleCodeExec(params, inputs) {
  const code = String(inputs.code ?? '')
  const lang = String(params.language ?? 'python')
  const timeoutS = Number(params.timeout_s ?? 30)
  if (!code.trim()) throw new Error('code required')

  let command
  if (lang === 'javascript') command = `node -e ${JSON.stringify(code)}`
  else if (lang === 'shell') command = code
  else command = `python3 -c ${JSON.stringify(code)}`

  return runShell(command, '.', timeoutS)
}

async function handleBrowserAction(params, inputs) {
  const url = String(inputs.url ?? params.url ?? '')
  const action = String(inputs.action ?? params.action ?? 'navigate')
  if (!url) throw new Error('url required')

  if (action === 'screenshot') {
    return {
      stdout: '',
      stderr: 'screenshot requires Playwright; use navigate/fetch in Electron v1',
      exit_code: 1,
      success: false,
      result: '',
      screenshot: '',
    }
  }

  const data = await runShell(`curl -sL ${JSON.stringify(url)}`, '.', Number(params.timeout_s ?? 30))
  return { ...data, result: data.stdout, screenshot: '' }
}

async function handleMcpCall(params, inputs) {
  const server = String(inputs.server ?? params.server ?? '')
  const tool = String(inputs.tool_name ?? params.tool ?? '')
  return {
    stdout: '',
    stderr: '',
    exit_code: 0,
    success: true,
    result: {
      server,
      tool,
      arguments: inputs.arguments ?? params.arguments ?? {},
      note: 'MCPCall in Electron defers to Hub MCP channel; use ShellExec/hub tools for host ops',
    },
  }
}

const HANDLERS = {
  CodeExec: handleCodeExec,
  BrowserAction: handleBrowserAction,
  MCPCall: handleMcpCall,
}

async function executeNode(classType, params, inputs) {
  const handler = HANDLERS[classType]
  if (!handler) throw new Error(`unsupported runtime node: ${classType}`)
  return handler(params ?? {}, inputs ?? {})
}

module.exports = { executeNode, POLARISOR_ROOT }
