<template>
  <div class="app-container">
    <header class="app-header">
      <div class="header-left">
        <span class="logo">◈ PolarUI</span>
        <span class="ui-build-stamp" title="260531 · 宋体">宋体·260531</span>
        <div class="mode-tabs">
          <button class="mode-tab" :class="{ active: viewMode === 'workflow' }" @click="viewMode = 'workflow'">工作流</button>
          <button class="mode-tab" :class="{ active: viewMode === 'ssot' }" @click="viewMode = 'ssot'">SSoT</button>
          <button class="mode-tab" :class="{ active: viewMode === 'health' }" @click="viewMode = 'health'">健康</button>
        </div>
        <div class="quick-mode-bar" v-if="viewMode === 'workflow'">
          <span class="quick-label">便捷</span>
          <button class="btn btn-sm" @click="quickStartAgentMode('IDEAgent')">IDE</button>
          <button class="btn btn-sm" @click="quickStartAgentMode('WebAgent')">Web</button>
          <button class="btn btn-sm" @click="quickStartAgentMode('FeishuRelay')">飞书</button>
          <span class="quick-label">原模型</span>
          <button class="btn btn-sm" @click="quickLoadSeed()">MVP Seed</button>
        </div>
      </div>
      <div class="header-center">
        <span class="workflow-name">{{ workflowStore.currentName }}</span>
        <template v-if="viewMode === 'workflow'">
          <button class="btn btn-run" @click="executeWorkflow" :disabled="workflowStore.execution.status === 'running'">
            <span v-if="workflowStore.execution.status === 'running'" class="spinner" />
            {{ workflowStore.execution.status === 'running' ? '▶ 执行中' : '▶ 执行' }}
          </button>
          <button
            class="btn"
            :class="{ 'btn-compile-fail': !compileCheckResult.valid }"
            @click="runCompileCheck"
            title="校验组件注册、必填输入接线与引用完整性"
          >🔍 编译检查</button>
          <button
            class="btn btn-sm"
            title="在视口中心添加注释卡片（特殊类，不参与执行）"
            @click="addNoteCardAtViewCenter"
          >📝 注释</button>
          <button class="btn" @click="openJsonFile">📂 打开</button>
          <button class="btn" @click="exportWorkflow">💾 导出</button>
          <button
            class="btn btn-deploy"
            title="部署到统一 Chat 壳（:3910/chat）"
            @click="deployWorkflow"
            :disabled="deploying"
          >
            <span v-if="deploying" class="spinner" />
            {{ deploying ? '部署中…' : '🚀 部署' }}
          </button>
          <button
            class="btn"
            :class="{ active: chatSidebarOpen }"
            title="侧边栏 Chat（部署后可对话）"
            @click="chatSidebarOpen = !chatSidebarOpen"
          >
            💬 Chat
          </button>
          <button class="btn suggestion-btn" @click="suggestionInboxOpen = true">
            💡 建议
            <span v-if="suggestionPending > 0" class="suggestion-badge" />
          </button>
        </template>
        <template v-else>
          <button class="btn btn-uptodate" @click="handleUpToDate" :disabled="ssotUpdating">
            <span v-if="ssotUpdating" class="spinner" />
            {{ ssotUpdating ? '检查中...' : 'Up to date' }}
          </button>
          <button class="btn btn-run" @click="handleExecPending" :disabled="ssotExecuting">
            <span v-if="ssotExecuting" class="spinner" />
            {{ ssotExecuting ? '执行中...' : '执行未完成项' }}
          </button>
        </template>
      </div>
      <div class="header-right">
        <span class="vault-status" :class="{ connected: vaultUnlocked }" :title="vaultUnlocked ? 'PolarPrivate vault 已解锁' : 'PolarPrivate 未就绪或 vault 未解锁'">
          {{ vaultUnlocked ? '● Vault' : '○ Vault' }}
        </span>
        <span class="hub-status" :class="{ connected: hubConnected }">
          {{ hubConnected ? '● Hub' : '○ Hub' }}
        </span>
        <button class="btn btn-sm" @click="fitView">适配</button>
        <button
          v-if="viewMode !== 'health' && canResetLayout"
          class="btn btn-sm"
          title="清除已记忆的布局并恢复默认自动排布"
          @click="resetLayout"
        >重置布局</button>
      </div>
    </header>

    <div class="main-content">
      <aside class="node-palette">
        <div class="palette-header palette-header--stacked" v-if="viewMode === 'workflow'">
          <div class="ssot-panel-tabs">
            <button class="panel-tab" :class="{ active: workflowPanelMode === 'registry' }" @click="workflowPanelMode = 'registry'">已注册</button>
            <button class="panel-tab" :class="{ active: workflowPanelMode === 'components' }" @click="workflowPanelMode = 'components'">组件</button>
          </div>
        </div>
        <div class="palette-header" v-else>
          <div class="ssot-panel-tabs">
            <button class="panel-tab" :class="{ active: ssotPanelMode === 'ecosystem' }" @click="ssotPanelMode = 'ecosystem'">生态地图</button>
            <button class="panel-tab" :class="{ active: ssotPanelMode === 'components' }" @click="ssotPanelMode = 'components'">组件</button>
          </div>
        </div>

        <!-- 已注册工作流面板（工作流模式） -->
        <template v-if="viewMode === 'workflow' && workflowPanelMode === 'registry'">
          <input v-model="registrySearch" class="palette-search" placeholder="搜索已注册工作流..." />
          <template v-for="group in registryWorkflowGroups" :key="group.category">
            <div
              class="category-title registry-section-title collapsible"
              @click="toggleCategory('registry:' + group.category)"
            >
              <span class="collapse-icon">{{ collapsedCategories.has('registry:' + group.category) ? '▶' : '▼' }}</span>
              {{ group.category }}
              <span class="category-count">{{ group.items.length }}</span>
            </div>
            <div v-if="!collapsedCategories.has('registry:' + group.category)" class="ecosystem-list registry-palette-section">
              <div
                v-for="wf in group.items"
                :key="wf.id"
                class="ecosystem-item ecosystem-item--draggable"
                :class="{ 'ecosystem-item--active': activeRegistryId === wf.id }"
                draggable="true"
                @dragstart="onDragStartRegistry($event, wf)"
                @click="openRegistryItem(wf)"
              >
                <div class="eco-item-header">
                  <span class="eco-dot active" />
                  <span class="eco-name">{{ wf.name }}</span>
                  <span class="eco-tier">{{ wf.nodeCount ? wf.nodeCount + '组件' : '范式' }}</span>
                </div>
                <div class="eco-item-progress" v-if="wf.description">
                  <span class="eco-progress-text" style="flex:1; white-space:normal; line-height:1.3;">{{ wf.description }}</span>
                </div>
              </div>
            </div>
          </template>
          <div
            v-if="registryWorkflowGroups.length === 0"
            style="color:#6e7681; font-size:11px; padding:12px; text-align:center;"
          >
            暂无匹配项<br />工作流 CLI：<br /><code style="font-size:10px;">node cli/register-workflow.mjs &lt;file&gt;</code>
          </div>
        </template>

        <!-- 生态地图面板（SSoT 模式） -->
        <template v-if="viewMode === 'ssot' && ssotPanelMode === 'ecosystem'">
          <input
            v-model="searchQuery"
            class="palette-search"
            placeholder="搜索项目..."
          />
          <div class="ecosystem-list">
            <div
              v-for="proj in filteredEcosystemProjects"
              :key="proj.path"
              class="ecosystem-item"
              :class="{ 'ecosystem-item--active': currentSsotProject === proj.name }"
              @click="loadProjectSsot(proj)"
            >
              <div class="eco-item-header">
                <span class="eco-dot" :class="proj.status" />
                <span class="eco-name" v-html="highlightText(proj.name, searchQuery)" />
                <span class="eco-tier">{{ proj.tier }}</span>
              </div>
              <div class="eco-item-progress">
                <div class="eco-progress-bar">
                  <div class="eco-progress-fill" :style="{ width: (proj.requirementCount > 0 ? (proj.doneCount / proj.requirementCount) * 100 : 0) + '%' }" />
                </div>
                <span class="eco-progress-text">{{ proj.doneCount }}/{{ proj.requirementCount }}</span>
              </div>
            </div>
          </div>
          <button class="btn btn-sm eco-refresh" @click="refreshEcosystem">刷新生态</button>
        </template>

        <!-- 组件面板（工作流 palette 或 SSoT 组件） -->
        <template v-if="(viewMode === 'workflow' && workflowPanelMode === 'components') || (viewMode === 'ssot' && ssotPanelMode === 'components')">
        <input
          v-model="searchQuery"
          class="palette-search"
          placeholder="搜索组件..."
        />
        <template v-for="group in paletteGroups" :key="group.name">
          <div
            class="category-title collapsible"
            @click="toggleCategory(group.name)"
          >
            <span class="collapse-icon">{{ collapsedCategories.has(group.name) ? '▶' : '▼' }}</span>
            {{ group.name }}
            <span class="category-count">{{ group.nodeCount }}</span>
          </div>
          <template v-if="!collapsedCategories.has(group.name)">
            <div
              v-for="node in group.nodes"
              :key="node.class_type"
              class="palette-node"
              draggable="true"
              @dragstart="onDragStart($event, node.class_type)"
              :title="node.description"
            >
              <span class="node-dot" :style="{ background: node.color || '#30475e' }" />
              <span class="node-label" v-html="highlightText(node.display_name, searchQuery)" />
              <button
                v-if="isExpandableNode(node)"
                class="expand-btn"
                @click.stop="expandNodeToSubgraph(node.class_type)"
                title="展开为子图"
              >⤢</button>
            </div>
            <template v-if="group.children.length">
              <div v-for="sub in group.children" :key="sub.name" class="sub-category">
                <div class="sub-category-title collapsible" @click="toggleCategory(group.name + '/' + sub.name)">
                  <span class="collapse-icon">{{ collapsedCategories.has(group.name + '/' + sub.name) ? '▶' : '▼' }}</span>
                  {{ sub.name }}
                  <span class="category-count">{{ sub.nodes.length }}</span>
                </div>
                <template v-if="!collapsedCategories.has(group.name + '/' + sub.name)">
                <div
                  v-for="node in sub.nodes"
                  :key="node.class_type"
                  class="palette-node sub-node"
                  draggable="true"
                  @dragstart="onDragStart($event, node.class_type)"
                  :title="node.description"
                >
                  <span class="node-dot" :style="{ background: node.color || '#30475e' }" />
                  <span class="node-label" v-html="highlightText(node.display_name, searchQuery)" />
                  <button
                    v-if="isExpandableNode(node)"
                    class="expand-btn"
                    @click.stop="expandNodeToSubgraph(node.class_type)"
                    title="展开为子图"
                  >⤢</button>
                </div>
                </template>
              </div>
            </template>
          </template>
        </template>
        </template>
      </aside>

      <main v-if="viewMode === 'health'" class="canvas-area health-main">
        <HealthOverview />
      </main>

      <main
        v-else
        class="canvas-area"
        :class="{ 'canvas-area--split': expandedSubgraph }"
        @dragover.prevent
        @drop="onDrop"
      >
        <div class="canvas-primary" :class="{ 'canvas-primary--split': expandedSubgraph }">
          <canvas ref="canvasEl" />
          <div v-if="outputPip" class="output-pip" @mousedown.stop @click.stop>
            <div class="output-pip-header">
              <span class="output-pip-title">▷ {{ outputPip.title }}</span>
              <button type="button" class="output-pip-close" title="关闭预览" @click="closeOutputPip">✕</button>
            </div>
            <pre class="output-pip-body" :class="{ 'output-pip-body--error': outputPip.isError }">{{ outputPip.text }}</pre>
          </div>
        </div>
        <div v-if="expandedSubgraph" class="canvas-secondary">
          <div class="subgraph-header">
            <div class="subgraph-breadcrumb">
              <span v-for="(frame, i) in subgraphStack" :key="i" class="crumb">
                {{ frame.name }}<span v-if="i < subgraphStack.length - 1"> › </span>
              </span>
            </div>
            <div class="subgraph-actions">
              <button class="btn btn-sm btn-primary" @click="saveSubgraphAsCustomAgentTake">💾 回存为 Agent Take</button>
              <button v-if="subgraphStack.length > 1" class="btn btn-sm" @click="popSubgraph">← 上一层</button>
              <button class="btn btn-sm" @click="closeSubgraph">✕ 关闭</button>
            </div>
          </div>
          <canvas ref="subCanvasEl" />
        </div>
      </main>

      <aside
        class="properties-panel"
        v-if="selectedLinkDetail || selectedNodeDef"
        :style="{ width: `${propertiesPanelWidth}px` }"
      >
        <div
          class="properties-panel-resize"
          title="拖拽调节侧栏宽度"
          @mousedown.prevent="startPropertiesPanelResize"
        />
        <template v-if="selectedLinkDetail && !selectedNodeId">
          <div class="panel-header">连线</div>
          <div class="panel-desc">
            {{ selectedLinkDetail.fromLabel }} → {{ selectedLinkDetail.toLabel }}
          </div>
          <div class="panel-section">
            <div class="section-title">端口</div>
            <div class="slot-info">
              <span class="slot-dot output" /> {{ selectedLinkDetail.outSlot }}
              <span class="link-arrow">→</span>
              <span class="slot-dot input" /> {{ selectedLinkDetail.inSlot }}
            </div>
          </div>
          <div class="panel-section">
            <div class="section-title">数据流颜色</div>
            <div class="slot-info">
              <span class="link-color-swatch" :style="{ background: selectedLinkDetail.color }" />
              <span class="slot-type">同 payload 的连线同色</span>
            </div>
          </div>
          <div class="panel-section">
            <div class="section-title">上次执行数据</div>
            <pre class="link-payload-pre">{{ selectedLinkDetail.payloadPreview }}</pre>
          </div>
          <button class="btn btn-danger" @click="deleteSelected">删除连线 (Delete)</button>
        </template>

        <template v-else-if="selectedNodeDef">
        <div class="panel-header">{{ selectedNodeDef.display_name }}</div>
        <div class="panel-desc" v-if="selectedNodeDef.description">{{ selectedNodeDef.description }}</div>
        <div
          v-if="selectedComponentStatus"
          class="component-status"
          :class="`component-status--${selectedComponentStatus.kind}`"
        >
          {{ selectedComponentStatus.text }}
        </div>

        <div v-if="selectedNodeInstance?.class_type === 'NoteCard'" class="panel-section note-card-panel">
          <div class="section-title">特殊 · 注释</div>
          <p class="output-terminal-intro">
            不参与编译与执行。画布上<strong>双击</strong>展开/折叠；拖拽底边调整高度；下方数值改宽高/字号<strong>立即生效</strong>。
          </p>
          <div class="param-row">
            <label>当前尺寸</label>
            <span class="output-spec-value">{{ selectedNodeInstance.width }} × {{ selectedNodeInstance.height }} px</span>
          </div>
          <button type="button" class="btn btn-sm" @click="toggleNoteCardCollapsed">
            {{ selectedNodeInstance.collapsed !== false ? '展开卡片' : '折叠卡片' }}
          </button>
        </div>

        <div
          v-if="selectedComponentInputs.length && selectedNodeInstance?.class_type !== 'NoteCard'"
          class="panel-section"
        >
          <div class="section-title">输入</div>
          <p class="panel-hint">变量名已标在连线上；此处显示连线来源与运行后的实际值。</p>
          <div v-for="row in selectedComponentInputs" :key="row.name" class="input-value-row">
            <div class="input-value-head">
              <span class="input-value-name">{{ row.name }}</span>
              <span class="slot-type">({{ row.type }})</span>
            </div>
            <p v-if="row.slotDescription" class="input-slot-doc">{{ row.slotDescription }}</p>
            <div class="input-value-source">{{ row.sourceHint }}</div>
            <pre class="link-payload-pre input-value-body">{{ row.valuePreview }}</pre>
          </div>
        </div>

        <div
          v-if="selectedComponentOutputs.length && selectedNodeInstance?.class_type !== 'NoteCard'"
          class="panel-section"
        >
          <div class="section-title">输出</div>
          <p class="panel-hint">每个输出变量的含义；Run 后显示本组件实际写出值。</p>
          <div v-for="row in selectedComponentOutputs" :key="'out-' + row.name" class="input-value-row">
            <div class="input-value-head">
              <span class="input-value-name">{{ row.name }}</span>
              <span class="slot-type">({{ row.type }})</span>
            </div>
            <p v-if="row.slotDescription" class="input-slot-doc">{{ row.slotDescription }}</p>
            <div class="input-value-source">{{ row.sourceHint }}</div>
            <pre class="link-payload-pre input-value-body">{{ row.valuePreview }}</pre>
          </div>
        </div>

        <div
          v-if="selectedNextSteps.length && selectedNodeInstance?.class_type !== 'NoteCard'"
          class="panel-section"
        >
          <div class="section-title">下一步</div>
          <button
            v-for="step in selectedNextSteps"
            :key="step.linkId"
            type="button"
            class="next-step-btn"
            @click="focusWorkflowComponent(step.toNodeId)"
          >
            → {{ step.label }}
            <span class="next-step-wire">{{ step.wireLabel }}</span>
          </button>
        </div>

        <div v-if="selectedNodeExecution && !isGroundOutputNode" class="panel-section node-exec-preview">
          <div class="section-title">上次运行</div>
          <pre
            class="link-payload-pre"
            :class="{ 'output-pip-body--error': selectedNodeExecution.error }"
          >{{ selectedNodeExecution.error || selectedNodeExecution.preview }}</pre>
        </div>

        <div v-if="isGroundOutputNode" class="panel-section output-terminal-guide">
          <div class="section-title">输出节点说明</div>
          <p class="output-terminal-intro">
            工作流终点：汇聚上游 <code>content</code> 作为本分支最终交付。
            画布上以绿色卡片呈现；执行完成后卡片高亮，点击可画中画预览结果。
          </p>
          <div class="output-spec-row">
            <span class="output-spec-label">格式要求</span>
            <code class="output-spec-value">{{ selectedNodeParams.format || 'auto' }}</code>
          </div>
          <p class="output-format-hint">{{ selectedOutputFormatHint }}</p>
          <div class="param-row" v-if="selectedNodeInstance?.class_type === 'Output' && selectedNodeParams.merge_strategy">
            <label>合并策略</label>
            <span class="output-spec-value">{{ selectedNodeParams.merge_strategy }}</span>
          </div>
          <div class="param-row">
            <label>交付物说明</label>
            <textarea
              v-model="selectedNodeParams.output_description"
              class="param-input param-textarea"
              rows="3"
              placeholder="描述此接地点应输出/展示什么，例如：AutoOffice 生成的 PDF 报告路径…"
            />
          </div>
        </div>

        <!-- WorkflowMeta 画中画左右对比 -->
        <div v-if="selectedNodeDef.class_type === 'WorkflowMeta' && workflowMetaCompare" class="panel-section meta-compare-panel">
          <div class="section-title">画中画对比（左：原版 / 右：修改版）</div>
          <div class="meta-compare-status">
            {{ workflowMetaCompare.accepted ? '✅ 已采纳修改' : '⏸ 未采纳（沙箱失败或需审批）' }}
            · 变更 {{ workflowMetaCompare.change_count }} 处
          </div>
          <div class="meta-compare-grid">
            <div class="meta-compare-col">
              <div class="meta-compare-label">原版</div>
              <pre class="meta-compare-pre">{{ workflowMetaCompare.originalText }}</pre>
            </div>
            <div class="meta-compare-col">
              <div class="meta-compare-label">修改版</div>
              <pre class="meta-compare-pre">{{ workflowMetaCompare.modifiedText }}</pre>
            </div>
          </div>
        </div>

        <!-- 规划器执行区 -->
        <div v-if="selectedNodeDef.class_type === 'Planner'" class="panel-section polar-claw-exec">
          <button class="btn btn-run btn-full" @click="runPlanner" :disabled="plannerRunning">
            <span v-if="plannerRunning" class="spinner" />
            {{ plannerRunning ? '规划中...' : '▶ 执行规划' }}
          </button>
          <div class="exec-hint">输入目标描述后执行，规划器将通过 LLM 推理生成逻辑链（工作流）</div>
        </div>

        <div v-if="selectedNodeDef.params?.role_declaration" class="panel-section role-declaration">
          <details open>
            <summary class="section-title">角色声明</summary>
            <template v-if="isStructuredRoleDeclaration">
              <div class="param-row">
                <label>角色</label>
                <select v-model="roleFields.role" class="param-input">
                  <option value="master">master</option>
                  <option value="slave">slave</option>
                  <option value="peer">peer</option>
                </select>
              </div>
              <div class="param-row">
                <label>职责</label>
                <textarea v-model="roleFields.responsibility" class="param-input param-textarea" rows="2" placeholder="设计规则体系给其他 Agent 消费…" />
              </div>
              <div class="param-row">
                <label>约束</label>
                <textarea v-model="roleFields.constraints" class="param-input param-textarea" rows="2" placeholder="方案必须通用，不绑定专属格式…" />
              </div>
              <div class="param-row">
                <label>消费者</label>
                <input v-model="roleFields.consumers" class="param-input" placeholder="PolarClaw, PolarPilot, PolarUI…" />
              </div>
            </template>
            <textarea
              v-else
              v-model="selectedNodeParams.role_declaration"
              class="param-input param-textarea"
              rows="4"
              placeholder="注入 LLM system prompt 的身份/立场/边界…"
            />
          </details>
        </div>

        <details v-if="hasConfigurableParams" class="panel-section panel-config-details" open>
          <summary class="section-title">配置</summary>
          <div v-for="(param, key) in selectedNodeDef.params" :key="key" class="param-row" v-show="String(key) !== 'role_declaration' && !(isGroundOutputNode && key === 'output_description')">
            <label>{{ param.label || key }}</label>
            <select v-if="param.type === 'select'" v-model="selectedNodeParams[key as string]" class="param-input">
              <option v-for="opt in param.options" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <input v-else-if="param.type === 'number'" type="number" v-model.number="selectedNodeParams[key as string]" class="param-input" />
            <input v-else-if="param.type === 'boolean'" type="checkbox" v-model="selectedNodeParams[key as string]" />
            <textarea v-else-if="param.type === 'text'" v-model="selectedNodeParams[key as string]" class="param-input param-textarea" rows="4" :placeholder="key === 'prompt' ? '输入任务描述，如：帮我写一份雷达实验报告...' : ''" />
            <input v-else type="text" v-model="selectedNodeParams[key as string]" class="param-input" />
          </div>
        </details>

        <div
          v-if="selectedExecutorSnippet && selectedNodeInstance?.class_type !== 'NoteCard'"
          class="panel-section panel-code-section"
        >
          <div class="section-title-row">
            <span class="section-title">组成代码</span>
            <button type="button" class="btn btn-sm" title="只读源码文档（对标 Dify 翻页书）" @click="openExecutorSourceDoc">
              📖 源码
            </button>
          </div>
          <ExecutorSnippetView :source="selectedExecutorSnippet" />
        </div>
        <button class="btn btn-danger" @click="deleteSelected">删除组件 (Delete)</button>
        </template>
      </aside>

      <ChatSidebar v-if="chatSidebarOpen && viewMode === 'workflow'" />
    </div>

    <footer class="app-footer">
      <span>组件: {{ workflowStore.graph?.nodes.length || 0 }}</span>
      <span>连线: {{ workflowStore.graph?.links.length || 0 }}</span>
      <span
        v-if="compileCheckResult.errors.length"
        class="exec-warn compile-status compile-status--error"
        :title="compileCheckSummary"
        @click="compilePanelOpen = !compilePanelOpen"
      >
        编译错误: {{ compileCheckResult.errors.length }}
      </span>
      <span
        v-else-if="compileCheckResult.warnings.length"
        class="exec-warn compile-status compile-status--warn"
        :title="compileCheckSummary"
        @click="compilePanelOpen = !compilePanelOpen"
      >
        编译警告: {{ compileCheckResult.warnings.length }}
      </span>
      <span v-else-if="workflowStore.graph?.nodes.length" class="compile-status compile-status--ok">
        编译: 通过
      </span>
      <span v-if="wiringIssueCount > 0" class="exec-warn" title="存在未连接的必填输入">
        悬空端口: {{ wiringIssueCount }}
      </span>
      <span v-if="workflowStore.execution.status === 'running'" class="exec-running">
        执行中 {{ Math.round(workflowStore.execution.progress ?? 0) }}%
        <span class="exec-progress-bar">
          <span class="exec-progress-fill" :style="{ width: (workflowStore.execution.progress ?? 0) + '%' }" />
        </span>
      </span>
      <span v-else-if="workflowStore.execution.status === 'error'" class="exec-warn" :title="workflowStore.execution.error">
        执行失败
      </span>
      <span v-if="workflowStore.execution.unhealthy_nodes?.length" class="exec-warn">
        不健康组件: {{ workflowStore.execution.unhealthy_nodes.length }}
      </span>
      <span v-if="workflowStore.execution.last_run_at">
        上次执行: {{ new Date(workflowStore.execution.last_run_at).toLocaleTimeString() }}
      </span>
      <span v-if="workflowStore.execution.last_log_path" class="log-path-hint" :title="workflowStore.execution.last_log_path">
        📋 {{ workflowStore.execution.last_log_path }}
      </span>
    </footer>

    <div v-if="compilePanelOpen && compileCheckSummary" class="compile-panel">
      <div class="compile-panel-header">
        <span>编译检查结果</span>
        <button class="btn btn-sm" @click="compilePanelOpen = false">关闭</button>
      </div>
      <ul v-if="compileChecklist.length" class="compile-checklist">
        <li
          v-for="(item, idx) in compileChecklist"
          :key="idx"
          :class="['compile-checklist-item', `compile-checklist-item--${item.level}`, { 'compile-checklist-item--clickable': !!item.nodeId }]"
          @click="focusCompileCheckItem(item)"
        >
          {{ item.message }}
        </li>
      </ul>
      <pre class="compile-panel-body">{{ compileCheckSummary }}</pre>
    </div>

    <SuggestionInbox
      :open="suggestionInboxOpen"
      @close="suggestionInboxOpen = false"
      @approved="onSuggestionApproved"
    />

    <div v-if="executorDocOpen" class="executor-doc-overlay" @click.self="executorDocOpen = false">
      <div class="executor-doc-panel">
        <div class="executor-doc-header">
          <span>组成代码 · {{ selectedNodeDef?.display_name ?? '' }}</span>
          <button type="button" class="btn btn-sm" @click="executorDocOpen = false">关闭</button>
        </div>
        <ExecutorSnippetView :source="executorDocBody" class="executor-doc-body" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import ExecutorSnippetView from './components/ExecutorSnippetView.vue'
