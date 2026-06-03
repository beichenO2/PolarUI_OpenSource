/**
 * Master/Slave 角色隔离协议（R7）
 */

export type RoleType = 'master' | 'slave'

/** Slave 禁止直接执行的高危节点 */
export const SLAVE_DENIED_CLASS_TYPES = new Set([
  'GitCommit',
  'ProcessKill',
  'TaskCreate',
  'ProcessStop',
])

export interface RoleViolation {
  agent_id: string
  class_type: string
  message: string
  timestamp: number
}

class RoleRegistryImpl {
  private agents = new Map<string, RoleType>()
  private violations: RoleViolation[] = []
  private masterId: string | null = null

  register(agentId: string, role: RoleType): void {
    this.agents.set(agentId, role)
    if (role === 'master') this.masterId = agentId
  }

  getRole(agentId: string): RoleType {
    return this.agents.get(agentId) ?? 'master'
  }

  canExecute(agentId: string, classType: string): boolean {
    const role = this.getRole(agentId)
    if (role === 'master') return true
    return !SLAVE_DENIED_CLASS_TYPES.has(classType)
  }

  reportViolation(agentId: string, classType: string): RoleViolation {
    const v: RoleViolation = {
      agent_id: agentId,
      class_type: classType,
      message: `Slave Agent "${agentId}" 无权执行 ${classType}，需要 Master 审批`,
      timestamp: Date.now(),
    }
    this.violations.push(v)
    if (this.violations.length > 100) this.violations.shift()
    console.warn('[RoleProtocol]', v.message)
    return v
  }

  getViolations(): RoleViolation[] {
    return [...this.violations]
  }

  getMasterId(): string | null {
    return this.masterId
  }

  clear(): void {
    this.agents.clear()
    this.violations.length = 0
    this.masterId = null
  }
}

export const roleRegistry = new RoleRegistryImpl()

export function canExecute(agentId: string, classType: string): boolean {
  return roleRegistry.canExecute(agentId, classType)
}

export function reportToMaster(agentId: string, classType: string): RoleViolation {
  return roleRegistry.reportViolation(agentId, classType)
}

/** 从工作流图中的 IDEAgent/WebAgent 节点解析角色 */
export function resolveWorkflowRole(
  nodes: { class_type: string; params: Record<string, unknown> }[]
): { agentId: string; role: RoleType } {
  let agentId = 'polar-ui'
  let role: RoleType = 'master'

  for (const n of nodes) {
    if (n.class_type !== 'IDEAgent' && n.class_type !== 'WebAgent') continue
    const mode = n.params.mode as string
    if (mode === 'master' || mode === 'slave') role = mode
    const id = n.params.agent_id as string
    if (id) agentId = id
  }

  roleRegistry.register(agentId, role)
  return { agentId, role }
}

export function getViolationsForCli(): string {
  return JSON.stringify({
    master_id: roleRegistry.getMasterId(),
    violations: roleRegistry.getViolations(),
  }, null, 2)
}

export function buildMasterApprovalRequest(v: RoleViolation): Record<string, unknown> {
  return {
    type: 'master_approval_required',
    agent_id: v.agent_id,
    class_type: v.class_type,
    message: v.message,
    timestamp: v.timestamp,
    cli_hint: `pc-role-approve --agent ${v.agent_id} --node ${v.class_type}`,
  }
}
