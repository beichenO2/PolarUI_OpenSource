import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { resolve, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const wfFrame = readFileSync(resolve(__dirname, 'prompts/mode-wf-system.txt'), 'utf8').trim()
const lgFrame = readFileSync(resolve(__dirname, 'prompts/mode-lg-system.txt'), 'utf8').trim()

const outDir = process.env.POLARUI_OUT_DIR ?? 'dist'

export default defineConfig({
  plugins: [
    vue(),
    nodePolyfills({ include: ['path', 'fs', 'url'] }),
  ],
  define: {
    'globalThis.__POLARUI_WF_FRAME__': JSON.stringify(wfFrame),
    'globalThis.__POLARUI_LG_FRAME__': JSON.stringify(lgFrame),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir,
    emptyOutDir: outDir === 'dist-next',
    sourcemap: false,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
    },
  },
  server: {
    port: 5170,
    proxy: {
      '/api': {
        target: 'http://localhost:8040',
        changeOrigin: true,
      },
    },
  },
})