import { useWorkflowStore } from './stores/workflow'
import { GraphCanvas } from './engine/canvas'
import { Graph } from './engine/graph'
import { loadWorkflowJson, applyGraphAutoLayout, computeBackLinks } from './engine/loader'
import { formatLinkPayloadPreview, describeLinkEndpoints, getLinkPayload } from './engine/link-payload'
import {
  buildComponentInputRows,
  buildComponentOutputRows,
  buildComponentNextSteps,
  componentStatusFor,
  executorSnippetReadonly,
  executorSourceDocument,
} from './engine/properties-panel-helpers'
import { linkForwardColor, linkBackwardColor, buildLinkColorMaps } from './engine/wire-colors'
import { loadWorkflowByRef } from './engine/workflow-loader'
import { saveCustomWorkflow } from './engine/custom-workflows'
import { saveCustomAgent, restoreCustomAgentsFromStorage } from './engine/custom-agents'
import { registry } from './engine/registry'
import { hubApi } from './api/hub'
import { listModels } from './sdk/llm-proxy'
import { compileSsotToGraph, scanEcosystem } from './engine/ssot-compiler'
import { executePlanner, executePlannerViaPolarClaw } from './engine/planner-engine'
import { runUpToDate, runExecutePending } from './engine/ssot-actions'
import {
  loadRegistry,
  loadWorkflowFile,
  getCachedRegistry,
  filterRegistryPaletteEntries,
  isParadigmRegistryEntry,
  classTypeFromRegistryEntry,
  isAgenticNodeCategory,
  type WorkflowEntry,
} from './engine/workflow-registry'
import SuggestionInbox from './components/SuggestionInbox.vue'
import ChatSidebar from './components/ChatSidebar.vue'
import { loadSuggestions, pendingCount, type EvolutionSuggestion } from './engine/suggestion-store'
import {
  applyStoredLayout,
  saveStoredLayout,
  clearStoredLayout,
  registerBuiltinSubgraphLayoutKeys,
  applyBuiltinSubgraphDefaultLayout,
  applySsotDefaultLayout,
  readLastSession,
  writeLastSession,
  type LayoutScope,
} from './engine/layout-memory'
import type { NodeDef, WorkflowLibrary } from './engine/types'
import { defaultRoleDeclaration } from './engine/role-prompt'
import HealthOverview from './components/HealthOverview.vue'
import { startCheckupDaemon } from './engine/checkup-runner'
import { validateGraphWiring } from './engine/wire-integrity'
import {
  compileCheckGraph,
  compileChecklistItems,
  formatCompileCheckMessage,
  type CompileChecklistItem,
} from './engine/compile-check'
import { applyNoteCardLayout } from './engine/note-card-layout'
import { formatOutputPreview, getOutputResultContent } from './engine/output-result'
import { isPrivPortalHealthy } from './sdk/llm-proxy'

