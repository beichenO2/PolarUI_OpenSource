/**
 * ADR-010 evolution archive stub — sidecar chunk keeps executeGraph/registerExecutor on main entry exports.
 * Replaces evolution-gate.ts (PetriDish dynamic import).
 */
import { registerExecutor } from './executor'
import { executeGraph } from './workflow-runner'

;(globalThis as Record<string, unknown>).__polarExecuteGraph = executeGraph

export async function runEvolutionGate(): Promise<{ passed: false; archived: true }> {
  registerExecutor('__EvolutionArchived', async () => ({
    outputs: { archived: true },
    duration_ms: 0,
  }))
  return { passed: false, archived: true }
}
