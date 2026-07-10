import type { NodeInstance, Link } from '../../../src/engine/types'

const DEFAULT_W = 200
const DEFAULT_H = 180

export function makeNode(
  id: string,
  x: number,
  y: number,
  opts: { w?: number; h?: number; classType?: string } = {},
): NodeInstance {
  return {
    id,
    class_type: opts.classType ?? 'Stub',
    x,
    y,
    width: opts.w ?? DEFAULT_W,
    height: opts.h ?? DEFAULT_H,
    params: {},
  }
}

export function makeLink(
  id: string,
  from: string,
  fromSlot: number,
  to: string,
  toSlot: number,
): Link {
  return { id, from_node: from, from_slot: fromSlot, to_node: to, to_slot: toSlot }
}

/** 3-node linear chain A → B → C */
export const linear3 = {
  nodes: [
    makeNode('a', 80, 120),
    makeNode('b', 380, 120),
    makeNode('c', 680, 120),
  ],
  links: [
    makeLink('l1', 'a', 0, 'b', 0),
    makeLink('l2', 'b', 0, 'c', 0),
  ],
  backLinks: new Set<string>(),
}

/** 1 → 6 fan-out from single output slot */
export const fanOut6 = {
  nodes: [
    makeNode('src', 80, 280, { h: 220 }),
    ...Array.from({ length: 6 }, (_, i) =>
      makeNode(`dst${i}`, 420 + (i % 2) * 24, 40 + i * 180, { h: 160 }),
    ),
  ],
  links: Array.from({ length: 6 }, (_, i) =>
    makeLink(`l${i}`, 'src', 0, `dst${i}`, 0),
  ),
  backLinks: new Set<string>(),
}

/** ReAct-style: forward chain + 3 backward loop edges (shared bottom lane bug) */
export const react3Loops = {
  nodes: [
    makeNode('input', 80, 200),
    makeNode('llm', 340, 200),
    makeNode('tool', 600, 200),
    makeNode('retry', 860, 200),
    makeNode('out', 1120, 200, { h: 160 }),
  ],
  links: [
    makeLink('f1', 'input', 0, 'llm', 0),
    makeLink('f2', 'llm', 0, 'tool', 0),
    makeLink('f3', 'tool', 0, 'retry', 0),
    makeLink('f4', 'retry', 0, 'out', 0),
    makeLink('b1', 'tool', 0, 'llm', 0),
    makeLink('b2', 'retry', 0, 'llm', 0),
    makeLink('b3', 'retry', 0, 'tool', 0),
  ],
  backLinks: new Set(['b1', 'b2', 'b3']),
}

/** @deprecated use react3Loops for I4 coverage */
export const react2Loops = react3Loops

/** Dense corridor — forces A* iteration pressure */
export const denseCorridor = {
  nodes: [
    makeNode('left', 80, 200),
    makeNode('right', 680, 200),
    ...Array.from({ length: 5 }, (_, i) =>
      makeNode(`obs${i}`, 300 + (i % 2) * 80, 80 + i * 55, { w: 120, h: 100 }),
    ),
  ],
  links: [makeLink('through', 'left', 0, 'right', 0)],
  backLinks: new Set<string>(),
}
