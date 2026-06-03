/**
 * R9 生态总架构图 — 生成 PolarUI Graph（控制流 + 多输入 + 项目层）
 */
import { Graph } from './graph'
import type { ServiceInfo } from '@/api/process'

export interface ArchProject {
  name: string
  tier: string
  status: string
  doneCount?: number
  requirementCount?: number
}

export interface WatchdogTarget {
  name: string
  status: string
}

const CX = 280
const CY = 160

/** 构建生态控制流架构图（Watchdog → 多服务 HealthCheck → Merge → SelfHeal → Hub Alerts） */
export function buildControlFlowArchitecture(
  services: ServiceInfo[],
  watchdog: WatchdogTarget[],
): Graph {
  const g = new Graph('生态控制流架构')
  const sx = 80
  const sy = 80

  const hub = g.addNode('StaticData', sx, sy)
  if (hub) {
    hub.params = {
      value: 'PolarCopilot Hub\n(MCP + Web UI :8040)',
      type: 'plain',
    }
  }

  const processList = g.addNode('ProcessList', sx + CX, sy)
  const healthChecks: ReturnType<Graph['addNode']>[] = []
  const svcList = services.length ? services : watchdog.map(w => ({ name: w.name, status: w.status }))

  svcList.slice(0, 8).forEach((svc, i) => {
    const n = g.addNode('HealthCheck', sx + CX * 2, sy + i * 72)
    if (n) {
      n.params = {
        service_name: String((svc as ServiceInfo).name ?? (svc as ServiceInfo).id ?? `svc-${i}`),
        health_endpoint: String((svc as ServiceInfo).health_endpoint ?? ''),
      }
      healthChecks.push(n)
    }
  })

  const merge = g.addNode('Merge', sx + CX * 3, sy + 120)
  const selfHeal = g.addNode('SelfHealUnit', sx + CX * 4, sy + 80)
  const alerts = g.addNode('Output', sx + CX * 5, sy + 80)

  if (processList && healthChecks[0]) g.addLink(processList.id, 0, healthChecks[0].id, 0)
  for (let i = 0; i < healthChecks.length; i++) {
    const hc = healthChecks[i]
    if (hc && merge) g.addLink(hc.id, 0, merge.id, 0)
  }
  if (merge && selfHeal) g.addLink(merge.id, 0, selfHeal.id, 0)
  if (hub && selfHeal) g.addLink(hub.id, 0, selfHeal.id, 0)
  if (selfHeal && alerts) g.addLink(selfHeal.id, 0, alerts.id, 0)

  return g
}

/** 构建生态项目层架构图（多项目 → PolarUI 编排层） */
export function buildProjectArchitecture(projects: ArchProject[]): Graph {
  const g = new Graph('生态项目架构')
  const polarui = g.addNode('StaticData', 80, 200)
  if (polarui) {
    polarui.params = {
      value: 'PolarUI\n(127 节点 / 工作流编排)',
      type: 'plain',
    }
  }

  const hubNode = g.addNode('StaticData', 80, 40)
  if (hubNode) {
    hubNode.params = { value: 'PolarCopilot Hub', type: 'plain' }
  }
  if (hubNode && polarui) g.addLink(hubNode.id, 0, polarui.id, 0)

  const cols = 4
  projects.slice(0, 16).forEach((p, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const n = g.addNode('SSoT_Project', 360 + col * 240, 40 + row * CY)
    if (n) {
      const total = p.requirementCount ?? 0
      const done = p.doneCount ?? 0
      n.params = {
        name: p.name,
        tier: p.tier,
        status: p.status,
        description: total ? `${done}/${total} features done` : '',
        version: '',
        reqCount: total,
      }
      if (polarui) g.addLink(n.id, 0, polarui.id, 0)
    }
  })

  return g
}

export function buildFullEcosystemArchitecture(
  projects: ArchProject[],
  services: ServiceInfo[],
  watchdog: WatchdogTarget[],
): Graph {
  const g = new Graph('Polarisor 生态总架构')
  const control = buildControlFlowArchitecture(services, watchdog)
  const project = buildProjectArchitecture(projects)

  let offsetY = 0
  for (const n of control.nodes) {
    const copy = { ...n, id: `c-${n.id}`, y: n.y + offsetY }
    g.nodes.push(copy)
  }
  for (const l of control.links) {
    g.links.push({
      ...l,
      id: `c-${l.id}`,
      from_node: `c-${l.from_node}`,
      to_node: `c-${l.to_node}`,
    })
  }

  offsetY = 520
  for (const n of project.nodes) {
    const copy = { ...n, id: `p-${n.id}`, y: n.y + offsetY }
    g.nodes.push(copy)
  }
  for (const l of project.links) {
    g.links.push({
      ...l,
      id: `p-${l.id}`,
      from_node: `p-${l.from_node}`,
      to_node: `p-${l.to_node}`,
    })
  }

  const bridge = g.addNode('NoteCard', 80, offsetY - 40)
  if (bridge) {
    bridge.params = {
      content: '## 控制流 ↔ 项目层\n\n上方：Watchdog 多路 HealthCheck 汇入 Merge → SelfHeal\n下方：各生态项目 SSoT 汇入 PolarUI 编排',
      color: '#2d3748',
      collapsed_height: 48,
      expanded_width: 320,
    }
    bridge.collapsed = true
  }

  return g
}
