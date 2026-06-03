import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const wfFrame = readFileSync(resolve(__dirname, 'prompts/mode-wf-system.txt'), 'utf8').trim()
const lgFrame = readFileSync(resolve(__dirname, 'prompts/mode-lg-system.txt'), 'utf8').trim()

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
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5170,
    proxy: {
      '/api': {
        target: 'http://localhost:8040',
        changeOrigin: true,
      }
    }
  }
})
