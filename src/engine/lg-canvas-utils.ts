/** LG Canvas 纯函数 — headless smoke 与 GraphCanvas 共用 */

import type { Link } from './types'

export interface LgEdgeSpec {
  from: string
  to: string
  kind: string
  when?: string
  label?: string
}

export interface MaterializedLink {
  from: string
  to: string
  when?: string
  step?: number
}

export function isConditionalLgEdge(edge: LgEdgeSpec): boolean {
  return edge.kind === 'conditional'
}

/** ReAct / RetryLoop 回边 — 不参与 forward 布局与正交布线 */
export function isLgLayoutBackEdge(edge: Pick<LgEdgeSpec, 'label'>): boolean {
  return Boolean(
    edge.label?.includes('ReAct')
    || edge.label?.includes('回环')
    || edge.label?.includes('RetryLoop')
    || edge.label?.includes('回边'),
  )
}

/** 回放步 index 内可见的物化边（含 step 未标注的静态边） */
export function materializedLinksVisibleAtStep(
  links: MaterializedLink[],
  stepIndex: number,
): MaterializedLink[] {
  return links.filter(l => l.step === undefined || l.step <= stepIndex)
}

/** LG Spec 边是否已被 WF-style link 覆盖 */
export function lgEdgeHasInputLink(
  existingPairs: Set<string>,
  from: string,
  to: string,
): boolean {
  return existingPairs.has(`${from}->${to}`)
}

export function buildExistingLinkPairs(links: Array<{ from_node: string; to_node: string }>): Set<string> {
  const pairs = new Set<string>()
  for (const l of links) pairs.add(`${l.from_node}->${l.to_node}`)
  return pairs
}

/** Spec 虚线边：conditional 或未接线的 static */
export function lgSpecEdgesToDraw(
  lgEdges: LgEdgeSpec[],
  existingPairs: Set<string>,
): LgEdgeSpec[] {
  return lgEdges.filter(e => {
    if (isConditionalLgEdge(e)) return true
    return !lgEdgeHasInputLink(existingPairs, e.from, e.to)
  })
}

/** LG Spec / 物化 overlay → 画布虚拟 Link */
export function lgSpecEdgeToVirtualLink(edge: LgEdgeSpec): Link {
  const tag = edge.when ?? 'static'
  return {
    id: `lg-spec:${edge.from}:${edge.to}:${tag}`,
    from_node: edge.from,
    to_node: edge.to,
    from_slot: 0,
    to_slot: 0,
  }
}

export function materializedLinkToVirtualLink(link: MaterializedLink, index: number): Link {
  return {
    id: `lg-mat:${link.from}:${link.to}:${index}`,
    from_node: link.from,
    to_node: link.to,
    from_slot: 0,
    to_slot: 0,
  }
}

/**
 * LG 画布绕线：graph.links（全部输入/输出接线）+ Spec 补充边 + Run 物化边。
 * 全部 graph.links + lg-spec 补充边 + 物化边；布局仍用 _lg_edges 主干（见 auto-layout）。
 */
export function buildLgCanvasRoutingLinks(
  graphLinks: Link[],
  lgEdges: LgEdgeSpec[] | undefined,
  materializedLinks: MaterializedLink[] = [],
  replayStep: number | null = null,
): Link[] {
  const out = [...graphLinks]
  const pairs = buildExistingLinkPairs(out)

  for (const edge of lgSpecEdgesToDraw(lgEdges ?? [], pairs)) {
    const v = lgSpecEdgeToVirtualLink(edge)
    out.push(v)
    pairs.add(`${v.from_node}->${v.to_node}`)
  }

  const visible =
    replayStep === null
      ? materializedLinks
      : materializedLinksVisibleAtStep(materializedLinks, replayStep)

  for (let i = 0; i < visible.length; i++) {
    out.push(materializedLinkToVirtualLink(visible[i], i))
  }

  return out
}

export function isLgSpecVirtualLink(linkId: string): boolean {
  return linkId.startsWith('lg-spec:')
}

export function isLgMaterializedVirtualLink(linkId: string): boolean {
  return linkId.startsWith('lg-mat:')
}

export function lgSpecEdgeKind(linkId: string, lgEdges: LgEdgeSpec[] | undefined): LgEdgeSpec['kind'] | null {
  if (!isLgSpecVirtualLink(linkId) || !lgEdges?.length) return null
  const parts = linkId.slice('lg-spec:'.length).split(':')
  if (parts.length < 3) return null
  const [from, to, when] = parts
  const edge = lgEdges.find(e => e.from === from && e.to === to && (e.when ?? 'static') === when)
  return edge?.kind ?? null
}

export function isStemCellClass(classType: string): boolean {
  return classType === 'StemCell' || classType === 'PluripotentCell' || classType === 'LG_Pluripotent'
}

/** @deprecated use isStemCellClass */
export function isPluripotentClass(classType: string): boolean {
  return isStemCellClass(classType)
}
