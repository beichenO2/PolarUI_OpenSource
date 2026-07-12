<script setup lang="ts">
import ChatSidebar from './ChatSidebar.vue'
import RunsPanel from './RunsPanel.vue'

export type RightPanelTab = 'inspect' | 'chat' | 'runs'

const open = defineModel<boolean>('open', { default: false })
const activeTab = defineModel<RightPanelTab>('activeTab', { default: 'inspect' })
const width = defineModel<number>('width', { default: 340 })

const emit = defineEmits<{
  resized: []
}>()

const WIDTH_KEY = 'polarui.propertiesPanelWidth'
const MIN_W = 280
const MAX_W = 720

function closePanel(): void {
  open.value = false
}

function setTab(tab: RightPanelTab): void {
  activeTab.value = tab
}

function startResize(e: MouseEvent): void {
  const startX = e.clientX
  const startW = width.value
  const onMove = (ev: MouseEvent) => {
    width.value = Math.min(MAX_W, Math.max(MIN_W, startW - (ev.clientX - startX)))
  }
  const onUp = () => {
    localStorage.setItem(WIDTH_KEY, String(width.value))
    emit('resized')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <aside v-if="open" class="right-panel" :style="{ width: `${width}px` }">
    <div
      class="right-panel-resize"
      title="拖拽调节侧栏宽度"
      @mousedown.prevent="startResize"
    />
    <div class="right-panel-toolbar">
      <div class="right-panel-tabs">
        <button
          type="button"
          class="right-panel-tab"
          :class="{ active: activeTab === 'inspect' }"
          @click="setTab('inspect')"
        >
          属性
        </button>
        <button
          type="button"
          class="right-panel-tab"
          :class="{ active: activeTab === 'chat' }"
          @click="setTab('chat')"
        >
          Chat
        </button>
        <button
          type="button"
          class="right-panel-tab"
          :class="{ active: activeTab === 'runs' }"
          @click="setTab('runs')"
        >
          运行
        </button>
      </div>
      <button type="button" class="right-panel-close" title="关闭侧栏" @click="closePanel">×</button>
    </div>
    <div class="right-panel-body">
      <div v-show="activeTab === 'inspect'" class="right-panel-pane inspect-pane">
        <slot name="inspect" />
      </div>
      <div v-show="activeTab === 'chat'" class="right-panel-pane">
        <ChatSidebar />
      </div>
      <div v-show="activeTab === 'runs'" class="right-panel-pane">
        <RunsPanel />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.right-panel {
  position: relative;
  flex-shrink: 0;
  min-width: 280px;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-surface);
  border-left: 1px solid var(--color-border);
}

.right-panel-resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 2;
}

.right-panel-resize:hover {
  background: rgba(124, 58, 237, 0.15);
}

.right-panel-toolbar {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  border-bottom: 1px solid var(--color-border);
}

.right-panel-tabs {
  display: flex;
  flex: 1;
  min-width: 0;
}

.right-panel-tab {
  flex: 1;
  padding: 10px 12px;
  border: none;
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.right-panel-tab:hover:not(.active) {
  color: var(--color-text);
}

.right-panel-tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.right-panel-close {
  flex-shrink: 0;
  width: 36px;
  border: none;
  border-left: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.right-panel-close:hover {
  color: var(--color-text);
  background: var(--color-bg);
}

.right-panel-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.right-panel-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.inspect-pane {
  overflow-y: auto;
  padding: 16px;
  background: var(--color-surface);
  color: var(--color-text);
}
</style>
