import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { registry } from './engine/registry'

async function bootstrap() {
  // SSoT: ~/Polarisor/node-defs/ → symlink → public/node-defs/ → Vite serves as /node-defs/*
  const cacheBust = import.meta.env.DEV ? `?v=${Date.now()}` : ''
  const { loaded, errors } = await registry.loadFromUrl(`/node-defs/index.json${cacheBust}`)
  if (loaded === 0) {
    console.error('[PolarUI] FATAL: node-defs 加载失败，组件注册表为空。', errors)
    console.error('[PolarUI] 请确认 public/node-defs/ 目录 symlink 指向 ~/Polarisor/node-defs/')
  }

  const app = createApp(App)
  app.use(createPinia())
  app.mount('#app')
}

bootstrap()