interface PaletteSubGroup {
  name: string
  nodes: NodeDef[]
}
interface PaletteGroup {
  name: string
  nodes: NodeDef[]
  children: PaletteSubGroup[]
  nodeCount: number
}

const workflowStore = useWorkflowStore()
const canvasEl = ref<HTMLCanvasElement>()
const subCanvasEl = ref<HTMLCanvasElement>()
let graphCanvas: GraphCanvas | null = null
let subGraphCanvas: GraphCanvas | null = null

interface SubgraphFrame {
  name: string
  graph: Graph
  classType: string
  sourceNodeId?: string
  layoutScope: LayoutScope
}

const mainLayoutScope = ref<LayoutScope | null>(null)
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleLayoutSave(graph: Graph, scope: LayoutScope): void {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer)
  layoutSaveTimer = setTimeout(() => {
    saveStoredLayout(graph, scope)
  }, 350)
}

/** 记忆布局 / Dagre 自动布局；无记忆时先排布再挂载画布，避免闪烁重叠占位 */
async function finalizeGraphLayout(
  graph: Graph,
  scope: LayoutScope | null,
  canvas: GraphCanvas | null,
): Promise<void> {
  if (!canvas) return
  const restored = scope ? applyStoredLayout(graph, scope) : false
  if (!restored && graph.nodes.length > 0) {
    await applyGraphAutoLayout(graph)
  }
  canvas.setGraph(graph)
  canvas.refreshWireRouting()
  canvas.fitToContent()
}

async function setMainGraph(graph: Graph, scope: LayoutScope | null): Promise<void> {
  workflowStore.setGraph(graph)
  mainLayoutScope.value = scope
  if (!graphCanvas) return
  await finalizeGraphLayout(graph, scope, graphCanvas)
}

const subgraphStack = ref<SubgraphFrame[]>([])
const expandedSubgraph = computed(() => subgraphStack.value[subgraphStack.value.length - 1] ?? null)
const canResetLayout = computed(() => {
  if (viewMode.value === 'health') return false
  if (expandedSubgraph.value) return true
  return mainLayoutScope.value != null && (workflowStore.graph?.nodes.length ?? 0) > 0
})

const wiringIssueCount = computed(() => {
  if (!workflowStore.graph?.nodes.length) return 0
  return validateGraphWiring(workflowStore.graph).issues.length
})
const compileCheckResult = computed(() => compileCheckGraph(workflowStore.graph))
const compileCheckSummary = computed(() => formatCompileCheckMessage(compileCheckResult.value, 20))
const compileChecklist = computed(() => compileChecklistItems(compileCheckResult.value))
const compilePanelOpen = ref(false)

