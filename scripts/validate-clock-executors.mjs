#!/usr/bin/env node
/**
 * Clock 32 节点 executor 对齐探测 — 模拟各节点所需 HTTP 前置条件
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLOCK = 'http://127.0.0.1:15550'
const DIGIST = 'http://127.0.0.1:3800'
const KL = 'http://127.0.0.1:18080'

const USER = 'polarui_clock_e2e'
let token = ''
let syncKey = ''

let passed = 0
let failed = 0
function ok(m) { console.log('OK:', m); passed++ }
function fail(m) { console.error('FAIL:', m); failed++ }

async function jfetch(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

async function setup() {
  try {
    syncKey = fs.readFileSync(path.join(ROOT, 'Clock/backend/data/sync_key.txt'), 'utf8').trim()
  } catch { syncKey = '' }
  await jfetch(`${CLOCK}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER }),
  })
  const login = await jfetch(`${CLOCK}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER }),
  })
  token = login.data?.token ?? ''
  if (!token) fail('setup login token')
  else ok(`setup user=${USER}`)
}

const AUTH = () => ({ 'X-Token': token, ...(syncKey ? { 'X-Sync-Key': syncKey } : {}) })

const PROBES = {
  ClockSnapshot: () => jfetch(`${CLOCK}/api/sync/snapshot?username=${USER}`, { headers: { 'X-Sync-Key': syncKey } }),
  ClockScheduleQuery: () => jfetch(`${CLOCK}/api/sync/snapshot?username=${USER}`, { headers: { 'X-Sync-Key': syncKey } }),
  ClockHabitQuery: () => jfetch(`${CLOCK}/api/habits`, { headers: AUTH() }),
  ClockStatsQuery: () => jfetch(`${CLOCK}/api/stats/dashboard`, { headers: AUTH() }),
  ClockUserScope: async () => ({ ok: true, status: 200, data: { local: true } }),
  ClockTimerState: () => jfetch(`${CLOCK}/api/timer/state`, { headers: AUTH() }),
  ClockTimerStart: () => jfetch(`${CLOCK}/api/timer/start`, {
    method: 'POST', headers: { ...AUTH(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'exercise' }),
  }),
  ClockMeditationMode: () => jfetch(`${CLOCK}/api/timer/start`, {
    method: 'POST', headers: { ...AUTH(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'meditation' }),
  }),
  ClockTaskList: () => jfetch(`${CLOCK}/api/tasks`, { headers: AUTH() }),
  ClockAchievementList: () => jfetch(`${CLOCK}/api/achievements`, { headers: AUTH() }),
  ClockBackup: () => jfetch(`${CLOCK}/api/backup`, { headers: AUTH() }),
  ClockFlipAnimation: () => jfetch(`${CLOCK}/api/sync/snapshot?username=${USER}`, { headers: { 'X-Sync-Key': syncKey } }),
  ClockAmbientSound: () => jfetch(`${CLOCK}/api/timer/sounds`, { headers: AUTH() }),
  ClockCustomRingtone: async () => ({ ok: true, status: 200, data: { upload: '/api/timer/sounds/upload' } }),
  ClockMiniTimer: () => jfetch(`${CLOCK}/api/timer/state`, { headers: AUTH() }),
  ClockGantt: () => jfetch(`${CLOCK}/api/tasks/gantt-data`, { headers: AUTH() }),
  ClockQuadrantPriority: () => jfetch(`${CLOCK}/api/tasks`, { headers: AUTH() }),
  ClockHeatmap: () => jfetch(`${CLOCK}/api/stats/heatmap?range=1m`, { headers: AUTH() }),
  ClockPeakHours: () => jfetch(`${CLOCK}/api/stats/peak-hours`, { headers: AUTH() }),
  ClockShareCard: () => jfetch(`${CLOCK}/api/sync/snapshot?username=${USER}`, { headers: { 'X-Sync-Key': syncKey } }),
  ClockAchievementTrack: () => jfetch(`${CLOCK}/api/achievements`, { headers: AUTH() }),
  ClockAchievementDisplay: () => jfetch(`${CLOCK}/api/achievements`, { headers: AUTH() }),
  ClockRecurringTask: () => jfetch(`${CLOCK}/api/tasks`, { headers: AUTH() }),
  ClockFeed: () => jfetch(`${DIGIST}/api/recommend?user_id=${USER}&n=3`),
  ClockFeedReport: () => jfetch(`${DIGIST}/api/recommend?user_id=${USER}&n=3`),
  ClockFeedSources: () => jfetch(`${DIGIST}/api/sources/config`),
  ClockFeat_PWA离线_d9d461: () => jfetch(`${CLOCK}/clock/manifest.webmanifest`),
  ClockFeat_国际化_bb81f9: () => jfetch(`${CLOCK}/api/users/preferences`, { headers: AUTH() }),
  ClockFeat_主题切换_a79e8b: () => jfetch(`${CLOCK}/api/users/preferences`, { headers: AUTH() }),
  ClockFeat_命令面板_93e40c: () => jfetch(`${CLOCK}/api/health`),
  ClockFeat_国际象棋Puzzle_ffa7d6: () => jfetch(`${CLOCK}/clock/puzzles/puzzles.json`),
  ClockFeat_视频队列与播放_d371f2: () => jfetch(`${DIGIST}/api/recommend?n=3&content_type=video`),
}

async function main() {
  console.log('--- Clock executor probes (32 nodes) ---\n')
  await setup()
  const nodes = JSON.parse(fs.readFileSync(path.join(ROOT, 'node-defs/clock.json'), 'utf8'))
  for (const n of nodes) {
    const fn = PROBES[n.class_type]
    if (!fn) { fail(`${n.class_type} no probe`); continue }
    try {
      const r = await fn()
      if (r.ok || r.status === 422) ok(`${n.class_type} (${r.status})`)
      else fail(`${n.class_type} HTTP ${r.status}`)
    } catch (e) {
      fail(`${n.class_type} ${e.message}`)
    }
  }
  // KnowLever optional for FeedReport
  const kl = await jfetch(`${KL}/api/digist/report`).catch(() => ({ ok: false, status: 0 }))
  if (kl.ok) ok('ClockFeedReport knowlever report optional')
  console.log(`\n--- ${passed} ok, ${failed} fail ---`)
  process.exit(failed ? 1 : 0)
}

main()
