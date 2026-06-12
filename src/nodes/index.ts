/**
 * 所有节点定义已迁移至 ~/Polarisor/PolarUI/node-defs.json（生态级唯一信源）。
 *
 * registerAllNodes() 保留为 fallback 入口——当 node-defs.json 无法加载时，
 * main.ts 会调用此函数。但由于硬编码已移除，此函数现在是空操作。
 *
 * 如需添加新节点，请直接编辑 ~/Polarisor/PolarUI/node-defs.json。
 */
import { registerSSoTNodes } from './ssot'
import { registerPlannerNodes } from './planner'

export function registerAllNodes(): void {
  console.warn('[PolarUI] registerAllNodes called — this is a legacy fallback. All defs should come from node-defs.json')
  registerSSoTNodes()
  registerPlannerNodes()
}