function focusCompileCheckItem(item: CompileChecklistItem): void {
  if (!item.nodeId) return
  selectedNodeId.value = item.nodeId
  selectedLinkId.value = null
  graphCanvas?.focusNode(item.nodeId)
}
const hubConnected = ref(false)
const vaultUnlocked = ref(false)
const deploying = ref(false)
const chatSidebarOpen = ref(false)
const POLARCLAW_CHAT_BASE = import.meta.env.VITE_POLARCLAW_URL ?? 'http://127.0.0.1:3910'
const selectedNodeId = ref<string | null>(null)
const selectedLinkId = ref<string | null>(null)
const searchQuery = ref('')
const collapsedCategories = reactive(new Set<string>())

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function highlightText(text: string, query: string): string {
  const safe = escapeHtml(text)
  const q = query.trim()
  if (!q) return safe
  const re = new RegExp(`(${escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return safe.replace(re, '<mark class="search-hit">$1</mark>')
}
const viewMode = ref<'workflow' | 'ssot' | 'health'>('workflow')
const ssotPanelMode = ref<'ecosystem' | 'components'>('ecosystem')
const workflowPanelMode = ref<'registry' | 'components'>('registry')
const libraryMode = computed(() => workflowStore.graph?.library ?? 'WF')
const plannerRunning = ref(false)
const ssotUpdating = ref(false)
const ssotExecuting = ref(false)
const currentSsotProject = ref<string>('')
const currentSsotData = ref<Record<string, unknown> | null>(null)
const ecosystemProjects = ref<EcosystemProject[]>([])

interface EcosystemProject {
  name: string
  path: string
  tier: string
  status: string
  requirementCount: number
  doneCount: number
}

const registrySearch = ref('')
const registryWorkflows = ref<WorkflowEntry[]>([])
const activeRegistryId = ref<string>('')
const suggestionInboxOpen = ref(false)
const suggestionPending = ref(pendingCount(loadSuggestions()))
/** bump after dynamic model list refresh — palette param options react */
const registryVersion = ref(0)
watch(
  () => suggestionInboxOpen.value,
  (open) => {
    if (!open) suggestionPending.value = pendingCount(loadSuggestions())
  },
)

const filteredRegistryWorkflows = computed(() => {
  let list = filterRegistryPaletteEntries(registryWorkflows.value, libraryMode.value)
  if (!registrySearch.value) return list
  const q = registrySearch.value.toLowerCase()
  return list.filter(w =>
    w.name.toLowerCase().includes(q) ||
    w.description.toLowerCase().includes(q) ||
    w.category.toLowerCase().includes(q),
  )
})

/** 已注册：按 category 分组，组名与组内工作流均按首字母排序 */
const registryWorkflowGroups = computed(() => {
  const map = new Map<string, WorkflowEntry[]>()
  for (const wf of filteredRegistryWorkflows.value) {
    const cat = wf.category?.trim() || '未分类'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(wf)
  }
  return [...map.entries()]
    .map(([category, items]) => ({
      category,
      items: [...items].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    }))
    .sort((a, b) => a.category.localeCompare(b.category, 'zh'))
})

const SEED_REGISTRY: Record<'WF', string> = {
  WF: 'mvp-seed-wf',
}

async function quickLoadSeed() {
  workflowPanelMode.value = 'registry'
  const targetId = SEED_REGISTRY.WF
  let wf = registryWorkflows.value.find(w => w.id === targetId)
  if (!wf) {
    const entries = await loadRegistry()
    registryWorkflows.value = entries
    wf = entries.find(w => w.id === targetId)
  }
  if (wf) await loadRegisteredWorkflow(wf)
  else alert(`未找到 Seed ${targetId}，请检查 registry.json`)
}

function onSuggestionApproved(_sug: EvolutionSuggestion) {
  suggestionPending.value = pendingCount(loadSuggestions())
}


async function loadRegisteredWorkflow(wf: WorkflowEntry) {
  const json = await loadWorkflowFile(wf)
  if (json) {
    activeRegistryId.value = wf.id
    subgraphStack.value = []
    const newGraph = loadWorkflowJson(json)
    newGraph.library = 'WF'
    await setMainGraph(newGraph, { kind: 'registry', id: wf.id })
    writeLastSession({ viewMode: 'workflow', registryId: wf.id, libraryMode: 'WF' })
  } else {
    alert(`无法加载: ${wf.file}`)
  }
}

function toggleCategory(name: string) {
  if (collapsedCategories.has(name)) collapsedCategories.delete(name)
  else collapsedCategories.add(name)
}

function isExpandableNode(nodeDef: NodeDef): boolean {
  return nodeDef.expandable === true || nodeDef.params?.expandable?.default === true
}

async function mountSubGraphCanvas(graph: Graph, layoutScope: LayoutScope) {
  await nextTick()
  if (subCanvasEl.value) {
    subGraphCanvas?.destroy()
    subGraphCanvas = new GraphCanvas(subCanvasEl.value, graph)
    subGraphCanvas.onNodeSelected = (id) => {
      selectedNodeId.value = id
      if (id) selectedLinkId.value = null
    }
    subGraphCanvas.onLinkSelected = (id) => {
      selectedLinkId.value = id
      if (id) selectedNodeId.value = null
    }
    subGraphCanvas.onExpandNode = (_nodeId, classType) => {
      void expandNodeToSubgraph(classType, true)
    }
    subGraphCanvas.onWorkflowChanged = () => {
      scheduleLayoutSave(graph, layoutScope)
    }
    subGraphCanvas.onOutputPreview = openOutputPip
    subGraphCanvas.setExecutionResults(workflowStore.execution.results)
    await finalizeGraphLayout(graph, layoutScope, subGraphCanvas)
  }
  graphCanvas?.resize()
}

async function pushSubgraphFrame(frame: SubgraphFrame) {
  subgraphStack.value.push(frame)
  await mountSubGraphCanvas(frame.graph, frame.layoutScope)
}

async function expandNodeToSubgraph(classType: string, nested = false) {
  const def = registry.get(classType)
  if (!def) return

  if (classType === 'PetriDish') {
    const inst = workflowStore.graph.nodes.find(n => n.class_type === 'PetriDish')
    const slaveRef = String(inst?.params.slave_workflow ?? '').trim()
    if (slaveRef) {
      const ref = slaveRef.replace(/^workflows\//, '')
      const subGraph = await loadWorkflowByRef(ref)
      if (subGraph) {
        subGraph.library = workflowStore.graph.library
        await pushSubgraphFrame({
          name: `${def.display_name} — Slave 子工作流`,
          graph: subGraph,
          classType,
          layoutScope: { kind: 'workflow-ref', ref },
        })
        return
      }
    }
  }

  if (def.internal_workflow) {
    const subGraph = await loadWorkflowByRef(def.internal_workflow)
    if (subGraph) {
      const layoutScope: LayoutScope = def.internal_workflow.startsWith('custom/')
        ? { kind: 'custom', id: def.internal_workflow.replace(/^custom\//, '') }
        : { kind: 'workflow-ref', ref: def.internal_workflow }
      await pushSubgraphFrame({
        name: `${def.display_name} — 内部结构`,
        graph: subGraph,
        classType,
        layoutScope,
      })
      return
    }
  }

  const subGraph = new Graph(`${def.display_name} — 内部结构`)
  const sx = 60
  const sy = 60
  const sp = 260

  if (classType === 'AgenticUnit') {
    const promptIn = subGraph.addNode('PromptInput', sx, sy)
    const promptInj = subGraph.addNode('PromptInject', sx, sy + 180)
    const workLLM = subGraph.addNode('LLM', sx + sp, sy)
    const validator = subGraph.addNode('Validator', sx + sp * 2, sy)
    const retryLoop = subGraph.addNode('RetryLoop', sx + sp * 2, sy + 180)
    const output = subGraph.addNode('Output', sx + sp * 3, sy)

    if (promptIn && workLLM) subGraph.addLink(promptIn.id, 0, workLLM.id, 0)
    if (promptInj && workLLM) subGraph.addLink(promptInj.id, 0, workLLM.id, 1)
    if (workLLM && validator) subGraph.addLink(workLLM.id, 0, validator.id, 1)
    if (promptIn && validator) subGraph.addLink(promptIn.id, 0, validator.id, 0)
    if (validator && retryLoop) subGraph.addLink(validator.id, 0, retryLoop.id, 0)
    if (validator && output) subGraph.addLink(validator.id, 0, output.id, 0)
    if (retryLoop && workLLM) subGraph.addLink(retryLoop.id, 0, workLLM.id, 0)
  } else if (classType === 'AgenticChain') {
    const promptIn = subGraph.addNode('PromptInput', sx, sy)
    const llm1 = subGraph.addNode('LLM', sx + sp, sy)
    const val1 = subGraph.addNode('Validator', sx + sp * 2, sy)
    const retry1 = subGraph.addNode('RetryLoop', sx + sp * 2, sy + 180)
    const llm2 = subGraph.addNode('LLM', sx + sp * 3, sy)
    const val2 = subGraph.addNode('Validator', sx + sp * 4, sy)
    const output = subGraph.addNode('Output', sx + sp * 5, sy)

    if (promptIn && llm1) subGraph.addLink(promptIn.id, 0, llm1.id, 0)
    if (llm1 && val1) subGraph.addLink(llm1.id, 0, val1.id, 1)
    if (val1 && retry1) subGraph.addLink(val1.id, 0, retry1.id, 0)
    if (retry1 && llm1) subGraph.addLink(retry1.id, 0, llm1.id, 0)
    if (val1 && llm2) subGraph.addLink(val1.id, 0, llm2.id, 0)
    if (llm2 && val2) subGraph.addLink(llm2.id, 0, val2.id, 1)
    if (val2 && output) subGraph.addLink(val2.id, 0, output.id, 0)
  } else {
    const promptIn = subGraph.addNode('PromptInput', sx, sy)
    const llm = subGraph.addNode('LLM', sx + sp, sy)
    const output = subGraph.addNode('Output', sx + sp * 2, sy)

    if (promptIn && llm) subGraph.addLink(promptIn.id, 0, llm.id, 0)
    if (llm && output) subGraph.addLink(llm.id, 0, output.id, 0)
  }

  registerBuiltinSubgraphLayoutKeys(subGraph)
  await pushSubgraphFrame({
    name: `${def.display_name} — 内部结构`,
    graph: subGraph,
    classType,
    layoutScope: { kind: 'builtin-subgraph', classType },
  })
}

function popSubgraph() {
  if (subgraphStack.value.length <= 1) {
    closeSubgraph()
    return
  }
  subgraphStack.value.pop()
  const top = subgraphStack.value[subgraphStack.value.length - 1]
  if (top) void mountSubGraphCanvas(top.graph, top.layoutScope)
}

function saveSubgraphAsCustomAgentTake() {
  const frame = expandedSubgraph.value
  if (!frame) return
  const name = window.prompt('自定义 Agent Take 名称', `${frame.classType} 定制版`)
  if (!name?.trim()) return
  const wf = frame.graph.toWorkflow()
  const saved = saveCustomWorkflow(name.trim(), wf, { source_class_type: frame.classType })
  const agent = saveCustomAgent({
    display_name: name.trim(),
    internal_workflow: `custom/${saved.id}`,
    source_class_type: frame.classType,
  })
  window.alert(`已回存为 ${agent.class_type}\n可在组件面板 Agentic/Custom 中拖入画布使用。`)
}

function closeSubgraph() {
  subgraphStack.value = []
  subGraphCanvas?.destroy()
  subGraphCanvas = null
  nextTick(() => {
    if (graphCanvas) graphCanvas.resize()
  })
}

const paletteGroups = computed((): PaletteGroup[] => {
  void registryVersion.value
  const modeFiltered = viewMode.value === 'ssot'
    ? registry.getAll().filter(n => n.category.startsWith('SSoT/'))
    : viewMode.value === 'workflow'
      ? registry.getPaletteNodes(libraryMode.value).filter(
          n => !n.category.startsWith('SSoT/') && !isAgenticNodeCategory(n.category),
        )
      : registry.getAll().filter(n => !n.category.startsWith('SSoT/'))
  const filtered = searchQuery.value
    ? modeFiltered.filter(n => {
        const q = searchQuery.value.toLowerCase()
        return (
          n.display_name.toLowerCase().includes(q) ||
          n.class_type.toLowerCase().includes(q) ||
          (n.description || '').toLowerCase().includes(q) ||
          (n.category || '').toLowerCase().includes(q)
        )
      })
    : modeFiltered

  const topMap = new Map<string, { nodes: NodeDef[]; subs: Map<string, NodeDef[]> }>()

  for (const node of filtered) {
    const parts = node.category.split('/')
    const top = parts[0]
    const sub = parts.slice(1).join('/')

    if (!topMap.has(top)) topMap.set(top, { nodes: [], subs: new Map() })
    const entry = topMap.get(top)!

    if (sub) {
      if (!entry.subs.has(sub)) entry.subs.set(sub, [])
      entry.subs.get(sub)!.push(node)
    } else {
      entry.nodes.push(node)
    }
  }

  const groups: PaletteGroup[] = []
  for (const [name, entry] of topMap) {
    const children: PaletteSubGroup[] = []
    let totalCount = entry.nodes.length
    for (const [subName, subNodes] of entry.subs) {
      children.push({ name: subName, nodes: subNodes })
      totalCount += subNodes.length
    }
    groups.push({ name, nodes: entry.nodes, children, nodeCount: totalCount })
  }

  const order = viewMode.value === 'ssot'
    ? ['SSoT']
    : ['LLM', 'Control', 'Input', 'Output', 'Transform', 'Memory', 'History', 'Tools', 'Agentic', 'Evolve', '特殊']
  groups.sort((a, b) => {
    const ai = order.indexOf(a.name)
    const bi = order.indexOf(b.name)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  return groups
})

const selectedLinkDetail = computed(() => {
  if (!selectedLinkId.value || !workflowStore.graph || selectedNodeId.value) return null
  const link = workflowStore.graph.links.find(l => l.id === selectedLinkId.value)
  if (!link) return null
  const endpoints = describeLinkEndpoints(link, workflowStore.graph.nodes)
  const payload = getLinkPayload(link, workflowStore.graph.nodes, workflowStore.execution.results)
  const backLinks = computeBackLinks(workflowStore.graph)
  const maps = buildLinkColorMaps(
    workflowStore.graph.links,
    workflowStore.graph.nodes,
    backLinks,
    workflowStore.execution.results,
  )
  const color = maps.backwardByLink.has(link.id)
    ? linkBackwardColor(link.id, maps)
    : linkForwardColor(link.id, maps)
  return {
    ...endpoints,
    payloadPreview: formatLinkPayloadPreview(payload),
    color,
  }
})

const selectedNodeDef = computed(() => {
  if (!selectedNodeId.value) return null
  const node = workflowStore.graph?.nodes.find(n => n.id === selectedNodeId.value)
  if (!node) return null
  return registry.get(node.class_type) || null
})

const selectedNodeInstance = computed(() => {
  if (!selectedNodeId.value) return null
  return workflowStore.graph?.nodes.find(n => n.id === selectedNodeId.value) ?? null
})

const isGroundOutputNode = computed(() => {
  return selectedNodeInstance.value?.class_type === 'Output'
})

const selectedNodeExecution = computed(() => {
  if (!selectedNodeId.value) return null
  const streaming = workflowStore.execution.streaming?.[selectedNodeId.value]
  const result = workflowStore.execution.results?.[selectedNodeId.value]
  if (!streaming && !result) return null
  return {
    streaming: streaming ?? '',
    error: result?.error as string | undefined,
    preview: result?.outputs
      ? formatOutputPreview(result.outputs)
      : streaming ?? '',
    running: workflowStore.execution.status === 'running'
      && workflowStore.execution.current_node === selectedNodeId.value,
  }
})

const PROPERTIES_PANEL_WIDTH_KEY = 'polarui.propertiesPanelWidth'
const PROPERTIES_PANEL_MIN = 280
const PROPERTIES_PANEL_MAX = 720
const propertiesPanelWidth = ref(
  Math.min(
    PROPERTIES_PANEL_MAX,
    Math.max(
      PROPERTIES_PANEL_MIN,
      Number(localStorage.getItem(PROPERTIES_PANEL_WIDTH_KEY)) || 320,
    ),
  ),
)
function startPropertiesPanelResize(e: MouseEvent): void {
  const startX = e.clientX
  const startW = propertiesPanelWidth.value
  const onMove = (ev: MouseEvent) => {
    const next = Math.min(
      PROPERTIES_PANEL_MAX,
      Math.max(PROPERTIES_PANEL_MIN, startW - (ev.clientX - startX)),
    )
    propertiesPanelWidth.value = next
  }
  const onUp = () => {
    localStorage.setItem(PROPERTIES_PANEL_WIDTH_KEY, String(propertiesPanelWidth.value))
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    graphCanvas?.resize()
    subGraphCanvas?.resize()
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const selectedComponentStatus = computed(() => {
  if (!selectedNodeId.value) return null
  return componentStatusFor(selectedNodeId.value, workflowStore.execution)
})

const selectedComponentInputs = computed(() => {
  const node = selectedNodeInstance.value
  const def = selectedNodeDef.value
  const graph = workflowStore.graph
  if (!node || !def || !graph) return []
  return buildComponentInputRows(graph, node, def, workflowStore.execution.results)
})

const selectedComponentOutputs = computed(() => {
  const node = selectedNodeInstance.value
  const def = selectedNodeDef.value
  const graph = workflowStore.graph
  if (!node || !def || !graph || !def.outputs.length) return []
  return buildComponentOutputRows(graph, node, def, workflowStore.execution.results)
})

const selectedNextSteps = computed(() => {
  const id = selectedNodeId.value
  const graph = workflowStore.graph
  if (!id || !graph) return []
  return buildComponentNextSteps(graph, id, selectedNodeDef.value)
})

const selectedExecutorSnippet = computed(() => {
  const ct = selectedNodeInstance.value?.class_type
  if (!ct || ct === 'NoteCard') return null
  return executorSnippetReadonly(ct)
})

const hasConfigurableParams = computed(() => {
  const params = selectedNodeDef.value?.params
  if (!params) return false
  return Object.keys(params).some(
    k => k !== 'role_declaration' && !(isGroundOutputNode.value && k === 'output_description'),
  )
})

function focusWorkflowComponent(componentId: string): void {
  selectedNodeId.value = componentId
  selectedLinkId.value = null
  graphCanvas?.focusNode(componentId)
}

const executorDocOpen = ref(false)
const executorDocBody = computed(() => {
  const ct = selectedNodeInstance.value?.class_type
  if (!ct) return ''
  return executorSourceDocument(ct)
})

function openExecutorSourceDoc(): void {
  if (!selectedNodeInstance.value?.class_type) return
  executorDocOpen.value = true
}

const outputPip = ref<{ nodeId: string; title: string; text: string; isError: boolean } | null>(null)

function openOutputPip(nodeId: string) {
  const node = workflowStore.graph?.nodes.find(n => n.id === nodeId)
  const def = node ? registry.get(node.class_type) : null
  const title = def?.display_name ?? 'Output'
  const r = workflowStore.execution.results?.[nodeId]
  if (r?.error) {
    outputPip.value = { nodeId, title, text: r.error, isError: true }
    return
  }
  const content = getOutputResultContent(nodeId, workflowStore.execution.results)
  if (content === null) {
    outputPip.value = {
      nodeId,
      title,
      text: '尚无执行结果。请先运行工作流，或检查上游节点是否已连接到 Output。',
      isError: false,
    }
    return
  }
  outputPip.value = { nodeId, title, text: formatOutputPreview(content), isError: false }
}

function closeOutputPip() {
  outputPip.value = null
}

function syncCanvasExecutionResults() {
  graphCanvas?.setExecutionResults(workflowStore.execution.results)
  subGraphCanvas?.setExecutionResults(workflowStore.execution.results)
  graphCanvas?.setNodeStates(workflowStore.execution.node_states)
  subGraphCanvas?.setNodeStates(workflowStore.execution.node_states)
}

const selectedNodeParams = computed((): Record<string, any> => {
  if (!selectedNodeId.value) return {}
  const node = workflowStore.graph?.nodes.find(n => n.id === selectedNodeId.value)
  return node?.params ?? {}
})

const OUTPUT_FORMAT_HINTS: Record<string, string> = {
  auto: '自动推断：字符串直出；对象/数组序列化为 JSON。',
  json: 'JSON 对象或数组，便于下游结构化消费。',
  markdown: 'Markdown 文档（报告、说明、清单等）。',
  plain: '纯文本，无额外格式约束。',
  yaml: 'YAML 结构数据。',
  table: '表格化展示，适合中间结果预览。',
}

const selectedOutputFormatHint = computed(() => {
  const fmt = String(selectedNodeParams.value.format ?? 'auto')
  return OUTPUT_FORMAT_HINTS[fmt] ?? fmt
})

const workflowMetaCompare = computed(() => {
  if (selectedNodeInstance.value?.class_type !== 'WorkflowMeta') return null
  if (!selectedNodeId.value || !workflowStore.execution.results) return null
  const r = workflowStore.execution.results[selectedNodeId.value]
  if (!r?.outputs) return null
  const orig = r.outputs.original_workflow ?? r.outputs.current_workflow
  const mod = r.outputs.modified_workflow
  if (!orig && !mod) return null
  return {
    accepted: Boolean(r.outputs.accepted),
    change_count: Number(r.outputs.change_count ?? 0),
    originalText: formatOutputPreview(orig),
    modifiedText: formatOutputPreview(mod),
  }
})

const isStructuredRoleDeclaration = computed(() => {
  const rd = selectedNodeDef.value?.params?.role_declaration as { type?: string; fields?: unknown } | undefined
  return rd?.type === 'object' && !!rd?.fields
})

const roleFields = reactive(defaultRoleDeclaration())

watch([selectedNodeId, isStructuredRoleDeclaration], () => {
  if (!isStructuredRoleDeclaration.value || !selectedNodeId.value) return
  const node = workflowStore.graph?.nodes.find(n => n.id === selectedNodeId.value)
  if (!node) return
  const rd = node.params.role_declaration
  if (typeof rd === 'object' && rd !== null && !Array.isArray(rd) && 'role' in rd) {
    Object.assign(roleFields, rd)
  } else {
    const d = defaultRoleDeclaration()
    node.params.role_declaration = d
    Object.assign(roleFields, d)
  }
})

watch(roleFields, () => {
  if (!isStructuredRoleDeclaration.value || !selectedNodeId.value) return
  const node = workflowStore.graph?.nodes.find(n => n.id === selectedNodeId.value)
  if (!node) return
  node.params.role_declaration = { ...roleFields }
  workflowStore.markDirty()
}, { deep: true })

watch(
  () => {
    const node = workflowStore.graph?.nodes.find(n => n.id === selectedNodeId.value)
    if (node?.class_type !== 'NoteCard') return null
    return {
      collapsed: node.collapsed,
      content: node.params.content,
      expanded_width: node.params.expanded_width,
      expanded_height: node.params.expanded_height,
      collapsed_height: node.params.collapsed_height,
      collapsed_width: node.params.collapsed_width,
      body_font_size: node.params.body_font_size,
      color: node.params.color,
    }
  },
  () => {
    const node = workflowStore.graph?.nodes.find(n => n.id === selectedNodeId.value)
    if (node?.class_type !== 'NoteCard') return
    applyNoteCardLayout(node)
    graphCanvas?.syncNoteCardLayouts(node.id)
    workflowStore.markDirty()
  },
)

function toggleNoteCardCollapsed() {
  const node = selectedNodeInstance.value
  if (!node || node.class_type !== 'NoteCard') return
  node.collapsed = !node.collapsed
  applyNoteCardLayout(node)
  graphCanvas?.syncNoteCardLayouts(node.id)
  workflowStore.markDirty()
}

function addNoteCardAtViewCenter() {
  if (!workflowStore.graph || !graphCanvas) return
  const center = graphCanvas.viewportGraphCenter()
  workflowStore.addNode('NoteCard', center.x - 120, center.y - 40)
  const node = workflowStore.graph.nodes.at(-1)
  if (node?.class_type === 'NoteCard') {
    applyNoteCardLayout(node)
    graphCanvas.syncNoteCardLayouts(node.id)
  }
}

const REGISTRY_DRAG_PREFIX = 'registry:'

function onDragStart(e: DragEvent, classType: string) {
  e.dataTransfer?.setData('text/plain', classType)
}

function onDragStartRegistry(e: DragEvent, wf: WorkflowEntry) {
  e.dataTransfer?.setData('text/plain', `${REGISTRY_DRAG_PREFIX}${wf.id}`)
}

async function openRegistryItem(wf: WorkflowEntry) {
  if (isParadigmRegistryEntry(wf)) {
    const classType = classTypeFromRegistryEntry(wf)
    if (classType) await expandNodeToSubgraph(classType)
    return
  }
  await loadRegisteredWorkflow(wf)
}

const filteredEcosystemProjects = computed(() => {
  if (!searchQuery.value) return ecosystemProjects.value
  const q = searchQuery.value.toLowerCase()
  return ecosystemProjects.value.filter(p =>
    p.name.toLowerCase().includes(q) || p.tier.toLowerCase().includes(q)
  )
})

async function refreshEcosystem() {
  try {
    const projects = await scanEcosystem()
    ecosystemProjects.value = projects
  } catch (err) {
    console.warn('[PolarUI] Failed to scan ecosystem:', err)
  }
}

async function loadProjectSsot(proj: EcosystemProject) {
  try {
    const res = await fetch(`/api/polaris/${encodeURIComponent(proj.name)}`)
    if (res.ok) {
      const polarisData = await res.json()
      console.log('[PolarUI] Loading SSoT for:', proj.name, 'data keys:', Object.keys(polarisData))
      currentSsotProject.value = proj.name
      currentSsotData.value = polarisData
      const newGraph = compileSsotToGraph(polarisData, proj.name)
      await setMainGraph(newGraph, { kind: 'ssot', project: proj.name })
      writeLastSession({ viewMode: 'ssot', ssotProject: proj.name })
      return
    }
    console.error('[PolarUI] SSoT API returned:', res.status)
    alert(`无法加载项目 ${proj.name} 的 SSoT 数据 (${res.status})`)
  } catch (err) {
    console.error('[PolarUI] loadProjectSsot error:', err)
    alert(`无法连接到 Hub 加载 ${proj.name} 的 SSoT 数据`)
  }
}

function onDrop(e: DragEvent) {
  const payload = e.dataTransfer?.getData('text/plain')
  if (!payload || !workflowStore.graph) return

  const rect = canvasEl.value!.parentElement!.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top

  if (payload.startsWith(REGISTRY_DRAG_PREFIX)) {
    const id = payload.slice(REGISTRY_DRAG_PREFIX.length)
    const merged = filterRegistryPaletteEntries(registryWorkflows.value, libraryMode.value)
    const wf =
      merged.find(w => w.id === id) ??
      getCachedRegistry().find(w => w.id === id)
    if (wf && isParadigmRegistryEntry(wf)) {
      const classType = classTypeFromRegistryEntry(wf)
      if (classType) {
        workflowStore.addNode(classType, x, y)
        graphCanvas?.refreshWireRouting()
      }
      return
    }
    const wfWorkflow =
      wf ??
      registryWorkflows.value.find(w => w.id === id)
    if (!wfWorkflow?.file && !wfWorkflow?.paradigm_class_type) return
    if (!wfWorkflow) return
    workflowStore.addRegistryWorkflowCall(
      { id: wfWorkflow.id, name: wfWorkflow.name, description: wfWorkflow.description },
      x,
      y,
    )
    graphCanvas?.refreshWireRouting()
    return
  }

  workflowStore.addNode(payload, x, y)
  graphCanvas?.refreshWireRouting()
}

function runCompileCheck() {
  compilePanelOpen.value = true
  if (compileCheckResult.value.valid && compileCheckResult.value.warnings.length === 0) {
    return
  }
  if (!compileCheckResult.value.valid) {
    window.alert(`编译未通过：\n\n${compileCheckSummary.value}`)
  }
}

async function executeWorkflow() {
  if (!workflowStore.graph) return
  const check = compileCheckGraph(workflowStore.graph)
  if (!check.valid) {
    compilePanelOpen.value = true
    window.alert(`编译未通过，无法执行：\n\n${formatCompileCheckMessage(check)}\n\n请修复错误后重试。`)
    return
  }
  if (graphNeedsPrivPortal(workflowStore.graph)) {
    await checkVault()
    if (!vaultUnlocked.value) {
      window.alert(
        'PolarPrivate 未就绪或 Vault 未解锁，无法执行含 LLM/ToolCall 的工作流。\n\n'
        + '请在本机解锁 PolarPrivate vault（默认 http://127.0.0.1:12790），确认 header 显示 ● Vault 后重试。',
      )
      return
    }
  }
  await workflowStore.execute()
  syncCanvasExecutionResults()
  if (workflowStore.execution.status === 'error') {
    window.alert(`执行失败：\n\n${workflowStore.execution.error ?? '未知错误'}`)
    return
  }
  const outputs = workflowStore.graph.nodes.filter(n => n.class_type === 'Output')
  for (const node of outputs) {
    const content = getOutputResultContent(node.id, workflowStore.execution.results)
    if (content !== null) {
      openOutputPip(node.id)
      break
    }
  }
}

function exportWorkflow() {
  if (!workflowStore.graph) return
  const json = JSON.stringify(workflowStore.graph.toApiFormat(), null, 2)
  navigator.clipboard.writeText(json)

  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${workflowStore.currentName || 'workflow'}.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function deployWorkflow() {
  if (!workflowStore.graph) return
  const check = compileCheckGraph(workflowStore.graph)
  if (!check.valid) {
    compilePanelOpen.value = true
    window.alert(`编译未通过，无法部署：\n\n${formatCompileCheckMessage(check)}`)
    return
  }
  if (graphNeedsPrivPortal(workflowStore.graph)) {
    await checkVault()
    if (!vaultUnlocked.value) {
      window.alert('PolarPrivate 未就绪或 Vault 未解锁，无法部署含 LLM 的工作流。')
      return
    }
  }
  const workflowId = activeRegistryId.value || workflowStore.currentName.replace(/\s+/g, '-').toLowerCase()
  const displayName = workflowStore.currentName || workflowId
  deploying.value = true
  try {
    const res = await fetch(`${POLARCLAW_CHAT_BASE}/api/deployments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: workflowId,
        workflow_id: workflowId,
        display_name: displayName,
        library: libraryMode.value,
        memory: 'WorkingMemory',
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(err.error ?? `HTTP ${res.status}`)
    }
    const data = await res.json() as { chat_url?: string; deployment?: { id: string } }
    const chatPath = data.chat_url ?? `/chat?workflow=${encodeURIComponent(workflowId)}`
    const chatUrl = chatPath.startsWith('http')
      ? chatPath
      : `${POLARCLAW_CHAT_BASE}${chatPath.startsWith('/') ? chatPath : `/${chatPath}`}`
    chatSidebarOpen.value = true
    if (window.confirm(`已部署「${displayName}」到 Chat 壳。\n\n侧栏 Chat 已打开。是否同时在浏览器打开 ${chatUrl} ？`)) {
      window.open(chatUrl, '_blank')
    }
  } catch (err) {
    window.alert(`部署失败：${err instanceof Error ? err.message : String(err)}\n\n请确认 PolarClaw Web 已启动（${POLARCLAW_CHAT_BASE}/api/status）`)
  } finally {
    deploying.value = false
  }
}

function openJsonFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    const text = await file.text()
    try {
      const newGraph = loadWorkflowJson(text)
      await setMainGraph(newGraph, { kind: 'graph', graphId: newGraph.id, name: newGraph.name })
    } catch (err) {
      alert(`加载失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  input.click()
}

function fitView() {
  if (expandedSubgraph.value && subGraphCanvas) {
    subGraphCanvas.fitToContent()
    return
  }
  if (graphCanvas) {
    graphCanvas.fitToContent()
  }
}

async function reloadSubgraphToDefault(frame: SubgraphFrame) {
  if (frame.layoutScope.kind === 'workflow-ref') {
    const subGraph = await loadWorkflowByRef(frame.layoutScope.ref)
    if (subGraph) {
      frame.graph = subGraph
      const idx = subgraphStack.value.length - 1
      if (idx >= 0) subgraphStack.value[idx] = frame
      await mountSubGraphCanvas(subGraph, frame.layoutScope)
    }
    return
  }
  if (frame.layoutScope.kind === 'custom') {
    const subGraph = await loadWorkflowByRef(`custom/${frame.layoutScope.id}`)
    if (subGraph) {
      frame.graph = subGraph
      const idx = subgraphStack.value.length - 1
      if (idx >= 0) subgraphStack.value[idx] = frame
      await mountSubGraphCanvas(subGraph, frame.layoutScope)
    }
    return
  }
  if (frame.layoutScope.kind === 'builtin-subgraph') {
    applyBuiltinSubgraphDefaultLayout(frame.graph, frame.classType)
    await mountSubGraphCanvas(frame.graph, frame.layoutScope)
  }
}

async function resetLayout() {
  if (!window.confirm('清除已记忆的布局并恢复默认自动排布？')) return

  const inSubgraph = Boolean(expandedSubgraph.value)
  const frame = expandedSubgraph.value
  const scope = frame?.layoutScope ?? mainLayoutScope.value
  const graph = frame?.graph ?? workflowStore.graph
  const canvas = inSubgraph ? subGraphCanvas : graphCanvas

  if (!scope || !graph?.nodes.length) return

  clearStoredLayout(scope)

  if (inSubgraph && (scope.kind === 'workflow-ref' || scope.kind === 'custom')) {
    await reloadSubgraphToDefault(frame!)
    return
  }

  if (scope.kind === 'ssot') {
    applySsotDefaultLayout(graph)
  } else if (scope.kind === 'builtin-subgraph') {
    applyBuiltinSubgraphDefaultLayout(graph, frame!.classType)
  } else {
    computeBackLinks(graph)
    await applyGraphAutoLayout(graph)
  }

  canvas?.setGraph(graph)
  canvas?.refreshWireRouting()
  canvas?.fitToContent()
}

function deleteSelected() {
  const canvas = expandedSubgraph.value ? subGraphCanvas : graphCanvas
  if (canvas?.deleteSelection()) {
    selectedNodeId.value = canvas.getSelectedNode()
    selectedLinkId.value = canvas.getSelectedLink()
    workflowStore.markDirty()
    if (mainLayoutScope.value && workflowStore.graph) {
      scheduleLayoutSave(workflowStore.graph, mainLayoutScope.value)
    }
    return
  }
  if (selectedLinkId.value && workflowStore.graph) {
    workflowStore.graph.removeLink(selectedLinkId.value)
    selectedLinkId.value = null
    workflowStore.markDirty()
    return
  }
  if (selectedNodeId.value && workflowStore.graph) {
    workflowStore.graph.removeNode(selectedNodeId.value)
    selectedNodeId.value = null
    workflowStore.markDirty()
    if (mainLayoutScope.value) {
      scheduleLayoutSave(workflowStore.graph, mainLayoutScope.value)
    }
  }
}

function handleGlobalKeyDown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  if (selectedLinkId.value || selectedNodeId.value) {
    e.preventDefault()
    deleteSelected()
  }
}

async function runPlanner() {
  if (!selectedNodeId.value || !workflowStore.graph) return
  const node = workflowStore.graph.nodes.find(n => n.id === selectedNodeId.value)
  if (!node || node.class_type !== 'Planner') return

  const goal = String(node.params.goal || '')
  if (!goal.trim()) {
    alert('请先输入目标描述')
    return
  }

  plannerRunning.value = true
  try {
    const viaPolarClaw = node.params.via_polarclaw === true
    const result = viaPolarClaw
      ? await executePlannerViaPolarClaw(goal)
      : await executePlanner(goal, {
          model: String(node.params.model || 'qwen3'),
          strategy: String(node.params.strategy || 'linear') as 'linear' | 'parallel' | 'iterative',
          max_depth: Number(node.params.max_depth || 5),
          reflect: Boolean(node.params.reflect ?? true),
        })

    const json = JSON.stringify(result.workflow, null, 2)
    const newGraph = loadWorkflowJson(json)
    await setMainGraph(newGraph, { kind: 'graph', graphId: newGraph.id, name: newGraph.name })
  } catch (err) {
    alert(`规划失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    plannerRunning.value = false
  }
}

