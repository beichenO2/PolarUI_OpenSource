#!/usr/bin/env node
/**
 * Claude Code parity — 4 benchmark prompts via claude-code-lg.
 * Writes results to benchmarks/claude-code/polarui/ (baseline frozen in benchmarks/claude-code/baseline/).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'benchmarks', 'claude-code', 'polarui')
const BASELINE = join(ROOT, 'benchmarks', 'claude-code', 'baseline', 'summary.json')

const CASES = [
  {
    id: 'q1-folders',
    message: 'List only the directory names (not files) at the top level of the current project root. Then summarize in one English sentence.',
    expect: (t) => /\b(src|workflows|scripts)\b/i.test(t) && t.length > 40,
  },
  {
    id: 'q2-package-name',
    message: 'Read the file package.json and reply with ONLY the value of the "name" field, nothing else.',
    expect: (t) => /polar-ui/i.test(t),
  },
  {
    id: 'q3-grep-count',
    message: 'Use GrepSearch to count how many times the string PermissionGate appears in workflows/claude-code.lg.json. Reply with ONLY the integer count.',
    expect: (t) => /\b3\b/.test(t.trim()),
  },
  {
    id: 'q4-math-control',
    message: 'Compute 17×23+5 and reply with ONLY the numeric result.',
    expect: (t) => /\b396\b/.test(t),
  },
]

mkdirSync(OUT, { recursive: true })

const results = []
let failed = 0

for (const c of CASES) {
  const conv = `parity-${c.id}`
  const start = Date.now()
  let payload
  try {
    const raw = execSync(
      `npx tsx scripts/run-workflow-chat-once.mjs --workflow claude-code-lg --conversation-id ${conv} --message ${JSON.stringify(c.message)}`,
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    )
    payload = JSON.parse(raw.trim())
  } catch (err) {
    payload = { error: String(err.stderr ?? err.message ?? err), status: 'error' }
  }
  const elapsed_ms = Date.now() - start
  const content = String(payload.content ?? '')
  const pass = payload.status === 'completed' && !payload.unhealthy_nodes?.length && c.expect(content)
  if (!pass) failed++
  const record = {
    id: c.id,
    workflow_id: 'claude-code-lg',
    elapsed_ms,
    content,
    pass,
    unhealthy_nodes: payload.unhealthy_nodes ?? [],
    status: payload.status ?? 'error',
  }
  results.push(record)
  writeFileSync(join(OUT, `polarui-lg-${c.id}.json`), JSON.stringify(record, null, 2))
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${c.id} (${elapsed_ms}ms) → ${content.slice(0, 120)}`)
}

const summary = {
  generated_at: new Date().toISOString(),
  workflow: 'claude-code-lg',
  baseline: existsSync(BASELINE) ? BASELINE : null,
  pass: results.filter(r => r.pass).length,
  total: results.length,
  results: results.map(({ id, pass, elapsed_ms }) => ({ id, pass, elapsed_ms })),
}
writeFileSync(join(OUT, 'polarui-lg-summary.json'), JSON.stringify(summary, null, 2))
console.log(`\n--- parity: ${summary.pass}/${summary.total} pass, ${failed} failures ---`)
process.exit(failed ? 1 : 0)
