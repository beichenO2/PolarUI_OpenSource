import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { registry } from './engine/registry'
import { executeGraph as __keepExecuteGraphExport } from './engine/workflow-runner'

export { executeGraph } from './engine/workflow-runner'
export { loadWorkflowJson as parseWorkflow } from './engine/loader'
export { registerExecutor } from './engine/executor'

void __keepExecuteGraphExport

/** Keep headless e/l/r exports on main chunk (evolution-gate sidecar; ADR-010 stub). */
import('./engine/evolution-gate-stub').then((m) => {
  void m.runEvolutionGate
})

async function bootstrap() {
  // SSoT: node-defs/ (versioned) → build copies to dist/node-defs/ → served as /node-defs/*
  const cacheBust = import.meta.env.DEV ? `?v=${Date.now()}` : ''
  const { loaded, errors } = await registry.loadFromUrl(`/node-defs/index.json${cacheBust}`)
  if (loaded === 0) {
    console.error('[PolarUI] FATAL: node-defs 加载失败，组件注册表为空。', errors)
    console.error('[PolarUI] 请确认 node-defs/ 存在且 build 已 sync 到 dist/node-defs/')
  }

  if ((globalThis as { __POLAR_HEADLESS__?: boolean }).__POLAR_HEADLESS__) return

  const app = createApp(App)
  app.use(createPinia())
  app.mount('#app')
}

bootstrap()