async function checkHub() {
  hubConnected.value = await hubApi.checkHealth()
}

async function checkVault() {
  vaultUnlocked.value = await isPrivPortalHealthy()
}

function graphNeedsPrivPortal(graph: Graph): boolean {
  return graph.nodes.some(n => {
    if (n.class_type === 'LLM' || n.class_type === 'ToolCall') return true
    if (n.class_type === 'Validator' && String(n.params.verify_mode ?? '') === 'auto') return true
    if (n.class_type === 'AgenticUnit') return true
    return false
  })
}

async function handleUpToDate() {
  if (!currentSsotProject.value) {
    alert('请先在生态地图中选择一个项目')
    return
  }
  ssotUpdating.value = true
  try {
    await runUpToDate(currentSsotProject.value, {
      onProgress: (msg) => console.log('[SSoT Up-to-date]', msg),
      onComplete: () => {
        const proj = ecosystemProjects.value.find(p => p.name === currentSsotProject.value)
        if (proj) loadProjectSsot(proj)
      },
      onError: (err) => alert(`状态检查失败: ${err}`),
    })
  } finally {
    ssotUpdating.value = false
  }
}

async function handleExecPending() {
  if (!currentSsotProject.value || !currentSsotData.value) {
    alert('请先在生态地图中选择一个项目')
    return
  }
  ssotExecuting.value = true
  try {
    await runExecutePending(currentSsotProject.value, currentSsotData.value, {
      onProgress: (msg) => console.log('[SSoT Execute]', msg),
      onFeatureUpdated: (reqId, name, status) => {
        console.log(`[SSoT Execute] ${reqId}/${name} → ${status}`)
      },
      onComplete: () => {
        const proj = ecosystemProjects.value.find(p => p.name === currentSsotProject.value)
        if (proj) loadProjectSsot(proj)
      },
      onError: (err) => alert(`执行失败: ${err}`),
    })
  } finally {
    ssotExecuting.value = false
  }
}

