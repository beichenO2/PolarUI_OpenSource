#!/usr/bin/env node
/**
 * Design API bridge — exposes PolarDesign functions over HTTP for PolarUI executors
 * Port: 3920 (default)
 */
import http from 'node:http'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const PORT = Number(process.env.DESIGN_BRIDGE_PORT ?? 3920)
const POLAR_DESIGN_DIR = resolve(process.env.HOME ?? '~', 'Polarisor/PolarDesign')

let designMod = null

async function loadMod() {
  const entry = resolve(POLAR_DESIGN_DIR, 'dist/index.js')
  return import(entry)
}

async function getMod() {
  if (!designMod) designMod = await loadMod()
  return designMod
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    const mod = await getMod()
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    let body = ''
    if (req.method === 'POST') {
      for await (const chunk of req) body += chunk
    }
    const json = body ? JSON.parse(body) : {}

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === '/api/design/resolve' && req.method === 'POST') {
      const keywords = String(json.keywords ?? json.style_description ?? '')
      const systems = mod.designResolve(keywords)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ systems }))
      return
    }
    if (url.pathname === '/api/design/generate' && req.method === 'POST') {
      const result = mod.designGenerate({
        skill: String(json.skill ?? 'landing'),
        system: String(json.system ?? 'polar-tech'),
        brief: String(json.brief ?? ''),
        inputs: json.inputs ?? {},
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }
    if (url.pathname === '/api/design/critique' && req.method === 'POST') {
      const html = String(json.html ?? '')
      const critique = mod.designCritique(html)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ report: critique }))
      return
    }
    if (url.pathname === '/api/design/preview' && req.method === 'POST') {
      const html = String(json.html ?? '')
      if (html.includes('<!DOCTYPE') || html.includes('<html')) {
        const outDir = join(POLAR_DESIGN_DIR, 'gallery', '.output')
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
        const outName = `preview-${Date.now()}`
        writeFileSync(join(outDir, `${outName}.html`), html, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ preview_url: `/preview/${outName}` }))
        return
      }
      const gen = mod.designGenerate({
        skill: String(json.skill ?? 'doc/report'),
        system: String(json.system ?? 'polar-tech'),
        brief: String(json.brief ?? ''),
        inputs: json.inputs ?? {
          title: String(json.brief ?? 'Preview'),
          sections: [{
            heading: 'Preview',
            content_md: String(json.brief ?? '简洁登录页'),
          }],
        },
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ preview_url: gen.previewUrl ?? '', html: gen.html ?? '' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
})

server.listen(PORT, () => console.log(`design-bridge listening on http://127.0.0.1:${PORT}`))
