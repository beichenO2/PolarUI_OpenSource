#!/usr/bin/env node
/**
 * 进化建议应用桥 — 供 PolarUI Web 批准时写盘
 * Port: 3921
 */
import http from 'node:http'
import { applySuggestion } from './suggestion-apply.mjs'

const PORT = Number(process.env.SUGGESTION_BRIDGE_PORT ?? 3921)

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'POST' && req.url === '/api/suggestion/apply') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { suggestion, target_ids: targetIds } = JSON.parse(body)
      const applied = applySuggestion(suggestion, targetIds)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, applied }))
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
  console.log(`suggestion-bridge listening on http://127.0.0.1:${PORT}`)
})