async function discoverModels() {
  const tryFetch = async () => {
    const models = await listModels()
    if (models.length > 0) {
      registry.updateModelOptions(models.map(m => m.id))
      registryVersion.value++
      console.log('[PolarUI] Dynamic models loaded:', models.map(m => m.id))
      return true
    }
    return false
  }
  try {
    if (await tryFetch()) return
  } catch {
    console.log('[PolarUI] PolarPrivate not available, retrying model discovery…')
  }
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000))
    try {
      if (await tryFetch()) return
    } catch { /* retry */ }
  }
  console.log('[PolarUI] Using default model list (PolarPrivate unavailable)')
}

onMounted(() => {
  if (canvasEl.value && workflowStore.graph) {
    graphCanvas = new GraphCanvas(canvasEl.value, workflowStore.graph)
    graphCanvas.onNodeSelected = (id) => {
      selectedNodeId.value = id
      if (id) selectedLinkId.value = null
    }
    graphCanvas.onLinkSelected = (id) => {
      selectedLinkId.value = id
      if (id) selectedNodeId.value = null
    }
    graphCanvas.onWorkflowChanged = () => {
      workflowStore.markDirty()
      if (mainLayoutScope.value) {
        scheduleLayoutSave(workflowStore.graph!, mainLayoutScope.value)
      }
    }
    graphCanvas.onExpandNode = (_nodeId, classType) => {
      expandNodeToSubgraph(classType)
    }
    graphCanvas.onOutputPreview = openOutputPip
    graphCanvas.setExecutionResults(workflowStore.execution.results)
    console.log('[PolarUI] Canvas initialized, graph nodes:', workflowStore.graph.nodes.length)
  } else {
    console.warn('[PolarUI] Canvas NOT initialized! canvasEl:', !!canvasEl.value, 'graph:', !!workflowStore.graph)
  }
  checkHub()
  checkVault()
  window.addEventListener('keydown', handleGlobalKeyDown)
  loadRegistry().then(async entries => {
    registryWorkflows.value = entries
    const last = readLastSession()
    if (last?.viewMode === 'workflow' && last.registryId) {
      const wf = entries.find(w => w.id === last.registryId)
      if (wf) await loadRegisteredWorkflow(wf)
    } else if (last?.viewMode === 'ssot' && last.ssotProject) {
      viewMode.value = 'ssot'
      await refreshEcosystem()
      const proj = ecosystemProjects.value.find(p => p.name === last.ssotProject)
      if (proj) await loadProjectSsot(proj)
    }
  })
  const customCount = restoreCustomAgentsFromStorage()
  if (customCount) console.log(`[PolarUI] Restored ${customCount} custom Agent Take nodes`)
  discoverModels()
  const stopCheckup = startCheckupDaemon()
  console.log('[PolarUI] @checkup-agent daemon started (SSE → CheckupTriageAndHeal)')
  const interval = setInterval(() => {
    checkHub()
    checkVault()
  }, 10000)
  onUnmounted(() => {
    clearInterval(interval)
    stopCheckup()
    window.removeEventListener('keydown', handleGlobalKeyDown)
    graphCanvas?.destroy()
  })
})

watch(() => workflowStore.execution.current_node, (nodeId) => {
  graphCanvas?.setRunningNode(nodeId || null)
  subGraphCanvas?.setRunningNode(nodeId || null)
})

watch(() => workflowStore.execution.results, () => {
  syncCanvasExecutionResults()
}, { deep: true })

watch(() => workflowStore.execution.node_states, () => {
  graphCanvas?.setNodeStates(workflowStore.execution.node_states)
  subGraphCanvas?.setNodeStates(workflowStore.execution.node_states)
}, { deep: true })

watch(viewMode, (mode, oldMode) => {
  if (mode !== oldMode) {
    const emptyGraph = new Graph(mode === 'ssot' ? 'SSoT View' : 'Untitled Workflow')
    mainLayoutScope.value = null
    void setMainGraph(emptyGraph, null)
    currentSsotProject.value = ''
    currentSsotData.value = null
  }
  if (mode === 'ssot' && ecosystemProjects.value.length === 0) {
    refreshEcosystem()
  }
})
</script>

<style>
.app-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 16px;
  background: #0d1117;
  border-bottom: 1px solid #30363d;
}

.header-left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }

.quick-mode-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 8px;
  border-left: 1px solid #30363d;
}
.quick-label {
  font-size: 10px;
  color: #8b949e;
  margin-right: 2px;
}

.mode-tabs {
  display: flex;
  background: #161b22;
  border-radius: 6px;
  padding: 2px;
  border: 1px solid #30363d;
}
.mode-tab {
  padding: 4px 12px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: #8b949e;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.mode-tab.active {
  background: #21262d;
  color: #e6edf3;
}
.mode-tab:hover:not(.active) { color: #c9d1d9; }
.header-center { display: flex; align-items: center; gap: 12px; }
.header-right { display: flex; align-items: center; gap: 8px; }
.suggestion-btn { position: relative; }
.suggestion-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f85149;
  border: 1px solid #161b22;
}

.lg-replay-bar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: #f0fdf4;
  border: 1px solid #86efac;
  border-radius: 6px;
  font-size: 11px;
}

