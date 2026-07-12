<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { fetchServices, fetchWatchdogStatus, type ServiceInfo } from '@/api/process'
import { getCheckupRunHistory } from '@/engine/checkup-runner'
import EcosystemArchitecture from './EcosystemArchitecture.vue'

interface AlertItem {
  id: string
  severity?: string
  title?: string
  detail?: string
  message?: string
  source?: string
  timestamp?: string
}

const services = ref<ServiceInfo[]>([])
interface PrewarmService {
  name: string
  port: number
  online: boolean
  checked_at?: string
}
const prewarmServices = ref<PrewarmService[]>([])
const prewarmUpdatedAt = ref('')
const watchdogTargets = ref<{ name: string; status: string }[]>([])
const alerts = ref<AlertItem[]>([])
const checkupPending = ref(0)
const checkupProcessing = ref(0)
const checkupResolved = ref(0)
const checkupNeedsHuman = ref(0)
const checkupRunCount = ref(0)
const checkupRecentRuns = ref<Array<{ event_id: string; ok: boolean; started_at: string }>>([])
const loading = ref(false)
const error = ref('')

function cardClass(status: string): string {
  if (status === 'healthy' || status === 'running') return 'health-card--ok'
  if (status === 'restarting' || status === 'degraded') return 'health-card--warn'
  return 'health-card--bad'
}

