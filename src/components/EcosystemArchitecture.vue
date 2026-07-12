<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { GraphCanvas } from '@/engine/canvas'
import { Graph } from '@/engine/graph'
import { scanEcosystem } from '@/engine/ssot-compiler'
import {
  buildFullEcosystemArchitecture,
  buildControlFlowArchitecture,
  buildProjectArchitecture,
} from '@/engine/ecosystem-architecture'
import { fetchServices, fetchWatchdogStatus } from '@/api/process'

const props = defineProps<{ mode?: 'full' | 'control' | 'projects' }>()

const canvasEl = ref<HTMLCanvasElement>()
let canvas: GraphCanvas | null = null
const loading = ref(false)
const error = ref('')
const graphName = ref('')

async function loadArchitecture() {
  loading.value = true
  error.value = ''
  try {
    const [projects, services, wdRaw] = await Promise.all([
      scanEcosystem('/api'),
      fetchServices().catch(() => []),
      fetchWatchdogStatus().catch(() => ({ targets: [] })),
    ])
    const wdTargets = Array.isArray(wdRaw)
      ? wdRaw.map((t: { name: string; status: string }) => ({ name: t.name, status: t.status }))
      : (wdRaw.targets ?? [])

    let graph: Graph
    const mode = props.mode ?? 'full'
    if (mode === 'control') {
      graph = buildControlFlowArchitecture(services, wdTargets)
    } else if (mode === 'projects') {
      graph = buildProjectArchitecture(projects)
    } else {
      graph = buildFullEcosystemArchitecture(projects, services, wdTargets)
    }
    graphName.value = graph.name

    if (canvasEl.value) {
      canvas?.destroy()
      canvas = new GraphCanvas(canvasEl.value, graph)
      canvas.fitToContent()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => loadArchitecture())
onUnmounted(() => canvas?.destroy())

defineExpose({ reload: loadArchitecture })
</script>

<template>
  <div class="eco-arch">
    <div class="eco-arch-toolbar">
      <span class="eco-arch-title">{{ graphName || '生态架构图' }}</span>
      <button class="btn btn-sm" :disabled="loading" @click="loadArchitecture">
        {{ loading ? '加载中…' : '刷新架构' }}
      </button>
    </div>
    <p v-if="error" class="eco-arch-error">{{ error }}</p>
    <div class="eco-arch-canvas-wrap">
      <canvas ref="canvasEl" />
    </div>
  </div>
</template>

<style scoped>
.eco-arch {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 420px;
}
.eco-arch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.eco-arch-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text);
}
.eco-arch-error {
  color: var(--color-error);
  padding: 8px 12px;
  margin: 0;
}
.eco-arch-canvas-wrap {
  flex: 1;
  min-height: 360px;
  position: relative;
}
.eco-arch-canvas-wrap canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