.lg-replay-slider { width: 120px; }
.lg-replay-step { color: #166534; min-width: 48px; }
.lg-replay-label { color: #15803d; }
.lg-replay-detail {
  color: #ca8a04;
  font-size: 11px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logo {
  font-size: 16px;
  font-weight: 700;
  background: linear-gradient(135deg, #7ee8fa, #eec643);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.workflow-name {
  font-size: 13px;
  color: #8b949e;
}

.hub-status {
  font-size: 11px;
  color: #f85149;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(248, 81, 73, 0.1);
}
.hub-status.connected {
  color: #2ea043;
  background: rgba(46, 160, 67, 0.1);
}

.vault-status {
  font-size: 11px;
  color: #d29922;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(210, 153, 34, 0.1);
}
.vault-status.connected {
  color: #2ea043;
  background: rgba(46, 160, 67, 0.1);
}

.btn {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn:hover { background: #30363d; }
.btn:active { transform: scale(0.97); }
.btn-run { background: #238636; border-color: #2ea043; }
.btn-run:hover { background: #2ea043; }
.btn-run:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-deploy { background: #1f4a7a; border-color: #388bfd; }
.btn-deploy:hover { background: #388bfd; }
.btn-deploy:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-uptodate { background: #6b5b1f; border-color: #d29922; color: #f0d060; }
.btn-uptodate:hover { background: #7a6a25; }
.btn-uptodate:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 4px 8px; font-size: 11px; }
.btn-danger { background: #da3633; border-color: #f85149; margin-top: 16px; width: 100%; }
.btn-danger:hover { background: #f85149; }
.btn-full { width: 100%; justify-content: center; display: flex; align-items: center; padding: 10px; font-size: 13px; }

.exec-hint {
  font-size: 10px;
  color: #6e7681;
  margin-top: 8px;
  line-height: 1.4;
}

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }

.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.node-palette {
  width: 220px;
  background: #0d1117;
  border-right: 1px solid #30363d;
  overflow-y: auto;
  padding: 12px;
}

.palette-header {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: #e6edf3;
}

.palette-header--stacked {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.library-mode-tabs .panel-tab {
  flex: 1;
  font-size: 11px;
}

.palette-search {
  width: 100%;
  padding: 6px 10px;
  margin-bottom: 12px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  font-size: 12px;
  outline: none;
}
.palette-search:focus { border-color: #58a6ff; }

.category-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: #c9d1d9;
  margin-top: 10px;
  margin-bottom: 4px;
  padding: 4px 4px;
  border-radius: 4px;
  user-select: none;
}
.category-title.collapsible { cursor: pointer; }
.category-title.collapsible:hover { background: #161b22; }
.collapse-icon {
  font-size: 8px;
  color: #6e7681;
  width: 12px;
  flex-shrink: 0;
  text-align: center;
}

.category-count {
  margin-left: auto;
  font-size: 10px;
  color: #6e7681;
  background: #21262d;
  padding: 1px 5px;
  border-radius: 8px;
}

.sub-category { margin-left: 8px; }
.sub-category-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #8b949e;
  padding: 3px 4px;
  margin: 4px 0 2px;
  border-radius: 4px;
  user-select: none;
}

.palette-node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
  cursor: grab;
  transition: background 0.15s;
}
.palette-node:hover { background: #161b22; }
.palette-node:active { cursor: grabbing; }
.palette-node.sub-node { margin-left: 12px; font-size: 11px; }
.node-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-label :deep(.search-hit),
.eco-name :deep(.search-hit) {
  background: #3d2e00;
  color: #ffd866;
  border-radius: 2px;
  padding: 0 1px;
}
.expand-btn {
  width: 20px;
  height: 20px;
  border: 1px solid #30363d;
  border-radius: 4px;
  background: #21262d;
  color: #7ee8fa;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0;
  transition: all 0.15s;
  padding: 0;
}
.palette-node:hover .expand-btn { opacity: 1; }
.expand-btn:hover {
  background: #30363d;
  border-color: #58a6ff;
  transform: scale(1.1);
}

.node-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.health-main {
  flex: 1;
  min-width: 0;
  background: #0f1419;
}

.canvas-area {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
}
.canvas-area--split { flex-direction: row; }
.canvas-primary {
  flex: 1;
  position: relative;
  overflow: hidden;
}
.canvas-primary--split { flex: 1; border-right: 2px solid #30363d; }
.canvas-primary canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.ui-build-stamp {
  margin-left: 8px;
  padding: 2px 8px;
  font-family: "SimSun", "宋体", "Songti SC", sans-serif;
  font-size: 11px;
  font-weight: bold;
  line-height: 1.2;
  color: #fff;
  background: #16a34a;
  border-radius: 4px;
}
.canvas-secondary {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.canvas-secondary canvas {
  flex: 1;
  width: 100%;
}
.subgraph-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
  flex-shrink: 0;
  gap: 8px;
}
.subgraph-breadcrumb {
  font-size: 11px;
  color: #8b949e;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subgraph-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.subgraph-title {
  font-size: 12px;
  font-weight: 600;
  color: #7ee8fa;
}

.properties-panel {
  position: relative;
  flex-shrink: 0;
  min-width: 280px;
  max-width: 720px;
  background: #0d1117;
  border-left: 1px solid #30363d;
  overflow-y: auto;
  padding: 16px;
}
.properties-panel-resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 2;
}
.properties-panel-resize:hover {
  background: rgba(88, 166, 255, 0.25);
}
.component-status {
  display: inline-block;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  margin-bottom: 10px;
}
.component-status--idle { background: #21262d; color: #8b949e; }
.component-status--running { background: #1f3d2a; color: #3fb950; }
.component-status--ok { background: #1f3d2a; color: #58a6ff; }
.component-status--error { background: #3d1f1f; color: #f85149; }
.panel-hint {
  font-size: 10px;
  color: #6e7681;
  margin: 0 0 8px;
  line-height: 1.4;
}
.input-value-row {
  margin-bottom: 10px;
  padding: 8px;
  background: #161b22;
  border-radius: 6px;
  border: 1px solid #21262d;
}
.input-value-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 4px;
}
.input-value-name {
  font-size: 14px;
  font-weight: 600;
  color: #e6edf3;
}
.input-slot-doc {
  margin: 0 0 4px;
  font-size: 11px;
  line-height: 1.45;
  color: #8b949e;
}
.input-value-source {
  font-size: 10px;
  color: #8b949e;
  margin-bottom: 4px;
}
.input-value-body {
  margin: 0;
  max-height: 120px;
}
.next-step-btn {
  display: block;
  width: 100%;
  text-align: left;
  margin-bottom: 6px;
  padding: 8px 10px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #e6edf3;
  font-size: 12px;
  cursor: pointer;
}
.next-step-btn:hover {
  border-color: #58a6ff;
  background: #1c2128;
}
.next-step-wire {
  display: block;
  font-size: 10px;
  color: #8b949e;
  margin-top: 2px;
}
.panel-config-details summary {
  cursor: pointer;
  list-style: none;
}
.panel-config-details summary::-webkit-details-marker {
  display: none;
}
.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.section-title-row .section-title {
  margin-bottom: 0;
}
.executor-doc-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.executor-doc-panel {
  width: min(900px, 92vw);
  max-height: 85vh;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}
.executor-doc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #30363d;
  font-size: 13px;
  font-weight: 600;
}
.executor-doc-body {
  margin: 0;
  padding: 16px;
  overflow: auto;
  font-size: 11px;
  max-height: calc(85vh - 56px);
  border: none;
  background: #1e1e1e;
}
.panel-code-section :deep(.executor-snippet-pre) {
  max-height: 280px;
}

.panel-header {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.panel-desc {
  font-size: 11px;
  color: #8b949e;
  margin-bottom: 12px;
}

.panel-section {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid #21262d;
}

.section-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #8b949e;
  margin-bottom: 8px;
}

.param-row {
  margin-bottom: 10px;
}
.param-row label {
  display: block;
  font-size: 11px;
  color: #8b949e;
  margin-bottom: 4px;
}

.param-input {
  width: 100%;
  padding: 6px 8px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  font-size: 12px;
}
.param-textarea { resize: vertical; font-family: monospace; }

.slot-info {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 12px;
}
.slot-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.slot-dot.input { background: #7ee8fa; }
.slot-dot.output { background: #eec643; }
.slot-type { color: #6e7681; font-size: 10px; }

.link-arrow { color: #8b949e; margin: 0 4px; }
.link-color-swatch {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.2);
  flex-shrink: 0;
}
.link-payload-pre {
  margin: 0;
  padding: 8px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.45;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: #c9d1d9;
}

.output-terminal-guide {
  background: #0f2419;
  border: 1px solid #2d8a5a;
  border-radius: 6px;
  padding: 10px;
}
.output-terminal-intro {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.5;
  color: #b6dfc8;
}
.output-terminal-intro code {
  font-size: 11px;
  color: #7ee8a8;
}
.output-spec-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
}
.output-spec-label {
  color: #8b949e;
  min-width: 64px;
}
.output-spec-value {
  color: #2d8a5a;
  font-size: 11px;
}
.output-format-hint {
  margin: 0 0 10px;
  font-size: 11px;
  color: #8b949e;
  line-height: 1.4;
}
.output-pip {
  position: absolute;
  right: 16px;
  bottom: 16px;
  width: min(420px, calc(100% - 32px));
  max-height: min(360px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  background: rgba(13, 17, 23, 0.96);
  border: 1px solid #30363d;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  z-index: 20;
  overflow: hidden;
}
.output-pip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid #30363d;
  background: #161b22;
}
.output-pip-title {
  font-size: 12px;
  font-weight: 600;
  color: #2d8a5a;
}
.output-pip-close {
  border: none;
  background: transparent;
  color: #8b949e;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
}
.output-pip-close:hover {
  color: #e6edf3;
  background: #21262d;
}
.output-pip-body {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  color: #e6edf3;
  flex: 1;
}
.output-pip-body--error {
  color: #f85149;
}

.meta-compare-panel { margin-top: 8px; }
.meta-compare-status {
  font-size: 11px;
  color: #8b949e;
  margin-bottom: 8px;
}
.meta-compare-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.meta-compare-label {
  font-size: 11px;
  font-weight: 600;
  color: #58a6ff;
  margin-bottom: 4px;
}
.meta-compare-pre {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  padding: 6px;
  border-radius: 4px;
  background: #0d1117;
  border: 1px solid #30363d;
  font-size: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  color: #c9d1d9;
}

.app-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 28px;
  padding: 0 16px;
  background: #0d1117;
  border-top: 1px solid #30363d;
  font-size: 11px;
  color: #8b949e;
}

.exec-warn { color: #f85149; }
.exec-running {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #58a6ff;
}
.exec-progress-bar {
  display: inline-block;
  width: 72px;
  height: 4px;
  background: #21262d;
  border-radius: 2px;
  overflow: hidden;
}
.exec-progress-fill {
  display: block;
  height: 100%;
  background: #58a6ff;
  transition: width 0.2s ease;
}
.compile-status { cursor: pointer; }
.compile-status--ok { color: #3fb950; }
.compile-status--warn { color: #d29922; }
.btn-compile-fail { border-color: #f85149; color: #f85149; }

.compile-panel {
  position: fixed;
  right: 16px;
  bottom: 36px;
  width: min(480px, calc(100vw - 32px));
  max-height: 40vh;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  z-index: 100;
  display: flex;
  flex-direction: column;
}
.compile-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #30363d;
  font-size: 12px;
  color: #e6edf3;
}
.compile-checklist {
  list-style: none;
  margin: 0;
  padding: 8px 12px;
  max-height: 160px;
  overflow: auto;
  border-bottom: 1px solid #30363d;
}
.compile-checklist-item {
  font-size: 11px;
  line-height: 1.45;
  padding: 4px 0;
  color: #c9d1d9;
}
.compile-checklist-item--error { color: #f85149; }
.compile-checklist-item--warning { color: #d29922; }
.compile-checklist-item--clickable {
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.compile-checklist-item--clickable:hover { color: #58a6ff; }
.compile-panel-body {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.5;
  color: #c9d1d9;
  white-space: pre-wrap;
}

.ssot-panel-tabs {
  display: flex;
  background: #161b22;
  border-radius: 4px;
  padding: 2px;
  border: 1px solid #30363d;
  width: 100%;
}
.panel-tab {
  flex: 1;
  padding: 4px 8px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: #8b949e;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.panel-tab.active {
  background: #21262d;
  color: #e6edf3;
}
.panel-tab:hover:not(.active) { color: #c9d1d9; }

.ecosystem-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.registry-palette-section {
  margin-bottom: 10px;
}
.registry-section-title {
  margin: 6px 0 4px;
  font-size: 11px;
  color: #8b949e;
  cursor: default;
}
.registry-paradigm-item {
  margin-bottom: 2px;
}
.ecosystem-item {
  padding: 8px 10px;
  border-radius: 6px;
  background: #161b22;
  border: 1px solid #21262d;
  cursor: pointer;
  transition: all 0.15s;
}
.ecosystem-item--draggable {
  cursor: grab;
}
.ecosystem-item--draggable:active {
  cursor: grabbing;
}
.ecosystem-item:hover {
  border-color: #58a6ff;
  background: #1c2531;
}
.ecosystem-item--active {
  border-color: #58a6ff;
  background: #1a3050;
  box-shadow: inset 3px 0 0 #58a6ff;
}
.eco-item-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.eco-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.eco-dot.active { background: #2ea043; }
.eco-dot.planning { background: #d29922; }
.eco-dot.archived { background: #6e7681; }
.eco-name {
  font-size: 12px;
  font-weight: 500;
  color: #e6edf3;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eco-tier {
  font-size: 9px;
  color: #8b949e;
  background: #21262d;
  padding: 1px 5px;
  border-radius: 6px;
}
.eco-item-progress {
  display: flex;
  align-items: center;
  gap: 6px;
}
.eco-progress-bar {
  flex: 1;
  height: 3px;
  background: #21262d;
  border-radius: 2px;
  overflow: hidden;
}
.eco-progress-fill {
  height: 100%;
  background: #238636;
  border-radius: 2px;
  transition: width 0.3s;
}
.eco-progress-text {
  font-size: 9px;
  color: #6e7681;
  white-space: nowrap;
}
.eco-refresh {
  margin-top: 12px;
  width: 100%;
}
</style>
