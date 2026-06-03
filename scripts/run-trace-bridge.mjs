#!/usr/bin/env node
/**
 * Run trace 落盘桥 — PolarUI/runs/{run_id}/trace.jsonl
 * Port: 3922
 */
import http from 'node:http'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.RUN_TRACE_BRIDGE_PORT ?? 3922)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNS_DIR = join(ROOT, 'runs')

function writeTrace(envelope) {
  const runId = envelope.run_id ?? `run_${Date.now()}`
  const dir = join(RUNS_DIR, runId)
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'trace.jsonl')
  writeFileSync(logPath, JSON.stringify(envelope) + '\n')
  const result = {
    log_path: `PolarUI/runs/${runId}/trace.jsonl`,
    abs_path: logPath,
  }
  if (envelope.library === 'LG' || envelope.materialized_graph) {
    const runJsonPath = join(dir, 'run.json')
    writeFileSync(runJsonPath, JSON.stringify(envelope, null, 2) + '\n')
    result.run_path = `PolarUI/runs/${runId}/run.json`
    result.run_abs_path = runJsonPath
  }
  return result
}

function listRuns(limit = 10) {
  if (!existsSync(RUNS_DIR)) return []
  return readdirSync(RUNS_DIR)
    .filter(n => existsSync(join(RUNS_DIR, n, 'trace.jsonl')))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .map(id => {
      const raw = readFileSync(join(RUNS_DIR, id, 'trace.jsonl'), 'utf8').trim()
      try { return JSON.parse(raw.split('\n')[0]) } catch { return { run_id: id } }
    })
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, runs_dir: RUNS_DIR }))
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/runs/list')) {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
      const limit = Number(url.searchParams.get('limit') ?? 10)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ runs: listRuns(limit) }))
      return
    }
    if (req.method === 'GET' && (req.url === '/api/runs/latest' || req.url === '/latest')) {
      const runs = listRuns(1)
      const latest = runs[0]
      if (!latest) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no runs' }))
        return
      }
      const runId = latest.run_id ?? latest.runId
      let steps = latest.steps?.length
      if (runId && existsSync(join(RUNS_DIR, runId, 'run.json'))) {
        try {
          const runJson = JSON.parse(readFileSync(join(RUNS_DIR, runId, 'run.json'), 'utf8'))
          steps = runJson.steps?.length ?? steps
        } catch { /* keep trace summary */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        run_id: runId,
        workflow_id: latest.workflow_id ?? latest.spec_id,
        status: latest.status ?? 'completed',
        steps,
        started_at: latest.started_at,
      }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/runs/write') {
      let body = ''
      for await (const chunk of req) body += chunk
      const envelope = JSON.parse(body)
      const result = writeTrace(envelope)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...result }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err.message ?? err) }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`run-trace-bridge listening on http://127.0.0.1:${PORT}`)
})