async function loadEcosystemStatus() {
  try {
    const res = await fetch('/data/ecosystem-status.json', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      prewarmServices.value = []
      prewarmUpdatedAt.value = ''
      return
    }
    const data = await res.json() as { services?: PrewarmService[]; updated_at?: string }
    prewarmServices.value = data.services ?? []
    prewarmUpdatedAt.value = data.updated_at ?? ''
  } catch {
    prewarmServices.value = []
    prewarmUpdatedAt.value = ''
  }
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    await loadEcosystemStatus()
    services.value = await fetchServices()
    const wd = await fetchWatchdogStatus()
    watchdogTargets.value = (wd.targets ?? []).map(t => ({
      name: t.name,
      status: t.status,
    }))
    const res = await fetch('/api/ui/alerts', { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = await res.json()
      alerts.value = Array.isArray(data) ? data : data.alerts ?? []
    } else {
      alerts.value = []
    }
    const evRes = await fetch('/api/ui/checkup-events?limit=50', { signal: AbortSignal.timeout(5000) })
    if (evRes.ok) {
      const data = await evRes.json() as {
        stats?: { pending?: number; processing?: number; resolved?: number; needs_human?: number }
      }
      checkupPending.value = data.stats?.pending ?? 0
      checkupProcessing.value = data.stats?.processing ?? 0
      checkupResolved.value = data.stats?.resolved ?? 0
      checkupNeedsHuman.value = data.stats?.needs_human ?? 0
    }
    checkupRunCount.value = getCheckupRunHistory().length
    checkupRecentRuns.value = getCheckupRunHistory().slice(0, 5)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  refresh()
  timer = setInterval(refresh, 15000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

defineExpose({ refresh })
</script>

<template>
  <div class="health-overview">
    <div class="health-toolbar">
      <span class="health-title">生态健康总览</span>
      <button class="btn btn-sm" :disabled="loading" @click="refresh">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>
    <p v-if="error" class="health-error">{{ error }}</p>

    <section class="health-section">
      <h3>预探测服务（gate prewarm）</h3>
      <p v-if="prewarmUpdatedAt" class="health-meta">更新于 {{ prewarmUpdatedAt }}</p>
      <div class="health-grid">
        <div
          v-for="svc in prewarmServices"
          :key="`prewarm-${svc.name}`"
          class="health-card"
          :class="svc.online ? 'health-card--ok' : 'health-card--bad'"
        >
          <div class="health-card-name">{{ svc.name }}</div>
          <div class="health-card-status">{{ svc.online ? 'online' : 'offline' }} · :{{ svc.port }}</div>
        </div>
        <p v-if="!prewarmServices.length && !loading" class="health-empty">
          无预探测快照（运行 <code>node scripts/ensure-ecosystem-services.mjs</code>）
        </p>
      </div>
    </section>

    <section class="health-section">
      <h3>服务状态（PolarProcess）</h3>
      <div class="health-grid">
        <div
          v-for="svc in services"
          :key="String(svc.id ?? svc.name)"
          class="health-card"
          :class="cardClass(String(svc.status ?? 'unknown'))"
        >
          <div class="health-card-name">{{ svc.name ?? svc.id }}</div>
          <div class="health-card-status">{{ svc.status ?? 'unknown' }}</div>
        </div>
        <p v-if="!services.length && !loading" class="health-empty">无注册服务（PolarProcess 未运行？）</p>
      </div>
    </section>

    <section class="health-section">
      <h3>Watchdog</h3>
      <div class="health-grid">
        <div
          v-for="t in watchdogTargets"
          :key="t.name"
          class="health-card"
          :class="cardClass(t.status)"
        >
          <div class="health-card-name">{{ t.name }}</div>
          <div class="health-card-status">{{ t.status }}</div>
        </div>
        <p v-if="!watchdogTargets.length && !loading" class="health-empty">Watchdog 无监控目标</p>
      </div>
    </section>

    <section class="health-section">
      <h3>检修队列（@checkup-agent）</h3>
      <div class="health-grid">
        <div class="health-card health-card--warn">
          <div class="health-card-name">待处理</div>
          <div class="health-card-status">{{ checkupPending }}</div>
        </div>
        <div class="health-card health-card--warn">
          <div class="health-card-name">处理中</div>
          <div class="health-card-status">{{ checkupProcessing }}</div>
        </div>
        <div class="health-card health-card--ok">
          <div class="health-card-name">已解决</div>
          <div class="health-card-status">{{ checkupResolved }}</div>
        </div>
        <div class="health-card health-card--bad">
          <div class="health-card-name">需人工</div>
          <div class="health-card-status">{{ checkupNeedsHuman }}</div>
        </div>
        <div class="health-card health-card--ok">
          <div class="health-card-name">本机 pipeline runs</div>
          <div class="health-card-status">{{ checkupRunCount }}</div>
        </div>
      </div>
      <p class="health-empty">PolarUI 启动时自动订阅 SSE 并跑 CheckupTriageAndHeal</p>
      <ul v-if="checkupRecentRuns.length" class="health-runs">
        <li v-for="run in checkupRecentRuns" :key="run.event_id">
          <code>{{ run.event_id.slice(0, 8) }}…</code>
          {{ run.ok ? '✅' : '⚠️' }}
          <span class="health-run-time">{{ run.started_at }}</span>
        </li>
      </ul>
    </section>

    <section class="health-section">
      <h3>Hub 告警</h3>
      <ul class="health-alerts">
        <li v-for="a in alerts" :key="a.id" :class="'alert-' + (a.severity ?? 'info')">
          <strong>{{ a.source ?? 'system' }}</strong> — {{ a.title ?? a.message }} <span v-if="a.detail" class="alert-detail">{{ a.detail }}</span>
        </li>
        <li v-if="!alerts.length" class="health-empty">无未处理告警</li>
      </ul>
    </section>

    <section class="health-section health-arch-section">
      <h3>生态架构图（R9）</h3>
      <EcosystemArchitecture mode="full" />
    </section>
  </div>
</template>

<style scoped>
.health-overview {
  padding: 16px 20px;
  overflow-y: auto;
  height: 100%;
  color: var(--color-text);
  background: var(--color-bg);
}
.health-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.health-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-text);
}
.health-error {
  color: var(--color-error);
  margin-bottom: 12px;
}
.health-section {
  margin-bottom: 24px;
}
.health-section h3 {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  margin-bottom: 10px;
}
.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}
.health-card {
  border-radius: 8px;
  padding: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}
.health-card--ok {
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.health-card--warn {
  border-color: #fcd34d;
  background: #fffbeb;
}
.health-card--bad {
  border-color: #fecaca;
  background: #fef2f2;
}
.health-card-name {
  font-weight: 600;
  margin-bottom: 4px;
}
.health-card-status {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
.health-alerts {
  list-style: none;
  padding: 0;
  margin: 0;
}
.health-alerts li {
  padding: 8px 12px;
  margin-bottom: 6px;
  border-radius: 6px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-left: 3px solid #3b82f6;
  font-size: 0.9rem;
}
.health-alerts .alert-critical {
  border-left-color: var(--color-error);
  background: #fef2f2;
}
.health-alerts .alert-warning {
  border-left-color: #d97706;
  background: #fffbeb;
}
.health-empty {
  color: var(--color-text-muted);
  font-size: 0.9rem;
}
.health-meta {
  color: var(--color-text-muted);
  font-size: 0.8rem;
  margin: -6px 0 10px;
}
.health-arch-section {
  min-height: 480px;
}
.health-runs {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
  font-size: 12px;
}
.health-runs li {
  padding: 4px 0;
  color: var(--color-text-muted);
}
.health-run-time {
  font-family: var(--font-mono);
  font-size: 11px;
}
</style>
